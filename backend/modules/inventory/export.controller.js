import ExportJob from '../../models/ExportJob.js';
import { EXPORTS, EXPORT_NAMES, runExport, listSnapshotRuns } from './export.service.js';
import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';

/**
 * Export endpoints (IMS Module M9).
 *
 * Every export is a streaming download. There is no job to poll and no file to
 * fetch later — the response IS the file. The history endpoint reads the log of
 * what was exported, not a store of the exports themselves.
 */

// `qs` extended parsing turns `?brand[$ne]=Koken` into an object, so non-strings
// are dropped rather than coerced and can never reach a filter.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};
const asInt = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());

/** The filters an export accepts, all coerced to strings first. */
const readFilters = (query) => {
  const out = {};
  for (const key of [
    'brand', 'category', 'status', 'search', 'skuCode', 'locationCode',
    'band', 'plannable', 'movementType', 'severity', 'alertType', 'runId', 'dateFrom', 'dateTo',
  ]) {
    const value = asString(query[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

export const listExportTypes = async (_req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: EXPORT_NAMES.map((key) => ({
        exportType: key,
        label: EXPORTS[key].label,
        requires: EXPORTS[key].requires ?? [],
        columns: EXPORTS[key].columns.map((c) => c.header),
      })),
      formats: ['xlsx', 'csv'],
    });
  } catch (error) { next(error); }
};

export const listRuns = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await listSnapshotRuns(allowedBrands(req.user)) });
  } catch (error) { next(error); }
};

/**
 * Run an export and stream it.
 *
 * Errors are answered as JSON only while the response is still clean. Once the
 * first byte of the file has gone out the headers are committed, so a failure
 * mid-stream destroys the connection instead — a truncated file that looks
 * complete is worse than an obviously broken download.
 */
export const download = async (req, res, next) => {
  try {
    const exportType = asString(req.params.exportType);
    if (!EXPORTS[exportType]) {
      return res.status(400).json({ success: false, message: `Unknown export "${exportType}". Expected one of: ${EXPORT_NAMES.join(', ')}.` });
    }

    const format = asString(req.query.format) || 'xlsx';
    if (!['xlsx', 'csv'].includes(format)) {
      return res.status(400).json({ success: false, message: 'Format must be xlsx or csv.' });
    }

    const filters = readFilters(req.query);

    for (const key of ['dateFrom', 'dateTo']) {
      if (filters[key] && !isIsoDate(filters[key])) {
        return res.status(400).json({ success: false, message: `${key} must be YYYY-MM-DD.` });
      }
    }
    if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
      return res.status(400).json({ success: false, message: 'dateFrom is after dateTo.' });
    }

    const brands = allowedBrands(req.user);
    if (filters.brand && !canAccessBrand(req.user, filters.brand)) {
      return res.status(403).json({ success: false, message: 'Access to this brand is restricted for your account.' });
    }
    for (const required of (EXPORTS[exportType].requires || [])) {
      if (!filters[required]) {
        return res.status(400).json({ success: false, message: `This export needs a ${required}.` });
      }
    }

    await runExport({ exportType, format, filters, brands, actor: req.user, req, res });
  } catch (error) {
    if (res.headersSent) {
      // Already streaming — nothing useful can be said in the body.
      return res.destroy();
    }
    if (error?.status) {
      return res.status(error.status).json({ success: false, message: error.message, code: error.code });
    }
    return next(error);
  }
};

/** What has been exported, by whom, with which filters. */
export const history = async (req, res, next) => {
  try {
    const filter = {};

    const exportType = asString(req.query.exportType);
    if (exportType) {
      if (!EXPORT_NAMES.includes(exportType)) {
        return res.status(400).json({ success: false, message: `Unknown export "${exportType}".` });
      }
      filter.exportType = exportType;
    }
    // A non-admin sees their own downloads. Who else exported the stock
    // position is an administrative question, not an everyday one.
    if (asString(req.query.mine) === 'true' || req.user?.role !== 'Admin') {
      filter.requestedBy = req.user._id;
    }

    const limit = asInt(req.query.limit, 25, 1, 200);
    const page = asInt(req.query.page, 1, 1, 10_000);

    const [rows, total] = await Promise.all([
      ExportJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('requestedBy', 'user email').lean(),
      ExportJob.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: rows.map((r) => ({ ...r, label: EXPORTS[r.exportType]?.label ?? r.exportType })),
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) { next(error); }
};

export default { listExportTypes, listRuns, download, history };
