/**
 * Direct stock adjustment endpoints — IMS.
 *
 * Thin. Brand access, then the service, then the things that make the change
 * visible everywhere at once: the dashboard cache is dropped and a socket event
 * is broadcast so screens already open re-read rather than showing a figure
 * that is now wrong.
 */

import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { adjustStock, previewAdjustment, adjustmentReasonCodes } from './adjustment.service.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

// Express parses the query string with `qs` in extended mode, so
// `?brand[$ne]=Koken` arrives as an object. Anything that is not a plain string
// is dropped rather than coerced, so an operator can never reach a filter.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};

/** Resolve the brand to act on, refusing anything outside the user's access. */
const resolveBrand = (req, raw) => {
  const brands = allowedBrands(req.user);
  if (brands.length === 0) {
    const err = new Error('Your account has no brand access.');
    err.status = 403;
    err.code = 'NO_BRAND_ACCESS';
    throw err;
  }

  const brand = asString(raw);
  if (!brand) {
    const err = new Error('A brand is required.');
    err.status = 400;
    throw err;
  }
  if (!canAccessBrand(req.user, brand)) {
    // 404 rather than 403 — confirming a SKU exists in a brand the caller
    // cannot see is itself a disclosure.
    const err = new Error(`${asString(req.params.sku) ?? 'That SKU'} was not found.`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  return brand;
};

/**
 * GET /api/v1/inventory/items/:sku/adjust
 * Current position + reason codes, for the adjustment dialog. Writes nothing.
 */
export const getAdjustmentPreview = async (req, res, next) => {
  try {
    const brand = resolveBrand(req, req.query.brand);
    const data = await previewAdjustment({
      skuCode: req.params.sku,
      brand,
      locationCode: asString(req.query.locationCode) ?? null,
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/inventory/adjustments/reason-codes */
export const getReasonCodes = async (req, res, next) => {
  try {
    const brand = asString(req.query.brand);
    if (brand && !canAccessBrand(req.user, brand)) {
      return res.json({ success: true, data: [] });
    }
    res.json({ success: true, data: await adjustmentReasonCodes({ brand: brand ?? null }) });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/inventory/items/:sku/adjust
 * Posts an ADJUSTMENT movement and re-projects balance and health.
 */
export const postAdjustment = async (req, res, next) => {
  try {
    const brand = resolveBrand(req, req.body?.brand);

    const result = await adjustStock({
      skuCode: req.params.sku,
      brand,
      locationCode: req.body?.locationCode ?? null,
      mode: req.body?.mode ?? 'set',
      quantity: typeof req.body?.quantity === 'string' ? Number(req.body.quantity) : req.body?.quantity,
      reasonCode: req.body?.reasonCode,
      note: req.body?.note ?? null,
      actor: req.user,
      req,
    });

    // The dashboard is served from a cache, so without this the headline
    // figures would keep reporting the pre-adjustment position.
    invalidateDashboardCache();

    // Screens already open elsewhere re-read on this. Deliberately carries the
    // new figures rather than a bare "something changed", so a list can patch
    // one row instead of refetching a page.
    req.app.get('io')?.emit('inventory:stock-updated', {
      skuCode: result.skuCode,
      brand: result.brand,
      locationCode: result.locationCode,
      onHand: result.after,
      delta: result.delta,
      band: result.health?.band ?? null,
      by: req.user?.name ?? null,
    });

    res.status(201).json({
      success: true,
      message:
        `${result.skuCode} at ${result.locationCode}: ${result.before} → ${result.after} ` +
        `(${result.delta > 0 ? '+' : ''}${result.delta}).`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export default { postAdjustment, getAdjustmentPreview, getReasonCodes };
