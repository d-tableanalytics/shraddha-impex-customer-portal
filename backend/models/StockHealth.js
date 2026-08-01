import mongoose from 'mongoose';

/**
 * Stock health projection (IMS Module M4).
 *
 * DERIVED VALUES ONLY. Every field here is computed from three inputs — the
 * balance projection, the product's planning parameters, and the effective
 * inventory configuration — and `rebuildHealth()` reproduces the whole document
 * from them. If this collection were dropped it could be regenerated exactly.
 *
 * GRAIN IS PER-SKU, NOT PER-LOCATION. Max Level derives from daily consumption,
 * lead time and safety factor, all of which are per-SKU planning parameters with
 * no location dimension. Projecting health per location would either invent a
 * Max Level per site from a single global consumption figure — making every
 * location read Critical because each holds a fraction of the stock — or leave
 * the band meaningless. So balances are summed to a network figure first, and
 * per-location health is deliberately out of scope until per-location planning
 * parameters exist.
 *
 * WHY IT IS STORED AT ALL. The obvious alternative is computing health on read.
 * That fails one specific requirement: the inventory list must FILTER and SORT
 * by band across ~8,600 SKUs, and a value computed in application memory cannot
 * be indexed. This is a projection with an owner, a `computedAt` stamp and a
 * recorded `formulaVersion` — not the unowned stale field the audit found in
 * `availableInPercent`.
 */

/** The six health states. Order matters — see classify() in health.service.js. */
export const HEALTH_BANDS = {
  UNKNOWN: 'Unknown',
  OUT_OF_STOCK: 'Out of Stock',
  CRITICAL: 'Critical',
  LOW: 'Low',
  HEALTHY: 'Healthy',
  OVERSTOCK: 'Overstock',
};

export const HEALTH_BAND_NAMES = Object.values(HEALTH_BANDS);

/**
 * Why a SKU cannot be planned. Machine-readable so the completeness worklist is
 * a query rather than a string match — roughly 90% of the current catalogue is
 * missing at least one of these, so this is the launch worklist, not an edge case.
 */
export const NOT_PLANNABLE_REASONS = {
  NO_BALANCE: 'NO_BALANCE',                 // no stockbalances row — never moved
  NO_CONSUMPTION: 'NO_CONSUMPTION',         // daily average is zero for the current season
  NO_LEAD_TIME: 'NO_LEAD_TIME',             // lead time not set
  NO_SAFETY_FACTOR: 'NO_SAFETY_FACTOR',     // zero, and the active formula multiplies by it
  NOT_ACTIVE: 'NOT_ACTIVE',                 // discontinued or inactive SKU
};

const stockHealthSchema = new mongoose.Schema(
  {
    // ── Grain ───────────────────────────────────────────────────────────────
    skuCode: { type: String, required: true },
    brand: { type: String, required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

    // ── Input snapshot ──────────────────────────────────────────────────────
    // Copied in so the derivation can be explained after the fact without
    // re-reading three collections, and so a later planning edit does not
    // silently rewrite the history of how a band was reached.
    onHand: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    available: { type: Number, default: 0 },
    dailyAvgConsumption: { type: Number, default: 0 },
    currentSeason: { type: String, default: null },
    leadTime: { type: Number, default: 0 },
    safetyFactor: { type: Number, default: 0 },

    // ── Derived planning levels ─────────────────────────────────────────────
    // Null rather than zero when they cannot be derived — a zero target is
    // indistinguishable from a real one and would read as "everything is
    // overstocked".
    maxLevel: { type: Number, default: null },
    // Max Level x the critical threshold. Not a separate input: the workbook's
    // red band IS the reorder trigger, and deriving both from one number
    // guarantees the reorder list and the band can never disagree.
    reorderLevel: { type: Number, default: null },
    // Only meaningful under the additive formula (v2). Under v1 the safety
    // factor multiplies the whole target rather than adding a buffer, so there
    // is no separate safety-stock quantity and inventing one would double-count.
    safetyStock: { type: Number, default: null },

    // ── Derived measures ────────────────────────────────────────────────────
    // On Hand / Max Level. Drives the band, and matches the workbook exactly:
    // booked-but-not-dispatched units are physically present, so they count
    // toward replenishment health.
    replenishmentPercent: { type: Number, default: null },
    // Available / Max Level. Shown on the detail view for the sales desk. NOT
    // used for banding — a single large booking would otherwise flip healthy
    // SKUs to critical and trigger purchases for stock already on the shelf.
    salesCoveragePercent: { type: Number, default: null },
    // On Hand / daily consumption. More actionable to a buyer than a percentage
    // — "11 days of cover against a 180-day lead time" prompts action in a way
    // "6%" does not.
    coverageDays: { type: Number, default: null },

    // ── Classification ──────────────────────────────────────────────────────
    band: {
      type: String,
      enum: HEALTH_BAND_NAMES,
      default: HEALTH_BANDS.UNKNOWN,
      required: true,
    },
    plannable: { type: Boolean, default: false },
    notPlannableReasons: {
      type: [String],
      enum: Object.values(NOT_PLANNABLE_REASONS),
      default: [],
    },

    // ── Provenance ──────────────────────────────────────────────────────────
    // Which rules produced this row. Without these, "why did Critical jump from
    // 97 to 400 last Tuesday" is unanswerable after a config change.
    formulaVersion: { type: String, default: 'v1' },
    thresholds: {
      critical: { type: Number, default: 33 },
      low: { type: Number, default: 66 },
      healthy: { type: Number, default: 100 },
    },
    // Which configuration scope resolved — 'global', 'brand:Koken', etc.
    configScope: { type: String, default: 'global' },
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
);

// The grain.
stockHealthSchema.index({ skuCode: 1, brand: 1 }, { unique: true });
// The list screen's primary index: filter by brand + band, sort by stock, all
// served in-database rather than by an in-memory sort.
stockHealthSchema.index({ brand: 1, band: 1, onHand: -1 });
// Band and completeness counts.
stockHealthSchema.index({ band: 1 });
stockHealthSchema.index({ plannable: 1 });
// Reorder list ordering — worst-covered first.
stockHealthSchema.index({ replenishmentPercent: 1 });
// Coverage lookups.
stockHealthSchema.index({ coverageDays: 1 });

export default mongoose.model('StockHealth', stockHealthSchema);
