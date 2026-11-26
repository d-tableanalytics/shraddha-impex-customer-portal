import mongoose from 'mongoose';

/**
 * Transactional outbox for stock-ledger postings (Phase 2).
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * Ledger postings used to be fire-and-forget: `recordStockMovement` raced the
 * posting against a 2-second timeout and, after three consecutive timeouts, a
 * circuit breaker skipped postings outright for thirty seconds. On this
 * deployment — a Sydney backend against a Mumbai cluster — every posting
 * exceeded that budget, so the breaker opened partway through most multi-line
 * bookings and the remaining lines were silently dropped. 495 order lines are
 * missing movements because of it.
 *
 * A row in this collection is written INSIDE the same transaction as the legacy
 * stock mutation. Either both commit or neither does. Once committed, the
 * intent is durable and a worker will post it however many attempts that takes.
 * The ledger can now only lag — never lose.
 *
 * WHY THE IDEMPOTENCY KEY IS MINTED HERE AND STORED
 * -------------------------------------------------
 * It would be natural to derive the key from the content — workflow, reference,
 * SKU, movement type. That is wrong for this system: two identical stock
 * adjustments on the same SKU on the same day are a legitimate thing to want,
 * and a content-derived key would silently swallow the second as a replay.
 *
 * So the key is minted ONCE, when the intent is recorded, and stored on the
 * row. Every retry of that row reuses it, and `stockbatches.idempotencyKey`
 * (already unique-indexed) turns a replay into a no-op. That is what makes
 * at-least-once delivery safe: a posting may be attempted any number of times
 * and can only ever produce one batch, one set of movements, and one
 * projection update.
 *
 * STATES
 *   pending  waiting to be posted; `nextAttemptAt` gates the retry
 *   claimed  a worker holds it. A claim older than CLAIM_TIMEOUT is reclaimable,
 *            which is what makes a worker restart safe
 *   applied  posted; `batchId` names the batch it produced
 *   failed   gave up after maxAttempts. Never discarded — it is the worklist
 *            that says the ledger is behind and why
 */
const stockOutboxSchema = new mongoose.Schema(
  {
    // Minted at insert, reused by every retry. The whole safety argument.
    idempotencyKey: { type: String, required: true, unique: true },

    // The posting to make, captured by value. The caller's product document
    // keeps changing after this row is written, so nothing may be read from it
    // later — a retry an hour after the fact must post what was true then.
    payload: {
      skuCode: { type: String, required: true },
      brand: { type: String, required: true },
      workflow: { type: String, required: true },
      referenceType: { type: String, default: null },
      referenceId: { type: String, default: null },
      note: { type: String, default: null },
      actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

      /**
       * WHEN THE STOCK ACTUALLY MOVED — not when the ledger got round to
       * hearing about it.
       *
       * postBatch() defaults a movement's effectiveDate to the moment it is
       * posted. That was harmless while posting happened inline, because the
       * two were the same instant. Once posting is asynchronous it is not:
       * two movements on one SKU could be posted in either order, and the SKU
       * Activity Log — which sorts by effectiveDate — would show them in an
       * order that never happened.
       *
       * Stamping it here fixes the history to the mutation, so the log is
       * correct no matter when, or in what order, the rows are drained. It
       * also makes the log more accurate than it was before, where a slow
       * posting already shifted a movement by up to two seconds.
       *
       * The ledger's `backdated` flag has a 60-second tolerance, so an
       * ordinary drain delay is not mistaken for a late-entered count.
       */
      effectiveDate: { type: Date, required: true },

      // The request that caused the mutation, flattened to the four fields
      // recordAudit() reads. An Express request cannot be stored and will not
      // exist when the worker posts this an hour later, so the provenance is
      // captured now — otherwise every posting made by the worker would be
      // audited as if it came from the server itself.
      method: { type: String, default: null },
      endpoint: { type: String, default: null },
      ipAddress: { type: String, default: null },
      userAgent: { type: String, default: null },
      movements: {
        type: [{
          movementType: String,
          quantity: Number,
          beforeQuantity: Number,
          afterQuantity: Number,
          reasonCode: String,
          note: String,
          _id: false,
        }],
        required: true,
      },
    },

    state: {
      type: String,
      enum: ['pending', 'claimed', 'applied', 'failed'],
      default: 'pending',
    },

    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    // Exponential backoff gate. `pending` with a future date is not yet due.
    nextAttemptAt: { type: Date, default: () => new Date() },

    // Who holds it, and since when. Two workers cannot hold the same row —
    // the claim is an atomic findOneAndUpdate on `state`.
    claimedBy: { type: String, default: null },
    claimedAt: { type: Date, default: null },

    appliedAt: { type: Date, default: null },
    batchId: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

// The claim query: the oldest due row, in creation order.
stockOutboxSchema.index({ state: 1, nextAttemptAt: 1, createdAt: 1 });
// Reclaiming rows abandoned by a worker that died mid-flight.
stockOutboxSchema.index({ state: 1, claimedAt: 1 });
// "Is the ledger behind for this booking?" — the operational question.
stockOutboxSchema.index({ 'payload.referenceId': 1 });
stockOutboxSchema.index({ 'payload.skuCode': 1, state: 1 });

export default mongoose.model('StockOutbox', stockOutboxSchema);
