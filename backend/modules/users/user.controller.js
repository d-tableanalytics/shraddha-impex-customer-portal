import User from '../../models/User.js';
import ArchivedUser from '../../models/ArchivedUser.js';
import { hasPermission, PERMISSIONS } from '../../middlewares/rbac.js';
import { RoleAssignmentError } from '../../shared/permissions/assignment.js';
import { isHrmsRoleKey } from '../../shared/permissions/constants.js';
// AD-4, asked of the LIVE role model rather than the literal name 'Customer'.
import { assertHrmsRolesAssignable } from '../../utils/hrmsRoleGuard.js';
import { hashPassword } from '../../utils/password.js';
import {
  assignableRoleNames,
  resolveUserPermissions,
  grantsForUser,
} from '../../utils/roleResolver.js';
import { validateGrants, compileGrants } from '../../config/moduleRegistry.js';

/**
 * Roles an admin may assign.
 *
 * Asked of the role resolver rather than read off a schema enum, because the
 * set is no longer fixed: a Super Admin can create roles, and one that cannot
 * be assigned to anybody is not a role. The resolver answers with the built-in
 * names plus every role that actually exists, and the User model validates
 * against the same function - so the check here and the check at save time
 * cannot disagree.
 *
 * A FUNCTION, not a constant. The old version was evaluated once at import; a
 * role created five minutes into the process's life would have been rejected
 * as unknown until the next restart.
 */
const assignableRoles = () => assignableRoleNames();

/**
 * Customer master details — captured at creation, never editable afterwards.
 *
 * These identify the legal entity we trade with. A GST or shop number changing
 * on a live account means it is a different customer, and rewriting it in place
 * would leave every past booking attributed to a record that no longer matches
 * what was agreed.
 *
 * Kept out of ALLOWED_UPDATES *and* rejected explicitly below. Silently
 * dropping them would be worse than refusing: the caller would be told the save
 * succeeded while the value they sent was thrown away.
 */
export const CUSTOMER_MASTER_FIELDS = [
  'customerName', 'phone', 'location', 'shopNumber', 'vendorNumber', 'gstNumber',
];

/**
 * Addresses, which are editable — deliberately NOT part of the master set above.
 *
 * `CUSTOMER_MASTER_FIELDS` identify the legal entity we trade with, and the
 * intent is that they do not change on a live account. An address is the
 * opposite: a customer moving warehouse is ordinary, and refusing the edit would
 * mean deleting and recreating the account to record it.
 *
 * Changing them does not rewrite history. Every booking snapshots the addresses
 * onto its own Order rows at creation, so a picklist already issued keeps the
 * address it was picked against — see models/User.js.
 *
 * Optional on creation: an account can be made before its addresses are known,
 * and the picklist degrades to the customer's `location` until they are filled
 * in. That is why they are absent from the required-fields loop below.
 */
export const CUSTOMER_ADDRESS_FIELDS = ['shippingAddress', 'billingAddress'];

/**
 * Who this actor is allowed to act on.
 *
 * MANAGE_USERS (Admin) is unrestricted. MANAGE_CUSTOMER_USERS (Sales) may only
 * touch accounts whose role is Customer — reading, creating and editing alike.
 * The check is on the TARGET, because a permission cannot express "only
 * Customers" on its own, and because the obvious attack on a role that can
 * create logins is to create a privileged one.
 */
const canManageAllUsers = (actor) => hasPermission(actor, PERMISSIONS.MANAGE_USERS);

const isCustomerAccount = (account) => (account?.role || 'Customer') === 'Customer';

/**
 * AD-4: an account fenced into the customer portal may hold no HRMS role.
 *
 * The portal-role endpoints below can create that violation from the other
 * direction - demoting an employee to a portal-only role while they still hold
 * `hrms_*` keys. `assertHrmsRolesAssignable` is the single rule; this wraps it
 * for the HTTP layer. Responds 409 (a conflicting state) rather than 400, and
 * returns true when it has already answered.
 *
 * It asks the LIVE role model, not the literal name `Customer`: a Super Admin
 * can mark any role they invent as `portalOnly`, and an account on one is as
 * fenced as a Customer is.
 */
const denyIfRoleCombinationInvalid = (res, role, roles) => {
  try {
    assertHrmsRolesAssignable(role, roles ?? []);
    return false;
  } catch (err) {
    if (!(err instanceof RoleAssignmentError)) throw err;
    res.status(409).json({ success: false, message: err.message, code: err.code });
    return true;
  }
};

/**
 * Refuse when the actor may not act on this account. Returns true when it has
 * already answered the request, so callers `if (denied(...)) return;`.
 */
const denyIfOutOfScope = (req, res, target, verb) => {
  if (canManageAllUsers(req.user)) return false;
  if (isCustomerAccount(target)) return false;
  res.status(403).json({
    success: false,
    message: `You can only ${verb} customer accounts.`,
  });
  return true;
};

// Suspended accounts live in `archivedusers`, not `users`. The admin list has to
// show them anyway — otherwise there is no way to bring one back — so both
// collections are merged here and archived rows are flagged for the UI.
const asArchivedRow = (doc) => ({
  ...doc,
  status: 'Suspended',
  archived: true,
});

export const getUsers = async (req, res, next) => {
  try {
    // Scoped in the QUERY, not filtered after the fact: an actor who may only
    // manage customers must not receive staff accounts in the payload either.
    const scope = canManageAllUsers(req.user) ? {} : { role: 'Customer' };

    // -password: the admin list has never had a use for it, and sending every
    // account's credential to a browser on every visit to this screen is a
    // wider blast radius than the screen needs. Nothing on the client reads it
    // (the create form has its own field).
    const [users, archived] = await Promise.all([
      User.find(scope).select('-password').lean(),
      ArchivedUser.find(scope).select('-password').lean(),
    ]);

    res.status(200).json({
      success: true,
      data: [...users, ...archived.map(asArchivedRow)],
    });
  } catch (error) {
    next(error);
  }
};

// Admin creates a customer, choosing its category (MSIL / Customer).
export const createUser = async (req, res, next) => {
  try {
    const { email, password, user, company, role, customerCategory, status, brandAccess } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    // Only recognised roles are accepted; anything else falls back to Customer
    // so an unexpected value can never grant privileges.
    const requestedRole = assignableRoles().includes(role) ? role : 'Customer';

    // A Sales actor may only create CUSTOMERS. Checked against the role being
    // requested, before anything is written — otherwise the obvious escalation
    // is to POST /users with role: 'Admin'.
    if (denyIfOutOfScope(req, res, { role: requestedRole }, 'create')) return;
    if (denyIfRoleCombinationInvalid(res, requestedRole, req.body.roles)) return;

    // Master details are mandatory for a NEW customer, and only meaningful for
    // one — staff accounts carry no GST or shop number.
    const master = {};
    if (requestedRole === 'Customer') {
      const missing = [];
      for (const field of CUSTOMER_MASTER_FIELDS) {
        const value = typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field];
        if (value === undefined || value === null || value === '') { missing.push(field); continue; }
        master[field] = String(value);
      }
      if (missing.length) {
        return res.status(400).json({
          success: false,
          message: `These customer details are required and cannot be added later: ${missing.join(', ')}.`,
          missing,
        });
      }

      // Addresses are accepted here but never required — see the note on
      // CUSTOMER_ADDRESS_FIELDS. An account created without them still works;
      // its picklists fall back to `location` until they are filled in.
      for (const field of CUSTOMER_ADDRESS_FIELDS) {
        const value = typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field];
        if (value) master[field] = String(value);
      }
    }

    const normalisedEmail = email.toLowerCase();

    const exists = await User.findOne({ email: normalisedEmail });
    if (exists) {
      return res.status(400).json({ success: false, message: 'A user with this email already exists.' });
    }

    // The email may belong to a suspended account that is only archived, not gone.
    const archived = await ArchivedUser.findOne({ email: normalisedEmail });
    if (archived) {
      return res.status(400).json({
        success: false,
        message: 'A suspended account already uses this email. Set it back to Active to restore it instead of creating a new one.',
      });
    }

    const newUser = await User.create({
      email,
      // AD-10: a password is only ever stored as a bcrypt hash. This used to
      // write the plaintext straight through.
      password: await hashPassword(password),
      user: user || null,
      company: company || null,
      role: requestedRole,
      customerCategory: customerCategory === 'MSIL' ? 'MSIL' : 'Customer',
      status: status || 'Active',
      ...(brandAccess ? { brandAccess } : {}),
      // Written once, here. updateUser() refuses them from now on.
      ...master,
    });

    res.status(201).json({ success: true, data: newUser });
  } catch (error) {
    next(error);
  }
};

// Fields an admin may change after creation.
const ALLOWED_UPDATES = ['user', 'company', 'email', 'role', 'customerCategory', 'status', 'brandAccess', 'showMsilCode', ...CUSTOMER_MASTER_FIELDS, ...CUSTOMER_ADDRESS_FIELDS];

// Admin updates a user, including changing the customer category at any time.
// Status transitions have side effects:
//   -> Suspended : the document is moved out of `users` into the archive.
//   Suspended -> : the archived document is recreated in `users` with its
//                  original _id, so all its history reattaches.
export const updateUser = async (req, res, next) => {
  try {

    // Scope: a Sales actor may only edit CUSTOMER accounts, and may not turn one
    // into anything else. Both halves matter — without the second, editing a
    // customer's role to 'Admin' would be an escalation through an allowed edit.
    const target = await User.findById(req.params.id).lean()
      || await ArchivedUser.findById(req.params.id).lean();
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (denyIfOutOfScope(req, res, target, 'edit')) return;

    if ('role' in req.body && !canManageAllUsers(req.user) && req.body.role !== 'Customer') {
      return res.status(403).json({
        success: false,
        message: 'You can only manage customer accounts, so this account must stay a Customer.',
      });
    }

    // AD-4, same reasoning as updateUserRole: a role change must not leave the
    // account holding HRMS roles it may no longer have.
    if ('role' in req.body && denyIfRoleCombinationInvalid(res, req.body.role, target.roles)) return;

    const updates = {};
    for (const key of ALLOWED_UPDATES) {
      if (key in req.body) updates[key] = req.body[key];
    }

    // The two legacy spellings stay accepted so an integration still sending
    // them does not start failing; anything else is a typo worth rejecting.
    if (updates.customerCategory && !['MSIL', 'Customer', 'Regular Customer', 'Non-MSIL'].includes(updates.customerCategory)) {
      return res.status(400).json({ success: false, message: 'Invalid customer category. Use "MSIL" or "Customer".' });
    }

    // If email is being changed, ensure it is not taken by another user.
    if (updates.email) {
      updates.email = updates.email.toLowerCase();
      const [clash, archivedClash] = await Promise.all([
        User.findOne({ email: updates.email, _id: { $ne: req.params.id } }),
        ArchivedUser.findOne({ email: updates.email, _id: { $ne: req.params.id } }),
      ]);
      if (clash || archivedClash) {
        return res.status(400).json({ success: false, message: 'A user with this email already exists.' });
      }
    }

    const live = await User.findById(req.params.id);

    if (live) {
      if (updates.status === 'Suspended') {
        // Suspending yourself would lock the admin out of the portal mid-session.
        if (String(req.user?._id) === String(req.params.id)) {
          return res.status(400).json({ success: false, message: 'You cannot suspend your own account.' });
        }
        return suspend(live, updates, res);
      }

      const updated = await User.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
      return res.status(200).json({ success: true, data: updated });
    }

    // Not in `users` — it may be a suspended account sitting in the archive.
    const archived = await ArchivedUser.findById(req.params.id);
    if (!archived) return res.status(404).json({ success: false, message: 'User not found' });

    const merged = { ...archived.toObject(), ...updates };

    if (!updates.status || updates.status === 'Suspended') {
      // Still suspended — keep the edit in the archive so it applies on restore.
      await ArchivedUser.findByIdAndUpdate(req.params.id, updates, { new: true });
      return res.status(200).json({ success: true, data: asArchivedRow(merged) });
    }

    return restore(merged, updates.status, res);
  } catch (error) {
    next(error);
  }
};

// Move a live user into the archive and delete it from `users`.
const suspend = async (live, updates, res) => {
  const snapshot = { ...live.toObject(), ...updates, status: 'Suspended' };
  // _id must not appear in the update payload — Mongo rejects writes to it even
  // when the value is unchanged. The upsert takes it from the query instead.
  const { _id, ...fields } = snapshot;

  await ArchivedUser.findByIdAndUpdate(
    live._id,
    { ...fields, archivedAt: new Date() },
    { upsert: true, setDefaultsOnInsert: true },
  );
  await User.deleteOne({ _id: live._id });

  return res.status(200).json({ success: true, data: asArchivedRow(snapshot) });
};

// Recreate an archived user in `users` under its original _id.
const restore = async (merged, status, res) => {
  const clash = await User.findOne({ email: merged.email });
  if (clash) {
    return res.status(400).json({
      success: false,
      message: 'Another account now uses this email, so this one cannot be restored. Change the email first.',
    });
  }

  const { archivedAt, archived, ...fields } = merged;

  // save({ timestamps: false }) keeps the account's original createdAt rather
  // than stamping it with the restore date.
  const recreated = new User({ ...fields, status });
  await recreated.save({ timestamps: false, validateBeforeSave: false });
  await ArchivedUser.deleteOne({ _id: merged._id });

  return res.status(200).json({ success: true, data: recreated });
};

// Admin resets another user's password. No current-password check — this is an
// administrative override, gated by the manage_users permission on the route.
// Stored plaintext to remain consistent with the current auth scheme.
export const resetUserPassword = async (req, res, next) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 5) {
      return res.status(400).json({ success: false, message: 'New password must be at least 5 characters.' });
    }

    // Resetting a password is taking over an account, so it is scoped exactly
    // like editing one: Sales may reset a customer's, nobody else's.
    const target = await User.findById(req.params.id).lean()
      || await ArchivedUser.findById(req.params.id).lean();
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (denyIfOutOfScope(req, res, target, 'reset the password for')) return;

    const hashed = await hashPassword(newPassword);

    const user = await User.findById(req.params.id).select('+password');
    if (user) {
      // Also drops refreshTokenHash: an admin reset is an account takeover, so
      // any session the previous holder still has must stop working.
      await User.updateOne(
        { _id: user._id },
        { $set: { password: hashed, refreshTokenHash: null, refreshSessions: [] } },
      );
      return res.status(200).json({ success: true, message: `Password reset for ${user.email}.` });
    }

    // Suspended account: set the password on the archived copy so it is in place
    // the moment the account is restored.
    const archived = await ArchivedUser.findByIdAndUpdate(req.params.id, { password: hashed });
    if (!archived) return res.status(404).json({ success: false, message: 'User not found' });

    return res.status(200).json({
      success: true,
      message: `Password reset for ${archived.email}. It applies once the account is set back to Active.`,
    });
  } catch (error) {
    next(error);
  }
};

export const updateUserRole = async (req, res, next) => {
  try {
    const { role } = req.body;

    // Same rule as updateUser: a Sales actor may not change anyone's role, in
    // either direction. This endpoint exists precisely to change roles, so for
    // them it is refused outright rather than scoped.
    if (!canManageAllUsers(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Only an administrator can change an account role.',
      });
    }

    // The document-level pre('validate') hook does not run for
    // findByIdAndUpdate, so the AD-4 rule is checked here against the roles the
    // account already holds. Demoting an employee to Customer while they still
    // carry HRMS roles is exactly the case this catches.
    const target = await User.findById(req.params.id).select('roles').lean();
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (denyIfRoleCombinationInvalid(res, role, target.roles)) return;

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true, runValidators: true }
    );

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.status(200).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

/**
 * Extra access for ONE account, on top of whatever its role gives it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A PER-USER GRANT EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Because the alternative is worse. "Priya, and only Priya, may approve stock
 * counts" is a real request, and without this the only way to say it is to
 * invent a role for Priya - and a roles list that grows a row per person stops
 * being a roles list and becomes a second, worse copy of the user list.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE RULES
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. ADDITIVE ONLY. These grants are unioned with the role's; they can never
 *    subtract. An account always holds at least what its role advertises, so
 *    "what can this role do" stays answerable from the role screen alone.
 *    Taking something away is done by changing the role, where the next person
 *    to review the matrix will see it.
 *
 * 2. FULL USER MANAGEMENT ONLY. Deliberately narrower than the rest of this
 *    router, which also admits MANAGE_CUSTOMER_USERS. A salesperson may create
 *    and maintain customer accounts; letting them also hand one extra
 *    permissions would turn account creation into privilege escalation, which
 *    is the exact attack MANAGE_CUSTOMER_USERS exists to prevent.
 *
 * 3. YOU CANNOT GRANT WHAT YOU DO NOT HOLD. Today every actor who reaches this
 *    handler holds the wildcard, so the check never fires. It is here for the
 *    day somebody builds a custom role with MANAGE_USERS and not much else -
 *    at which point "the user admin can give anyone anything" would be a hole
 *    nobody remembered opening.
 */
export const updateUserAccess = async (req, res, next) => {
  try {
    if (!canManageAllUsers(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Only an administrator can change the extra access on an account.',
      });
    }

    const { extraGrants } = req.body;

    const { grants, error } = validateGrants(extraGrants || []);
    if (error) return res.status(400).json({ success: false, message: error });

    // Rule 3. Compared against the flat keys, because that is what a grant
    // actually means once resolved - a cell the actor cannot satisfy is a cell
    // they must not be able to hand on.
    const actorPermissions = resolveUserPermissions(req.user);
    if (!actorPermissions.includes('*')) {
      const beyond = [...compileGrants(grants)].filter((key) => !actorPermissions.includes(key));
      if (beyond.length) {
        return res.status(403).json({
          success: false,
          message: `You cannot grant access you do not hold yourself: ${beyond.join(', ')}`,
        });
      }
    }

    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });

    /**
     * AD-4, enforced HERE rather than left to the schema.
     *
     * The save below passes `validateBeforeSave: false`, so the User model's
     * AD-4 hook does NOT run on this path - and neither would it on a
     * findOneAndUpdate. A rule that only exists in a hook is a rule with a hole
     * in it, so this is the authorization boundary and the check belongs here.
     *
     * Two things are refused. First, extra access that carries an HRMS role:
     * `extraGrants` compile to flat PORTAL keys and the registry holds no HRMS
     * module, so this cannot happen today. It is asserted rather than assumed
     * so that adding an HRMS module to the registry later fails loudly here
     * instead of quietly becoming a second way to grant HRMS access.
     */
    const hrmsKeys = [...compileGrants(grants)].filter((key) => isHrmsRoleKey(String(key)));
    if (hrmsKeys.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          `Extra access cannot carry HRMS roles (${hrmsKeys.join(', ')}). ` +
          'HRMS roles are granted through the employee record, which enforces AD-4.',
        code: 'HRMS_ROLE_NOT_GRANTABLE_HERE',
      });
    }

    /**
     * Second: the account's own role pair must still satisfy AD-4 before it is
     * handed anything more. Widening the access of an account that is already
     * in violation - a portal-only role still holding `hrms_*` keys - would
     * write that violation back to disk with validation switched off.
     */
    if (denyIfRoleCombinationInvalid(res, target.role, target.roles)) return;

    target.extraGrants = grants;
    await target.save({ validateBeforeSave: false });

    const updated = target.toObject();
    delete updated.password;

    res.status(200).json({
      success: true,
      data: {
        ...updated,
        // What the account ACTUALLY holds now, role and extras combined, so the
        // screen can show the result rather than only the delta it just sent.
        permissions: resolveUserPermissions(updated),
        grants: grantsForUser(updated),
      },
    });
  } catch (error) {
    next(error);
  }
};
