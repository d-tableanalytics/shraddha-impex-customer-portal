import User from '../../models/User.js';
import ArchivedUser from '../../models/ArchivedUser.js';

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
    const [users, archived] = await Promise.all([
      User.find().lean(),
      ArchivedUser.find().lean(),
    ]);

    res.status(200).json({
      success: true,
      data: [...users, ...archived.map(asArchivedRow)],
    });
  } catch (error) {
    next(error);
  }
};

// Admin creates a customer, choosing its category (MSIL / Non-MSIL).
export const createUser = async (req, res, next) => {
  try {
    const { email, password, user, company, role, customerCategory, status, brandAccess } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
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
      // Only recognised roles are accepted; anything else falls back to Customer
      // so an unexpected value can never grant privileges.
      role: ['Admin', 'Sales', 'Customer'].includes(role) ? role : 'Customer',
      customerCategory: customerCategory === 'MSIL' ? 'MSIL' : 'Non-MSIL',
      status: status || 'Active',
      ...(brandAccess ? { brandAccess } : {}),
    });

    res.status(201).json({ success: true, data: newUser });
  } catch (error) {
    next(error);
  }
};

const ALLOWED_UPDATES = ['user', 'company', 'email', 'role', 'customerCategory', 'status', 'brandAccess', 'showMsilCode'];

// Admin updates a user, including changing the customer category at any time.
// Status transitions have side effects:
//   -> Suspended : the document is moved out of `users` into the archive.
//   Suspended -> : the archived document is recreated in `users` with its
//                  original _id, so all its history reattaches.
export const updateUser = async (req, res, next) => {
  try {
    const updates = {};
    for (const key of ALLOWED_UPDATES) {
      if (key in req.body) updates[key] = req.body[key];
    }

    if (updates.customerCategory && !['MSIL', 'Non-MSIL'].includes(updates.customerCategory)) {
      return res.status(400).json({ success: false, message: 'Invalid customer category. Use "MSIL" or "Non-MSIL".' });
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
