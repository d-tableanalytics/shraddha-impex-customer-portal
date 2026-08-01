import mongoose from 'mongoose';
import { HEALTH_BAND_NAMES } from './StockHealth.js';

/**
 * Inventory snapshot (IMS Module M6).
 *
 * A frozen copy of inventory state at a point in time, assembled by COPYING
 * from the balance and health projections. Nothing here is calculated — every
 * field was computed by Module M3 or M4 and is preserved verbatim so a
 * historical figure never changes because a formula or threshold changed later.
 *
 * IMMUTABILITY AND REBUILD, RECONCILED
 * ------------------------------------
 * Rows are append-only: every update and delete path throws. Rebuilding a
 * snapshot therefore does NOT rewrite rows — it creates a NEW run for the same
 * date and marks the previous run superseded. The active snapshot for a date is
 * the newest run that has not been superseded.
 *
 * That gives both properties at once: a row that has been read is a row that
 * can never change, and a snapshot taken from bad inputs can still be redone.
 * It is the same versioning shape already used by InventoryConfig.
 *
 * `available` IS stored here even though M3 deliberately never stores it. In a
 * projection it is an identity that must not be able to disagree with its
 * inputs; in a snapshot it is a historical fact being preserved. Freezing it is
 * the point.
 */
const inventorySnapshotSchema = new mongoose.Schema(
  {
    // ── Which run produced this row ─────────────────────────────────────────
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapshotRun', required: true },
    runId: { type: String, required: true },
    // Date-only (midnight UTC). The unit a snapshot is identified by.
    snapshotDate: { type: Date, required: true },

    // ── Grain ───────────────────────────────────────────────────────────────
    skuCode: { type: String, required: true },
    brand: { type: String, required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    locationCode: { type: String, default: null },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

    // ── Balance, copied from stockbalances (M3) ─────────────────────────────
    onHand: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    available: { type: Number, default: 0 },
    incoming: { type: Number, default: 0 },
    outgoing: { type: Number, default: 0 },

    // ── Health, copied from stockhealth (M4) ────────────────────────────────
    // Health is SKU-scoped, so every location row for one SKU carries the same
    // network-level classification. Duplicated deliberately: a snapshot row
    // must be readable on its own without joining back to a projection that
    // has since moved on.
    band: { type: String, enum: [...HEALTH_BAND_NAMES, null], default: null },
    coverageDays: { type: Number, default: null },
    maxLevel: { type: Number, default: null },
    reorderLevel: { type: Number, default: null },
    replenishmentPercent: { type: Number, default: null },
    plannable: { type: Boolean, default: false },
    notPlannableReasons: { type: [String], default: [] },

    // ── Provenance ──────────────────────────────────────────────────────────
    // The rules in force when the snapshot was taken, so a historical band can
    // be explained even after the formula or thresholds change.
    formulaVersion: { type: String, default: null },
    thresholds: {
      critical: { type: Number, default: null },
      low: { type: Number, default: null },
      healthy: { type: Number, default: null },
    },

    // ── Activity markers, copied from stockbalances ─────────────────────────
    // Carried so the aging report can be reproduced from a snapshot rather than
    // only from live balances.
    lastMovementAt: { type: Date, default: null },
    lastIssuedAt: { type: Date, default: null },
    lastReceivedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// Duplicate protection at row level: one row per SKU + location within a run.
inventorySnapshotSchema.index(
  { runId: 1, skuCode: 1, brand: 1, location: 1 },
  { unique: true },
);
// The primary read: everything in one snapshot, brand-scoped.
inventorySnapshotSchema.index({ snapshotDate: -1, brand: 1, skuCode: 1 });
// Per-SKU history across snapshots — the comparison and trend access path.
inventorySnapshotSchema.index({ skuCode: 1, snapshotDate: -1 });
// Band filtering within a snapshot.
inventorySnapshotSchema.index({ runId: 1, band: 1 });

// ─── Immutability ────────────────────────────────────────────────────────────
/**
 * Snapshot rows are historical record. Correcting one means taking a new run,
 * not editing the past — so there is deliberately no code path to call.
 */
const blockMutation = (op) => function guard(next) {
  next(new Error(
    `Inventory snapshots are immutable — ${op} is not permitted. ` +
    'Rebuild the snapshot to produce a new run instead.',
  ));
};

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  inventorySnapshotSchema.pre(op, blockMutation(op));
}

inventorySnapshotSchema.pre('save', function guard(next) {
  if (!this.isNew) {
    return next(new Error('Inventory snapshots are immutable — rebuild to produce a new run.'));
  }
  next();
});

export default mongoose.model('InventorySnapshot', inventorySnapshotSchema);
