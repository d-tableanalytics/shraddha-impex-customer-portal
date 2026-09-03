import mongoose from 'mongoose';

/**
 * Import job (IMS Module M9).
 *
 * One row per uploaded file. Tracks the file through the pipeline and holds the
 * counters the progress display reads.
 *
 * THE JOB IS A RECORD OF WORK, NOT A PLACE WHERE WORK HAPPENS. Nothing here
 * calculates a balance, a band or a target — the job only knows how many rows
 * it handed to the approved services and what came back.
 */

/**
 * The imports the blueprint defines. A closed set.
 *
 * MUST match the keys of IMPORT_TEMPLATES in modules/inventory/import.templates.js.
 * The list is repeated here rather than imported so the model stays a leaf with
 * no dependency on a module above it — the cost is that adding an import type
 * means editing BOTH places, and missing this one fails at save time with
 * "not a valid enum value".
 */
export const IMPORT_TYPES = [
  'inventory-master',
  'fresh-inventory',
  'planning',
  'opening-stock',
  'stock-update',
  'stock-movements',
  'physical-count',
  'locations',
  'product-details',
];

/**
 * Lifecycle.
 *
 *   Pending    — file received, being parsed and validated
 *   Validated  — parsed and checked, AWAITING CONFIRMATION. Nothing written yet.
 *   Processing — confirmed; rows are being handed to the approved services
 *   Completed  — every valid row processed
 *   Partial    — processed, but some rows failed. Deliberately distinct from
 *                Completed, because "1,200 of 1,240 imported" is not success
 *                and must not be reported as though it were.
 *   Failed     — the file could not be used at all
 *   Cancelled  — abandoned before processing
 *
 * Processing is re-enterable from itself so a resumed job keeps its status
 * rather than appearing to restart.
 */
export const JOB_STATUSES = ['Pending', 'Validated', 'Processing', 'Completed', 'Partial', 'Failed', 'Cancelled'];

export const JOB_TRANSITIONS = {
  Pending: ['Validated', 'Failed', 'Cancelled'],
  Validated: ['Processing', 'Cancelled', 'Failed'],
  Processing: ['Processing', 'Completed', 'Partial', 'Failed'],
  Completed: [],
  Partial: [],
  Failed: [],
  Cancelled: [],
};

const importJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true },
    importType: { type: String, enum: IMPORT_TYPES, required: true },

    // ── File ────────────────────────────────────────────────────────────────
    fileName: { type: String, required: true },
    fileType: { type: String, enum: ['xlsx', 'xls', 'csv'], required: true },
    fileSize: { type: Number, default: 0 },
    /**
     * SHA-256 of the file's bytes, computed while streaming it to disk.
     *
     * Backs re-upload detection: the same file imported twice is almost always
     * a mistake, and the second run would post a second set of movements under
     * a different idempotency key — which the ledger cannot catch, because to
     * it they are simply new postings.
     */
    fileHash: { type: String, required: true },

    // ── Scope ───────────────────────────────────────────────────────────────
    // Recorded from the request so an import can be shown against the brand it
    // touched, and so brand isolation is enforceable on the history list.
    brand: { type: String, default: null },
    locationCode: { type: String, default: null },
    options: { type: mongoose.Schema.Types.Mixed, default: null },

    // ── Progress ────────────────────────────────────────────────────────────
    status: { type: String, enum: JOB_STATUSES, default: 'Pending', required: true },
    totalRows: { type: Number, default: 0 },
    validRows: { type: Number, default: 0 },
    invalidRows: { type: Number, default: 0 },
    processedRows: { type: Number, default: 0 },
    successfulRows: { type: Number, default: 0 },
    failedRows: { type: Number, default: 0 },
    skippedRows: { type: Number, default: 0 },
    // Rows handed to the services in one go. Recorded so a resumed job uses the
    // same boundaries it started with — the ledger's idempotency keys are built
    // from the chunk index, and re-chunking would change them.
    chunkSize: { type: Number, default: 500 },
    chunksTotal: { type: Number, default: 0 },
    chunksDone: { type: Number, default: 0 },

    // ── Outcome ─────────────────────────────────────────────────────────────
    // File-level problems: wrong template, missing columns, unreadable file.
    // Row-level problems live in importerrors, because there can be thousands.
    fileErrors: { type: [String], default: [] },
    // What the import produced downstream — ledger batches, count sessions.
    // Keeps the trail from a spreadsheet to the movements it created.
    producedRefs: {
      type: [{
        kind: { type: String },   // 'ledgerBatch' | 'count' | 'product'
        id: { type: String },
        chunkIndex: { type: Number },
        _id: false,
      }],
      default: [],
    },

    /**
     * SKUs this import CREATED that still have no MOQ set.
     *
     * A SKU created by an import arrives with the schema default of 0, which
     * means "no minimum" — indistinguishable from a deliberate 0. The admin is
     * asked for a real figure before the SKU is considered configured, and the
     * list survives here so a closed browser or a reloaded page does not lose
     * the fact that it was never answered.
     *
     * Emptied as each SKU is answered, so `length === 0` is the whole "is this
     * import finished" question.
     */
    pendingMoqSkus: {
      type: [{
        skuCode: { type: String },
        brand: { type: String },
        description: { type: String, default: null },
        msilCode: { type: String, default: null },
        quantity: { type: Number, default: 0 },
        _id: false,
      }],
      default: [],
    },

    /**
     * NEW SKUs this file will CREATE, and the details they must state first.
     *
     * Written at validation time — before anything is imported — from the rows
     * whose SKU code is not in the catalogue. A new SKU otherwise lands on the
     * schema defaults for MOQ, lead time, safety factor and box number, which
     * read as deliberate answers and are not: its Max Level is zero, so it is
     * permanently "over-stocked", never reorders, and is picked from nowhere.
     *
     * The four are therefore asked for BEFORE the import runs, not after. The
     * confirm endpoint refuses a job with any of them unanswered, and
     * `newSku.rules.js` is the single definition of what counts as answered.
     *
     * Held on the job rather than in the browser so a closed tab, a reload or a
     * different device picks the same import back up with the answers already
     * given still in place.
     */
    newSkus: {
      type: [{
        skuCode: { type: String },
        description: { type: String, default: null },
        msilCode: { type: String, default: null },
        // The row that introduced the SKU, so the prompt can point at it.
        rowNumber: { type: Number, default: null },

        // Null means "not answered yet" — the state confirm refuses.
        //
        // `brand` and `availableStock` are prefilled where the upload already
        // knows them: brand from the Brand chosen on the upload form, stock
        // from the sheet's Quantity column. Prefilled is not the same as
        // answered only in that the user can change them — both still have to
        // be present before the import may run.
        brand: { type: String, default: null },
        /**
         * The opening stock the SKU is created with.
         *
         * Defaults to NULL, not zero, and the distinction is the whole point: a
         * sheet with no Quantity for this row leaves it unanswered so the prompt
         * asks, whereas a deliberate zero is a real answer meaning "the part
         * exists, the stock has not arrived". A default of 0 would make those
         * two indistinguishable and the prompt would never ask.
         */
        availableStock: { type: Number, default: null },
        moq: { type: Number, default: null },
        leadTime: { type: Number, default: null },
        safetyFactor: { type: Number, default: null },
        boxNo: { type: String, default: null },
        _id: false,
      }],
      default: [],
    },

    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, default: Date.now },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    confirmedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    processingMs: { type: Number, default: 0 },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: null },

    /**
     * Processing claim. Set atomically before any row is handed to a service
     * and cleared when the run stops.
     *
     * One processor per job, always. Two would post the same chunk at the same
     * moment: the ledger's transactions collide as write conflicts, and an
     * upsert-based import can insert the same row twice because both runs look,
     * find nothing, and both write. A stale claim — from a process that died
     * mid-run — is taken over after LOCK_STALE_MS rather than blocking the job
     * forever.
     */
    lockedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

importJobSchema.index({ status: 1, createdAt: -1 });
importJobSchema.index({ importType: 1, createdAt: -1 });
importJobSchema.index({ startedBy: 1, createdAt: -1 });
importJobSchema.index({ brand: 1, createdAt: -1 });
// Re-upload detection. Not unique: the same file may legitimately be uploaded
// again after the first attempt was cancelled or failed, and the service checks
// the status rather than the index refusing the write outright.
importJobSchema.index({ fileHash: 1, importType: 1 });

/**
 * A job's identity and its file are fixed once created.
 *
 * Without this, a completed job could be relabelled to claim it imported a
 * different file or a different type — and the audit trail from spreadsheet to
 * stock movement would be worthless.
 */
const IMMUTABLE_FIELDS = ['jobId', 'importType', 'fileName', 'fileHash', 'startedBy', 'startedAt'];

importJobSchema.pre('save', function guard(next) {
  if (this.isNew) return next();
  const violated = IMMUTABLE_FIELDS.filter((f) => this.isModified(f));
  if (violated.length) {
    return next(new Error(
      `An import job's identity is immutable — ${violated.join(', ')} cannot be changed.`,
    ));
  }
  next();
});

export default mongoose.model('ImportJob', importJobSchema);
