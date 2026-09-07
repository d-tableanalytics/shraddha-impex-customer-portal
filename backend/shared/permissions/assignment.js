/**
 * Role-assignment rules (AD-3, AD-4).
 *
 * Deciding WHICH roles a given account may hold is separate from evaluating
 * what a role can do. It lives here so the Mongoose schema, the user
 * controller, the import pipeline and the frontend all apply the same rule.
 *
 * Dependency-free.
 */

import { HRMS_ROLE_LIST, isHrmsRoleKey } from './constants.js';
import { LEGACY_ROLE_LIST } from './legacy.js';

/** The portal role that must never coexist with HRMS access (AD-4). */
export const CUSTOMER_ROLE = 'Customer';

/** Every role key that may legitimately appear in `User.roles[]`. */
export const ASSIGNABLE_ROLE_KEYS = Object.freeze([...LEGACY_ROLE_LIST, ...HRMS_ROLE_LIST]);

export const isAssignableRoleKey = (key) => ASSIGNABLE_ROLE_KEYS.includes(key);

/**
 * Thrown when a role assignment would violate AD-4. Carries a `code` so the
 * HTTP layer can map it to 409 without string-matching the message.
 */
export class RoleAssignmentError extends Error {
  constructor(message, code = 'ROLE_ASSIGNMENT_INVALID') {
    super(message);
    this.name = 'RoleAssignmentError';
    this.code = code;
  }
}

/**
 * Validate a `(role, roles[])` pair before it is written.
 *
 * Rules:
 *   1. Every key must be a known role.
 *   2. AD-4 - a Customer may hold no HRMS role. This is the invariant that
 *      keeps a customer out of payroll on a shared login (AD-14), so it is
 *      checked on every write path rather than trusted to the caller.
 *
 * `portalOnly` is supplied by the CALLER because the answer now depends on the
 * database: a Super Admin can mark any role they invent as portal-only, and
 * this module is dependency-free so it cannot ask. The compiled-in
 * `CUSTOMER_ROLE` check stays as the floor that holds without it - see
 * `backend/utils/hrmsRoleGuard.js`, which every backend write path uses to
 * supply the flag.
 *
 * @param {string}   role   the portal role (`User.role`)
 * @param {string[]} roles  the multi-role array (`User.roles`)
 * @param {object}   [options]
 * @param {boolean}  [options.portalOnly]  true when `role` is fenced into the
 *   customer portal by the live role model, whatever it is called
 * @throws {RoleAssignmentError}
 */
export function assertRolesAssignable(role, roles = [], { portalOnly = false } = {}) {
  const list = Array.isArray(roles) ? roles : [];

  const unknown = list.filter((k) => !isAssignableRoleKey(k));
  if (unknown.length > 0) {
    throw new RoleAssignmentError(
      `Unknown role key(s): ${unknown.join(', ')}`,
      'ROLE_UNKNOWN',
    );
  }

  const hrmsRoles = list.filter(isHrmsRoleKey);
  if ((portalOnly || role === CUSTOMER_ROLE) && hrmsRoles.length > 0) {
    throw new RoleAssignmentError(
      `A ${role} account is confined to the customer portal and cannot hold HRMS roles ` +
        `(${hrmsRoles.join(', ')}). Customer and Employee are mutually exclusive.`,
      'CUSTOMER_CANNOT_HOLD_HRMS_ROLE',
    );
  }

  return true;
}

/** Non-throwing form, for UI affordances. */
export function canAssignRoles(role, roles = [], options) {
  try {
    assertRolesAssignable(role, roles, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * The HRMS roles an account is permitted to hold, given its portal role.
 * A Customer gets an empty list - there is nothing valid to offer.
 */
export function assignableHrmsRolesFor(role) {
  return role === CUSTOMER_ROLE ? [] : [...HRMS_ROLE_LIST];
}

/** Does this account have any HRMS role at all? */
export const hasHrmsRole = (user) =>
  Array.isArray(user?.roles) && user.roles.some(isHrmsRoleKey);
