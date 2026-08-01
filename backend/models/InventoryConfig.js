import mongoose from 'mongoose';

/**
 * Inventory configuration (IMS Module M1).
 *
 * Thresholds, reason codes, the Max Level formula version and approval limits.
 * Configuration is deliberately NOT a single mutable document:
 *
 *  • A threshold change silently reclassifies thousands of SKUs and moves every
 *    dashboard number. "Why did Critical jump from 97 to 400 last Tuesday" has
 *    to be answerable, so every change is written as a NEW document and the
 *    previous one is stamped `supersededAt` (BR-41, BR-74).
 *  • Health projections record the `formulaVersion` they were computed under, so
 *    a formula change is explicable after the fact rather than a mystery.
 *
 * Scope resolution runs most-specific-first — sku → category → brand → global —
 * so a global default always resolves and a band is never undefined. Only the
 * global scope is exposed in the M1 UI; the chain is built now because
 * retrofitting it later would mean re-projecting every SKU.
 */

const reasonCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true },
    label: { type: String, required: true },
    group: {
      type: String,
      enum: ['Count', 'Loss', 'Found', 'Correction', 'Non-Sale Issue'],
      required: true,
    },
    // Which direction of adjustment this reason may be used for. 'Both' allows
    // either sign.
    direction: { type: String, enum: ['Positive', 'Negative', 'Both'], default: 'Both' },
    // A reason code in use is deactivated, never deleted (BR-24) — historical
    // movements must keep resolving their reason.
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const inventoryConfigSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      enum: ['global', 'brand', 'category', 'sku'],
      required: true,
      default: 'global',
    },
    // null for the global scope; the brand name, category or SKU code otherwise.
    scopeValue: { type: String, default: null },

    // ── Health bands ────────────────────────────────────────────────────────
    // Percentage boundaries, seeded to verified Excel parity. Must satisfy
    // 0 < critical < low < healthy (BR-40), validated in the controller.
    // Consumed by Module M4; stored here from M1 so the values exist and are
    // auditable before anything reads them.
    thresholds: {
      critical: { type: Number, default: 33 },
      low: { type: Number, default: 66 },
      healthy: { type: Number, default: 100 },
    },

    // ── Max Level formula ───────────────────────────────────────────────────
    // v1 — DAC x LeadTime x SafetyFactor        (verified against the workbooks)
    // v2 — DAC x LeadTime x (1 + SafetyFactor)  (conventional additive form)
    // The two differ by 3x on the current data. v1 is the default because it is
    // what the spreadsheet demonstrably does; v2 exists so the business decision
    // is a config change rather than a code change.
    formulaVersion: { type: String, enum: ['v1', 'v2'], default: 'v1' },

    // ── Operational limits ──────────────────────────────────────────────────
    // Adjustments above this quantity need second-person approval (M7).
    adjustmentApprovalThreshold: { type: Number, default: 100 },
    // How far back an effective date may be set without approval (M7).
    backdatingWindowDays: { type: Number, default: 30 },
    // A SKU with no issue movement for this long counts as dead stock (M6).
    deadStockDays: { type: Number, default: 180 },

    reasonCodes: { type: [reasonCodeSchema], default: [] },

    // ── Versioning ──────────────────────────────────────────────────────────
    effectiveFrom: { type: Date, default: Date.now },
    // Set when a newer document replaces this one. The active configuration for
    // a scope is the newest row with supersededAt == null.
    supersededAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    changeNote: { type: String, default: null },
  },
  { timestamps: true },
);

// Resolution lookup: newest live row for a scope.
inventoryConfigSchema.index({ scope: 1, scopeValue: 1, supersededAt: 1, effectiveFrom: -1 });

export default mongoose.model('InventoryConfig', inventoryConfigSchema);
