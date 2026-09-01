/**
 * The canonical HRMS permission evaluator.
 *
 * One implementation, used by the Express guard, the React nav filter and the
 * route gate. Backend enforcement and frontend affordances can therefore never
 * disagree - which is the failure the hand-mirrored `middlewares/rbac.js` /
 * `utils/permissions.js` pair used to be exposed to.
 *
 * Ported from the DTA HRMS reference (`packages/rbac/src/has-permission.ts`).
 * Dependency-free (see ../README.md).
 */

import { SCOPE_RANK, SCOPES, isHrmsRoleKey } from './constants.js';
import { permissionsForHrmsRoles } from './matrix.js';

/**
 * @typedef {Object} HrmsActor
 * @property {string|null}  userId
 * @property {string|null}  employeeId
 * @property {string|null}  departmentId
 * @property {string[]}     managerChain  Ancestor manager employee ids, nearest first.
 * @property {string[]}     roleKeys      HRMS role keys only (`hrms_*`).
 * @property {Array<{module:string,action:string,scope:string}>} permissions
 */

/**
 * @typedef {Object} ResourceContext
 * @property {string} [ownerUserId]
 * @property {string} [ownerEmployeeId]
 * @property {string[]} [ownerManagerChain]
 * @property {string} [ownerDepartmentId]
 */

/** An actor with no HRMS roles and no grants. The safe default everywhere. */
export const ANONYMOUS_HRMS_ACTOR = Object.freeze({
  userId: null,
  employeeId: null,
  departmentId: null,
  managerChain: Object.freeze([]),
  roleKeys: Object.freeze([]),
  permissions: Object.freeze([]),
});

/**
 * Build an HRMS actor from a user document plus its employee record.
 *
 * AD-4 is enforced here, at the single point where grants are derived:
 * only keys that pass `isHrmsRoleKey` contribute permissions. A portal role -
 * `Admin`, `Sales`, `Customer` - contributes nothing, so authentication alone
 * can never yield an HRMS grant.
 *
 * @param {Object}  input
 * @param {string}  [input.userId]
 * @param {string[]}[input.roles]       Raw `User.roles[]`, portal and HRMS keys mixed.
 * @param {string}  [input.legacyRole]  `User.role`. Never contributes HRMS grants.
 * @param {Object}  [input.employee]    `{ id, departmentId, managerChain }`, if any.
 * @returns {HrmsActor}
 */
export function buildHrmsActor({ userId = null, roles = [], legacyRole = null, employee = null } = {}) {
  // `legacyRole` is accepted so callers can pass a whole user object without
  // filtering first, and is then deliberately ignored - see AD-4 above.
  void legacyRole;

  const roleKeys = (Array.isArray(roles) ? roles : []).filter(isHrmsRoleKey);

  return {
    userId: userId ? String(userId) : null,
    employeeId: employee?.id ? String(employee.id) : null,
    departmentId: employee?.departmentId ? String(employee.departmentId) : null,
    managerChain: (employee?.managerChain ?? []).map(String),
    roleKeys,
    permissions: permissionsForHrmsRoles(roleKeys),
  };
}

/**
 * May `actor` perform (module, action) at `requiredScope` on `resource`?
 *
 * `resource` matters only for `self`, `team` and `department` scopes. For an
 * `org`-scope requirement it is ignored.
 *
 * @param {HrmsActor} actor
 * @param {string} module
 * @param {string} action
 * @param {string} requiredScope
 * @param {ResourceContext} [resource]
 * @returns {boolean}
 */
export function hasHrmsPermission(actor, module, action, requiredScope, resource) {
  if (!actor || !Array.isArray(actor.permissions) || actor.permissions.length === 0) return false;
  if (!(requiredScope in SCOPE_RANK)) return false;

  const required = SCOPE_RANK[requiredScope];

  const matching = actor.permissions.filter((g) => g.module === module && g.action === action);
  if (matching.length === 0) return false;

  return matching.some((g) => {
    const granted = SCOPE_RANK[g.scope];
    if (granted === undefined || granted < required) return false;
    return scopeCovers(actor, g.scope, requiredScope, resource);
  });
}

/**
 * Given the granted scope and the required scope, does the concrete resource
 * fall inside the actor's reach?
 */
function scopeCovers(actor, grantedScope, requiredScope, resource) {
  if (grantedScope === SCOPES.ORG) return true;

  if (grantedScope === SCOPES.DEPARTMENT) {
    if (requiredScope === SCOPES.ORG) return false;
    // No resource means a collection-level request; the query layer narrows it.
    if (!resource?.ownerDepartmentId) return true;
    return String(resource.ownerDepartmentId) === String(actor.departmentId);
  }

  if (grantedScope === SCOPES.TEAM) {
    if (requiredScope === SCOPES.ORG || requiredScope === SCOPES.DEPARTMENT) return false;
    return isInTeamOf(actor, resource);
  }

  // self
  if (requiredScope !== SCOPES.SELF) return false;
  return isSelf(actor, resource);
}

function isSelf(actor, resource) {
  // No resource: the actor is asking about their own bucket (`/leave/mine`).
  //
  // TRAP: a handler that omits the resource on a route which CAN address another
  // person's record turns a self-scope check into a pass. Any route with an id
  // parameter must resolve and pass the resource - which is what the
  // `requirePermission` middleware's `resourceParam` option exists to do.
  if (!resource) return true;
  if (resource.ownerUserId && actor.userId && String(resource.ownerUserId) === String(actor.userId)) return true;
  if (
    resource.ownerEmployeeId &&
    actor.employeeId &&
    String(resource.ownerEmployeeId) === String(actor.employeeId)
  ) {
    return true;
  }
  return false;
}

function isInTeamOf(actor, resource) {
  // No resource: a team-scoped listing. The repository must filter by
  // managerChain - the same trap as isSelf above.
  if (!resource) return true;
  if (isSelf(actor, resource)) return true;
  if (!actor.employeeId) return false;
  const chain = resource.ownerManagerChain ?? [];
  return chain.map(String).includes(String(actor.employeeId));
}

/**
 * Does the actor hold ANY permission on the module? Used by the nav filter and
 * the route gate to decide whether a screen is reachable at all.
 */
export function canAccessHrmsModule(actor, module) {
  if (!actor || !Array.isArray(actor.permissions)) return false;
  return actor.permissions.some((g) => g.module === module);
}

/** Does the actor hold any HRMS access whatsoever? The AD-4 top-level gate. */
export function hasAnyHrmsAccess(actor) {
  return Boolean(actor && Array.isArray(actor.permissions) && actor.permissions.length > 0);
}

/** ANY-OF evaluation across several specs. Mirrors the guard's semantics. */
export function hasAnyHrmsPermission(actor, specs = [], resource) {
  return specs.some((s) => hasHrmsPermission(actor, s.module, s.action, s.scope, resource));
}

export { SCOPES, SCOPE_RANK };
