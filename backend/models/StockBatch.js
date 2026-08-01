import mongoose from 'mongoose';

/**
 * Stock batch — the idempotency and reference boundary (IMS Module M2).
 *
 * One posting request produces one batch, which produces many movements.
 *
 * The batch exists because idempotency cannot live on the movement: a receipt
 * with ten lines writes ten movements, and they cannot share a unique key. The
 * key belongs one level up, on the request. That also gives a multi-line posting
 * a single reference id for drill-through and reversal, which the movements
 * alone could not provide.
 *
 * `status` is the recovery marker. The batch is written FIRST, in `pending`
 * state, and only promoted to `posted` once its movements are safely in. On a
 * standalone MongoDB without transactions, a crash mid-post therefore leaves a
 * `pending` batch — visibly incomplete rather than silently half-applied.
 */
const stockBatchSchema = new mongoose.Schema(
  {
    // Human-readable, sequential per year, from the existing Counter collection.
    batchId: { type: String, required: true, unique: true },

    /**
     * Caller-supplied idempotency key. The unique index IS the concurrency
     * control: two simultaneous requests carrying the same key race to insert,
     * one wins, and the loser gets a duplicate-key error which the service
     * translates into "return the batch that already exists".
     */
    idempotencyKey: { type: String, required: true, unique: true },

    // Which workflow produced this posting. Free-form rather than an enum
    // because later modules add their own, and an unrecognised label should not
    // be able to block a stock posting.
    workflowType: { type: String, required: true },

    status: {
      type: String,
      enum: ['pending', 'posted', 'failed'],
      default: 'pending',
    },

    lineCount: { type: Number, default: 0 },
    // Sum of the signed quantities. Cheap to store, and it makes a batch
    // listing readable without loading its movements.
    totalQuantity: { type: Number, default: 0 },

    // Transaction ids of the movements written, so a replayed request can
    // return the original result without a second query.
    transactionIds: { type: [String], default: [] },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorType: { type: String, enum: ['user', 'system'], default: 'user' },

    referenceType: { type: String, default: null },
    referenceId: { type: String, default: null },

    note: { type: String, default: null },
    // Populated when status is 'failed', so a failed posting explains itself.
    failureReason: { type: String, default: null },

    postedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// Batch listing and the ledger screen's batch column.
stockBatchSchema.index({ createdAt: -1 });
stockBatchSchema.index({ workflowType: 1, createdAt: -1 });
stockBatchSchema.index({ referenceType: 1, referenceId: 1 });

// Batches are append-mostly: the only permitted change is the pending → posted
// or pending → failed promotion the service performs. Deletion is never
// permitted, because it would orphan the movements that reference it.
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
  stockBatchSchema.pre(op, function guard(next) {
    next(new Error(`Stock batches cannot be deleted — ${op} is not permitted.`));
  });
}

export default mongoose.model('StockBatch', stockBatchSchema);
