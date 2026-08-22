import User from '../../models/User.js';
import ArchivedUser from '../../models/ArchivedUser.js';
import { hasPermission, PERMISSIONS } from '../../middlewares/rbac.js';

/**
 * Roles an admin may assign. Derived from the User schema enum so the two can
 * never drift — adding a role to the model makes it assignable, and nothing
 * else has to change.
 */
const ASSIGNABLE_ROLES = User.schema.path('role').enumValues;

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

    const [users, archived] = await Promise.all([
      User.find(scope).lean(),
      ArchivedUser.find(scope).lean(),
    ]);

    res.status(200).json({
      success: true,
      data: [...users, ...archived.map(asArchivedRow)],
    });
  } catch (error) {
    next(error);
  }
};

// Admin creates a customer, choosing its category (MSIL / Regular Customer).
export const createUser = async (req, res, next) => {
  try {
    const { email, password, user, company, role, customerCategory, status, brandAccess } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    // Only recognised roles are accepted; anything else falls back to Customer
    // so an unexpected value can never grant privileges.
    const requestedRole = ASSIGNABLE_ROLES.includes(role) ? role : 'Customer';

    // A Sales actor may only create CUSTOMERS. Checked against the role being
    // requested, before anything is written — otherwise the obvious escalation
    // is to POST /users with role: 'Admin'.
    if (denyIfOutOfScope(req, res, { role: requestedRole }, 'create')) return;

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
      password,
      user: user || null,
      company: company || null,
      role: requestedRole,
      customerCategory: customerCategory === 'MSIL' ? 'MSIL' : 'Regular Customer',
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
const ALLOWED_UPDATES = ['user', 'company', 'email', 'role', 'customerCategory', 'status', 'brandAccess', 'showMsilCode', ...CUSTOMER_MASTER_FIELDS];

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

    const updates = {};
    for (const key of ALLOWED_UPDATES) {
      if (key in req.body) updates[key] = req.body[key];
    }

    if (updates.customerCategory && !['MSIL', 'Regular Customer', 'Non-MSIL'].includes(updates.customerCategory)) {
      return res.status(400).json({ success: false, message: 'Invalid customer category. Use "MSIL" or "Regular Customer".' });
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

    const user = await User.findById(req.params.id).select('+password');
    if (user) {
      user.password = newPassword;
      await user.save({ validateBeforeSave: false });
      return res.status(200).json({ success: true, message: `Password reset for ${user.email}.` });
    }

    // Suspended account: set the password on the archived copy so it is in place
    // the moment the account is restored.
    const archived = await ArchivedUser.findByIdAndUpdate(req.params.id, { password: newPassword });
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
