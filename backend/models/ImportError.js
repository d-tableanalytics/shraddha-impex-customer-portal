import mongoose from 'mongoose';

/**
 * A row-level import error (IMS Module M9).
 *
 * Separate from the job because a bad file produces thousands of these, and
 * embedding them would make every job-list query drag the whole error set along
 * with it.
 *
 * ERRORS ARE COLLECTED, NOT THROWN. Validation runs to the end of the file and
 * reports every problem at once — stopping at the first bad row means the user
 * fixes one cell, re-uploads, and finds the next one, which for a 3,000-row
 * sheet is a day's work instead of ten minutes.
 */

/**
 * Error categories, so the report can be grouped and the same class of mistake
 * across 400 rows reads as one problem rather than 400.
 */
export const ERROR_CATEGORIES = [
  'file',          // unreadable, wrong format
  'template',      // wrong sheet, missing or unexpected columns
  'required',      // a mandatory cell is blank
  'format',        // not a number, not a date
  'enum',          // value outside an allowed set
  'reference',     // SKU / brand / location / reason code does not exist
  'duplicate',     // the same key appears twice in the file
  'range',         // quantity negative, percentage out of bounds
  'permission',    // the importer may not touch this brand
  'processing',    // the approved service rejected the row
];

const importErrorSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true },
    // Null for file- and template-level problems, which belong to no row.
    rowNumber: { type: Number, default: null },
    column: { type: String, default: null },
    category: { type: String, enum: ERROR_CATEGORIES, required: true },
    message: { type: String, required: true },
    // The offending cell value, so the report can show it without re-reading
    // the file — which by then has been deleted.
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

importErrorSchema.index({ jobId: 1, rowNumber: 1 });
importErrorSchema.index({ jobId: 1, category: 1 });

export default mongoose.model('ImportError', importErrorSchema);
