import SnapshotRun from '../../models/SnapshotRun.js';
import InventorySnapshot from '../../models/InventorySnapshot.js';
import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { MOVEMENT_TYPE_NAMES } from '../../models/StockMovement.js';
import { HEALTH_BAND_NAMES } from '../../models/StockHealth.js';
import {
  inventorySummary, movementReport, healthReport, balanceReport,
  agingReport, compareSnapshots,
} from './report.service.js';
import { generateSnapshot, validateSnapshot } from './snapshot.service.js';

/**
 * Report and snapshot endpoints (IMS Module M6).
 *
 * Reports are readable by anyone who may see inventory. Generating or
 * rebuilding a snapshot writes immutable history and therefore requires
 * CONFIGURE_INVENTORY, alongside the other projection-level operations.
 *
 * Every report is brand-scoped through the shared helper, and no endpoint here
 * computes an inventory value — see report.service.js.
 */

// Express parses the query string with `qs` in extended mode, so
// `?band[$ne]=Healthy` arrives as an object. Non-strings are dropped rather
// than coerced, so an operator cannot reach a filter.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};

const asDate = (value) => {
  const raw = asString(value);
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

const asInt = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

/** Shared paging + brand resolution. Returns { ctx } or { error }. */
const baseContext = (req) => {
  const brands = allowedBrands(req.user);
  if (brands.length === 0) return { empty: true };

  const brand = asString(req.query.brand);
  if (brand && !canAccessBrand(req.user, brand)) {
    return { error: { status: 403, message: 'Access to this brand is restricted for your account.' } };
  }

  return {
    ctx: {
      brands,
      brand: brand ?? null,
      category: asString(req.query.category) ?? null,
      locationCode: asString(req.query.locationCode)?.toUpperCase() ?? null,
      page: asInt(req.query.page, 1, 1, 100_000),
      limit: asInt(req.query.limit, 50, 1, 500),
    },
  };
};

const emptyReport = (extra = {}) => ({
  generatedAt: new Date(),
  rows: [],
  pagination: { total: 0, page: 1, pages: 1, limit: 0 },
  ...extra,
});

// ─── Reports ─────────────────────────────────────────────────────────────────

export const getInventorySummary = async (req, res, next) => {
  try {
    const { ctx, error, empty } = baseContext(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (empty) {
      return res.status(200).json({
        success: true,
        data: { generatedAt: new Date(), catalogueSkus: 0, totals: {}, byBrand: [], byLocation: [], valuation: { supported: false } },
      });
    }
    res.status(200).json({ success: true, data: await inventorySummary(ctx) });
  } catch (error) {
    next(error);
  }
};

export const getMovementReport = async (req, res, next) => {
  try {
    const { ctx, error, empty } = baseContext(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (empty) return res.status(200).json({ success: true, data: emptyReport({ summary: { byType: [], totalMovements: 0 } }) });

    const movementType = asString(req.query.movementType);
    if (movementType && !MOVEMENT_TYPE_NAMES.includes(movementType)) {
      return res.status(400).json({
        success: false,
        message: `Unknown movement type. Valid types: ${MOVEMENT_TYPE_NAMES.join(', ')}.`,
      });
    }

    const from = asDate(req.query.from);
    const to = asDate(req.query.to);
    if (from === null || to === null) {
      return res.status(400).json({ success: false, message: 'from/to must be valid dates.' });
    }
    if (from && to && to < from) {
      return res.status(400).json({ success: false, message: '"to" cannot be earlier than "from".' });
    }
    // Bounded so a report cannot be asked to scan the whole ledger.
    if (from && to && to - from > 366 * 86_400_000) {
      return res.status(400).json({ success: false, message: 'Date range may not exceed 366 days.' });
    }

    const userId = asString(req.query.userId);
    if (userId && !/^[a-f\d]{24}$/i.test(userId)) {
      return res.status(400).json({ success: false, message: 'userId must be a valid id.' });
    }

    const data = await movementReport({
      ...ctx,
      skuCode: asString(req.query.skuCode) ?? null,
      movementType: movementType ?? null,
      reasonCode: asString(req.query.reasonCode)?.toUpperCase() ?? null,
      referenceId: asString(req.query.referenceId) ?? null,
      referenceType: asString(req.query.referenceType) ?? null,
      userId: userId ?? null,
      // Inclusive of the whole "to" day, which is what picking a date means.
      from: from ?? null,
      to: to ? new Date(to.getTime() + 86_399_999) : null,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getHealthReport = async (req, res, next) => {
  try {
    const { ctx, error, empty } = baseContext(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (empty) return res.status(200).json({ success: true, data: emptyReport({ summary: { bands: {}, planningGaps: [] } }) });

    const band = asString(req.query.band);
    if (band && !HEALTH_BAND_NAMES.includes(band)) {
      return res.status(400).json({
        success: false,
        message: `Unknown health band. Valid bands: ${HEALTH_BAND_NAMES.join(', ')}.`,
      });
    }

    const plannableRaw = asString(req.query.plannable);
    const plannable = plannableRaw === 'true' ? true : plannableRaw === 'false' ? false : null;

    let maxCoverageDays = null;
    if (req.query.maxCoverageDays !== undefined) {
      const n = Number(req.query.maxCoverageDays);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ success: false, message: 'maxCoverageDays must be zero or greater.' });
      }
      maxCoverageDays = n;
    }

    res.status(200).json({
      success: true,
      data: await healthReport({ ...ctx, band: band ?? null, plannable, maxCoverageDays }),
    });
  } catch (error) {
    next(error);
  }
};

export const getBalanceReport = async (req, res, next) => {
  try {
    const { ctx, error, empty } = baseContext(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (empty) return res.status(200).json({ success: true, data: emptyReport({ summary: {} }) });

    res.status(200).json({
      success: true,
      data: await balanceReport({
        ...ctx,
        skuCode: asString(req.query.skuCode) ?? null,
        nonZeroOnly: ['true', '1'].includes(String(req.query.nonZeroOnly)),
      }),
    });
  } catch (error) {
    next(error);
  }
};

export const getAgingReport = async (req, res, next) => {
  try {
    const { ctx, error, empty } = baseContext(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (empty) return res.status(200).json({ success: true, data: emptyReport({ buckets: [], deadStock: {} }) });

    res.status(200).json({ success: true, data: await agingReport(ctx) });
  } catch (error) {
    next(error);
  }
};

// ─── Snapshots ───────────────────────────────────────────────────────────────

/** GET /reports/snapshots — the snapshot catalogue. */
export const listSnapshots = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) {
      return res.status(200).json({ success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 } });
    }

    const filter = {};
    const status = asString(req.query.status);
    if (status) {
      if (!['running', 'complete', 'failed', 'superseded'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status filter.' });
      }
      filter.status = status;
    } else {
      // The catalogue shows usable snapshots by default; superseded and failed
      // runs are history and must be asked for.
      filter.status = 'complete';
    }

    // A brand-scoped run is only meaningful to someone who can see that brand.
    filter.$or = [{ scopeBrand: null }, { scopeBrand: { $in: brands } }];

    const limit = asInt(req.query.limit, 50, 1, 200);
    const page = asInt(req.query.page, 1, 1, 10_000);

    const [rows, total] = await Promise.all([
      SnapshotRun.find(filter)
        .sort({ snapshotDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('user', 'user email')
        .lean(),
      SnapshotRun.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        runId: r.runId,
        snapshotDate: r.snapshotDate,
        trigger: r.trigger,
        frequency: r.frequency,
        status: r.status,
        scopeBrand: r.scopeBrand,
        rowCount: r.rowCount,
        skuCount: r.skuCount,
        totals: r.totals,
        bandCounts: r.bandCounts,
        missingHealthCount: r.missingHealthCount,
        healthComputedOldest: r.healthComputedOldest,
        durationMs: r.durationMs,
        supersededBy: r.supersededBy,
        createdAt: r.createdAt,
        user: r.user ? { name: r.user.user || r.user.email } : null,
      })),
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /reports/snapshots/:runId — one snapshot's rows. */
export const getSnapshot = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const run = await SnapshotRun.findOne({ runId: req.params.runId }).lean();
    if (!run) return res.status(404).json({ success: false, message: 'Snapshot not found' });
    if (run.scopeBrand && !brands.includes(run.scopeBrand)) {
      // 404 rather than 403, so run ids cannot be probed.
      return res.status(404).json({ success: false, message: 'Snapshot not found' });
    }

    const limit = asInt(req.query.limit, 50, 1, 500);
    const page = asInt(req.query.page, 1, 1, 100_000);

    const filter = { runId: run.runId, brand: { $in: brands } };
    const band = asString(req.query.band);
    if (band) {
      if (!HEALTH_BAND_NAMES.includes(band)) {
        return res.status(400).json({ success: false, message: 'Unknown health band.' });
      }
      filter.band = band;
    }
    const skuCode = asString(req.query.skuCode);
    if (skuCode) filter.skuCode = skuCode;

    const [rows, total] = await Promise.all([
      InventorySnapshot.find(filter).sort({ skuCode: 1, locationCode: 1 })
        .skip((page - 1) * limit).limit(limit).lean(),
      InventorySnapshot.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: { run, rows },
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /reports/snapshots — generate. Requires CONFIGURE_INVENTORY. */
export const createSnapshot = async (req, res, next) => {
  try {
    const brand = asString(req.body?.brand);
    if (brand && !canAccessBrand(req.user, brand)) {
      return res.status(403).json({ success: false, message: 'Access to this brand is restricted for your account.' });
    }

    let snapshotDate = null;
    if (req.body?.snapshotDate) {
      snapshotDate = new Date(req.body.snapshotDate);
      if (Number.isNaN(snapshotDate.getTime())) {
        return res.status(400).json({ success: false, message: 'snapshotDate is not a valid date.' });
      }
      // A snapshot dated in the future would be indistinguishable from a
      // present-state capture and would corrupt any comparison ordering.
      if (snapshotDate.getTime() > Date.now() + 86_400_000) {
        return res.status(400).json({ success: false, message: 'snapshotDate cannot be in the future.' });
      }
    }

    const frequency = asString(req.body?.frequency) || 'adhoc';
    if (!['daily', 'weekly', 'monthly', 'adhoc'].includes(frequency)) {
      return res.status(400).json({ success: false, message: 'frequency must be daily, weekly, monthly or adhoc.' });
    }

    const result = await generateSnapshot({
      snapshotDate,
      brand: brand ?? null,
      frequency,
      rebuild: req.body?.rebuild === true,
      actor: req.user,
      req,
    });

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        success: false, message: error.message, code: error.code, existingRunId: error.existingRunId,
      });
    }
    next(error);
  }
};

/** GET /reports/snapshots/:runId/validate — integrity check. */
export const getSnapshotValidation = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await validateSnapshot(req.params.runId) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

/** GET /reports/snapshot-comparison?from=SNP-…&to=SNP-… */
export const getSnapshotComparison = async (req, res, next) => {
  try {
    const { ctx, error, empty } = baseContext(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (empty) {
      return res.status(200).json({ success: true, data: { generatedAt: new Date(), summary: {}, changes: [] } });
    }

    const runIdA = asString(req.query.from);
    const runIdB = asString(req.query.to);
    if (!runIdA || !runIdB) {
      return res.status(400).json({ success: false, message: 'Both "from" and "to" snapshot run ids are required.' });
    }
    if (runIdA === runIdB) {
      return res.status(400).json({ success: false, message: 'Choose two different snapshots to compare.' });
    }

    const data = await compareSnapshots({
      runIdA, runIdB,
      brands: ctx.brands,
      brand: ctx.brand,
      changedOnly: !['false', '0'].includes(String(req.query.changedOnly)),
      limit: asInt(req.query.limit, 500, 1, 2000),
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

export default {
  getInventorySummary, getMovementReport, getHealthReport, getBalanceReport,
  getAgingReport, listSnapshots, getSnapshot, createSnapshot,
  getSnapshotValidation, getSnapshotComparison,
};
