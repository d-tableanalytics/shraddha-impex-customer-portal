import Role from '../models/Role.js';
import { currentPortal } from '../config/portal.js';
import {
  MODULES,
  servesPortal,
  compileGrants,
  availableActions,
  keysForGrant,
} from '../config/moduleRegistry.js';
import {
  BASELINE_ROLE_PERMISSIONS,
  baselineFor,
  isSuperAdminRoleName,
  isPortalOnlyRoleName,
} from '../config/permissions.js';

/**
 * Turns a role into the flat permission set the rest of the code enforces.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SYNCHRONOUS CACHE AND NOT AN AWAIT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * hasPermission(user, key) is called synchronously in ~25 controllers, often
 * inside a map over query results:
 *
 *     const seesEverything = hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS);
 *
 * Making permissions database-backed the obvious way - `await Role.findOne()`
 * inside the check - would require making all of those async, which means
 * touching every controller that calls them and every function that calls
 * those. It would also put a database round trip on the hot path of a request
 * that already has its answer.
 *
 * So the roles table is mirrored in memory. It is small (single-digit rows), it
 * changes only when a Super Admin saves the matrix, and every write path in
 * role.controller.js refreshes it before responding. Reads stay synchronous and
 * free, and the ~145 existing call sites keep the exact signature they had.
 *
 * The cache is authoritative only for the ADDITIVE half of the answer. The
 * baseline (config/permissions.js) is compiled into the process, so even a
 * completely empty or unreachable roles collection leaves every built-in role
 * working exactly as it did before this system existed. A database problem
 * cannot lock the business out of its own ERP; at worst it freezes permissions
 * at the baseline until the next successful load.
 */

// ── Cache ──────────────────────────────────────────────────────────────────

/** name -> plain role document */
let rolesByName = new Map();
/** id (string) -> plain role document */
let rolesById = new Map();
/** name -> frozen array of resolved permission keys */
let resolvedByName = new Map();

let loadedAt = null;

/** Every flat key a module or sub-module list can reach. */
const keysOf = (modules) => {
  const keys = new Set();
  for (const mod of modules) {
    for (const sub of mod.submodules || []) {
      for (const action of availableActions(sub)) {
        for (const key of sub.actions[action]) keys.add(key);
      }
    }
  }
  return keys;
};

/**
 * Every flat key reachable from inside the customer_portal MODULE.
 *
 * The ceiling a `portalOnly` ROLE is held to — a Customer account, or any role
 * a Super Admin marks portal-only. Distinct from PORTAL_MODULE_KEYS below, and
 * the two are easy to confuse:
 *
 *   CUSTOMER_MODULE_KEYS  a property of the ROLE. A Customer is fenced into the
 *                         customer_portal module wherever they sign in.
 *   PORTAL_MODULE_KEYS    a property of the DEPLOYMENT. Nobody, whatever their
 *                         role, sees another domain's modules from here.
 *
 * Both are computed from the registry rather than listed by hand, so a
 * sub-module added later lands inside or outside each fence automatically.
 */
const CUSTOMER_MODULE_KEYS = keysOf(MODULES.filter((m) => m.key === 'customer_portal'));

/**
 * Every flat key this DEPLOYMENT's portal is allowed to serve, per portal.
 *
 * Computed once per portal and cached, because `resolveUserPermissions` runs on
 * every authenticated request and must not be walking the registry each time.
 *
 * Sub-modules narrow: `administration` is served by both portals, but its
 * `roles` sub-module is employee-only and its `customers` sub-module is
 * customer-only — so a key reachable ONLY through a sub-module the current
 * portal does not serve is outside the fence even though its parent module is
 * inside it.
 */
const PORTAL_KEY_CACHE = new Map();

const portalKeys = (portal) => {
  if (PORTAL_KEY_CACHE.has(portal)) return PORTAL_KEY_CACHE.get(portal);
  const keys = new Set();
  for (const mod of MODULES) {
    if (!servesPortal(mod, portal)) continue;
    for (const sub of mod.submodules || []) {
      // A sub-module inherits its module's portals unless it names its own.
      if (!servesPortal({ portals: sub.portals ?? mod.portals }, portal)) continue;
      for (const action of availableActions(sub)) {
        for (const key of sub.actions[action]) keys.add(key);
      }
    }
  }
  PORTAL_KEY_CACHE.set(portal, keys);
  return keys;
};

// ── Loading ────────────────────────────────────────────────────────────────

/**
 * Refresh the mirror from the database.
 *
 * Never throws. A role lookup failing is not a reason to fail the request that
 * triggered it - the baseline still answers every built-in role - so the error
 * is logged and the previous snapshot is kept.
 */
export const loadRoles = async () => {
  try {
    const roles = await Role.find().lean();

    const byName = new Map();
    const byId = new Map();
    for (const role of roles) {
      byName.set(role.name, role);
      if (role.slug) byName.set(role.slug, role);
      byId.set(String(role._id), role);
    }

    rolesByName = byName;
    rolesById = byId;
    resolvedByName = new Map(); // recompute lazily against the new snapshot
    loadedAt = new Date();
    return roles.length;
  } catch (error) {
    console.error(`[RBAC] Could not refresh the role cache: ${error.message}`);
    console.error('[RBAC] Continuing on the previous snapshot; baseline permissions are unaffected.');
    return null;
  }
};

/** Drop the computed sets without re-reading the database. */
export const invalidateResolved = () => {
  resolvedByName = new Map();
};

export const cacheStatus = () => ({
  loadedAt,
  roles: rolesById.size,
});

export const getCachedRole = (nameOrSlug) => rolesByName.get(nameOrSlug) || null;
export const getCachedRoleById = (id) => (id ? rolesById.get(String(id)) || null : null);

/**
 * Every role name an account may be given: the built-in ones, plus whatever the
 * Super Admin has created.
 *
 * This is why User.role is validated against a function rather than a fixed
 * enum. An enum cannot grow at runtime, and a role model whose whole purpose is
 * that the Super Admin can invent roles is not much use if inventing one
 * produces a role nobody can be assigned to.
 *
 * The built-in names are listed FIRST and unconditionally, so an account can
 * always be given a real role even if the cache is cold or the roles collection
 * is unreachable.
 */
export const assignableRoleNames = () => {
  const names = new Set(Object.keys(BASELINE_ROLE_PERMISSIONS));
  for (const role of rolesById.values()) names.add(role.name);
  return [...names];
};

export const isAssignableRoleName = (name) =>
  Object.prototype.hasOwnProperty.call(BASELINE_ROLE_PERMISSIONS, name)
  || [...rolesById.values()].some((role) => role.name === name);

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Is this role fenced into the Customer Portal?
 *
 * Either source is sufficient, and the compiled-in one is checked first so the
 * answer does not depend on a database read having succeeded.
 */
const isPortalOnly = (roleName, roleDoc) =>
  isPortalOnlyRoleName(roleName) || !!roleDoc?.portalOnly;

/**
 * The permission set for a role NAME, cached.
 *
 * The union is deliberately one-directional - baseline, then grants, then the
 * legacy flat list, and nothing subtracts. See the note on BASELINE in
 * config/permissions.js for why revocation is a code change rather than a
 * checkbox.
 */
export const resolveRolePermissions = (roleName) => {
  if (!roleName) return [];

  const cached = resolvedByName.get(roleName);
  if (cached) return cached;

  const role = rolesByName.get(roleName) || null;
  const baseline = baselineFor(roleName);

  // Unrestricted, by either route: one of the two built-in super-admin names,
  // or a role a Super Admin has marked as such. Short-circuited before any
  // ceiling is applied - '*' is the answer authorize() has always understood.
  if (baseline.includes('*') || isSuperAdminRoleName(roleName) || role?.isSuperAdmin) {
    const wildcard = Object.freeze(['*']);
    resolvedByName.set(roleName, wildcard);
    return wildcard;
  }

  const permissions = new Set(baseline);

  if (role) {
    for (const key of compileGrants(role.grants)) permissions.add(key);
    for (const key of role.permissions || []) {
      // '*' is not grantable through the matrix or the legacy list. Promoting a
      // role to unrestricted is what isSuperAdmin is for, and it is a separate,
      // visible decision rather than a string somebody can paste into an array.
      if (key && key !== '*') permissions.add(key);
    }
  }

  // Requirement 1: a portal-only role cannot hold anything outside the Customer
  // Portal, whatever the matrix was told. Applied last so it constrains the
  // grants and the legacy list alike.
  //
  // Asked of the COMPILED-IN list first and the database row second. The
  // database answer is the one a Super Admin can set on a role they invented;
  // the compiled-in one is the one that still holds when the roles collection
  // is empty or unreachable, which is precisely when a fence that quietly
  // disappears would do the most damage.
  const bounded = isPortalOnly(roleName, role)
    ? [...permissions].filter((key) => CUSTOMER_MODULE_KEYS.has(key))
    : [...permissions];

  const frozen = Object.freeze(bounded);
  resolvedByName.set(roleName, frozen);
  return frozen;
};

/**
 * The permission set for a USER.
 *
 * Two sources:
 *
 *   1. their role - baseline plus whatever that role's matrix grants. This
 *      resolves custom roles too: `user.role` holds the role's NAME, and the
 *      cache is indexed by name, so a role the Super Admin invented needs no
 *      special handling here.
 *   2. per-user extra grants (requirement 4), for the one person who needs one
 *      more thing than their role gives them.
 *
 * The second ADDS to the first and never subtracts, so an account always holds
 * at least what its role advertises. Taking something away is done by changing
 * the role, where it is visible to whoever reviews the matrix next - not by a
 * per-user exception nobody will think to look for.
 */
export const resolveUserPermissions = (user) => {
  if (!user) return [];

  const rolePerms = resolveRolePermissions(user.role);

  /*
   * THE WILDCARD IS NOT FENCED HERE, AND THAT IS CORRECT.
   *
   * '*' means "unrestricted", and `setHas` reads it as satisfying every key.
   * Filtering it would be meaningless — there is no subset of a wildcard — and
   * removing it would strip a Super Admin of everything.
   *
   * What stops a Super Admin reaching another domain's modules is not this
   * function: it is that this deployment does not MOUNT them (an employee route
   * simply 404s here), plus `requirePortalModule` on anything that is mounted
   * but domain-scoped. The menu is filtered separately in `menuFor`, so an
   * unrestricted account still sees only this domain's navigation.
   */
  if (rolePerms.includes('*')) return rolePerms;

  const extras = user.extraGrants || [];

  const permissions = new Set(extras.length ? rolePerms : rolePerms);
  for (const key of compileGrants(extras)) permissions.add(key);

  /*
   * TWO FENCES, applied in order. They answer different questions and a user
   * can be caught by either.
   *
   *   1. THE ROLE fence. A `portalOnly` role — a Customer, or any role a Super
   *      Admin marks as such — is held to the customer_portal module wherever
   *      they sign in. It follows the USER, not just the role name, so extra
   *      grants given by mistake cannot add past it.
   *   2. THE DOMAIN fence. Nobody, whatever their role, comes away holding a
   *      key this deployment's portal does not serve. That is what makes the
   *      same account see different capabilities on the two domains.
   */
  let bounded = [...permissions];
  if (isPortalOnly(user.role, rolesByName.get(user.role))) {
    bounded = bounded.filter((key) => CUSTOMER_MODULE_KEYS.has(key));
  }
  const domain = portalKeys(currentPortal());
  return bounded.filter((key) => domain.has(key));
};

// ── Questions the rest of the system asks ──────────────────────────────────

/** Does this permission set satisfy `key`? Understands the wildcard. */
export const setHas = (permissions, key) =>
  permissions.includes('*') || permissions.includes(key);

/**
 * May this user take `action` on this sub-module?
 *
 * The matrix-shaped question, for code that would rather ask
 * `can(user, 'inventory', 'counts', 'approve')` than remember which flat key
 * that is. Both forms are the same check - this one just resolves the cell to
 * its keys first.
 *
 * An action with no keys behind it is refused. A cell that grants nothing must
 * not read as permission to do the thing.
 */
export const can = (user, moduleKey, submoduleKey, action) => {
  const keys = keysForGrant(moduleKey, submoduleKey, action);
  if (!keys.length) return false;
  const permissions = resolveUserPermissions(user);
  return keys.every((key) => setHas(permissions, key));
};

/**
 * The navigation tree this user may see - requirement 6, and the data behind
 * the dynamic sidebar.
 *
 * Only sub-modules that HAVE a path and are not `hidden` appear: the
 * capability-only entries (stock receipts, box numbers) are permissions rather
 * than destinations, and a hidden one is a screen that exists but is not ready
 * to be advertised. A module with no visible sub-module is dropped entirely
 * rather than rendered as an empty heading.
 */
export const menuFor = (user) => {
  const permissions = resolveUserPermissions(user);

  const portal = currentPortal();

  return [...MODULES]
    // The DOMAIN fence. A module this deployment does not serve never reaches
    // the menu, whatever the account holds — so an HR admin signing into the
    // customer domain sees the customer modules and no trace of HRMS.
    .filter((mod) => servesPortal(mod, portal))
    .sort((a, b) => a.order - b.order)
    .map((mod) => ({
      key: mod.key,
      label: mod.label,
      icon: mod.icon,
      order: mod.order,
      items: mod.submodules
        // Sub-modules narrow: Roles & Permissions is employee-only inside an
        // administration module both portals serve.
        .filter((sub) => servesPortal({ portals: sub.portals ?? mod.portals }, portal))
        .filter((sub) => sub.path && !sub.hidden)
        .filter((sub) => {
          const keys = sub.actions?.view;
          if (!Array.isArray(keys) || !keys.length) return false;
          // ANY, not every: two audiences reach the booking screens by two
          // different keys, and requiring both would hide them from each.
          return keys.some((key) => setHas(permissions, key));
        })
        .map((sub) => ({
          key: sub.key,
          label: sub.label,
          path: sub.path,
          icon: sub.icon,
          actions: availableActions(sub).filter((action) =>
            sub.actions[action].every((key) => setHas(permissions, key)),
          ),
        })),
    }))
    .filter((mod) => mod.items.length > 0);
};

/**
 * The user's own access, in matrix form - what the "my permissions" half of
 * /auth/me returns so a screen can grey out an Edit button without keeping its
 * own copy of the registry.
 */
export const grantsForUser = (user) => {
  const permissions = resolveUserPermissions(user);
  const grants = [];

  for (const mod of MODULES) {
    for (const sub of mod.submodules) {
      const actions = availableActions(sub).filter((action) =>
        sub.actions[action].every((key) => setHas(permissions, key)),
      );
      if (actions.length) grants.push({ module: mod.key, submodule: sub.key, actions });
    }
  }

  return grants;
};

export default {
  loadRoles,
  invalidateResolved,
  cacheStatus,
  getCachedRole,
  getCachedRoleById,
  assignableRoleNames,
  isAssignableRoleName,
  resolveRolePermissions,
  resolveUserPermissions,
  setHas,
  can,
  menuFor,
  grantsForUser,
};
