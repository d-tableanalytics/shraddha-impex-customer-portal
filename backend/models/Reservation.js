import mongoose from 'mongoose';

const reservationSchema = new mongoose.Schema({
  reservationId: { type: String, required: true, unique: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  skuCode: { type: String, required: true },
  msilCode: { type: String, default: null },
  quantity: { type: Number, required: true },
  reservationDate: { type: Date, default: Date.now },
  expiryDate: { type: Date, required: true },
  status: {
    type: String,
    enum: [
      'Draft', 'Reserved', 'Confirmed', 'Pending', 'Partially Confirmed', 'Expired', 'Cancelled',
      'Processing', 'Completed'
    ],
    default: 'Reserved'
  },
  reservedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  //  Indent id (PI-YYYY-######) — shares the booking's sequence number,
  // differing only in the 2-char prefix (booking is BO-YYYY-######).
  indentNumber: { type: String, default: null },
  // PO number of the confirmation that produced this indent. Distinct
  // from the booking/indent ids; used to link a indent back to its booking.
  poNumber: { type: String, default: null },
  confirmedAt: Date,
  expiredAt: Date,
  // An indent closed because its booking was cancelled or expired (no PO in
  // 7 days): when, and why. It holds no stock, so nothing is released.
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  lastReminderSent: { type: String, default: null }, // e.g. 'day5', 'day7'

  // ── Scheduled availability ────────────────────────────────────────────────
  // The date an admin has promised this SKU will be available. Until it
  // arrives the indent cannot be moved to the customer's selection list, even
  // if stock happens to be on the shelf — the stock may be spoken for, or the
  // promise may have been made against an inbound delivery.
  scheduledDate: { type: Date, default: null },
  scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  scheduledAt: { type: Date, default: null },
  scheduleNote: { type: String, default: null },

  // ── Availability notice ───────────────────────────────────────────────────
  // When the customer was last told this indent is fulfillable. Stamped so the
  // notice is sent ONCE per spell of availability rather than on every stock
  // movement that happens to touch the SKU — and CLEARED again if stock falls
  // short, so a genuine second chance is announced like the first.
  availabilityNotifiedAt: { type: Date, default: null },

  // ── Material inward notice ────────────────────────────────────────────────
  // The inward event this indent was last told about. Stored as the reference
  // of the posting (a ledger batch id or an import job id) rather than a
  // timestamp, because the thing that must not repeat is the SAME receipt being
  // announced twice — which is exactly what a replayed import chunk or a
  // retried adjustment would otherwise do. A genuinely new receipt carries a
  // new reference and is announced normally.
  materialInwardNotifiedRef: { type: String, default: null },
  materialInwardNotifiedAt: { type: Date, default: null },

  // ── Automatic booking ─────────────────────────────────────────────────────
  // The booking the system raised on the customer's behalf when this indent
  // became fulfillable. Recorded rather than inferred: an indent and its
  // booking are otherwise linked only by SKU and customer, which stops being a
  // unique pair the moment the same customer indents the same SKU twice. The
  // cancellation screen needs to name the booking, and an auditor needs to see
  // that nobody typed it in by hand.
  // The booking's MSIL Supply Date, mirrored here so the conversion rule can
  // read it even for a booking with no rows yet. Set with Order.msilSupplyDate.
  supplyDate: { type: Date, default: null },
  /**
   * The outcome of the MSIL supply check for this indent (utils/msilSupply.js).
   *
   *   Awaiting decision   stock arrived too late (after the Supply Date or the
   *                       7-day window from the booking) — NOT converted; the
   *                       desk must Convert or Cancel.
   *   Auto-converted      stock arrived in time and was converted by itself.
   *   Converted manually  the desk chose Convert.
   *   Cancelled           the desk chose Cancel.
   *
   * Null on every indent the check has never applied to.
   */
  supplyCheck: {
    status: {
      type: String,
      enum: ['Awaiting decision', 'Auto-converted', 'Converted manually', 'Cancelled', null],
      default: null,
    },
    reason: { type: String, default: null },
    arrivedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
  },

  autoBookedOrderId: { type: String, default: null },
  autoBookedAt: { type: Date, default: null }
}, { timestamps: true });

// Add index for fast querying
reservationSchema.index({ customerId: 1 });
reservationSchema.index({ status: 1 });
reservationSchema.index({ expiryDate: 1 });

export default mongoose.model('Reservation', reservationSchema);
