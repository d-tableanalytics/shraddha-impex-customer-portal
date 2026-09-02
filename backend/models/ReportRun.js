import mongoose from 'mongoose';

/**
 * One execution of a scheduled report.
 *
 * TWO JOBS, AND THE SECOND IS THE IMPORTANT ONE.
 *
 * It is the LOG the requirement asks for: when the job ran, what it found, what
 * it produced, whether the mail left, and what went wrong if it did not.
 *
 * And it is the LOCK that stops the same weekly report going out twice. The
 * mechanism is `runKey` plus a unique index, nothing more: a run claims its slot
 * by INSERTING that key, and the second attempt to claim the same slot fails on
 * the index rather than on a check-then-act that two processes can both pass.
 * That matters here because there are several ways to get two attempts at one
 * occurrence — PM2 restarting the process just before the scheduled minute, a
 * deploy that overlaps it, an operator running the manual script on the same
 * day the cron fires — and none of them are exotic.
 *
 * The key is derived from the OCCURRENCE, not from the moment of running: every
 * attempt at the same week produces the same key, so "did this week's report
 * already go?" is answered by the database and not by a timer.
 */

export const REPORT_TYPES = ['weekly-inventory-health'];

/**
 * Lifecycle.
 *
 *   Running   — claimed, work in progress. A row stuck here belonged to a
 *               process that died; see the stale-claim rule in the job.
 *   Completed — report generated AND mail accepted.
 *   Failed    — generation or delivery failed after every attempt. Kept, not
 *               deleted, so it can be retried and so the gap is visible.
 *   Skipped   — nothing to report, or deliberately not sent.
 */
export const REPORT_RUN_STATUSES = ['Running', 'Completed', 'Failed', 'Skipped'];

const reportRunSchema = new mongoose.Schema(
  {
    reportType: { type: String, enum: REPORT_TYPES, required: true },

    /**
     * The occurrence this run belongs to, e.g.
     * `weekly-inventory-health:2026-W36`.
     *
     * Unique, and that uniqueness IS the duplicate-send guard. Do not relax it
     * without replacing the guarantee with something else.
     */
    runKey: { type: String, required: true, unique: true },

    // Human-readable form of the same thing, for the log and the email subject.
    periodLabel: { type: String, default: null },
    scheduledFor: { type: Date, default: null },

    status: { type: String, enum: REPORT_RUN_STATUSES, default: 'Running', required: true },
    // 'schedule' or 'manual' — a manual re-run is a legitimate way to recover a
    // failed week, and the log should not pretend the cron did it.
    trigger: { type: String, enum: ['schedule', 'manual'], default: 'schedule' },
    triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },

    // ── What the report said ────────────────────────────────────────────────
    // Kept on the run so "how many were critical three weeks ago" is answerable
    // without regenerating a report against today's stock, which would give a
    // different answer and look like the earlier one had been wrong.
    summary: {
      total: { type: Number, default: 0 },
      healthy: { type: Number, default: 0 },
      low: { type: Number, default: 0 },
      critical: { type: Number, default: 0 },
      outOfStock: { type: Number, default: 0 },
      overstock: { type: Number, default: 0 },
      unknown: { type: Number, default: 0 },
    },

    // ── What it produced ────────────────────────────────────────────────────
    // The files themselves are attached to the mail and then discarded — this
    // is a log, not a file store, for the same reason the export log is.
    attachments: {
      type: [{
        fileName: { type: String },
        format: { type: String },
        bytes: { type: Number, default: 0 },
        _id: false,
      }],
      default: [],
    },

    // ── Delivery ────────────────────────────────────────────────────────────
    recipients: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    emailAttempts: { type: Number, default: 0 },
    emailedAt: { type: Date, default: null },

    /**
     * Every failure along the way, in order. Plural because a run can fail its
     * first two send attempts and succeed on the third, and "it worked" should
     * not erase the fact that SMTP was flapping.
     *
     * NOT called `errors`. That is a reserved path name — a Mongoose Document
     * already has an `errors` property, which is where validation puts its
     * findings — and declaring it warns on every boot that it "may break some
     * functionality". Today the schema path happens to win, but a log field
     * whose contents depend on whether the document also failed validation is
     * not a thing to leave resting on current behaviour.
     */
    failures: { type: [String], default: [] },
  },
  { timestamps: true, versionKey: false },
);

// The history list: newest first, per report type.
reportRunSchema.index({ reportType: 1, startedAt: -1 });
// Finding a failed run to retry.
reportRunSchema.index({ reportType: 1, status: 1, startedAt: -1 });

export default mongoose.model('ReportRun', reportRunSchema);
