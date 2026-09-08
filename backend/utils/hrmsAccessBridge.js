/**
 * The one place the portal role model and the HRMS role model meet.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHY IT IS A TRANSLATION RATHER THAN A MERGE
 * ---------------------------------------------------------------------------
 *
 * The portal answers flat capability strings; HRMS answers module x action x
 * scope. AD-3 kept them apart because they are different shapes with different
 * semantics, and forcing one function to answer both would make every call site
 * ambiguous. That reasoning still holds, so this file does NOT merge them.
 *
 * It does exactly one thing: given a user, it says which HRMS ROLE KEYS their
 * portal access implies. Everything downstream is unchanged - the keys go into
 * the same `buildHrmsActor()` that has always derived grants, against the same
 * matrix, checked by the same guard. HRMS still decides what an
 * `hrms_payroll_admin` may do; the portal now decides who is one.
 *
 * That is the difference between integrating the two systems and rewriting one
 * of them, and it is why no HRMS business logic is touched by this feature.
 *
 * ---------------------------------------------------------------------------
 * ADDITIVE, IN BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * The implied keys are UNIONED with whatever `User.roles[]` already holds. An
 * employee who was given `hrms_employee` through their employee record keeps
 * exactly the access they had, whether or not their portal role says anything
 * about HRMS. Nothing here can take an HRMS role away - the union has no
 * subtracting half - so every existing HRMS account behaves identically to the
 * day before this shipped.
 *
 * ---------------------------------------------------------------------------
 * AD-4 SURVIVES, AND IT SURVIVES FOR FREE
 * ---------------------------------------------------------------------------
 *
 * A Customer must never hold an HRMS role. Nothing in this file checks for
 * that, and it does not need to: the keys below live outside the
 * `customer_portal` module, and `resolveUserPermissions()` filters a
 * portal-only role's permissions down to PORTAL_KEYS as its last step. A
 * Customer therefore cannot resolve `access_hrms` no matter what the matrix, a
 * per-user extra grant or a mistake says - so there is nothing here for the
 * bridge to imply.
 *
 * The fence is enforced where it was already enforced, rather than restated
 * here where it could drift.
 */

import { PERMISSIONS } from '../config/permissions.js';
import { HRMS_ROLES, HRMS_ROLE_LIST } from '../shared/permissions/constants.js';
import { resolveUserPermissions, setHas } from './roleResolver.js';

/**
 * Portal permission key -> the HRMS role keys it means.
 *
 * Ordered widest-last only for readability; the lookup is a union, so a role
 * holding several tiers holds all of them and `permissionsForHrmsRoles()`
 * deduplicates the overlap.
 *
 * ADMINISTER_HRMS IS EVERY ROLE, NOT JUST `hrms_super_admin`.
 *
 * That looks redundant and is not. `hrms_super_admin` is the widest SINGLE
 * role, but it is not the union: seven module keys are reachable only through
 * the specialists who own them -
 *
 *     helpdesk:hr  helpdesk:payroll  helpdesk:it
 *     reports:payroll  reports:team  reports:hiring  reports:assets
 *
 * - and four of those are exactly what REPORTS_ENTRY_GRANTS gates HR Reports
 * on. Mapping this tier to the one role would have given HR a system that is
 * "full access" everywhere except the report catalogue, which is not what
 * "complete HRMS functionality" means and is the kind of gap nobody finds until
 * somebody needs a payroll report.
 *
 * It also makes HR identical to Admin and Super Admin rather than merely
 * similar: the wildcard satisfies all eight keys below, so a role holding this
 * one key comes away with the same set.
 */
export const HRMS_ACCESS_TIERS = Object.freeze([
  [PERMISSIONS.ACCESS_HRMS, [HRMS_ROLES.EMPLOYEE]],
  [PERMISSIONS.MANAGE_HRMS_TEAM, [HRMS_ROLES.MANAGER]],
  [PERMISSIONS.MANAGE_HRMS_PEOPLE, [HRMS_ROLES.HR_ADMIN]],
  [PERMISSIONS.MANAGE_HRMS_PAYROLL, [HRMS_ROLES.PAYROLL_ADMIN]],
  [PERMISSIONS.MANAGE_HRMS_HIRING, [HRMS_ROLES.RECRUITER]],
  [PERMISSIONS.MANAGE_HRMS_ASSETS, [HRMS_ROLES.IT_ADMIN]],
  [PERMISSIONS.AUDIT_HRMS, [HRMS_ROLES.AUDITOR]],
  [PERMISSIONS.ADMINISTER_HRMS, [...HRMS_ROLE_LIST]],
]);

/**
 * The HRMS role keys this user's PORTAL access implies.
 *
 * Synchronous, because `resolveUserPermissions` is a cache read - see the note
 * at the top of roleResolver.js. `attachHrmsActor` is already async for the
 * employee lookup, but this must stay cheap enough to run on requests that skip
 * that lookup entirely.
 *
 * A wildcard role ('*' - Super Admin, Admin, or any role marked unrestricted)
 * satisfies every key through `setHas`, so it comes away holding
 * `hrms_super_admin`. That is the requirement, and it is the reversal of AD-3
 * written out in config/permissions.js on the HR role.
 *
 * @param {object|null} user  a User document or lean object
 * @returns {string[]} `hrms_*` keys, possibly empty
 */
export const impliedHrmsRoleKeys = (user) => {
  if (!user) return [];

  const permissions = resolveUserPermissions(user);
  if (!permissions.length) return [];

  const keys = new Set();
  for (const [permission, roleKeys] of HRMS_ACCESS_TIERS) {
    if (setHas(permissions, permission)) {
      for (const key of roleKeys) keys.add(key);
    }
  }
  return [...keys];
};

/**
 * Every HRMS role key this user holds: the explicit ones on `User.roles[]` plus
 * the implied ones, deduplicated.
 *
 * Returned WITHOUT filtering out portal keys - `buildHrmsActor()` does that
 * itself with `isHrmsRoleKey`, and duplicating the filter here would be a
 * second copy of AD-4's structural half.
 *
 * @param {object|null} user
 * @returns {string[]}
 */
export const effectiveHrmsRoleKeys = (user) => {
  const explicit = Array.isArray(user?.roles) ? user.roles : [];
  return [...new Set([...explicit, ...impliedHrmsRoleKeys(user)])];
};

export default {
  HRMS_ACCESS_TIERS,
  impliedHrmsRoleKeys,
  effectiveHrmsRoleKeys,
};
