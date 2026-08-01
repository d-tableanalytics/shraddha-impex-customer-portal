import mongoose from 'mongoose';

/**
 * Snapshot run metadata (IMS Module M6).
 *
 * One document per snapshot generation. Rows in `inventorysnapshots` reference
 * it, so a run is the unit that is superseded when a snapshot is rebuilt —
 * which is how immutable rows and a rebuild capability coexist.
 *
 * It also carries the answer to "is this snapshot trustworthy": how many rows
 * it covered, how long it took, which projections it read, and whether the
 * health projection was already stale when it ran. A snapshot assembled from a
 * stale projection is not wrong, but it is worth being able to see.
 */
const snapshotRunSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true },
    // Date-only (midnight UTC). Several runs may share a date; only one is live.
    snapshotDate: { type: Date, required: true },

    // How it was triggered. `scheduled` is accepted now so a scheduler can be
    // wired later without a schema change.
    trigger: {
      type: String,
      enum: ['manual', 'scheduled', 'rebuild'],
      default: 'manual',
    },
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'adhoc'],
      default: 'adhoc',
    },

    status: {
      type: String,
      enum: ['running', 'complete', 'failed', 'superseded'],
      default: 'running',
    },

    // Optional narrowing. A brand-scoped run supersedes only runs of the same
    // scope, so a Koken rebuild does not invalidate the BIX snapshot.
    scopeBrand: { type: String, default: null },

    rowCount: { type: Number, default: 0 },
    skuCount: { type: Number, default: 0 },
    // Totals across the run, so a snapshot listing is readable without loading
    // its rows.
    totals: {
      onHand: { type: Number, default: 0 },
      reserved: { type: Number, default: 0 },
      available: { type: Number, default: 0 },
    },
    bandCounts: { type: mongoose.Schema.Types.Mixed, default: null },

    // ── Integrity ───────────────────────────────────────────────────────────
    // Oldest health `computedAt` folded into this run. If it predates the run
    // by a long way, the health side was stale when the snapshot was taken.
    healthComputedOldest: { type: Date, default: null },
    // Balances with no matching health record — normal before the health
    // projection has been built for the whole catalogue.
    missingHealthCount: { type: Number, default: 0 },

    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },

    // Set when a later run replaces this one.
    supersededAt: { type: Date, default: null },
    supersededBy: { type: String, default: null },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorType: { type: String, enum: ['user', 'system'], default: 'user' },
    note: { type: String, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

// Resolve the live run for a date and scope.
snapshotRunSchema.index({ snapshotDate: -1, status: 1, scopeBrand: 1 });
snapshotRunSchema.index({ status: 1, createdAt: -1 });

// A run may be superseded or marked failed, but never deleted — deleting one
// would orphan the immutable rows that reference it.
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
  snapshotRunSchema.pre(op, function guard(next) {
    next(new Error(`Snapshot runs cannot be deleted — ${op} is not permitted.`));
  });
}

export default mongoose.model('SnapshotRun', snapshotRunSchema);
