import mongoose from 'mongoose';

/**
 * A stock increase the ledger recorded, as Upcoming Stock counted it.
 *
 * One row per ledger movement, and the unique index on `movement` is the whole
 * point: two passes that see the same receipt at the same moment (an import's
 * stock step and somebody opening the screen) cannot both take it off the
 * shipments. The loser's insert fails, its transaction rolls back, and the
 * receipt is counted once.
 *
 * `appliedQty` is how much of it went against upcoming shipments; the rest was
 * more than anything outstanding and is simply stock. Rows with nothing applied
 * are kept too, so the same movement is never looked at twice.
 */

const allocationSchema = new mongoose.Schema({
  shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'UpcomingShipment', required: true },
  shipmentRef: { type: String, default: null },
  qty: { type: Number, required: true, min: 1 },
}, { _id: false });

const upcomingArrivalSchema = new mongoose.Schema({
  movement: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', required: true },
  transactionId: { type: String, default: null },
  batchId: { type: String, default: null },
  brand: { type: String, required: true },
  skuCode: { type: String, required: true },
  movementType: { type: String, default: null },
  referenceType: { type: String, default: null },
  referenceId: { type: String, default: null },
  quantity: { type: Number, required: true },
  appliedQty: { type: Number, default: 0 },
  allocations: { type: [allocationSchema], default: [] },
  movedAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });

upcomingArrivalSchema.index({ movement: 1 }, { unique: true });
upcomingArrivalSchema.index({ brand: 1, skuCode: 1, movedAt: -1 });

export default mongoose.model('UpcomingArrival', upcomingArrivalSchema);
