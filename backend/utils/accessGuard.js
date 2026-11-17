import User from '../models/User.js';
import { resolveUserPermissions, resolveRolePermissions, getCachedRole } from './roleResolver.js';

/**
 * Who may hand out access, and to whom. Shared by both portals (identical
 * file), used by every endpoint that assigns a role, edits a role's matrix,
 * grants extra access, or acts on another account.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The route guards answer "may this actor use user management / role
 * management at all". They never asked WHAT the actor was handing out, so:
 *
 *   - anyone who could edit users could set any account's role to Super Admin,
 *     including their own;
 *   - anyone who could edit roles could tick every cell on their OWN role;
 *   - an account administrator could reset a Super Admin's password and sign in
 *     as them.
 *
 * ---------------------------------------------------------------------------
 * THE RULES
 * ---------------------------------------------------------------------------
 *
 *   1. YOU CANNOT GIVE WHAT YOU DO NOT HOLD. A role assigned, a cell ticked on
 *      a role, or an extra grant must resolve to keys the actor holds.
 *   2. YOU CANNOT RAISE YOURSELF. Your own role and your own role's matrix are
 *      changed by somebody else (an unrestricted actor excepted).
 *   3. FULL ACCESS IS GUARDED BY FULL ACCESS. Only an unrestricted actor (the
 *      '*' wildcard: Super Admin, Admin, or a role marked full-access) may
 *      assign such a role, change such an account, or edit such a role.
 *   4. THERE IS ALWAYS A SUPER ADMIN. The last active unrestricted account
 *      cannot be moved to a lesser role.
 *
 * Every check returns a problem `{ status, message, code }` or null, so each
 * controller keeps answering in its own response shape.
 */

const problem = (status, message, code) => ({ status, message, code });

/** Holds the wildcard, after role and extra grants are resolved. */
export const isUnrestricted = (user) => resolveUserPermissions(user).includes('*');

/** A role that resolves to the wildcard. */
export const isUnrestrictedRole = (roleName) => resolveRolePermissions(roleName).includes('*');

/**
 * The keys in `keys` the actor does not hold. Empty for an unrestricted actor.
 * '*' itself is always "beyond" a restricted actor.
 */
export const keysBeyond = (actor, keys) => {
  const mine = resolveUserPermissions(actor);
  if (mine.includes('*')) return [];
  return [...new Set(keys || [])].filter((key) => key && (key === '*' || !mine.includes(key)));
};

/**
 * A role fenced to the customer side: 'Customer', or any role marked
 * portal-only. Its access is a customer's own bookings and catalogue, scoped to
 * their own account everywhere it is read, so giving it is not giving a staff
 * member anything they lack - Sales creates customers without holding
 * create_order itself. Rule 1 is therefore not applied to it; rule 3 still is.
 */
export const isCustomerFencedRole = (roleName) =>
  roleName === 'Customer' || Boolean(getCachedRole(roleName)?.portalOnly);

const isSelf = (actor, target) => Boolean(target?._id && actor?._id && String(target._id) === String(actor._id));

const roleLabel = (name) => `"${name}"`;

/**
 * May `actor` act on `target`'s account at all (edit it, reset its password,
 * change its role or extra access)? Only rule 3 applies here: an account with
 * full access is changed only by somebody with full access.
 */
export const actOnAccountProblem = (actor, target) => {
  if (!target || isSelf(actor, target)) return null;
  if (isUnrestricted(target) && !isUnrestricted(actor)) {
    return problem(403, 'Only a Super Admin can change an account that has full system access.', 'TARGET_ABOVE_ACTOR');
  }
  return null;
};

/** How many OTHER active accounts hold full access. */
const otherUnrestrictedCount = async (excludeId) => {
  const roles = await User.distinct('role', { status: 'Active', ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
  const fullRoles = roles.filter((name) => name && isUnrestrictedRole(name));
  if (fullRoles.length === 0) return 0;
  return User.countDocuments({ status: 'Active', role: { $in: fullRoles }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
};

/**
 * May `actor` give `target` (null for a new account) the role `newRole`?
 * Assigning the role the account already has is not a change and passes.
 */
export const assignRoleProblem = async (actor, target, newRole) => {
  if (!newRole) return null;
  if (target && target.role === newRole) return null;

  const actorFull = isUnrestricted(actor);

  // Rule 2.
  if (target && isSelf(actor, target) && !actorFull) {
    return problem(403, 'You cannot change your own role. Ask another administrator.', 'SELF_ROLE_CHANGE');
  }

  // Rule 3, both directions: giving full access, and changing a full-access account.
  if (isUnrestrictedRole(newRole) && !actorFull) {
    return problem(403, `Only a Super Admin can assign the ${roleLabel(newRole)} role.`, 'ROLE_ABOVE_ACTOR');
  }
  const above = actOnAccountProblem(actor, target);
  if (above) return above;

  // Rule 1 (not for a customer-fenced role, see isCustomerFencedRole).
  const beyond = isCustomerFencedRole(newRole) ? [] : keysBeyond(actor, resolveRolePermissions(newRole));
  if (beyond.length) {
    return problem(
      403,
      `The ${roleLabel(newRole)} role includes access you do not hold yourself (${beyond.join(', ')}), so you cannot assign it.`,
      'ROLE_ABOVE_ACTOR',
    );
  }

  // Rule 4.
  if (target && isUnrestrictedRole(target.role) && !isUnrestrictedRole(newRole)) {
    if (await otherUnrestrictedCount(target._id) === 0) {
      return problem(409, 'This is the last active Super Admin account. Give another account full access first.', 'LAST_SUPER_ADMIN');
    }
  }
  return null;
};

/**
 * May `actor` take `target` out of service (suspend / deactivate)? The last
 * active full-access account cannot be, and a full-access account only by a
 * full-access actor.
 */
export const deactivateProblem = async (actor, target) => {
  if (!target) return null;
  if (isSelf(actor, target)) {
    return problem(403, 'You cannot suspend your own account.', 'SELF_DEACTIVATE');
  }
  const above = actOnAccountProblem(actor, target);
  if (above) return above;
  if (isUnrestrictedRole(target.role) && await otherUnrestrictedCount(target._id) === 0) {
    return problem(409, 'This is the last active Super Admin account and cannot be suspended.', 'LAST_SUPER_ADMIN');
  }
  return null;
};

/**
 * May `actor` save `keys` (the compiled matrix + flat list) onto `role`?
 *
 * `role` is the stored role (null when creating). Rule 2: not your own role.
 * Rule 3: a full-access role is edited only by a full-access actor. Rule 1:
 * only keys you hold.
 */
export const editRoleProblem = (actor, role, keys) => {
  if (isUnrestricted(actor)) return null;
  if (role && (role.name === actor?.role || role.slug === actor?.role)) {
    return problem(403, 'You cannot change the permissions of your own role. Ask another administrator.', 'SELF_ROLE_EDIT');
  }
  if (role && (role.isSuperAdmin || isUnrestrictedRole(role.name))) {
    return problem(403, 'Only a Super Admin can change a role with full system access.', 'ROLE_ABOVE_ACTOR');
  }
  const beyond = keysBeyond(actor, keys);
  if (beyond.length) {
    return problem(403, `You cannot grant access you do not hold yourself: ${beyond.join(', ')}.`, 'GRANT_ABOVE_ACTOR');
  }
  return null;
};

/** Send a problem in the shape every controller here already uses. */
export const sendProblem = (res, p) => res.status(p.status).json({ success: false, message: p.message, code: p.code });

export default {
  isCustomerFencedRole,
  isUnrestricted,
  isUnrestrictedRole,
  keysBeyond,
  actOnAccountProblem,
  assignRoleProblem,
  deactivateProblem,
  editRoleProblem,
  sendProblem,
};
