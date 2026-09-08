/**
 * HRMS authorization middleware.
 *
 * The HRMS model is module x action x scope, not the portal's flat capability
 * strings. The two live side by side and never merge (AD-3): this file is the
 * HRMS half, `./rbac.js` is the portal half.
 *
 * Layering on an HRMS route:
 *
 *   router.use(protect);                       // authenticated  (middlewares/auth.js)
 *   router.use(attachHrmsActor);               // resolve the actor
 *   router.use(requireHrmsAccess);             // AD-4 choke point - any HRMS grant at all
 *   router.get('/x', requirePermission({...}), handler);   // the specific grant
 *
 * `requireHrmsAccess` is mounted once on the HRMS router rather than per route,
 * so a new endpoint cannot be added without it.
 */

import {
  buildHrmsActor,
  hasAnyHrmsAccess,
  hasHrmsPermission,
  ANONYMOUS_HRMS_ACTOR,
} from '../shared/permissions/has-permission.js';
import { effectiveHrmsRoleKeys } from '../utils/hrmsAccessBridge.js';
import { isHrmsRoleKey } from '../shared/permissions/constants.js';

// ---------------------------------------------------------------------------
// Extension points
//
// Phase 0 has no Employee collection and no HRMS resources yet. Rather than
// leave a gap for Phase 1 to fill by editing this file, the two things that
// will need wiring are registered from outside.
// ---------------------------------------------------------------------------

/**
 * Resolves a user id to `{ id, departmentId, managerChain }`, or null.
 * Registered by the employees module in Phase 1.
 * @type {null | ((userId: string) => Promise<object|null>)}
 */
let employeeResolver = null;

export function setEmployeeResolver(fn) {
  employeeResolver = typeof fn === 'function' ? fn : null;
}

/**
 * Resolvers that turn a route parameter into a ResourceContext, so `self`,
 * `team` and `department` scopes can be evaluated against a concrete row.
 * @type {Map<string, (id: string, req: object) => Promise<object|undefined>>}
 */
const resourceResolvers = new Map();

export function registerResourceResolver(paramName, fn) {
  if (typeof fn !== 'function') throw new TypeError('resource resolver must be a function');
  resourceResolvers.set(paramName, fn);
}

/** Test seam. */
export function __resetHrmsAuthRegistry() {
  employeeResolver = null;
  resourceResolvers.clear();
}

// ---------------------------------------------------------------------------
// Actor resolution
// ---------------------------------------------------------------------------

/**
 * Build `req.hrmsActor` from `req.user`.
 *
 * The employee lookup is skipped entirely for a user with no HRMS role. That
 * is both an AD-4 reinforcement - a Customer can never acquire employee context
 * - and the reason portal traffic pays nothing for HRMS being installed.
 * (documentation/architecture-decisions.md AD-3 assumed one extra lookup per
 * request; making it conditional removes that cost from the portal entirely.)
 *
 * ---------------------------------------------------------------------------
 * WHERE THE ROLE KEYS NOW COME FROM
 * ---------------------------------------------------------------------------
 * `effectiveHrmsRoleKeys` replaces the bare `user.roles` this used to pass: the
 * explicit keys on the account, UNIONED with the ones the portal's Roles &
 * Permissions matrix implies. The union is what makes the matrix able to grant
 * HRMS access without touching the employee record, and what makes it unable to
 * take away access the employee record already gave.
 *
 * Everything below this line is unchanged. The keys still reach the same
 * `buildHrmsActor`, which still filters them with `isHrmsRoleKey` and still
 * resolves them against the same matrix, so no HRMS grant, scope or guard means
 * anything different than it did before. See utils/hrmsAccessBridge.js.
 */
export async function attachHrmsActor(req, res, next) {
  try {
    const user = req.user;

    if (!user) {
      req.hrmsActor = ANONYMOUS_HRMS_ACTOR;
      return next();
    }

    // Resolved ONCE and reused below. The gate and the actor need the same
    // answer, and asking twice would put the tier scan on every HRMS request
    // for no benefit.
    const roleKeys = effectiveHrmsRoleKeys(user);

    if (!roleKeys.some(isHrmsRoleKey)) {
      // No HRMS role, and none implied by their portal access -> no grants,
      // and no employee lookup.
      req.hrmsActor = buildHrmsActor({
        userId: user._id ?? user.id,
        roles: [],
        legacyRole: user.role,
      });
      return next();
    }

    let employee = null;
    if (employeeResolver) {
      employee = await employeeResolver(String(user._id ?? user.id));
    }

    req.hrmsActor = buildHrmsActor({
      userId: user._id ?? user.id,
      roles: roleKeys,
      legacyRole: user.role,
      employee,
    });

    return next();
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const forbid = (res, message) =>
  res.status(403).json({ success: false, message });

/**
 * AD-4 choke point. Refuses anyone holding no HRMS grant whatsoever -
 * every Customer, and every portal-only Admin, Sales or warehouse account.
 */
export function requireHrmsAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authorized to access this route.' });
  }
  if (!hasAnyHrmsAccess(req.hrmsActor)) {
    return forbid(res, 'Forbidden. This account has no HRMS access.');
  }
  return next();
}

/**
 * Require one of several `{ module, action, scope, resourceParam? }` specs.
 *
 * ANY-OF: satisfying one spec is enough. That is how a single route serves an
 * employee viewing their own record, a manager viewing a report, and HR viewing
 * anyone - which is the shape the reference system uses throughout.
 *
 * When a spec names `resourceParam`, the registered resolver turns that route
 * parameter into a ResourceContext so a self/team/department grant is checked
 * against the actual row rather than waved through. A spec WITHOUT
 * `resourceParam` on a route that can address someone else's record is the one
 * real trap here - see the note on `isSelf` in shared/permissions/has-permission.js.
 */
export function requirePermission(...specs) {
  if (specs.length === 0) {
    throw new TypeError('requirePermission needs at least one permission spec');
  }
  for (const s of specs) {
    if (!s?.module || !s?.action || !s?.scope) {
      throw new TypeError(
        `invalid permission spec: ${JSON.stringify(s)} - module, action and scope are required`,
      );
    }
  }

  return async (req, res, next) => {
    try {
      const actor = req.hrmsActor;
      if (!actor) {
        // attachHrmsActor was not mounted. Fail closed and make it obvious.
        return forbid(res, 'Forbidden. HRMS actor was not resolved for this request.');
      }

      // Resolve each distinct resourceParam at most once per request.
      const resolved = new Map();
      for (const spec of specs) {
        const param = spec.resourceParam;
        if (!param || resolved.has(param)) continue;

        const raw = req.params?.[param];
        const resolver = resourceResolvers.get(param);
        resolved.set(
          param,
          raw && resolver ? await resolver(String(raw), req) : undefined,
        );
      }

      const allowed = specs.some((spec) =>
        hasHrmsPermission(
          actor,
          spec.module,
          spec.action,
          spec.scope,
          spec.resourceParam ? resolved.get(spec.resourceParam) : undefined,
        ),
      );

      if (!allowed) {
        const needed = specs.map((s) => `${s.module}:${s.action}:${s.scope}`).join(', ');
        return forbid(res, `Forbidden. Requires one of: ${needed}`);
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * The HRMS authorization chain, in order, WITHOUT authentication.
 *
 * `hrms.routes.js` applies `protect` and then this. Exported as one array so
 * the composition lives in a single place and route-level tests can exercise
 * the real guards behind a stub authenticator, rather than re-declaring the
 * chain and testing a copy of it.
 */
export const hrmsAuthorizationChain = [attachHrmsActor, requireHrmsAccess];

/** Convenience for a route gated on holding any permission on a module. */
export function requireModule(module) {
  return (req, res, next) => {
    const actor = req.hrmsActor;
    if (!actor || !actor.permissions.some((g) => g.module === module)) {
      return forbid(res, `Forbidden. No access to ${module}.`);
    }
    return next();
  };
}

export default {
  attachHrmsActor,
  requireHrmsAccess,
  requirePermission,
  requireModule,
  setEmployeeResolver,
  registerResourceResolver,
};
