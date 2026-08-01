import mongoose from 'mongoose';

/**
 * An export record (IMS Module M9).
 *
 * Exports stream straight to the response — the file is never stored, so there
 * is nothing to serve later and no "download again" link. This collection is
 * therefore a LOG, not a queue: it records who exported what, with which
 * filters, and how much left the building.
 *
 * That is deliberate. Inventory exports carry cost and margin-adjacent data, so
 * "who took a copy of the stock position on the 3rd" is a question the business
 * will eventually need answered. Storing the files themselves would answer it
 * no better and would create a directory of sensitive spreadsheets to secure.
 */

export const EXPORT_TYPES = [
  'inventory-master',
  'stock-balance',
  'stock-health',
  'stock-movements',
  'inventory-summary',
  'aging-report',
  'snapshot',
  'stock-counts',
  'alerts',
];

export const EXPORT_FORMATS = ['xlsx', 'csv'];

const exportJobSchema = new mongoose.Schema(
  {
    exportId: { type: String, required: true, unique: true },
    exportType: { type: String, enum: EXPORT_TYPES, required: true },
    format: { type: String, enum: EXPORT_FORMATS, required: true },
    fileName: { type: String, required: true },

    // Exactly what was asked for, so a historical export can be reproduced —
    // the same filters against the same projections give the same file.
    filters: { type: mongoose.Schema.Types.Mixed, default: null },
    // Which brands the exporter could actually see. Recorded because the answer
    // to "why does this file have fewer rows than mine" is usually here.
    brandScope: { type: [String], default: [] },

    rowCount: { type: Number, default: 0 },
    byteCount: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    status: { type: String, enum: ['Completed', 'Failed'], default: 'Completed' },
    failureReason: { type: String, default: null },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
);

exportJobSchema.index({ requestedBy: 1, createdAt: -1 });
exportJobSchema.index({ exportType: 1, createdAt: -1 });
exportJobSchema.index({ createdAt: -1 });

export default mongoose.model('ExportJob', exportJobSchema);
