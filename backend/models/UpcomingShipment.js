import mongoose from 'mongoose';

/**
 * Upcoming stock — one SKU on one inbound shipment (a supplier PO or a
 * container), ordered but not yet received.
 *
 * Loaded from the Upcoming Stock import. Nothing here is stock: the ledger is
 * not touched when a line is recorded, and `onHand` does not move. What moves
 * this line is the inventory itself — every stock INCREASE posted to the ledger
 * for the SKU after the line was recorded (a goods receipt, an Inventory Import,
 * an upward Update Stock or count) is counted as that much of it arriving,
 * earliest ETA first (modules/inventory/upcomingStock.service.js). Decreases
 * never put quantity back: upcoming only goes down (decided 2026-10-21).
 *
 *   outstanding = orderedQty − receivedQty − cancelledQty
 *
 * `outstanding` is not stored, for the same reason StockBalance does not store
 * `available`: it is an identity over the three fields that are.
 */

// 'Deleted': removed from upcoming stock by a user because it was no longer
// required. Kept, not erased, for the audit trail and any receipts counted
// against it; never shown and never counted.
export const SHIPMENT_STATUSES = ['Open', 'Partially Received', 'Received', 'Cancelled', 'Deleted'];
export const OPEN_SHIPMENT_STATUSES = ['Open', 'Partially Received'];

const etaChangeSchema = new mongoose.Schema({
  from: { type: Date, default: null },
  // null when the date was cleared ("not known yet").
  to: { type: Date, default: null },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  byName: { type: String, default: null },
  at: { type: Date, default: Date.now },
}, { _id: false });

const upcomingShipmentSchema = new mongoose.Schema({
  brand: { type: String, required: true },
  skuCode: { type: String, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

  // The supplier PO / container reference, as typed — optional (decided
  // 2026-10-22: only SKU and quantity are required on import). `refKey` is the
  // same in lower case, so the duplicate guard below treats "po-1" and "PO-1"
  // as one. A line WITHOUT a reference gets a unique key of its own
  // (noRefKey), so any number of them can sit beside each other — there is
  // nothing to tell a repeat from a second shipment by.
  shipmentRef: { type: String, default: null, trim: true },
  refKey: { type: String, required: true },
  supplier: { type: String, default: null },

  orderedQty: {
    type: Number,
    required: true,
    min: 1,
    validate: { validator: Number.isInteger, message: 'Ordered quantity must be a whole number.' },
  },
  receivedQty: { type: Number, default: 0, min: 0 },
  cancelledQty: { type: Number, default: 0, min: 0 },

  // Start of the expected IST calendar day (utils/businessDay.js). Optional:
  // null means "date not known yet" — never Delayed, and filled last when
  // stock arrives (after every line that has a date).
  eta: { type: Date, default: null },
  etaChanges: { type: [etaChangeSchema], default: [] },

  status: { type: String, enum: SHIPMENT_STATUSES, default: 'Open' },
  // Kept apart from status so the duplicate guard can be a partial index: a
  // cancelled line frees its reference for a corrected re-import, a received
  // one does not (the same PO line arriving twice is the mistake it catches).
  cancelled: { type: Boolean, default: false },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  cancelledByName: { type: String, default: null },
  cancelNote: { type: String, default: null },

  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deletedByName: { type: String, default: null },
  deleteReason: { type: String, default: null },

  lastArrivalAt: { type: Date, default: null },

  // Provenance: the file it came from, and the import it belonged to. The
  // import id is what makes a resubmitted import a replay rather than a copy.
  source: { type: String, default: 'Manual' },
  importId: { type: String, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdByName: { type: String, default: null },
}, { timestamps: true });

upcomingShipmentSchema.index(
  { brand: 1, skuCode: 1, refKey: 1 },
  { unique: true, partialFilterExpression: { cancelled: false } },
);
// The working set: every open line of a SKU, earliest ETA first.
upcomingShipmentSchema.index({ brand: 1, skuCode: 1, status: 1, eta: 1 });
upcomingShipmentSchema.index({ status: 1 });
upcomingShipmentSchema.index({ importId: 1 }, { sparse: true });

/** The duplicate-guard key for a reference, or a unique one when there is none. */
export const refKeyFor = (ref) => (ref ? String(ref).toLowerCase() : `#noref:${new mongoose.Types.ObjectId()}`);

/** Earliest expected arrival first; lines with no date after every dated one, oldest first. */
export const byEta = (a, b) => {
  const ta = a.eta ? new Date(a.eta).getTime() : Infinity;
  const tb = b.eta ? new Date(b.eta).getTime() : Infinity;
  if (ta !== tb) return ta - tb;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || String(a._id).localeCompare(String(b._id));
};

export const outstandingOf = (line) =>
  Math.max(0, (line.orderedQty || 0) - (line.receivedQty || 0) - (line.cancelledQty || 0));

/** The status a line's quantities describe. Cancellation is decided elsewhere. */
export const shipmentStatusOf = (line) => {
  if (line.deletedAt) return 'Deleted';
  if (line.cancelled) return 'Cancelled';
  if (outstandingOf(line) === 0) return 'Received';
  return (line.receivedQty || 0) > 0 ? 'Partially Received' : 'Open';
};

export default mongoose.model('UpcomingShipment', upcomingShipmentSchema);
