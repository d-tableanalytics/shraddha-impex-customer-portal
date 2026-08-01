import mongoose from 'mongoose';

/**
 * Stock balance projection (IMS Module M3).
 *
 * THIS IS NOT A SOURCE OF TRUTH. Every figure here is a projection of
 * `stockmovements`, and `rebuildBalances()` reconstructs the whole document
 * from the ledger. If this collection were dropped it could be regenerated
 * exactly; if it disagrees with the ledger, the ledger is right.
 *
 * It exists for one reason: read performance. Deriving a balance by aggregating
 * the ledger on every availability check would put a scan on the hot path of
 * the customer booking flow. So the ledger provides auditability and recovery,
 * and this provides speed — both, not either.
 *
 * Grain is one document per SKU + brand + location. Brand is carried explicitly
 * rather than being looked up from the product, so a balance query never joins
 * and brand scoping is a plain indexed filter.
 *
 * Scope note: M3 projects QUANTITIES only. Max Level, Available %, health bands
 * and reorder points are Module M4 and deliberately absent — storing a derived
 * planning figure beside a balance is what left `availableInPercent` stale in
 * the first place.
 */
const stockBalanceSchema = new mongoose.Schema(
  {
    // ── Grain ───────────────────────────────────────────────────────────────
    skuCode: { type: String, required: true },
    brand: { type: String, required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    locationCode: { type: String, required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

    // ── Projected quantities ────────────────────────────────────────────────
    // Physical stock actually in this location. Sum of every PHYSICAL movement.
    onHand: { type: Number, default: 0 },
    // Committed against confirmed bookings awaiting dispatch. Sum of every
    // ALLOCATION movement. NOT the customer selection list — nothing is
    // allocated until a booking is confirmed.
    reserved: { type: Number, default: 0 },
    // Inbound but not yet received. No approved workflow produces inbound
    // movements yet, so this stays 0 until goods receipt ships (M7).
    incoming: { type: Number, default: 0 },
    // Committed outbound not yet issued. Tracked separately from `reserved`
    // because a future dispatch stage will move units between the two.
    outgoing: { type: Number, default: 0 },

    // `available` and `projected` are deliberately NOT stored:
    //   available = onHand - reserved
    //   projected = onHand + incoming - outgoing
    // They are identities over the fields above. Storing them would create a
    // third number that can disagree with the two it derives from.

    // ── Activity markers ────────────────────────────────────────────────────
    // Split deliberately. A SKU repeatedly reserved and released by expiring
    // bookings looks busy on `lastMovementAt` while never physically moving, so
    // dead-stock and ageing analysis must key on the physical timestamps.
    lastMovementAt: { type: Date, default: null },
    lastPhysicalMovementAt: { type: Date, default: null },
    lastIssuedAt: { type: Date, default: null },
    lastReceivedAt: { type: Date, default: null },
    lastCountedAt: { type: Date, default: null },

    // ── Projection bookkeeping ──────────────────────────────────────────────
    // How many movements have been folded in. Compared against the ledger count
    // during reconciliation, so a missed incremental update is detectable
    // without replaying the whole history.
    movementCount: { type: Number, default: 0 },
    // Set by rebuildBalances(). A balance that has never been rebuilt is still
    // valid — it just has not been independently confirmed.
    lastRebuiltAt: { type: Date, default: null },
    // Marks a projection built from a full replay rather than incremental
    // application, which reconciliation reports treat as trustworthy.
    rebuiltFromLedger: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);

// The grain. Also the availability hot path: one indexed lookup per SKU.
stockBalanceSchema.index({ skuCode: 1, brand: 1, location: 1 }, { unique: true });
// Per-location listing and stock-take sheet generation.
stockBalanceSchema.index({ location: 1, skuCode: 1 });
// Brand-scoped listing, which is every read the API serves.
stockBalanceSchema.index({ brand: 1, skuCode: 1 });
// Dead-stock and ageing queries become indexed lookups rather than ledger scans.
stockBalanceSchema.index({ lastIssuedAt: 1 });

/**
 * Derived reads. Kept as instance/statics helpers so every caller computes
 * availability the same way — this identity is the invariant the whole system
 * rests on and must not be re-derived ad hoc.
 */
export const deriveBalance = (doc) => {
  if (!doc) return null;
  const onHand = doc.onHand ?? 0;
  const reserved = doc.reserved ?? 0;
  const incoming = doc.incoming ?? 0;
  const outgoing = doc.outgoing ?? 0;
  return {
    onHand,
    reserved,
    incoming,
    outgoing,
    available: onHand - reserved,
    projected: onHand + incoming - outgoing,
  };
};

export default mongoose.model('StockBalance', stockBalanceSchema);
