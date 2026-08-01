import mongoose from 'mongoose';

/**
 * Adjustment posting record (IMS Module M7).
 *
 * The bridge between an approved count and the ledger entries it produced. One
 * document per posting operation, holding what was posted, who approved it, and
 * which ledger batch carries the immutable movements.
 *
 * It is NOT a second inventory mechanism — it stores no balance and moves no
 * stock. The movements live in `stockmovements`; this records the decision that
 * caused them, so "who authorised this correction, and why" is answerable
 * without reverse-engineering the ledger.
 *
 * Distinct from `stockbatches`: that is the ledger's internal idempotency
 * boundary, this is the business approval record. One adjustment maps to
 * exactly one batch.
 */
const stockAdjustmentSchema = new mongoose.Schema(
  {
    adjustmentId: { type: String, required: true, unique: true },

    // Where the adjustment came from. Only 'count' is produced in M7; 'manual'
    // exists so a standalone adjustment workflow slots in without a schema change.
    source: { type: String, enum: ['count', 'manual'], default: 'count' },
    count: { type: mongoose.Schema.Types.ObjectId, ref: 'StockCount', default: null },
    countId: { type: String, default: null },

    brand: { type: String, default: null },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    locationCode: { type: String, default: null },

    status: { type: String, enum: ['posted', 'failed'], default: 'posted' },

    lineCount: { type: Number, default: 0 },
    // Sum of the signed differences posted. A summary figure, not a balance.
    netQuantity: { type: Number, default: 0 },
    increases: { type: Number, default: 0 },
    decreases: { type: Number, default: 0 },

    // ── Ledger linkage ──────────────────────────────────────────────────────
    ledgerBatchId: { type: String, default: null },
    transactionIds: { type: [String], default: [] },

    // ── Audit detail required per line ──────────────────────────────────────
    // Before / counted / difference / reason are recorded here as well as on the
    // count line, so the adjustment record is self-contained evidence.
    lines: {
      type: [{
        skuCode: String,
        brand: String,
        locationCode: String,
        beforeQuantity: Number,
        countedQuantity: Number,
        difference: Number,
        reasonCode: String,
        transactionId: String,
        _id: false,
      }],
      default: [],
    },

    // Maker and checker, carried from the count session.
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    postedAt: { type: Date, default: Date.now },

    note: { type: String, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

stockAdjustmentSchema.index({ countId: 1 });
stockAdjustmentSchema.index({ postedAt: -1 });
stockAdjustmentSchema.index({ ledgerBatchId: 1 });

// An adjustment record is evidence for immutable ledger entries — deleting one
// would orphan the explanation for movements that still exist.
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
  stockAdjustmentSchema.pre(op, function guard(next) {
    next(new Error(`Stock adjustments cannot be deleted — ${op} is not permitted.`));
  });
}

export default mongoose.model('StockAdjustment', stockAdjustmentSchema);
