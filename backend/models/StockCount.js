import mongoose from 'mongoose';

/**
 * Physical stock count session (IMS Module M7).
 *
 * A controlled session for verifying physical stock against the system. It
 * NEVER writes an inventory balance. Approved variances become immutable
 * COUNT movements in the ledger, and the balance and health projections update
 * from those — the same path every other stock change takes.
 *
 * Lines live in `stockcountlines`, not embedded here. A full-catalogue count is
 * ~8,600 rows: embedded, that would approach the 16 MB document limit and make
 * every single line entry rewrite the whole document.
 *
 * STATE MACHINE
 * -------------
 *   Draft ──► Counting ──► Submitted ──► Approved ──► Posted
 *               ▲              │
 *               └──── Rejected ┘
 *   Draft / Counting / Submitted ──► Cancelled
 *
 * Posted is terminal and immutable. A correction after posting is a NEW count
 * or an adjustment — never an edit, because the ledger entries it produced
 * cannot be unmade.
 */

export const COUNT_STATUSES = [
  'Draft', 'Counting', 'Submitted', 'Approved', 'Rejected', 'Posted', 'Cancelled',
];

/** Which transitions are legal. Anything absent here is rejected. */
export const COUNT_TRANSITIONS = {
  Draft: ['Counting', 'Cancelled'],
  Counting: ['Submitted', 'Cancelled'],
  Submitted: ['Approved', 'Rejected', 'Cancelled'],
  Approved: ['Posted'],
  Rejected: ['Counting', 'Cancelled'],
  Posted: [],
  Cancelled: [],
};

const stockCountSchema = new mongoose.Schema(
  {
    countId: { type: String, required: true, unique: true },

    // ── Scope ───────────────────────────────────────────────────────────────
    // What this session covers. `full` counts everything in scope; `cycle` a
    // recurring subset; `spot` an ad-hoc handful. One entity, three cadences —
    // they are the same mechanism and were deliberately not built as three
    // separate workflows.
    scope: { type: String, enum: ['full', 'cycle', 'spot'], default: 'spot' },
    brand: { type: String, default: null },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    locationCode: { type: String, required: true },
    category: { type: String, default: null },

    status: { type: String, enum: COUNT_STATUSES, default: 'Draft', required: true },

    // ── People ──────────────────────────────────────────────────────────────
    // Separation of duties (BR-27) is enforced against these, not merely
    // against permissions — Inventory Manager holds BOTH perform and approve,
    // so a permission check alone would let one person do the lot.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    counter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── Timeline ────────────────────────────────────────────────────────────
    startedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    postedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // ── Line roll-up, maintained as lines are entered ───────────────────────
    lineCount: { type: Number, default: 0 },
    countedLines: { type: Number, default: 0 },
    varianceLines: { type: Number, default: 0 },
    // Net of all differences. Not a balance — a sum of per-line arithmetic.
    netVariance: { type: Number, default: 0 },

    // ── Ledger linkage, set at posting ──────────────────────────────────────
    // Both are proof the count reached the ledger, and the basis of the
    // double-post guard.
    ledgerBatchId: { type: String, default: null },
    adjustmentId: { type: String, default: null },
    postedMovementCount: { type: Number, default: 0 },

    notes: { type: String, default: null },
    rejectionReason: { type: String, default: null },
    cancelReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

// Approval queue and session listing.
stockCountSchema.index({ status: 1, createdAt: -1 });
stockCountSchema.index({ locationCode: 1, status: 1 });
stockCountSchema.index({ brand: 1, createdAt: -1 });

/**
 * Remember the status the document was LOADED with.
 *
 * The immutability guard below has to tell "this session was already posted"
 * apart from "this save is what posts it", and `this.status` cannot answer that
 * — by the time `save()` runs it already holds the new value.
 */
stockCountSchema.post('init', function rememberStatus() {
  this.$locals.priorStatus = this.status;
});

/**
 * A posted count is history. The status guard in the service prevents the
 * transition; this blocks any other write path from editing a posted session.
 *
 * Keyed on the PRIOR status, not the current one. Testing `this.status ===
 * 'Posted'` blocked the very save that performs the Approved -> Posted
 * transition: the ledger movement had already been written and the stock had
 * already moved, then this threw, so the session stayed "Approved" with
 * postedAt, adjustmentId and ledgerBatchId all null — a count that had posted
 * but did not know it, and an HTTP 500 for an operation that had in fact
 * succeeded.
 */
stockCountSchema.pre('save', function guard(next) {
  if (!this.isNew && this.$locals.priorStatus === 'Posted' && !this.$locals.allowPostedWrite) {
    const changed = this.modifiedPaths().filter((p) => p !== 'updatedAt');
    if (changed.length) {
      return next(new Error(
        'A posted count is immutable — create a new count or adjustment instead.',
      ));
    }
  }
  next();
});

for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
  stockCountSchema.pre(op, function guard(next) {
    next(new Error(`Stock counts cannot be deleted — ${op} is not permitted. Cancel the session instead.`));
  });
}

export default mongoose.model('StockCount', stockCountSchema);
