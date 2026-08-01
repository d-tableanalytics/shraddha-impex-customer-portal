import mongoose from 'mongoose';

/**
 * A staged import row (IMS Module M9).
 *
 * WHY THIS COLLECTION EXISTS.
 *
 * The blueprint's pipeline requires that nothing is written before the user
 * confirms — so the parsed file has to survive between the upload request and
 * the confirm request. Two ways to do that: keep the file on disk and re-read
 * it at confirm time, or stage the parsed rows.
 *
 * Staging wins on three counts that matter here:
 *
 *   • Resume-safety. A row carries its own status, so a process that dies
 *     halfway restarts from the first unprocessed row rather than the top of
 *     the file.
 *   • Idempotency. `processed` is set in the same write that records the
 *     result, so a row cannot be handed to the ledger twice.
 *   • Preview. The preview and the processing run read exactly the same rows.
 *     Re-parsing would allow the file on disk to differ from what the user
 *     approved.
 *
 * The file itself is deleted once staging completes — it has no further use,
 * and keeping uploaded spreadsheets around is a data-retention liability.
 *
 * Rows are staged in chunks as the file streams, so a large import never holds
 * more than one chunk in memory.
 */

export const ROW_STATUSES = ['pending', 'processed', 'failed', 'skipped'];

const importRowSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true },
    // 1-based row number in the source sheet, header excluded. This is what the
    // error report shows, so it must match what the user sees in Excel.
    rowNumber: { type: Number, required: true },
    // Which chunk this row belongs to. Fixed at staging time, because the
    // ledger idempotency key is derived from it — re-chunking a resumed job
    // would produce new keys and let the same movements post twice.
    chunkIndex: { type: Number, required: true, default: 0 },

    // As read from the file, before any coercion. Kept so the error report can
    // quote what was actually in the cell rather than what we made of it.
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
    // After type coercion and normalisation. Null when the row failed
    // validation, since there is nothing trustworthy to store.
    data: { type: mongoose.Schema.Types.Mixed, default: null },

    valid: { type: Boolean, default: true },
    validationErrors: { type: [String], default: [] },

    status: { type: String, enum: ROW_STATUSES, default: 'pending' },
    // What the row produced — a transaction id, a product id, a count line.
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    failureReason: { type: String, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// One row per position per job. Staging a chunk twice — a retried upload, a
// duplicated write — cannot create a second copy of the same row.
importRowSchema.index({ jobId: 1, rowNumber: 1 }, { unique: true });
// The processing sweep: next pending rows, in file order.
importRowSchema.index({ jobId: 1, status: 1, chunkIndex: 1, rowNumber: 1 });
// The preview and the error report.
importRowSchema.index({ jobId: 1, valid: 1, rowNumber: 1 });

export default mongoose.model('ImportRow', importRowSchema);
