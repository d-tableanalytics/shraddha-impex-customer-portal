import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { Product } from '../../models/Product.js';
import StockBalance from '../../models/StockBalance.js';
import { getActivity, getStockSummary, ACTIVITY_TYPES } from './activity.service.js';

/**
 * SKU Activity Log — read endpoints.
 *
 * Read-only, like the ledger it projects. Nothing here can write, so adding the
 * screen cannot change a single stock figure.
 *
 * Brand scope is applied in the service, not here, so a caller that forgets to
 * pass it gets an empty list rather than another brand's history.
 */

// Express parses the query string with `qs` in extended mode, so
// `?activityType[$ne]=ISSUE` arrives as an object. Anything that is not a plain
// string is dropped rather than coerced, so it can never reach a Mongo filter
// as an operator.
const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};

/** Parse a date query param. Returns undefined for absent, null for invalid. */
const asDate = (value) => {
  const raw = asString(value);
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

const VALID_TYPES = new Set(ACTIVITY_TYPES.map((t) => t.type));

/**
 * Shared query parsing.
 *
 * `limit` is capped at 100. The feed merges two paginated sources by
 * over-fetching `skip + limit` from each (see activity.service.js), so an
 * uncapped limit or an unbounded page would turn one request into two
 * collection scans.
 */
const parse = (req, { defaultLimit = 20 } = {}) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || defaultLimit, 1), 100);
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 500);

  const activityType = asString(req.query.activityType);
  if (activityType && !VALID_TYPES.has(activityType)) {
    return {
      error: {
        status: 400,
        message: `Unknown activity type. Valid types: ${[...VALID_TYPES].join(', ')}.`,
      },
    };
  }

  const from = asDate(req.query.from);
  const to = asDate(req.query.to);
  if (from === null || to === null) {
    return { error: { status: 400, message: 'from/to must be valid dates.' } };
  }
  if (from && to && to.getTime() < from.getTime()) {
    return { error: { status: 400, message: '"to" cannot be earlier than "from".' } };
  }

  return {
    query: {
      activityType: activityType || null,
      from: from || null,
      // Inclusive of the whole "to" day, which is what a user picking a date
      // means — the same rule the ledger filter uses.
      to: to ? new Date(to.getTime() + 86_399_999) : null,
      page,
      limit,
    },
  };
};

/**
 * GET /api/v1/inventory/activity
 * The cross-SKU feed: what has happened across every SKU this user may see.
 */
export const listActivity = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const { query, error } = parse(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const brand = asString(req.query.brand);
    if (brand && !canAccessBrand(req.user, brand)) {
      return res.status(403).json({
        success: false, message: 'Access to this brand is restricted for your account.',
      });
    }

    const result = await getActivity({
      ...query,
      skuCode: asString(req.query.skuCode) || null,
      brands: brand ? [brand] : brands,
    });

    res.status(200).json({
      success: true,
      data: result.records,
      pagination: {
        total: result.total, page: result.page, pages: result.pages, limit: result.limit,
      },
    });
  } catch (error) { next(error); }
};

/**
 * GET /api/v1/inventory/items/:sku/activity
 *
 * One SKU's history, newest first. Defaults to the latest 20 — the brief's
 * "most recent 20 activity records" — and pages through the complete history
 * from the same endpoint, because "show me everything" is the same question
 * with a bigger answer, not a different screen.
 */
export const getSkuActivity = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const { query, error } = parse(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const skuCode = req.params.sku;

    // The product is looked up so the header can name the material, and so an
    // inaccessible brand 404s here rather than silently returning an empty
    // history that reads as "this SKU has never moved".
    const product = await Product.findOne({ skuCode }, 'skuCode description brand uom').lean();
    if (product && !canAccessBrand(req.user, product.brand)) {
      return res.status(404).json({ success: false, message: 'SKU not found' });
    }

    const result = await getActivity({ ...query, skuCode, brands });

    res.status(200).json({
      success: true,
      data: result.records,
      item: product
        ? {
          skuCode: product.skuCode,
          productName: product.description || null,
          brand: product.brand,
          uom: product.uom || 'PCS',
        }
        : { skuCode, productName: null, brand: null, uom: 'PCS' },
      pagination: {
        total: result.total, page: result.page, pages: result.pages, limit: result.limit,
      },
    });
  } catch (error) { next(error); }
};

/**
 * GET /api/v1/inventory/items/:sku/activity/summary
 * Opening stock, stock in, stock out, closing stock for the chosen window.
 */
export const getSkuActivitySummary = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const { query, error } = parse(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const skuCode = req.params.sku;
    const product = await Product.findOne({ skuCode }, 'brand').lean();
    if (product && !canAccessBrand(req.user, product.brand)) {
      return res.status(404).json({ success: false, message: 'SKU not found' });
    }

    const summary = await getStockSummary(skuCode, brands, { from: query.from, to: query.to });
    res.status(200).json({
      success: true,
      data: summary || {
        skuCode, openingStock: 0, stockIn: 0, stockOut: 0, closingStock: 0,
        netChange: 0, movementCount: 0, reserved: 0, available: 0, derivedFromBalance: true,
      },
    });
  } catch (error) { next(error); }
};

/**
 * GET /api/v1/inventory/activity/skus
 *
 * The SKU picker: which items have a history worth opening, most recently
 * active first. Read from the balance projection rather than by aggregating the
 * ledger — `lastMovementAt` is already maintained there, and grouping millions
 * of movements to sort a dropdown would be absurd.
 */
export const listActivitySkus = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) return res.status(200).json({ success: true, data: [] });

    const search = asString(req.query.search);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);

    const filter = { brand: { $in: brands } };
    if (search) {
      // Escaped: a SKU code may legitimately contain regex characters, and an
      // unescaped one would either throw or match far too much.
      filter.skuCode = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const rows = await StockBalance.find(
      filter, 'skuCode brand onHand reserved lastMovementAt movementCount',
    )
      .sort({ lastMovementAt: -1 })
      .limit(limit)
      .lean();

    // One lookup for the page's names, not one per row.
    const products = await Product.find(
      { skuCode: { $in: rows.map((r) => r.skuCode) } }, 'skuCode description',
    ).lean();
    const nameBySku = new Map(products.map((p) => [p.skuCode, p.description || null]));

    res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        skuCode: r.skuCode,
        productName: nameBySku.get(r.skuCode) || null,
        brand: r.brand,
        onHand: r.onHand ?? 0,
        reserved: r.reserved ?? 0,
        movementCount: r.movementCount ?? 0,
        lastActivityAt: r.lastMovementAt ?? null,
      })),
    });
  } catch (error) { next(error); }
};

/** GET /api/v1/inventory/activity/types — the filter list. */
export const listActivityTypes = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: ACTIVITY_TYPES });
  } catch (error) { next(error); }
};

export default {
  listActivity, getSkuActivity, getSkuActivitySummary, listActivitySkus, listActivityTypes,
};
