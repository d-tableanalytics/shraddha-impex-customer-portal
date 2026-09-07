/**
 * AD-4, widened for the database-driven role model.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * AD-4 says Customer and Employee are mutually exclusive: an account fenced
 * into the customer portal may hold no HRMS role. That was expressible as
 * `role === 'Customer'` while `Customer` was the only such role and the list of
 * roles was a fixed enum.
 *
 * It is not any more. A Super Admin can now invent roles, and mark any of them
 * `portalOnly` — at which point the resolver holds them to the customer-portal
 * ceiling exactly as it holds `Customer`. A rule that names only `Customer`
 * would let an account on a role called `Dealer`, fenced into the portal by
 * every other measure, be handed `hrms_employee` and reach payroll.
 *
 * So the rule became: A PORTAL-ONLY ROLE CANNOT HOLD AN HRMS ROLE — asked of
 * the same two sources the portal resolver asks, in the same order:
 *
 *   1. the compiled-in PORTAL_ONLY_ROLES, which still answers on a cold cache
 *      or an unreachable roles collection — precisely when a fence that
 *      quietly disappears would do the most damage
 *   2. the `portalOnly` flag on the Role document, which is the half a Super
 *      Admin can set
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS HERE AND NOT IN shared/permissions/assignment.js
 * ---------------------------------------------------------------------------
 * `shared/permissions/` is dependency-free on purpose: the frontend imports it
 * through the `@shared` alias, and it cannot reach a Mongoose model or the role
 * cache. `assertRolesAssignable` therefore keeps its compiled-in Customer rule
 * and now accepts a `portalOnly` flag the caller supplies; this module is the
 * backend caller that knows how to compute it.
 *
 * Every backend path that can put an `hrms_*` key on an account goes through
 * here: the User schema hook, `assignEmployeeRoles`, `updateUserRole` and
 * `updateUserAccess`. The hook alone is not enough — Mongoose does not run
 * document validation for `findOneAndUpdate`, which several of those paths use.
 */

import { isPortalOnlyRoleName } from '../config/permissions.js';
import { getCachedRole } from './roleResolver.js';
import { assertRolesAssignable } from '../shared/permissions/assignment.js';

/**
 * Is this portal role fenced into the customer portal?
 *
 * Compiled-in list first, database flag second — the same order and the same
 * reasoning as `isPortalOnly` in the role resolver.
 *
 * @param {string} roleName
 * @returns {boolean}
 */
export const isPortalOnlyRole = (roleName) =>
  isPortalOnlyRoleName(roleName) || Boolean(getCachedRole(roleName)?.portalOnly);

/**
 * Validate a `(portal role, roles[])` pair before it is written.
 *
 * Identical to `assertRolesAssignable`, with the portal-only question answered
 * from the live role model rather than from a hardcoded name.
 *
 * @param {string}   roleName  `User.role`
 * @param {string[]} roles     `User.roles[]`
 * @throws {RoleAssignmentError}
 */
export function assertHrmsRolesAssignable(roleName, roles = []) {
  return assertRolesAssignable(roleName, roles, {
    portalOnly: isPortalOnlyRole(roleName),
  });
}

export default { isPortalOnlyRole, assertHrmsRolesAssignable };
