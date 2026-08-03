import StockMovement, {
  MOVEMENT_TYPES, MOVEMENT_TYPE_NAMES, MOVEMENT_CLASS,
} from '../../models/StockMovement.js';
import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import StockBatch from '../../models/StockBatch.js';
import User from '../../models/User.js';
import { findBatch } from './ledger.service.js';

/**
 * Ledger read endpoints (IMS Module M2).
 *
 * Read-only. Movements are posted through LedgerService by workflows in later
 * modules; there is deliberately no HTTP route that writes to the ledger yet,
 * because no approved workflow produces movements until M7.
 *
 * Every query is brand-scoped through the shared helper, and the cross-SKU
 * search refuses to run without a narrowing filter — an unbounded scan of the
 * one collection that grows without limit is not something a client should be
 * able to ask for by accident.
 */

// Express parses the query string with `qs` in extended mode, so
// `?movementType[$ne]=ISSUE` arrives as an object. Anything that is not a plain
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

const SORTABLE = {
  'date-desc': { effectiveDate: -1, transactionId: -1 },
  'date-asc': { effectiveDate: 1, transactionId: 1 },
  'posted-desc': { postedAt: -1 },
};

// A ledger row carries everything it needs — SKU, brand and location are
// denormalised onto the movement — so listing never joins per row.
const shapeMovement = (m) => ({
  transactionId: m.transactionId,
  batchId: m.batchId,
  skuCode: m.skuCode,
  brand: m.brand,
  locationCode: m.locationCode,
  movementClass: m.movementClass,
  movementType: m.movementType,
  quantity: m.quantity,
  beforeQuantity: m.beforeQuantity,
  afterQuantity: m.afterQuantity,
  effectiveDate: m.effectiveDate,
  postedAt: m.postedAt,
  backdated: m.backdated,
  reasonCode: m.reasonCode,
  note: m.note,
  referenceType: m.referenceType,
  referenceId: m.referenceId,
  reversalOf: m.reversalOf || null,
  reversedBy: m.reversedBy || null,
  actorType: m.actorType,
  user: m.user ? { id: m.user._id, name: m.user.user || m.user.email } : null,
});

/**
 * Build the shared filter for a ledger query.
 * Returns { filter } or { error } — never a partially-built filter.
 */
const buildFilter = (req, { requireNarrowing }) => {
  const brands = allowedBrands(req.user);
  if (brands.length === 0) return { filter: null, brands };

  const filter = { brand: { $in: brands } };
  let narrowed = false;

  const brand = asString(req.query.brand);
  if (brand) {
    if (!canAccessBrand(req.user, brand)) {
      return { error: { status: 403, message: 'Access to this brand is restricted for your account.' } };
    }
    filter.brand = brand;
  }

  const skuCode = asString(req.query.skuCode);
  if (skuCode) { filter.skuCode = skuCode; narrowed = true; }

  const movementType = asString(req.query.movementType);
  if (movementType) {
    if (!MOVEMENT_TYPE_NAMES.includes(movementType)) {
      return {
        error: {
          status: 400,
          message: `Unknown movement type. Valid types: ${MOVEMENT_TYPE_NAMES.join(', ')}.`,
        },
      };
    }
    filter.movementType = movementType;
    narrowed = true;
  }

  const movementClass = asString(req.query.movementClass);
  if (movementClass) {
    if (!Object.values(MOVEMENT_CLASS).includes(movementClass)) {
      return {
        error: {
          status: 400,
          message: `Movement class must be one of: ${Object.values(MOVEMENT_CLASS).join(', ')}.`,
        },
      };
    }
    filter.movementClass = movementClass;
  }

  const reasonCode = asString(req.query.reasonCode);
  if (reasonCode) { filter.reasonCode = reasonCode.toUpperCase(); narrowed = true; }

  const locationCode = asString(req.query.locationCode);
  if (locationCode) filter.locationCode = locationCode.toUpperCase();

  const batchId = asString(req.query.batchId);
  if (batchId) { filter.batchId = batchId; narrowed = true; }

  const referenceId = asString(req.query.referenceId);
  if (referenceId) { filter.referenceId = referenceId; narrowed = true; }

  const referenceType = asString(req.query.referenceType);
  if (referenceType) filter.referenceType = referenceType;

  const userId = asString(req.query.userId);
  if (userId) {
    if (!/^[a-f\d]{24}$/i.test(userId)) {
      return { error: { status: 400, message: 'userId must be a valid id.' } };
    }
    filter.user = userId;
    narrowed = true;
  }

  const from = asDate(req.query.from);
  const to = asDate(req.query.to);
  if (from === null || to === null) {
    return { error: { status: 400, message: 'from/to must be valid dates.' } };
  }
  if (from || to) {
    filter.effectiveDate = {};
    if (from) filter.effectiveDate.$gte = from;
    // Inclusive of the whole "to" day, which is what a user picking a date means.
    if (to) filter.effectiveDate.$lte = new Date(to.getTime() + 86_399_999);
    narrowed = true;

    if (from && to && to.getTime() < from.getTime()) {
      return { error: { status: 400, message: '"to" cannot be earlier than "from".' } };
    }
    // A year is generous for an operational view and bounds the worst case.
    if (from && to && to.getTime() - from.getTime() > 366 * 86_400_000) {
      return { error: { status: 400, message: 'Date range may not exceed 366 days.' } };
    }
  }

  if (requireNarrowing && !narrowed) {
    return {
      error: {
        status: 400,
        message:
          'A ledger search needs at least one narrowing filter — SKU, date range, ' +
          'movement type, reason, batch, reference or user.',
      },
    };
  }

  return { filter };
};

/**
 * GET /api/v1/inventory/ledger
 * Cross-SKU movement search. Requires a narrowing filter (no unbounded scans).
 */
/**
 * GET /api/v1/inventory/ledger/grouped
 *
 * One row per POSTING, not per movement.
 *
 * A single action routinely writes many movements — a go-live import wrote 714,
 * a counted variance writes one per SKU — and the flat ledger then reads as
 * hundreds of near-identical rows for something the user did once. Grouping by
 * the batch every posting already carries turns that back into what happened:
 * "opening stock import, 714 lines, +24,711 units, by Krishna".
 *
 * Aggregated over MOVEMENTS rather than read from `stockbatches`, so the
 * existing filters keep working and the counts describe what matched. Filtering
 * by one SKU and grouping shows how many lines of each posting touched THAT
 * SKU, which is the honest answer to the question being asked.
 */
export const searchLedgerGrouped = async (req, res, next) => {
  try {
    const { filter, error } = buildFilter(req, { requireNarrowing: true });
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (!filter) {
      return res.status(200).json({
        success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 },
      });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const pipeline = [
      { $match: filter },
      {
        $group: {
          _id: '$batchId',
          movementCount: { $sum: 1 },
          netQuantity: { $sum: '$quantity' },
          skuCodes: { $addToSet: '$skuCode' },
          movementTypes: { $addToSet: '$movementType' },
          firstAt: { $min: '$effectiveDate' },
          lastAt: { $max: '$effectiveDate' },
          postedAt: { $max: '$postedAt' },
          user: { $first: '$user' },
          actorType: { $first: '$actorType' },
          referenceType: { $first: '$referenceType' },
          referenceId: { $first: '$referenceId' },
          note: { $first: '$note' },
        },
      },
      { $sort: { postedAt: -1, _id: -1 } },
    ];

    const [rows, totals] = await Promise.all([
      StockMovement.aggregate([...pipeline, { $skip: (page - 1) * limit }, { $limit: limit }]),
      StockMovement.aggregate([...pipeline.slice(0, 2), { $count: 'n' }]),
    ]);

    // The workflow that produced each batch — the thing a person recognises as
    // "what I did". It lives on the batch, not on its movements.
    const batches = await StockBatch.find(
      { batchId: { $in: rows.map((r) => r._id) } },
      'batchId workflowType lineCount status',
    ).lean();
    const byId = new Map(batches.map((b) => [b.batchId, b]));

    const users = await User.find(
      { _id: { $in: rows.map((r) => r.user).filter(Boolean) } }, 'name email',
    ).lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    const total = totals[0]?.n ?? 0;
    res.status(200).json({
      success: true,
      data: rows.map((r) => {
        const batch = byId.get(r._id);
        const u = r.user ? userById.get(String(r.user)) : null;
        return {
          batchId: r._id,
          workflowType: batch?.workflowType ?? null,
          status: batch?.status ?? null,
          // What the batch posted in total, versus what matched the filter —
          // stated separately so a filtered view never looks like the whole
          // posting was smaller than it was.
          movementCount: r.movementCount,
          batchLineCount: batch?.lineCount ?? r.movementCount,
          netQuantity: r.netQuantity,
          skuCount: r.skuCodes.length,
          sampleSkus: r.skuCodes.slice(0, 3),
          movementTypes: r.movementTypes,
          firstAt: r.firstAt,
          lastAt: r.lastAt,
          postedAt: r.postedAt,
          referenceType: r.referenceType,
          referenceId: r.referenceId,
          note: r.note,
          actorType: r.actorType,
          user: u ? { id: u._id, name: u.name || u.email } : null,
        };
      }),
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) { next(error); }
};

export const searchLedger = async (req, res, next) => {
  try {
    const { filter, error, brands } = buildFilter(req, { requireNarrowing: true });
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (!filter) {
      return res.status(200).json({
        success: true,
        data: [],
        pagination: { total: 0, page: 1, pages: 1, limit: 0 },
      });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const sort = SORTABLE[asString(req.query.sort)] || SORTABLE['date-desc'];

    const [movements, total] = await Promise.all([
      StockMovement.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('user', 'user email')
        .lean(),
      StockMovement.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: movements.map(shapeMovement),
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/inventory/items/:sku/movements
 * Per-SKU history. Already narrowed by the SKU itself.
 */
export const getSkuMovements = async (req, res, next) => {
  try {
    req.query.skuCode = req.params.sku;
    const { filter, error } = buildFilter(req, { requireNarrowing: false });
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (!filter) return res.status(200).json({ success: true, data: [], pagination: { total: 0, page: 1, pages: 1, limit: 0 } });

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const [movements, total] = await Promise.all([
      StockMovement.find(filter)
        .sort({ effectiveDate: -1, transactionId: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('user', 'user email')
        .lean(),
      StockMovement.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: movements.map(shapeMovement),
      pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/inventory/ledger/:transactionId — a single movement. */
export const getMovement = async (req, res, next) => {
  try {
    const movement = await StockMovement.findOne({ transactionId: req.params.transactionId })
      .populate('user', 'user email')
      .lean();

    // 404 rather than 403 for an inaccessible brand, so the endpoint cannot be
    // used to probe which transaction ids exist.
    if (!movement || !canAccessBrand(req.user, movement.brand)) {
      return res.status(404).json({ success: false, message: 'Movement not found' });
    }

    res.status(200).json({ success: true, data: shapeMovement(movement) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/inventory/batches/:identifier — batch by id or idempotency key. */
export const getBatch = async (req, res, next) => {
  try {
    const batch = await findBatch(req.params.identifier);
    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    // A batch may span brands; show only the movements this user may see, and
    // hide the batch entirely when none of them are visible.
    const brands = allowedBrands(req.user);
    const visible = batch.movements.filter((m) => brands.includes(m.brand));
    if (visible.length === 0 && batch.movements.length > 0) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    res.status(200).json({
      success: true,
      data: { ...batch, movements: visible.map(shapeMovement) },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/inventory/ledger/movement-types — the closed set, for filters. */
export const listMovementTypes = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: MOVEMENT_TYPE_NAMES.map((name) => ({
        type: name,
        label: MOVEMENT_TYPES[name].label,
        class: MOVEMENT_TYPES[name].class,
        sign: MOVEMENT_TYPES[name].sign,
      })),
    });
  } catch (error) {
    next(error);
  }
};

export default { searchLedger, getSkuMovements, getMovement, getBatch, listMovementTypes };
