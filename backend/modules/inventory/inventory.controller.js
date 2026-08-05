import { Product } from '../../models/Product.js';
import StockBalance from '../../models/StockBalance.js';
import StockHealth from '../../models/StockHealth.js';
import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { recordAudit } from '../../utils/auditLog.js';
import { msilAppliesTo } from '../../utils/msilVisibility.js';
import { prefixMatch } from '../../utils/searchQuery.js';
import { recomputeHealthForSkus } from './health.service.js';

/**
 * Inventory master reads and planning-parameter maintenance (Module M1).
 *
 * This is the unified replacement for the per-brand product endpoints. Because
 * all three brands now live in one collection, brand scoping is a single `$in`
 * clause and paging is done by the database — the previous implementation had
 * to fetch (skip + limit) rows from each of three collections, concatenate,
 * re-sort in JavaScript and slice.
 *
 * Deliberately NOT here (later modules own them):
 *   • balances and movements   → M3
 *   • Max Level, %, health band → M4
 * The list therefore reports quantities from the legacy product fields and no
 * health at all. Adding a half-computed band now would be worse than none.
 */

// Sort keys accepted by the list, mapped to Mongo sort specs. Allow-listed so a
// caller cannot sort by an unindexed field and table-scan the collection.
const SORT_SPECS = {
  'sku-asc': { skuCode: 1 },
  'sku-desc': { skuCode: -1 },
  // `_available` is computed by the aggregation below, not stored on the
  // product — the old spec sorted by `availableForSale`, a product field the
  // ledger stopped updating at go-live.
  'stock-asc': { _available: 1 },
  'stock-desc': { _available: -1 },
  'updated-desc': { updatedAt: -1 },
};

/** Sorts that need the balance projection joined in before paging. */
const STOCK_SORTS = new Set(['stock-asc', 'stock-desc']);

/**
 * Balances for one page of products, summed across locations.
 *
 * A SKU may hold stock in several locations while this list has one row per
 * SKU, so the figures are totals — matching what the Health screen shows.
 */
const balancesForPage = async (docs) => {
  const skus = [...new Set(docs.map((d) => d.skuCode).filter(Boolean))];
  if (skus.length === 0) return new Map();

  const rows = await StockBalance.aggregate([
    { $match: { skuCode: { $in: skus } } },
    {
      $group: {
        _id: { skuCode: '$skuCode', brand: '$brand' },
        onHand: { $sum: '$onHand' },
        reserved: { $sum: '$reserved' },
        incoming: { $sum: '$incoming' },
      },
    },
  ]);
  return new Map(rows.map((r) => [`${r._id.skuCode}::${r._id.brand}`, r]));
};

// Fields a caller may change through the master API. Everything else is either
// identity that must not drift or a balance that only the stock ledger may
// touch (BR-03) — passing req.body wholesale to the model is what let an admin
// write the four stock counters into an inconsistent state before.
const PLANNING_FIELDS = [
  'description',
  'uom',
  'itemParameter',
  'currentSeason',
  'leadTime',
  'safetyFactor',
  'moq',
  'boxNo',
  'vendorName',
  'status',
  'category',
];

// Nested planning inputs, handled separately so a partial update does not wipe
// the siblings it did not mention.
const DAC_KEYS = ['low', 'normal', 'peak'];

// Non-negative numerics. Zero is meaningful (it means "not set" for lead time
// and safety factor), negatives never are.
const NUMERIC_FIELDS = ['leadTime', 'safetyFactor', 'moq'];

// Derived from the schema so the API and the model can never disagree about
// what a valid value is.
const PRODUCT_STATUSES = Product.schema.path('status').enumValues;
const SEASONS = Product.schema.path('currentSeason').enumValues.filter(Boolean);

/**
 * Coerce a query-string value to a plain string, or undefined.
 *
 * Express parses the query string with `qs` in extended mode, so
 * `?status[$ne]=Active` arrives as the OBJECT `{ $ne: 'Active' }`. Assigning
 * that straight into a Mongo filter injects an operator. Every value that
 * reaches a query must pass through here first — `sort` is allow-listed and
 * `limit`/`page` go through Number(), which are equally safe, but anything
 * free-text needs this.
 */
const asString = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  // Arrays and objects are the injection shapes — reject rather than coerce,
  // so `?category[$ne]=x` becomes "no category filter" and never an operator.
  return undefined;
};

/**
 * Shape a product document for the API.
 *
 * Balances come from M3's projection, passed in by the caller. They used to be
 * read from the product's own `totalAvailableQuantity`/`bookedQuantity`, which
 * no workflow has updated since the ledger went live — so a stock adjustment
 * posted from this very screen left the row showing its pre-adjustment figure
 * while Health and Ledger showed the truth.
 *
 * `available` is computed, never stored, because storing it creates a third
 * number that can disagree with the other two.
 */
const shapeItem = (doc, { showMsil, balance = null }) => {
  const onHand = balance?.onHand ?? 0;
  const reserved = balance?.reserved ?? 0;
  return {
    id: doc._id,
    skuCode: doc.skuCode,
    msilCode: showMsil ? (doc.msilCode || null) : null,
    brand: doc.brand,
    description: doc.description || null,
    category: Array.isArray(doc.category) ? doc.category : [],
    uom: doc.uom || 'PCS',
    status: doc.status,
    moq: doc.moq ?? 0,
    boxNo: doc.boxNo || null,
    vendorName: doc.vendorName || null,
    // Planning inputs — the values M4 will derive Max Level from.
    planning: {
      dailyAvgConsumption: {
        low: doc.dailyAvgConsumption?.low ?? 0,
        normal: doc.dailyAvgConsumption?.normal ?? 0,
        peak: doc.dailyAvgConsumption?.peak ?? 0,
      },
      currentSeason: doc.currentSeason || null,
      leadTime: doc.leadTime ?? 0,
      safetyFactor: doc.safetyFactor ?? 0,
      itemParameter: doc.itemParameter || null,
    },
    // From the balance projection (M3) — the ledger's own running total.
    balances: {
      onHand,
      reserved,
      available: onHand - reserved,
      inTransit: balance?.incoming ?? 0,
    },
    // Whether this SKU has the inputs a health calculation needs. Computed here
    // rather than stored — M4 owns the real projection with its reason list.
    // Surfaced now because ~90% of the catalogue is missing these, and the list
    // is unusable without a way to see which rows are plannable.
    hasPlanningInputs: Boolean(
      (doc.leadTime ?? 0) > 0 &&
      (doc.dailyAvgConsumption?.[String(doc.currentSeason || 'Normal').toLowerCase()] ?? 0) > 0,
    ),
    updatedAt: doc.updatedAt,
  };
};

/** Ceiling on one lookup. Large enough for a real sheet, bounded all the same. */
const LOOKUP_MAX = 5000;

/**
 * POST /api/v1/inventory/items/lookup
 *
 * Given a list of SKU codes, report what the catalogue holds for each.
 *
 * READ ONLY. Nothing is created, nothing is staged, no import job exists — this
 * answers "what have I actually got for these codes" and stops there. It is
 * deliberately NOT the import pipeline: that one writes, and a person checking a
 * supplier's list against their own stock should not have to go near something
 * that can change it.
 *
 * A code that is not in the catalogue is RETURNED, marked as missing, rather
 * than dropped. Silence would read as "found it, zero stock", which is the one
 * answer this must never give by accident.
 */
export const lookupItems = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) return res.status(200).json({ success: true, data: [], summary: null });

    const raw = Array.isArray(req.body?.skuCodes) ? req.body.skuCodes : null;
    if (!raw || raw.length === 0) {
      return res.status(400).json({ success: false, message: 'Send a skuCodes array.' });
    }

    // Order is preserved so the preview reads in the order of the uploaded file.
    const seen = new Set();
    const codes = [];
    for (const c of raw) {
      const code = typeof c === 'string' ? c.trim() : String(c ?? '').trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
      if (codes.length >= LOOKUP_MAX) break;
    }
    if (codes.length === 0) {
      return res.status(400).json({ success: false, message: 'No usable SKU codes were found in the file.' });
    }

    const showMsil = msilAppliesTo(req.user);
    const [products, balances, health] = await Promise.all([
      Product.find(
        { skuCode: { $in: codes }, brand: { $in: brands } },
        'skuCode brand msilCode description uom status',
      ).lean(),
      StockBalance.aggregate([
        { $match: { skuCode: { $in: codes }, brand: { $in: brands } } },
        { $group: { _id: '$skuCode', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
      ]),
      StockHealth.find({ skuCode: { $in: codes }, brand: { $in: brands } }, 'skuCode band').lean(),
    ]);

    const P = new Map(products.map((p) => [p.skuCode, p]));
    const B = new Map(balances.map((b) => [b._id, b]));
    const H = new Map(health.map((h) => [h.skuCode, h]));

    const data = codes.map((code) => {
      const p = P.get(code);
      if (!p) return { skuCode: code, found: false };
      const b = B.get(code);
      const onHand = b?.onHand ?? 0;
      const reserved = b?.reserved ?? 0;
      return {
        skuCode: code,
        found: true,
        brand: p.brand,
        msilCode: showMsil ? (p.msilCode || null) : null,
        description: p.description || null,
        uom: p.uom || 'PCS',
        status: p.status,
        onHand,
        reserved,
        available: onHand - reserved,
        band: H.get(code)?.band ?? null,
      };
    });

    const found = data.filter((d) => d.found);
    res.status(200).json({
      success: true,
      data,
      summary: {
        requested: raw.length,
        unique: codes.length,
        found: found.length,
        missing: data.length - found.length,
        totalAvailable: found.reduce((n, d) => n + d.available, 0),
        truncated: raw.length > LOOKUP_MAX,
      },
    });
  } catch (error) { next(error); }
};

/**
 * GET /api/v1/inventory/items
 * Paginated, filtered inventory list across every brand the caller may see.
 */
/**
 * Build the product query from the request's filters.
 *
 * Shared by the list and the select-all codes endpoint, so "everything matching
 * my filter" can never mean something different from what the table is showing.
 *
 * Returns { query } on success, or { error } describing what to send back.
 */
const buildItemQuery = (req) => {
  const brands = allowedBrands(req.user);
  // A user with no brand access matches nothing rather than everything — the
  // same deliberate choice brandFilter() makes.
  if (brands.length === 0) return { empty: true };

  const showMsil = msilAppliesTo(req.user);
  const query = { brand: { $in: brands } };

  const brandParam = asString(req.query.brand);
  if (brandParam) {
    // Reject rather than silently ignore a brand the caller cannot see.
    if (!canAccessBrand(req.user, brandParam)) {
      return { error: { status: 403, message: 'Access to this brand is restricted for your account.' } };
    }
    query.brand = brandParam;
  }

  const category = asString(req.query.category);
  if (category) query.category = category;

  // Enum-constrained, so validate rather than trust — an unrecognised value is
  // a client error, not something to silently ignore.
  const status = asString(req.query.status);
  if (status) {
    if (!PRODUCT_STATUSES.includes(status)) {
      return { error: { status: 400, message: `Status must be one of: ${PRODUCT_STATUSES.join(', ')}.` } };
    }
    query.status = status;
  }

  const search = asString(req.query.search);
  const anchored = prefixMatch(search);
  if (anchored) {
    query.$or = [{ skuCode: anchored }];
    if (showMsil) query.$or.push({ msilCode: anchored });
  }

  return { query, showMsil, filtered: Boolean(search || category || status || brandParam) };
};

/**
 * GET /api/v1/inventory/items/codes
 *
 * Every SKU code matching the current filter, and nothing else. This is what
 * the table's select-all checkbox uses: the list endpoint pages at 200, so
 * without this "select everything matching" would mean 40+ round trips to
 * learn what the user already asked for in one filter.
 */
export const listItemCodes = async (req, res, next) => {
  try {
    const built = buildItemQuery(req);
    if (built.empty) return res.status(200).json({ success: true, data: [], total: 0 });
    if (built.error) {
      return res.status(built.error.status).json({ success: false, message: built.error.message });
    }

    const total = await Product.countDocuments(built.query);
    if (total > SELECT_ALL_MAX) {
      return res.status(413).json({
        success: false,
        code: 'TOO_MANY_MATCHES',
        message: `${total.toLocaleString()} SKUs match this filter, which is more than the `
          + `${SELECT_ALL_MAX.toLocaleString()} that can be selected at once. Narrow the filter first.`,
      });
    }

    const rows = await Product.find(built.query, 'skuCode').sort({ skuCode: 1 }).lean();
    res.status(200).json({
      success: true,
      data: rows.map((r) => r.skuCode).filter(Boolean),
      total,
    });
  } catch (error) {
    next(error);
  }
};

export const listItems = async (req, res, next) => {
  try {
    const built = buildItemQuery(req);
    if (built.empty) {
      return res.status(200).json({
        success: true,
        data: [],
        pagination: { total: 0, page: 1, pages: 1, limit: 0 },
        totals: { catalogue: 0 },
      });
    }
    if (built.error) {
      return res.status(built.error.status).json({ success: false, message: built.error.message });
    }
    const { query, showMsil } = built;
    const brands = allowedBrands(req.user);

    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    // Allow-listed: an unknown or object-valued sort falls back to the default
    // rather than reaching the database.
    const sortSpec = SORT_SPECS[asString(req.query.sort)] || SORT_SPECS['sku-asc'];

    // Sorting by stock cannot use a product field any more — the quantities
    // live in the balance projection. Those two sorts join to it and order on
    // the joined value; every other sort paginates on the product first and
    // then fetches balances for the page only, which is one small indexed read
    // instead of a lookup across the whole catalogue.
    const byStock = STOCK_SORTS.has(asString(req.query.sort));

    const findDocs = byStock
      ? Product.aggregate([
        { $match: query },
        {
          $lookup: {
            from: 'stockbalances',
            let: { sku: '$skuCode', br: '$brand' },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ['$skuCode', '$$sku'] }, { $eq: ['$brand', '$$br'] }] } } },
              { $group: { _id: null, onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
            ],
            as: 'bal',
          },
        },
        {
          $addFields: {
            _onHand: { $ifNull: [{ $arrayElemAt: ['$bal.onHand', 0] }, 0] },
            _reserved: { $ifNull: [{ $arrayElemAt: ['$bal.reserved', 0] }, 0] },
          },
        },
        // Ordered by what is actually sellable, which is what "most stock"
        // means to someone looking at this list.
        { $addFields: { _available: { $subtract: ['$_onHand', '$_reserved'] } } },
        { $sort: { _available: sortSpec._available, skuCode: 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ])
      : Product.find(query).sort(sortSpec).skip((page - 1) * limit).limit(limit).lean();

    const [docs, total, catalogue] = await Promise.all([
      findDocs,
      Product.countDocuments(query),
      // Unfiltered count for the KPI tile — describes the catalogue, not the
      // current search. Skipped when there is no filter, since it is the same
      // number we already have.
      built.filtered
        ? Product.countDocuments({ brand: { $in: brands } })
        : Promise.resolve(null),
    ]);

    // One indexed read for the page's SKUs, summed across locations.
    const balances = await balancesForPage(docs);

    res.status(200).json({
      success: true,
      data: docs.map((d) => shapeItem(d, { showMsil, balance: balances.get(`${d.skuCode}::${d.brand}`) })),
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit) || 1,
        limit,
      },
      totals: { catalogue: catalogue ?? total },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/inventory/items/:sku
 * Single item detail. Answers 404 rather than 403 for a brand the caller cannot
 * see, so the endpoint cannot be used to probe which SKUs exist.
 */
export const getItem = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const doc = await Product.findOne({
      skuCode: req.params.sku,
      brand: { $in: brands },
    }).lean();

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({
      success: true,
      data: shapeItem(doc, { showMsil: msilAppliesTo(req.user) }),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/v1/inventory/items/:sku/planning
 *
 * Maintains the planning INPUTS. Deliberately cannot touch a balance field
 * (BR-03) — those move only through the stock ledger, and letting them be set
 * here would recreate exactly the inconsistency the audit found.
 */
export const updatePlanning = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    const doc = await Product.findOne({
      skuCode: req.params.sku,
      brand: { $in: brands },
    });

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const updates = {};
    const errors = [];

    for (const field of PLANNING_FIELDS) {
      if (!(field in req.body)) continue;
      updates[field] = req.body[field];
    }

    // Nested consumption figures, merged so a partial update keeps its siblings.
    if (req.body.dailyAvgConsumption && typeof req.body.dailyAvgConsumption === 'object') {
      for (const key of DAC_KEYS) {
        if (!(key in req.body.dailyAvgConsumption)) continue;
        const value = Number(req.body.dailyAvgConsumption[key]);
        if (!Number.isFinite(value) || value < 0) {
          errors.push(`Daily average consumption (${key}) must be zero or greater.`);
          continue;
        }
        updates[`dailyAvgConsumption.${key}`] = value;
      }
    }

    for (const field of NUMERIC_FIELDS) {
      if (!(field in updates)) continue;
      const value = Number(updates[field]);
      if (!Number.isFinite(value) || value < 0) {
        errors.push(`${field} must be a number greater than or equal to zero.`);
        continue;
      }
      updates[field] = value;
    }

    if ('currentSeason' in updates && updates.currentSeason !== null) {
      if (!SEASONS.includes(updates.currentSeason)) {
        errors.push(`Current season must be one of: ${SEASONS.join(', ')}.`);
      }
    }

    if ('status' in updates && !PRODUCT_STATUSES.includes(updates.status)) {
      errors.push(`Status must be one of: ${PRODUCT_STATUSES.join(', ')}.`);
    }

    // BR-06: a SKU still holding or owing stock cannot be retired, or its
    // balance would vanish from every report while remaining in the ledger.
    //
    // The guard is on the TARGET state and the live balance — not on the state
    // being left. An earlier version only fired when transitioning away from
    // Active, which let Inactive → Discontinued through with stock on hand.
    if (updates.status && updates.status !== 'Active') {
      // READ FROM THE M3 PROJECTION, NOT THE PRODUCT DOCUMENT.
      //
      // `totalAvailableQuantity` / `bookedQuantity` on the product are the
      // deprecated pre-M3 mirror. Since M3 the ledger owns the balance and
      // those fields are no longer maintained — they sit at zero on most rows.
      // Reading them here meant the guard was checking a value that is now
      // structurally stale, so a SKU holding real ledger stock would sail
      // through and disappear from every report while its movements remained.
      //
      // Summed across locations: the product is retired as a whole, so stock
      // anywhere blocks it.
      const [bal] = await StockBalance.aggregate([
        { $match: { skuCode: doc.skuCode, brand: doc.brand } },
        { $group: { _id: null, onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
      ]);
      const onHand = bal?.onHand ?? 0;
      const reserved = bal?.reserved ?? 0;
      if (onHand !== 0 || reserved > 0) {
        errors.push(
          `Cannot set status to ${updates.status} while stock remains ` +
          `(on hand ${onHand}, reserved ${reserved}). Clear the balance first.`,
        );
      }
    }

    if ('category' in updates) {
      updates.category = Array.isArray(updates.category)
        ? updates.category.map((c) => String(c).trim()).filter(Boolean)
        : String(updates.category).split(',').map((c) => c.trim()).filter(Boolean);
    }

    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join(' '), errors });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No editable fields supplied.' });
    }

    // Before/after detail so the trail answers "what changed", not just "it was
    // edited" — the same shape the sales controller records for booking edits.
    const before = {};
    for (const key of Object.keys(updates)) {
      before[key] = key.startsWith('dailyAvgConsumption.')
        ? doc.dailyAvgConsumption?.[key.split('.')[1]]
        : doc[key];
    }

    const updated = await Product.findOneAndUpdate(
      { _id: doc._id },
      { $set: updates },
      { new: true, runValidators: true },
    ).lean();

    await recordAudit(
      req.user,
      'Inventory Planning Updated',
      `Planning parameters updated for ${doc.brand} ${doc.skuCode}.`,
      req,
      { meta: { skuCode: doc.skuCode, brand: doc.brand, before, after: updates } },
    );

    // HEALTH TRIGGER 2 of 3 — BR-04. Lead time, consumption, season, safety
    // factor and status all feed Max Level, so an edit here changes the band.
    // Recomputed synchronously so the response the caller receives already
    // reflects the new classification.
    await recomputeHealthForSkus([doc.skuCode], { brand: doc.brand });

    res.status(200).json({
      success: true,
      data: shapeItem(updated, { showMsil: msilAppliesTo(req.user) }),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/inventory/categories
 * Distinct categories across the caller's permitted brands, for the filter.
 */
export const listCategories = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);
    if (brands.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const raw = await Product.distinct('category', { brand: { $in: brands } });
    const categories = [...new Set(raw.filter(Boolean).map((c) => String(c).trim()))].sort();

    res.status(200).json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
};

/**
 * Apply one set of planning values to many SKUs at once (Module M1).
 *
 * The case this exists for is the seasonal switch: when the season turns, every
 * SKU in a category moves from Normal to Peak together. Doing that one row at a
 * time is 400 round trips and 400 audit rows for what is a single business
 * decision.
 *
 * DELIBERATELY NARROWER THAN THE SINGLE-SKU EDIT. Only the fields that are
 * genuinely uniform across a selection can be set here — season, lead time,
 * safety factor, MOQ, status, vendor. Per-SKU identity (description, box no,
 * item parameter, category) and the consumption figures are excluded: writing
 * one consumption rate across a mixed selection would silently destroy the
 * per-SKU rates that Max Level depends on, and the damage would only surface
 * later as wrong bands.
 */
const BULK_FIELDS = ['currentSeason', 'leadTime', 'safetyFactor', 'moq', 'status', 'vendorName'];

/** How many SKUs one call may touch. Beyond this, use an import. */
const BULK_MAX = 500;

/** Ceiling on a single select-all, so one checkbox cannot pull the whole catalogue. */
const SELECT_ALL_MAX = 10000;

export const bulkUpdatePlanning = async (req, res, next) => {
  try {
    const brands = allowedBrands(req.user);

    const skuCodes = Array.isArray(req.body?.skuCodes)
      ? [...new Set(req.body.skuCodes.map((s) => String(s).trim()).filter(Boolean))]
      : [];
    if (skuCodes.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one SKU.' });
    }
    if (skuCodes.length > BULK_MAX) {
      return res.status(400).json({
        success: false,
        message: `A bulk edit is limited to ${BULK_MAX} SKUs at once. Use an import for larger changes.`,
      });
    }

    // ── Validate the single value set, once ─────────────────────────────────
    const updates = {};
    const errors = [];

    for (const field of BULK_FIELDS) {
      if (!(field in req.body)) continue;
      updates[field] = req.body[field];
    }

    for (const field of NUMERIC_FIELDS) {
      if (!(field in updates)) continue;
      const value = Number(updates[field]);
      if (!Number.isFinite(value) || value < 0) {
        errors.push(`${field} must be a number greater than or equal to zero.`);
        continue;
      }
      updates[field] = value;
    }

    if ('currentSeason' in updates && updates.currentSeason !== null
        && !SEASONS.includes(updates.currentSeason)) {
      errors.push(`Current season must be one of: ${SEASONS.join(', ')}.`);
    }
    if ('status' in updates && !PRODUCT_STATUSES.includes(updates.status)) {
      errors.push(`Status must be one of: ${PRODUCT_STATUSES.join(', ')}.`);
    }
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join(' '), errors });
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No editable fields supplied.' });
    }

    // ── Resolve the selection within the caller's brands ────────────────────
    const docs = await Product.find(
      { skuCode: { $in: skuCodes }, brand: { $in: brands } },
      'skuCode brand currentSeason leadTime safetyFactor moq status vendorName',
    ).lean();

    const found = new Set(docs.map((d) => d.skuCode));
    // Named rather than counted: "3 not updated" leaves the user guessing which.
    const skipped = skuCodes.filter((s) => !found.has(s));

    // ── BR-06, evaluated per SKU against the ledger ─────────────────────────
    // Retiring in bulk must not become a way around the guard that stops a
    // single SKU being retired with stock. One aggregate for the whole
    // selection rather than a query per row.
    const blocked = [];
    if (updates.status && updates.status !== 'Active') {
      const held = await StockBalance.aggregate([
        { $match: { skuCode: { $in: [...found] }, brand: { $in: brands } } },
        { $group: { _id: '$skuCode', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
        { $match: { $or: [{ onHand: { $ne: 0 } }, { reserved: { $gt: 0 } }] } },
      ]);
      for (const h of held) blocked.push({ skuCode: h._id, onHand: h.onHand, reserved: h.reserved });
    }
    const blockedSet = new Set(blocked.map((b) => b.skuCode));
    const targets = docs.filter((d) => !blockedSet.has(d.skuCode));

    if (targets.length === 0) {
      return res.status(400).json({
        success: false,
        message: blocked.length
          ? 'Every selected SKU still holds stock and cannot be retired.'
          : 'None of the selected SKUs are within the brands you can access.',
        blocked, skipped,
      });
    }

    const result = await Product.updateMany(
      { _id: { $in: targets.map((d) => d._id) } },
      { $set: updates },
      { runValidators: true },
    );

    // ONE audit row for one decision, carrying the per-SKU before values so the
    // change is still reversible from the trail. A row per SKU would bury the
    // fact that this was a single deliberate action.
    await recordAudit(
      req.user,
      'Inventory Planning Bulk Updated',
      `Planning parameters updated for ${result.modifiedCount} SKU(s): ` +
      `${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
      req,
      {
        meta: {
          fields: updates,
          matched: targets.length,
          modified: result.modifiedCount,
          before: targets.map((d) => {
            const prev = { skuCode: d.skuCode, brand: d.brand };
            for (const k of Object.keys(updates)) prev[k] = d[k];
            return prev;
          }),
          blocked, skipped,
        },
      },
    );

    // Every bulk field feeds Max Level, so the bands must be re-projected.
    // Grouped by brand because the projection is scoped per brand.
    const byBrand = targets.reduce((acc, d) => {
      (acc[d.brand] ||= []).push(d.skuCode);
      return acc;
    }, {});
    for (const [brand, skus] of Object.entries(byBrand)) {
      await recomputeHealthForSkus(skus, { brand });
    }

    res.status(200).json({
      success: true,
      data: {
        matched: targets.length,
        modified: result.modifiedCount,
        applied: updates,
        // Not errors — the caller asked for these and deserves to know why the
        // number it gets back is smaller than the number it sent.
        blocked,
        skipped,
      },
    });
  } catch (error) {
    next(error);
  }
};

export default { listItems, getItem, updatePlanning, bulkUpdatePlanning, listCategories };
