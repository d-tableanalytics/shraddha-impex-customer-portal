import mongoose from 'mongoose';

/**
 * One counted SKU within a count session (IMS Module M7).
 *
 * Separate from the session document so a full-catalogue count scales: ~8,600
 * embedded lines would approach the BSON size limit and make each entry rewrite
 * the entire session.
 *
 * THE FROZEN EXPECTED QUANTITY
 * ----------------------------
 * `expectedQuantity` is captured from the balance projection when the count
 * sheet is generated, and never refreshed. That freeze is the whole basis of a
 * trustworthy count: the variance a counter sees is measured against the figure
 * the system held when counting began, not against a number that moved while
 * they were walking the aisle.
 *
 * Stock that moves mid-count is detected at submission — `movedDuringCount` is
 * raised by comparing the live balance to the frozen one — and surfaced for
 * explicit review rather than silently absorbed. The previous CLI script simply
 * overwrote the balance with the counted figure, destroying any booking
 * confirmed in between.
 */

export const VERIFICATION_STATUSES = ['Pending', 'Counted', 'Matched', 'Variance', 'Skipped'];

const stockCountLineSchema = new mongoose.Schema(
  {
    count: { type: mongoose.Schema.Types.ObjectId, ref: 'StockCount', required: true },
    countId: { type: String, required: true },

    // ── What is being counted ───────────────────────────────────────────────
    skuCode: { type: String, required: true },
    brand: { type: String, required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    locationCode: { type: String, required: true },
    description: { type: String, default: null },
    boxNo: { type: String, default: null },

    // ── The count itself ────────────────────────────────────────────────────
    // Frozen at sheet generation. Never updated.
    expectedQuantity: { type: Number, required: true },
    expectedAt: { type: Date, required: true },
    // Null until entered. Zero is a legitimate count and must be
    // distinguishable from "not yet counted".
    countedQuantity: {
      type: Number,
      default: null,
      validate: {
        validator: (v) => v === null || (Number.isInteger(v) && v >= 0),
        message: 'Counted quantity must be a whole number of zero or more.',
      },
    },
    /**
     * The ONLY arithmetic this module performs:
     *     difference = countedQuantity − expectedQuantity
     * It does not recalculate a balance, and the expected side is read from the
     * projection rather than derived.
     */
    difference: { type: Number, default: null },

    reasonCode: { type: String, default: null },
    note: { type: String, default: null },

    verificationStatus: {
      type: String,
      enum: VERIFICATION_STATUSES,
      default: 'Pending',
    },

    // ── Concurrency detection ───────────────────────────────────────────────
    // Raised at submission when the live balance no longer matches the frozen
    // expectation, i.e. stock moved while the count was open.
    movedDuringCount: { type: Boolean, default: false },
    balanceAtSubmit: { type: Number, default: null },

    // ── Posting ─────────────────────────────────────────────────────────────
    adjustmentRequired: { type: Boolean, default: false },
    adjustmentPosted: { type: Boolean, default: false },
    // Proof this line reached the ledger, and what it became.
    ledgerTransactionId: { type: String, default: null },
    ledgerBatchId: { type: String, default: null },

    countedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    countedAt: { type: Date, default: null },

    /**
     * Present and true only while the line belongs to an OPEN count.
     *
     * Backs the partial unique index below, which enforces BR-45: at most one
     * open count may cover a given SKU at a given location. Two overlapping
     * counts would both snapshot the same expected quantity and both post the
     * same variance, applying the correction twice.
     *
     * Cleared (unset) when the count is posted or cancelled, releasing the SKU.
     */
    openLock: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);

// BR-45 — one open count per SKU + location. Partial, so posted and cancelled
// lines drop out of the index and the SKU becomes countable again.
stockCountLineSchema.index(
  { skuCode: 1, brand: 1, location: 1 },
  { unique: true, partialFilterExpression: { openLock: true } },
);

// Sheet rendering and variance review.
stockCountLineSchema.index({ countId: 1, skuCode: 1 });
stockCountLineSchema.index({ countId: 1, verificationStatus: 1 });
// Per-SKU count history.
stockCountLineSchema.index({ skuCode: 1, createdAt: -1 });

/** A posted line is history — the ledger entry behind it cannot be unmade. */
stockCountLineSchema.pre('save', function guard(next) {
  if (!this.isNew && this.adjustmentPosted && !this.$locals.allowPostedWrite) {
    return next(new Error('A posted count line is immutable — post a new adjustment instead.'));
  }
  next();
});

export default mongoose.model('StockCountLine', stockCountLineSchema);
