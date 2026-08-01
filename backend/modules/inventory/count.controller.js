import StockCount from '../../models/StockCount.js';
import StockCountLine from '../../models/StockCountLine.js';
import StockAdjustment from '../../models/StockAdjustment.js';
import OversoldException from '../../models/OversoldException.js';
import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import {
  createCount, startCount, recordCounts, submitCount,
  reviewCount, postCount, cancelCount, resolveOversold,
} from './count.service.js';

/**
 * Stock count endpoints (IMS Module M7).
 *
 * Permission split follows the M1 role matrix and is enforced at the route.
 * Separation of duties is ALSO enforced against the record inside the service —
 * Inventory Manager holds both perform_count and approve_count, so a permission
 * check alone would let one person count and approve their own work.
 */

// Express parses the query string with `qs` in extended mode, so
// `?status[$ne]=Posted` arrives as an object. Non-strings are dropped rather
// than coerced, so an operator cannot reach a filter.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};
const asInt = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

const COUNT_STATUSES = ['Draft', 'Counting', 'Submitted', 'Approved', 'Rejected', 'Posted', 'Cancelled'];

/** Map a CountError onto its HTTP status; anything else goes to the handler. */
const handle = (error, res, next) => {
  if (error?.status) {
    return res.status(error.status).json({
      success: false, message: error.message, code: error.code,
    });
  }
  return next(error);
};

/**
 * A count is visible when its brand is visible. A brand-less (all-brand)
 * session is visible to anyone who can see inventory, because its lines are
 * filtered separately.
 */
const visibilityFilter = (brands) => ({ $or: [{ brand: null }, { brand: { $in: brands } }] });

// ─── Sessions ────────────────────────────────────────────────────────────────

export const listCounts = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) {
      return res.status(200).json({ success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 } });
    }

    const filter = visibilityFilter(brands);

    const status = asString(req.query.status);
    if (status) {
      if (!COUNT_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false, message: `Status must be one of: ${COUNT_STATUSES.join(', ')}.`,
        });
      }
      filter.status = status;
    }

    const locationCode = asString(req.query.locationCode);
    if (locationCode) filter.locationCode = locationCode.toUpperCase();

    const brand = asString(req.query.brand);
    if (brand) {
      if (!canAccessBrand(req.user, brand)) {
        return res.status(403).json({ success: false, message: 'Access to this brand is restricted for your account.' });
      }
      filter.brand = brand;
    }

    const limit = asInt(req.query.limit, 25, 1, 200);
    const page = asInt(req.query.page, 1, 1, 10_000);

    const [rows, total, statusCounts] = await Promise.all([
      StockCount.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('createdBy counter submittedBy approvedBy postedBy', 'user email').lean(),
      StockCount.countDocuments(filter),
      // Tab counts describe the visible scope, not the current status filter.
      StockCount.aggregate([
        { $match: visibilityFilter(brands) },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);

    const byStatus = Object.fromEntries(COUNT_STATUSES.map((s) => [s, 0]));
    for (const c of statusCounts) byStatus[c._id] = c.n;

    res.status(200).json({
      success: true,
      data: rows,
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
      statusCounts: byStatus,
    });
  } catch (error) { next(error); }
};

export const getCount = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const count = await StockCount.findOne({ countId: req.params.countId })
      .populate('createdBy counter submittedBy approvedBy postedBy', 'user email').lean();

    // 404 rather than 403, so count ids cannot be probed.
    if (!count || (count.brand && !brands.includes(count.brand))) {
      return res.status(404).json({ success: false, message: 'Count not found' });
    }

    const limit = asInt(req.query.limit, 100, 1, 500);
    const page = asInt(req.query.page, 1, 1, 10_000);

    const lineFilter = { countId: count.countId, brand: { $in: brands } };
    const status = asString(req.query.verificationStatus);
    if (status) lineFilter.verificationStatus = status;
    if (['true', '1'].includes(String(req.query.varianceOnly))) lineFilter.adjustmentRequired = true;
    const skuCode = asString(req.query.skuCode);
    if (skuCode) lineFilter.skuCode = skuCode;

    const [lines, lineTotal] = await Promise.all([
      StockCountLine.find(lineFilter).sort({ skuCode: 1 })
        .skip((page - 1) * limit).limit(limit).lean(),
      StockCountLine.countDocuments(lineFilter),
    ]);

    res.status(200).json({
      success: true,
      data: { count, lines },
      pagination: { total: lineTotal, page, pages: Math.ceil(lineTotal / limit) || 1, limit },
    });
  } catch (error) { next(error); }
};

export const create = async (req, res, next) => {
  try {
    const brand = asString(req.body?.brand);
    if (brand && !canAccessBrand(req.user, brand)) {
      return res.status(403).json({ success: false, message: 'Access to this brand is restricted for your account.' });
    }
    const result = await createCount({
      scope: asString(req.body?.scope) || 'spot',
      brand: brand ?? null,
      locationCode: asString(req.body?.locationCode) ?? null,
      category: asString(req.body?.category) ?? null,
      skuCodes: Array.isArray(req.body?.skuCodes) ? req.body.skuCodes : null,
      includeZeroStock: req.body?.includeZeroStock === true,
      notes: asString(req.body?.notes) ?? null,
      actor: req.user, req,
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) { handle(error, res, next); }
};

export const start = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await startCount({ countId: req.params.countId, actor: req.user, req }) });
  } catch (error) { handle(error, res, next); }
};

export const update = async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.lines)) {
      return res.status(400).json({ success: false, message: 'lines must be an array.' });
    }
    const result = await recordCounts({
      countId: req.params.countId, lines: req.body.lines, actor: req.user, req,
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) { handle(error, res, next); }
};

export const submit = async (req, res, next) => {
  try {
    const result = await submitCount({
      countId: req.params.countId,
      allowUncounted: req.body?.allowUncounted === true,
      actor: req.user, req,
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) { handle(error, res, next); }
};

export const review = async (req, res, next) => {
  try {
    const result = await reviewCount({
      countId: req.params.countId,
      decision: asString(req.body?.decision),
      reason: asString(req.body?.reason) ?? null,
      actor: req.user, req,
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) { handle(error, res, next); }
};

export const post = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await postCount({ countId: req.params.countId, actor: req.user, req }) });
  } catch (error) { handle(error, res, next); }
};

export const cancel = async (req, res, next) => {
  try {
    const result = await cancelCount({
      countId: req.params.countId, reason: asString(req.body?.reason), actor: req.user, req,
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) { handle(error, res, next); }
};

// ─── Variance & history ──────────────────────────────────────────────────────

/** GET /counts/:countId/variances — review queue for one session. */
export const listVariances = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const count = await StockCount.findOne({ countId: req.params.countId }).lean();
    if (!count || (count.brand && !brands.includes(count.brand))) {
      return res.status(404).json({ success: false, message: 'Count not found' });
    }

    const limit = asInt(req.query.limit, 100, 1, 500);
    const page = asInt(req.query.page, 1, 1, 10_000);
    const filter = { countId: count.countId, adjustmentRequired: true, brand: { $in: brands } };

    const [rows, total, summary] = await Promise.all([
      // Largest absolute variance first — the lines worth a second look.
      StockCountLine.find(filter).sort({ difference: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      StockCountLine.countDocuments(filter),
      StockCountLine.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$reasonCode',
            lines: { $sum: 1 },
            net: { $sum: '$difference' },
            increases: { $sum: { $cond: [{ $gt: ['$difference', 0] }, '$difference', 0] } },
            decreases: { $sum: { $cond: [{ $lt: ['$difference', 0] }, '$difference', 0] } },
          },
        },
        { $sort: { lines: -1 } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: rows,
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
      summary: {
        byReason: summary.map((s) => ({
          reasonCode: s._id, lines: s.lines, net: s.net,
          increases: s.increases, decreases: s.decreases,
        })),
        movedDuringCount: rows.filter((r) => r.movedDuringCount).length,
      },
    });
  } catch (error) { next(error); }
};

/** GET /counts/history/lines — per-SKU count history across sessions. */
export const countHistory = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) {
      return res.status(200).json({ success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 } });
    }

    const filter = { brand: { $in: brands }, countedQuantity: { $ne: null } };
    const skuCode = asString(req.query.skuCode);
    if (skuCode) filter.skuCode = skuCode;
    if (['true', '1'].includes(String(req.query.varianceOnly))) filter.adjustmentRequired = true;

    const limit = asInt(req.query.limit, 50, 1, 200);
    const page = asInt(req.query.page, 1, 1, 10_000);

    const [rows, total] = await Promise.all([
      StockCountLine.find(filter).sort({ countedAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('countedBy', 'user email').lean(),
      StockCountLine.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true, data: rows,
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) { next(error); }
};

/** GET /adjustments — posted adjustment summaries. */
export const listAdjustments = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) {
      return res.status(200).json({ success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 } });
    }
    const filter = visibilityFilter(brands);
    const countId = asString(req.query.countId);
    if (countId) filter.countId = countId;

    const limit = asInt(req.query.limit, 25, 1, 200);
    const page = asInt(req.query.page, 1, 1, 10_000);

    const [rows, total] = await Promise.all([
      StockAdjustment.find(filter).sort({ postedAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('submittedBy approvedBy postedBy', 'user email').lean(),
      StockAdjustment.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true, data: rows,
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) { next(error); }
};

// ─── Oversold exceptions ─────────────────────────────────────────────────────

export const listOversold = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) return res.status(200).json({ success: true, data: [] });

    const filter = { brand: { $in: brands } };
    const status = asString(req.query.status);
    filter.status = status === 'Resolved' ? 'Resolved' : 'Open';

    const rows = await OversoldException.find(filter)
      .sort({ raisedAt: -1 }).limit(asInt(req.query.limit, 100, 1, 500))
      .populate('resolvedBy', 'user email').lean();

    res.status(200).json({ success: true, data: rows });
  } catch (error) { next(error); }
};

export const resolveOversoldException = async (req, res, next) => {
  try {
    const result = await resolveOversold({
      exceptionId: req.params.id,
      resolution: asString(req.body?.resolution),
      note: asString(req.body?.note) ?? null,
      actor: req.user, req,
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) { handle(error, res, next); }
};

export default {
  listCounts, getCount, create, start, update, submit, review, post, cancel,
  listVariances, countHistory, listAdjustments, listOversold, resolveOversoldException,
};
