import mongoose from 'mongoose';

/**
 * One row per SKU that has ever had upcoming stock — the SKU's handle on this
 * screen.
 *
 * It carries no quantities. Those are sums over the shipment lines, read when
 * needed, so there is no second figure to drift. What it
 * does carry:
 *
 *   version        bumped by every write to the SKU's upcoming stock (import,
 *                  edit, cancel, delete, arrival). Inside a transaction that
 *                  bump is a write to the same document, so two writers on one
 *                  SKU conflict and one retries rather than both working from
 *                  the same figures.
 *   syncedThrough  the newest ledger movement already looked at for arrivals.
 */

const upcomingStockItemSchema = new mongoose.Schema({
  brand: { type: String, required: true },
  skuCode: { type: String, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  version: { type: Number, default: 0 },
  syncedThrough: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

upcomingStockItemSchema.index({ brand: 1, skuCode: 1 }, { unique: true });
upcomingStockItemSchema.index({ skuCode: 1 });

export default mongoose.model('UpcomingStockItem', upcomingStockItemSchema);
