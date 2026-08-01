import mongoose from 'mongoose';

/**
 * Stock movement — the inventory ledger (IMS Module M2).
 *
 * This collection is the system of record for inventory history. Balances are a
 * projection of it (Module M3), never the other way round, which is what makes a
 * wrong number recoverable by replay rather than merely regrettable.
 *
 * Three properties are enforced structurally, not by convention:
 *
 *   APPEND-ONLY  every update/delete path on this model throws (see the guards
 *                at the bottom). There is no code path to call, so there is
 *                nothing to misuse.
 *   IMMUTABLE    a movement is corrected with a contra-entry (REVERSAL), never
 *                by editing it.
 *   SELF-VERIFYING  beforeQuantity/afterQuantity make each row independently
 *                checkable, so corruption is detectable at the exact row where a
 *                chain breaks rather than only in aggregate.
 *
 * Scope note: M2 stores movements. It does NOT compute balances, health or
 * targets — those belong to M3/M4. beforeQuantity/afterQuantity are supplied by
 * the caller and only validated for internal consistency here.
 */

// ─── Movement type registry ──────────────────────────────────────────────────
/**
 * Which balance a movement projects into.
 *
 * PHYSICAL movements change what is actually in the building. ALLOCATION
 * movements change how much of it is spoken for. They are kept apart because
 * merging them makes "how much is physically here" unanswerable and turns every
 * stock-count variance into a false positive.
 */
export const MOVEMENT_CLASS = {
  PHYSICAL: 'PHYSICAL',
  ALLOCATION: 'ALLOCATION',
};

/**
 * The closed set of movement types, each with the class it projects into and
 * the sign its quantity must carry.
 *
 *   'positive' — quantity must be > 0
 *   'negative' — quantity must be < 0
 *   'signed'   — either direction is meaningful, but never zero
 *
 * REVERSAL is deliberately 'signed' and classless here: it inherits both from
 * the movement it reverses, which the service resolves at post time.
 */
export const MOVEMENT_TYPES = {
  OPENING:      { class: MOVEMENT_CLASS.PHYSICAL,   sign: 'positive', label: 'Opening Balance' },
  RECEIPT:      { class: MOVEMENT_CLASS.PHYSICAL,   sign: 'positive', label: 'Goods Receipt' },
  ISSUE:        { class: MOVEMENT_CLASS.PHYSICAL,   sign: 'negative', label: 'Issue' },
  ADJUSTMENT:   { class: MOVEMENT_CLASS.PHYSICAL,   sign: 'signed',   label: 'Adjustment' },
  TRANSFER_IN:  { class: MOVEMENT_CLASS.PHYSICAL,   sign: 'positive', label: 'Transfer In' },
  TRANSFER_OUT: { class: MOVEMENT_CLASS.PHYSICAL,   sign: 'negative', label: 'Transfer Out' },
  COUNT:        { class: MOVEMENT_CLASS.PHYSICAL,   sign: 'signed',   label: 'Count Variance' },
  RESERVE:      { class: MOVEMENT_CLASS.ALLOCATION, sign: 'positive', label: 'Reserve' },
  RELEASE:      { class: MOVEMENT_CLASS.ALLOCATION, sign: 'negative', label: 'Release' },
  REVERSAL:     { class: null,                      sign: 'signed',   label: 'Reversal' },
};

export const MOVEMENT_TYPE_NAMES = Object.keys(MOVEMENT_TYPES);

/** Types that may only be produced by reversing another movement. */
export const DERIVED_TYPES = ['REVERSAL'];

const movementSchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────────
    // Human-readable, sequential per year. Allocated from the existing Counter
    // collection, which is already atomic and collision-safe.
    transactionId: { type: String, required: true, unique: true },

    // The posting request this movement belongs to. One request → one batch →
    // many movements; the batch carries the idempotency key.
    batch: { type: mongoose.Schema.Types.ObjectId, ref: 'StockBatch', required: true, index: true },
    // Human-readable duplicate of the batch reference. Indexed separately
    // because every read path — batch drill-through, the ledger filter — queries
    // by this string rather than by the ObjectId.
    batchId: { type: String, required: true, index: true },

    // ── What moved, and where ───────────────────────────────────────────────
    // SKU, brand and location are DENORMALISED on purpose: historical reporting
    // must stay correct if the product master is later edited, and a ledger
    // report must never need a lookup per row.
    skuCode: { type: String, required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    brand: { type: String, required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    locationCode: { type: String, required: true },

    // ── The movement itself ─────────────────────────────────────────────────
    movementClass: {
      type: String,
      enum: Object.values(MOVEMENT_CLASS),
      required: true,
    },
    movementType: {
      type: String,
      enum: MOVEMENT_TYPE_NAMES,
      required: true,
    },
    // Signed. The sign carries direction so a projection is a plain sum rather
    // than a conditional. Whole units only — fractional stock quantities make
    // balances stop reconciling cleanly.
    quantity: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: 'Movement quantity must be a whole number.',
      },
    },

    // ── Self-verification ───────────────────────────────────────────────────
    // Supplied by the caller from whatever balance source it holds; M2 does not
    // compute them. When both are present the service asserts
    // after === before + quantity, so a caller cannot record an inconsistent pair.
    beforeQuantity: { type: Number, default: null },
    afterQuantity: { type: Number, default: null },

    // ── When ────────────────────────────────────────────────────────────────
    // Deliberately two timestamps. effectiveDate drives as-at reporting and may
    // be backdated for a late-arriving count or receipt; postedAt is when the
    // row was actually written. Keeping them apart is what lets backdating stay
    // honest instead of rewriting history.
    effectiveDate: { type: Date, required: true },
    postedAt: { type: Date, default: Date.now },
    // Set when effectiveDate precedes postedAt, so reports can flag the row
    // without recomputing the comparison.
    backdated: { type: Boolean, default: false },

    // ── Why, and who ────────────────────────────────────────────────────────
    reasonCode: { type: String, default: null },
    note: { type: String, default: null },
    // Null only for genuine system movements, where actorType records it.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorType: { type: String, enum: ['user', 'system'], default: 'user' },

    // ── Provenance ──────────────────────────────────────────────────────────
    // Links the movement to the document that caused it, so the ledger can be
    // drilled through in both directions. Replaces the fragile id-prefix string
    // surgery the audit found between orders and indents.
    referenceType: {
      type: String,
      enum: ['booking', 'order', 'reservation', 'receipt', 'adjustment', 'count', 'transfer', 'import', 'migration', 'system', null],
      default: null,
    },
    referenceId: { type: String, default: null },

    // ── Correction chain ────────────────────────────────────────────────────
    // Set on a contra-entry. A reversal cannot itself be reversed.
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },

    // ── Optional valuation ──────────────────────────────────────────────────
    // Captured on receipts from day one even while valuation is switched off, so
    // enabling it later is a calculation over existing history rather than a
    // data-collection exercise that has to start from scratch.
    unitCost: { type: Number, default: null },
    currency: { type: String, default: null },

    // Free-form structured detail for the posting workflow.
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    // A movement is never edited, so there is no concurrent-write conflict to
    // resolve and the version key is dead weight on every document.
    versionKey: false,
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────────
// This is the only collection in the system that grows without bound, and
// retro-indexing at volume needs a maintenance window — so the access patterns
// are indexed now, before the data arrives.

// Per-SKU history and as-at balance: the most-used ledger read.
movementSchema.index({ skuCode: 1, location: 1, effectiveDate: -1 });
// Period reports and movement summaries.
movementSchema.index({ effectiveDate: -1, movementType: 1 });
// Drill-through from a booking, count or adjustment.
movementSchema.index({ referenceType: 1, referenceId: 1 });
// Adjustment governance reporting, grouped by reason.
movementSchema.index({ reasonCode: 1, effectiveDate: -1 });
// "What did this person change?" — the audit question.
movementSchema.index({ user: 1, createdAt: -1 });
// Brand-scoped ledger listing, which is the default screen query.
movementSchema.index({ brand: 1, effectiveDate: -1 });

// ─── Append-only enforcement ─────────────────────────────────────────────────
/**
 * Immutability is enforced at the model, not left to discipline.
 *
 * Every mutating path throws, so there is no "correct" way to edit a movement
 * that someone could reach for by accident — including from a script or a
 * console session that imports this model. Corrections are contra-entries.
 *
 * The one permitted exception is stamping `reversedBy` on the movement being
 * reversed: that is the ledger recording its own correction chain, it is
 * append-only in spirit (a field that goes from null to set exactly once), and
 * the service is the only caller. It is allowed through an explicit
 * `allowLedgerLink` option so it cannot be reached by a generic update.
 */
const blockMutation = (operation) => function guard(next) {
  if (this.getOptions?.()?.allowLedgerLink === true) return next();
  next(new Error(
    `Stock movements are append-only — ${operation} is not permitted. ` +
    'Post a REVERSAL movement instead.',
  ));
};

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne']) {
  movementSchema.pre(op, blockMutation(op));
}
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
  movementSchema.pre(op, function guard(next) {
    next(new Error(`Stock movements are append-only — ${op} is not permitted.`));
  });
}

// Document-level: allow the initial insert, refuse any later save.
movementSchema.pre('save', function guard(next) {
  if (!this.isNew) {
    return next(new Error('Stock movements are immutable — post a REVERSAL movement instead.'));
  }
  next();
});

export default mongoose.model('StockMovement', movementSchema);
