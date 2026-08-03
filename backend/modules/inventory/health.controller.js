import StockHealth, { HEALTH_BAND_NAMES, HEALTH_BANDS } from '../../models/StockHealth.js';
import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { rebuildHealth, MAX_LEVEL_FORMULAS } from './health.service.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

/**
 * Stock Health endpoints (IMS Module M4).
 *
 * Reads the `stockhealth` projection. No endpoint here computes health on the
 * fly — the projection exists precisely so that filtering and sorting by band
 * across the catalogue is served by an index rather than by application memory.
 *
 * Scope note: these are health queries, not dashboard endpoints. There is no
 * aggregate KPI payload, no trend and no chart data — those belong to M5 and
 * would be built on top of these.
 */

// Express parses the query string with `qs` in extended mode, so
// `?band[$ne]=Healthy` arrives as an object. Anything that is not a plain
// string is dropped rather than coerced, so an operator cannot reach a filter.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};

const SORT_SPECS = {
  'percent-asc': { replenishmentPercent: 1 },   // worst covered first
  'percent-desc': { replenishmentPercent: -1 },
  'coverage-asc': { coverageDays: 1 },
  'coverage-desc': { coverageDays: -1 },
  'stock-desc': { onHand: -1 },
  'stock-asc': { onHand: 1 },
  'sku-asc': { skuCode: 1 },
};

/** Rounded for display; the stored value keeps full precision for comparison. */
const round = (v, dp = 2) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? null
    : Math.round(v * 10 ** dp) / 10 ** dp;

const shapeHealth = (h) => ({
  skuCode: h.skuCode,
  brand: h.brand,
  // Balance snapshot the classification was made against.
  onHand: h.onHand,
  reserved: h.reserved,
  available: h.available,
  // Derived planning levels.
  maxLevel: round(h.maxLevel),
  reorderLevel: round(h.reorderLevel),
  safetyStock: round(h.safetyStock),
  // Derived measures.
  replenishmentPercent: round(h.replenishmentPercent),
  salesCoveragePercent: round(h.salesCoveragePercent),
  coverageDays: round(h.coverageDays, 1),
  // Classification.
  band: h.band,
  plannable: h.plannable,
  notPlannableReasons: h.notPlannableReasons || [],
  // Provenance — so a band can be explained rather than merely displayed.
  inputs: {
    dailyAvgConsumption: h.dailyAvgConsumption,
    currentSeason: h.currentSeason,
    leadTime: h.leadTime,
    safetyFactor: h.safetyFactor,
  },
  formulaVersion: h.formulaVersion,
  thresholds: h.thresholds,
  configScope: h.configScope,
  computedAt: h.computedAt,
});

/**
 * Build the brand-scoped filter shared by every list endpoint.
 * Returns { filter } or { error }.
 */
const buildFilter = (req) => {
  const brands = allowedBrands(req.user);
  if (brands.length === 0) return { filter: null };

  const filter = { brand: { $in: brands } };

  const brand = asString(req.query.brand);
  if (brand) {
    if (!canAccessBrand(req.user, brand)) {
      return { error: { status: 403, message: 'Access to this brand is restricted for your account.' } };
    }
    filter.brand = brand;
  }

  const band = asString(req.query.band);
  if (band) {
    if (!HEALTH_BAND_NAMES.includes(band)) {
      return {
        error: {
          status: 400,
          message: `Unknown health band. Valid bands: ${HEALTH_BAND_NAMES.join(', ')}.`,
        },
      };
    }
    filter.band = band;
  }

  const plannable = asString(req.query.plannable);
  if (plannable === 'true') filter.plannable = true;
  if (plannable === 'false') filter.plannable = false;

  const skuCode = asString(req.query.skuCode);
  if (skuCode) filter.skuCode = skuCode;

  return { filter };
};

/** GET /api/v1/inventory/health — paginated, filterable health list. */
/**
 * GET /api/v1/inventory/health/codes
 *
 * Every SKU code matching the current health filter. Backs the table's
 * select-all and its "export the selected rows" — the list pages at 200, so
 * without this "everything matching" would be dozens of round trips for a
 * question the filter already answers once.
 *
 * Shares buildFilter with the list above, so the selection can never be a
 * different set from what the table is showing.
 */
const SELECT_ALL_MAX = 10000;

export const listHealthCodes = async (req, res, next) => {
  try {
    const { filter, error } = buildFilter(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (!filter) return res.status(200).json({ success: true, data: [], total: 0 });

    const total = await StockHealth.countDocuments(filter);
    if (total > SELECT_ALL_MAX) {
      return res.status(413).json({
        success: false,
        code: 'TOO_MANY_MATCHES',
        message: `${total.toLocaleString()} SKUs match this filter, which is more than the `
          + `${SELECT_ALL_MAX.toLocaleString()} that can be selected at once. Narrow the filter first.`,
      });
    }

    const rows = await StockHealth.find(filter, 'skuCode').sort({ skuCode: 1 }).lean();
    res.status(200).json({
      success: true,
      data: rows.map((r) => r.skuCode).filter(Boolean),
      total,
    });
  } catch (error) { next(error); }
};

export const listHealth = async (req, res, next) => {
  try {
    const { filter, error } = buildFilter(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (!filter) {
      return res.status(200).json({
        success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 }, bandCounts: {},
      });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const sort = SORT_SPECS[asString(req.query.sort)] || SORT_SPECS['sku-asc'];

    // Band counts describe the FILTERED brand scope, not the current band
    // filter — otherwise selecting "Critical" would report every other band as
    // zero and the summary would be useless for navigating.
    const countFilter = { ...filter };
    delete countFilter.band;

    const [rows, total, counts] = await Promise.all([
      StockHealth.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      StockHealth.countDocuments(filter),
      StockHealth.aggregate([
        { $match: countFilter },
        { $group: { _id: '$band', n: { $sum: 1 } } },
      ]),
    ]);

    const bandCounts = Object.fromEntries(HEALTH_BAND_NAMES.map((b) => [b, 0]));
    for (const c of counts) bandCounts[c._id] = c.n;

    res.status(200).json({
      success: true,
      data: rows.map(shapeHealth),
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
      bandCounts,
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/inventory/health/:sku — one SKU, with its full derivation. */
export const getHealthBySku = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const row = await StockHealth.findOne({
      skuCode: req.params.sku,
      brand: { $in: brands },
    }).lean();

    // 404 rather than 403 for an inaccessible brand, so the endpoint cannot be
    // used to probe which SKUs exist.
    if (!row) {
      return res.status(404).json({
        success: false,
        message: 'No health record for this SKU. It may not have been projected yet.',
      });
    }

    res.status(200).json({ success: true, data: shapeHealth(row) });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/inventory/health/reorder/list
 * SKUs at or below their reorder level, worst covered first.
 *
 * Excludes Unknown-band and unplannable SKUs — a target that cannot be derived
 * cannot be breached, and including them would bury the real signal.
 */
export const getReorderList = async (req, res, next) => {
  try {
    const { filter, error } = buildFilter(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (!filter) return res.status(200).json({ success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 } });

    // At or below reorder level. Both bands qualify: Out of Stock is the most
    // urgent case of needing to reorder, not a separate concern.
    filter.plannable = true;
    filter.band = { $in: [HEALTH_BANDS.OUT_OF_STOCK, HEALTH_BANDS.CRITICAL] };

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const [rows, total] = await Promise.all([
      StockHealth.find(filter)
        .sort({ replenishmentPercent: 1, skuCode: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      StockHealth.countDocuments(filter),
    ]);

    // Suggested quantity brings stock back to target. Rounded up to a whole
    // unit — a purchase order cannot ask for a fraction of a socket.
    const data = rows.map((r) => ({
      ...shapeHealth(r),
      suggestedQuantity: r.maxLevel ? Math.max(0, Math.ceil(r.maxLevel - r.onHand)) : null,
    }));

    res.status(200).json({
      success: true,
      data,
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/inventory/health/overstock/list — above target. */
export const getOverstockList = async (req, res, next) => {
  try {
    const { filter, error } = buildFilter(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (!filter) return res.status(200).json({ success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 } });

    filter.band = HEALTH_BANDS.OVERSTOCK;

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const [rows, total] = await Promise.all([
      StockHealth.find(filter)
        .sort({ replenishmentPercent: -1, skuCode: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      StockHealth.countDocuments(filter),
    ]);

    const data = rows.map((r) => ({
      ...shapeHealth(r),
      // How far above target, in units — the capital-tied-up figure.
      excessQuantity: r.maxLevel ? Math.max(0, Math.ceil(r.onHand - r.maxLevel)) : null,
    }));

    res.status(200).json({
      success: true,
      data,
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/inventory/health/coverage/lookup?maxDays=30
 * SKUs whose days-of-cover falls below a threshold. Answers the buyer's real
 * question — "what runs out before my lead time?" — which a percentage cannot.
 */
export const getCoverage = async (req, res, next) => {
  try {
    const { filter, error } = buildFilter(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (!filter) return res.status(200).json({ success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 } });

    const maxDays = Number(req.query.maxDays);
    if (!Number.isFinite(maxDays) || maxDays < 0) {
      return res.status(400).json({
        success: false,
        message: 'maxDays must be a number greater than or equal to zero.',
      });
    }

    filter.plannable = true;
    filter.coverageDays = { $lte: maxDays };

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const [rows, total] = await Promise.all([
      StockHealth.find(filter).sort({ coverageDays: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      StockHealth.countDocuments(filter),
    ]);

    const data = rows.map((r) => ({
      ...shapeHealth(r),
      // The number that makes coverage actionable: cover minus lead time. A
      // negative value means the SKU runs out before a replacement can arrive.
      daysAfterLeadTime: r.leadTime ? round(r.coverageDays - r.leadTime, 1) : null,
    }));

    res.status(200).json({
      success: true,
      data,
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/inventory/health/rebuild
 * Recomputes the projection. Defaults to a dry run — a full rebuild rewrites
 * every row, so it must be asked for explicitly rather than triggered by an
 * empty body.
 */
export const rebuild = async (req, res, next) => {
  try {
    const scope = {};
    const skuCode = asString(req.body?.skuCode);
    const brand = asString(req.body?.brand);

    if (skuCode) scope.skuCode = skuCode;
    if (brand) {
      if (!canAccessBrand(req.user, brand)) {
        return res.status(403).json({
          success: false, message: 'Access to this brand is restricted for your account.',
        });
      }
      scope.brand = brand;
    }

    const dryRun = req.body?.apply !== true;
    const result = await rebuildHealth(scope, { dryRun, actor: req.user, req });

    // The dashboard reads this projection, so a rebuild must not leave it
    // serving pre-rebuild numbers for the rest of the cache window.
    if (!dryRun) invalidateDashboardCache();

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/inventory/health/meta/formulas — the available strategies. */
export const listFormulas = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        formulas: Object.entries(MAX_LEVEL_FORMULAS).map(([version, f]) => ({
          version,
          label: f.label,
          providesSafetyStock: f.safetyStock({ dac: 1, leadTime: 1, safetyFactor: 1 }) !== null,
        })),
        bands: HEALTH_BAND_NAMES,
      },
    });
  } catch (error) {
    next(error);
  }
};

export default {
  listHealth, getHealthBySku, getReorderList, getOverstockList,
  getCoverage, rebuild, listFormulas,
};
