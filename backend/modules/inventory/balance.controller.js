import StockBalance from '../../models/StockBalance.js';
import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { rebuildBalances, getSkuBalance, getAvailability, shapeBalance } from './balance.service.js';
import { reconcile } from './reconciliation.service.js';
import { dualWriteStatus } from '../../utils/dualWrite.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

/**
 * Balance Engine endpoints (IMS Module M3).
 *
 * Reads project from `stockbalances`; the rebuild and reconciliation endpoints
 * are operational tools, not business features. Nothing here computes health,
 * targets or percentages — that is Module M4.
 *
 * Every query is brand-scoped through the shared helper. Rebuild is gated
 * behind CONFIGURE_INVENTORY because recomputing a projection is a system
 * operation, not an inventory one.
 */

// Express parses the query string with `qs` in extended mode, so
// `?brand[$ne]=Koken` arrives as an object. Anything that is not a plain string
// is dropped rather than coerced, so an operator can never reach a filter.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};

/** GET /api/v1/inventory/balances — paginated, brand-scoped balance list. */
export const listBalances = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) {
      return res.status(200).json({
        success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 },
      });
    }

    const filter = { brand: { $in: brands } };

    const brand = asString(req.query.brand);
    if (brand) {
      if (!canAccessBrand(req.user, brand)) {
        return res.status(403).json({
          success: false, message: 'Access to this brand is restricted for your account.',
        });
      }
      filter.brand = brand;
    }

    const skuCode = asString(req.query.skuCode);
    if (skuCode) filter.skuCode = skuCode;

    const locationCode = asString(req.query.locationCode);
    if (locationCode) filter.locationCode = locationCode.toUpperCase();

    // `?nonZero=true` hides the rows that exist only because something once
    // moved and came back — the default listing is otherwise mostly zeroes.
    if (['true', '1'].includes(String(req.query.nonZero))) {
      filter.$or = [{ onHand: { $ne: 0 } }, { reserved: { $ne: 0 } }];
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const [rows, total] = await Promise.all([
      StockBalance.find(filter)
        .sort({ skuCode: 1, locationCode: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      StockBalance.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: rows.map(shapeBalance),
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/inventory/balances/:sku
 * One SKU: per-location rows plus a network total.
 */
export const getBalanceBySku = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const balance = await getSkuBalance(req.params.sku, brands);

    // 404 rather than 403 for an inaccessible brand, so the endpoint cannot be
    // used to probe which SKUs exist.
    if (!balance) {
      return res.status(404).json({
        success: false,
        message: 'No balance found for this SKU. It may have no ledger history yet.',
      });
    }

    res.status(200).json({ success: true, data: balance });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/inventory/availability?skus=A,B,C
 * Batch lookup for the booking path. Capped and brand-checked.
 */
export const getAvailabilityBatch = async (req, res, next) => {
  try {
    const raw = asString(req.query.skus);
    if (!raw) {
      return res.status(400).json({ success: false, message: 'skus is required.' });
    }

    const skus = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (skus.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one SKU is required.' });
    }
    // Capped so the endpoint cannot be used to enumerate the catalogue.
    if (skus.length > 50) {
      return res.status(400).json({ success: false, message: 'A maximum of 50 SKUs may be requested at once.' });
    }

    const brands = allowedBrands(req.user);
    const locationCode = asString(req.query.locationCode);
    const balances = await getAvailability(skus, brands, locationCode?.toUpperCase() || null);

    res.status(200).json({ success: true, data: balances });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/inventory/balances/rebuild
 * Replays the ledger into the projection. `dryRun` reports what would change.
 */
export const rebuild = async (req, res, next) => {
  try {
    const scope = {};
    const skuCode = asString(req.body?.skuCode);
    const brand = asString(req.body?.brand);
    const locationCode = asString(req.body?.locationCode);

    if (skuCode) scope.skuCode = skuCode;
    if (brand) {
      if (!canAccessBrand(req.user, brand)) {
        return res.status(403).json({
          success: false, message: 'Access to this brand is restricted for your account.',
        });
      }
      scope.brand = brand;
    }
    if (locationCode) scope.locationCode = locationCode.toUpperCase();

    let asOf = null;
    if (req.body?.asOf) {
      asOf = new Date(req.body.asOf);
      if (Number.isNaN(asOf.getTime())) {
        return res.status(400).json({ success: false, message: 'asOf is not a valid date.' });
      }
    }

    // Default to a dry run. A full rebuild rewrites every projection row, so it
    // must be asked for explicitly rather than triggered by an empty body.
    const dryRun = req.body?.apply !== true;

    const result = await rebuildBalances(scope, { dryRun, asOf, actor: req.user, req });
    if (!dryRun) invalidateDashboardCache();

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/inventory/reconciliation
 * Three-way comparison: legacy vs ledger vs projection. Read-only — it never
 * corrects a value, because which side is wrong is not a report's decision.
 */
export const getReconciliation = async (req, res, next) => {
  try {
    const scope = {};
    const skuCode = asString(req.query.skuCode);
    const brand = asString(req.query.brand);

    if (skuCode) scope.skuCode = skuCode;
    if (brand) {
      if (!canAccessBrand(req.user, brand)) {
        return res.status(403).json({
          success: false, message: 'Access to this brand is restricted for your account.',
        });
      }
      scope.brand = brand;
    } else {
      // Without an explicit brand, restrict to what the caller may see.
      const brands = allowedBrands(req.user);
      if (brands.length === 0) {
        return res.status(200).json({
          success: true,
          data: { scope, summary: { tracked: 0, matched: 0, projectionDrift: 0, legacyMismatch: 0, untracked: 0 }, healthy: true, mismatches: [] },
        });
      }
    }

    const includeUntracked = ['true', '1'].includes(String(req.query.includeUntracked));
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);

    const result = await reconcile(scope, { includeUntracked, limit });

    // Surfaced alongside the numbers because it explains them: if the breaker
    // has tripped, movements were deliberately skipped and the gap is expected
    // rather than a defect to hunt.
    res.status(200).json({
      success: true,
      data: { ...result, dualWrite: dualWriteStatus() },
    });
  } catch (error) {
    next(error);
  }
};

export default {
  listBalances, getBalanceBySku, getAvailabilityBatch, rebuild, getReconciliation,
};
