import mongoose from 'mongoose';

/**
 * Parking space for suspended accounts.
 *
 * Suspending a user removes the document from `users` entirely — the account
 * stops existing as far as login, customer lists and every other query is
 * concerned. The record is copied here first so setting the account back to
 * Active can recreate it, keeping the SAME _id: orders, reservations and
 * indents all reference the user by id, so they stay attached.
 *
 * `strict: false` on purpose — this stores whatever the User document held at
 * suspension time, including fields added to the User schema later.
 */
const archivedUserSchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,
    email: { type: String, required: true, lowercase: true, index: true },
    status: { type: String, default: 'Suspended' },
    archivedAt: { type: Date, default: Date.now },
  },
  { strict: false, versionKey: false },
);

export default mongoose.model('ArchivedUser', archivedUserSchema);
