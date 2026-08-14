import mongoose from 'mongoose';

/**
 * One row per booking status change — the booking's timeline.
 *
 * WHY A SEPARATE COLLECTION. An Order document is one line item, and a booking
 * is every line sharing an orderId. Keeping the history on the Order would give
 * a five-SKU booking five copies of the same timeline, each free to drift from
 * the others. The timeline belongs to the booking, so it is stored against the
 * booking id.
 *
 * The document doubles as the NOTIFICATION LOG. Whether the customer was
 * actually told is a fact about the status change, not a separate concern: an
 * admin looking at "Dispatched — 14 Aug" needs to see in the same place that
 * the email bounced. Storing it anywhere else means two records to reconcile.
 */
const bookingStatusEventSchema = new mongoose.Schema({
  // The booking (BO-/SO-YYYY-######), not a line-item _id.
  orderId: { type: String, required: true },
  // The customer the booking belongs to — who the email was owed to.
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  status: { type: String, required: true },
  previousStatus: { type: String, default: null },
  changedAt: { type: Date, default: Date.now },

  // Who moved it. Null for system-driven transitions (the PO settlement job).
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  changedByName: { type: String, default: null },
  changedByRole: { type: String, default: null },

  remarks: { type: String, default: null },
  lineItemCount: { type: Number, default: 0 },

  /**
   * The guard against duplicate emails, enforced by the database rather than by
   * checking-then-writing.
   *
   * Shaped `<orderId>|<status>|<occurrence>`, where occurrence counts how many
   * times this booking has previously entered this status. Two requests racing
   * on the SAME transition compute the same key, so exactly one insert survives
   * and only one email goes out — which is what happens when an admin
   * double-clicks, or when the per-line-item route fires once per SKU. A
   * booking legitimately re-entering a status later (moved back a stage, then
   * forward again) computes a higher occurrence, so a genuine second transition
   * is never mistaken for a duplicate and is announced normally.
   */
  dedupeKey: { type: String, required: true, unique: true },

  notification: {
    // pending      — recorded, mail not yet attempted
    // sent/failed  — attempted, with the outcome
    // skipped      — deliberately not sent (no address, notifications switched off)
    // not_applicable — not a lifecycle stage (e.g. Cancelled)
    state: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'skipped', 'not_applicable'],
      default: 'pending',
    },
    recipient: { type: String, default: null },
    cc: { type: [String], default: [] },
    subject: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    // Why it failed, or why it was skipped — the line an admin actually reads.
    error: { type: String, default: null },
    reason: { type: String, default: null },
  },
}, { timestamps: true });

// The timeline query: every event for one booking, oldest first.
bookingStatusEventSchema.index({ orderId: 1, changedAt: 1 });
// A customer's recent activity.
bookingStatusEventSchema.index({ user: 1, changedAt: -1 });
// The admin's "what did not reach the customer" view.
bookingStatusEventSchema.index({ 'notification.state': 1, changedAt: -1 });

export default mongoose.model('BookingStatusEvent', bookingStatusEventSchema);
