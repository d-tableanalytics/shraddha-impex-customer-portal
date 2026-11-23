import StockMovement, { MOVEMENT_CLASS } from '../../models/StockMovement.js';
import StockBatch from '../../models/StockBatch.js';
import Reservation from '../../models/Reservation.js';
import { Product } from '../../models/Product.js';
import User from '../../models/User.js';
import { getSkuBalance } from './balance.service.js';

/**
 * SKU activity log — the ledger said in the words a client uses.
 *
 * WHY THIS IS A PROJECTION, NOT A NEW COLLECTION
 * ----------------------------------------------
 * Every inventory-related transaction in this system already funnels through
 * exactly two places:
 *
 *   utils/stockLedger.js → dualWrite → StockMovement   (anything that moves stock)
 *   Reservation documents                              (indents, which move nothing)
 *
 * So a second write path — "also append a row to sku_activity" — would add
 * twelve new call sites to miss, would start empty on the day it shipped, and
 * would be a third number able to disagree with the other two. Deriving the log
 * instead means it is complete back to the first movement ever posted, it can
 * never drift, and no booking workflow gains a line of code it could fail in.
 *
 * WHAT THE LEDGER CANNOT TELL YOU
 * -------------------------------
 * An indent holds no stock, so raising one posts no movement. The same is true
 * of a booking request still sitting in the customer's selection list. Both are
 * real activity against a SKU and both are read straight off the Reservation
 * collection here, with `affectsStock: false` so nothing pretends a quantity
 * changed.
 *
 * THE BEFORE/AFTER TRAP
 * ---------------------
 * A RESERVE/RELEASE movement's beforeQuantity/afterQuantity are the BOOKED
 * count, not the on-hand count (see models/StockMovement.js — allocation and
 * physical balances are deliberately separate). Rendering those two numbers
 * under a column called "Stock" is what makes a confirmed booking look like
 * stock arrived. Every record below therefore carries `balanceKind`, and the
 * screens label the pair by what it actually counts.
 */

// ─── The vocabulary ──────────────────────────────────────────────────────────
/**
 * The five labels the brief asked for, plus the two the ledger genuinely has
 * that none of them covers. These are what a row SAYS; `activityType` below is
 * the finer key the filters use.
 */
export const ACTIVITY_LABELS = Object.freeze({
  STOCK_IN: 'Stock In',
  STOCK_OUT: 'Stock Out',
  BOOKING: 'Booking',
  INDENT: 'Indent',
  ADJUSTMENT: 'Adjustment',
  STOCK_COUNT: 'Stock Count',
  REVERSAL: 'Reversal',
});

/**
 * Direction drives the visual indicator, and it is deliberately five values
 * rather than the sign of a number.
 *
 * `in`/`out` mean goods physically moved. `allocate`/`release` mean they did
 * not — the same units are still in the building, they are merely spoken for.
 * Collapsing those into + and − is exactly the confusion this work exists to
 * fix.
 */
export const DIRECTIONS = Object.freeze({
  IN: 'in', OUT: 'out', ALLOCATE: 'allocate', RELEASE: 'release', NONE: 'none',
});

/**
 * Movement type → what happened, in client language.
 *
 * `verb` completes the sentence "<n> Units <verb>". Types whose direction
 * depends on the sign of the quantity carry no verb and are phrased by
 * `describeMovement` instead.
 */
const FROM_MOVEMENT = {
  OPENING:      { activityType: 'OPENING',           label: 'STOCK_IN',    direction: 'in',       verb: 'OPENING' },
  RECEIPT:      { activityType: 'STOCK_IN',          label: 'STOCK_IN',    direction: 'in',       verb: 'Received' },
  TRANSFER_IN:  { activityType: 'TRANSFER_IN',       label: 'STOCK_IN',    direction: 'in',       verb: 'Transferred in' },
  ISSUE:        { activityType: 'STOCK_OUT',         label: 'STOCK_OUT',   direction: 'out',      verb: 'Issued' },
  TRANSFER_OUT: { activityType: 'TRANSFER_OUT',      label: 'STOCK_OUT',   direction: 'out',      verb: 'Transferred out' },
  ADJUSTMENT:   { activityType: 'ADJUSTMENT',        label: 'ADJUSTMENT',  direction: null,       verb: null },
  COUNT:        { activityType: 'STOCK_COUNT',       label: 'STOCK_COUNT', direction: null,       verb: null },
  RESERVE:      { activityType: 'BOOKING_CONFIRMED', label: 'BOOKING',     direction: 'allocate', verb: null },
  RELEASE:      { activityType: 'BOOKING_RELEASED',  label: 'BOOKING',     direction: 'release',  verb: null },
  REVERSAL:     { activityType: 'REVERSAL',          label: 'REVERSAL',    direction: null,       verb: null },
};

/**
 * The full filter list the screens offer. Built from the two sources rather
 * than hand-listed, so a movement type added to the model shows up here.
 */
export const ACTIVITY_TYPES = Object.freeze([
  ...Object.entries(FROM_MOVEMENT).map(([movementType, m]) => ({
    type: m.activityType,
    label: ACTIVITY_LABELS[m.label],
    source: 'ledger',
    movementType,
  })),
  { type: 'BOOKING_PENDING', label: 'Booking Pending', source: 'indent', movementType: null },
  { type: 'INDENT_RAISED', label: 'Indent Raised', source: 'indent', movementType: null },
]);

/** activityType → the movement types that produce it, for the type filter. */
const MOVEMENTS_FOR_TYPE = Object.entries(FROM_MOVEMENT).reduce((acc, [movementType, m]) => {
  (acc[m.activityType] ||= []).push(movementType);
  return acc;
}, {});

export const INDENT_TYPES = ['BOOKING_PENDING', 'INDENT_RAISED'];

/**
 * Workflow key → the action a person recognises.
 *
 * The workflow lives on the batch, not the movement, which is why the callers
 * below fetch batches for the page. It is worth the one extra indexed query:
 * "PO raised — stock issued" and "PO expired — stock released" produce the same
 * ISSUE/RELEASE movement types, and without it a client cannot tell them apart.
 */
const WORKFLOW_LABEL = {
  import: 'Inventory import',
  'stock-update': 'Stock updated by hand',
  'stock-adjustment': 'Stock adjustment',
  'stock-count': 'Stock count',
  'booking-confirm': 'Booking confirmed',
  'booking-cancel': 'Booking cancelled',
  'order-create': 'Booking created',
  'po-raise': 'PO raised',
  'po-settlement-release': 'PO expired — stock released',
  'po-settlement-consume': 'PO raised — stock issued',
  'po-expiry': 'PO expired',
  reserve: 'Stock reserved',
  release: 'Stock released',
  consume: 'Stock issued',
  deduct: 'Stock deducted',
  'adjust-consumed': 'Booking quantity amended',
  'sales-desk-edit': 'Sales desk edit',
  'indent-allocation': 'Indent stock allocated',
  'indent-allocation-rollback': 'Indent allocation rolled back',
  'indent-allocation-cancel': 'Indent allocation cancelled',
  'indent-reassign-release': 'Indent reassigned',
  'indent-auto-book': 'Indent converted to a booking',
  'indent-auto-book-rollback': 'Indent conversion rolled back',
  reversal: 'Reversal',
};

export const workflowLabel = (w) => WORKFLOW_LABEL[w] || null;

/** Reference type → the document a client would name. */
const REFERENCE_LABEL = {
  booking: 'Booking', order: 'Booking', reservation: 'Indent',
  receipt: 'Goods receipt', adjustment: 'Adjustment', count: 'Stock count',
  transfer: 'Transfer', import: 'Import', migration: 'Migration', system: 'System',
};

const units = (n) => `${Math.abs(n).toLocaleString('en-IN')} Unit${Math.abs(n) === 1 ? '' : 's'}`;

// ─── Movement → activity record ──────────────────────────────────────────────
/**
 * Turn one ledger movement into a self-explanatory activity record.
 *
 * Exported because the Stock Ledger screen renders the SAME sentences. Two
 * mappings would be two vocabularies, and the whole point of this work is that
 * a client reads one.
 *
 * @param {object} m        a lean StockMovement
 * @param {object} [extra]  { workflowType, productName }
 */
export const describeMovement = (m, extra = {}) => {
  const spec = FROM_MOVEMENT[m.movementType] || {
    activityType: m.movementType, label: 'ADJUSTMENT', direction: null, verb: null,
  };
  const qty = m.quantity ?? 0;
  const physical = m.movementClass === MOVEMENT_CLASS.PHYSICAL;

  // Signed types take their direction from the quantity; allocation types keep
  // theirs, because a RELEASE is negative yet nothing left the building.
  let direction = spec.direction;
  if (!direction) {
    if (!physical) direction = qty > 0 ? DIRECTIONS.ALLOCATE : DIRECTIONS.RELEASE;
    else direction = qty > 0 ? DIRECTIONS.IN : DIRECTIONS.OUT;
  }

  let description;
  if (spec.verb === 'OPENING') description = `${units(qty)} recorded as opening stock`;
  else if (spec.verb) description = `${units(qty)} ${spec.verb}`;
  else if (m.movementType === 'RESERVE') description = `${units(qty)} set aside for a booking`;
  else if (m.movementType === 'RELEASE') description = `${units(qty)} released back to available stock`;
  else if (m.movementType === 'COUNT') {
    description = qty > 0
      ? `Stock count found ${units(qty)} more than recorded`
      : `Stock count found ${units(qty)} fewer than recorded`;
  } else if (m.movementType === 'REVERSAL') {
    description = qty > 0 ? `${units(qty)} added back by a reversal` : `${units(qty)} removed by a reversal`;
  } else {
    description = qty > 0 ? `${units(qty)} added by adjustment` : `${units(qty)} removed by adjustment`;
  }

  return {
    id: m.transactionId,
    source: 'ledger',
    activityType: spec.activityType,
    movementType: m.movementType,
    label: ACTIVITY_LABELS[spec.label],
    direction,
    description,
    // What the action WAS, where the batch knows it. Null rather than a guess.
    action: extra.workflowType ? workflowLabel(extra.workflowType) : null,
    skuCode: m.skuCode,
    productName: extra.productName || null,
    brand: m.brand,
    locationCode: m.locationCode,
    quantity: qty,
    affectsStock: true,
    // Names the pair below, so "Booked 100 → 120" can never be read as stock.
    balanceKind: physical ? 'onHand' : 'booked',
    previousStock: m.beforeQuantity ?? null,
    updatedStock: m.afterQuantity ?? null,
    referenceType: m.referenceType || null,
    referenceLabel: m.referenceType ? (REFERENCE_LABEL[m.referenceType] || m.referenceType) : null,
    referenceNumber: m.referenceId || null,
    batchId: m.batchId,
    at: m.effectiveDate,
    postedAt: m.postedAt,
    backdated: Boolean(m.backdated),
    actor: m.actorType === 'system'
      ? { name: 'System', type: 'system' }
      : { name: m.user?.name || m.user?.user || m.user?.email || null, type: 'user' },
    reasonCode: m.reasonCode || null,
    remarks: m.note || null,
  };
};

// ─── Reservation → activity record ───────────────────────────────────────────
/**
 * Which reservations are activity, and which are already in the ledger.
 *
 * AN INDENT is any reservation that was ever stamped with a PI- number. The
 * stamping is the event, so it stays in the log whatever became of the indent
 * afterwards — a cancelled indent was still raised, and a history that quietly
 * drops it is not a history.
 *
 * A PENDING BOOKING is a reservation sitting in a customer's selection list,
 * not yet confirmed: 'Draft' or 'Reserved'.
 *
 * Everything else — Confirmed, Completed, Processing, Expired, Cancelled, with
 * no indent number — is a reservation whose outcome the LEDGER already records
 * as a RESERVE movement. Letting those through is how a confirmed booking ended
 * up appearing twice, once correctly and once as "not yet confirmed".
 */
const PENDING_STATUSES = ['Draft', 'Reserved'];
const INDENT_OPEN_STATUSES = new Set(['Pending', 'Partially Confirmed']);

/** The Mongo shape of each, so the query and the rendering cannot disagree. */
export const RESERVATION_MATCH = Object.freeze({
  INDENT_RAISED: { indentNumber: { $ne: null } },
  BOOKING_PENDING: { indentNumber: null, status: { $in: PENDING_STATUSES } },
});

/** What became of an indent, for the row that records its raising. */
const INDENT_OUTCOME = {
  Pending: 'awaiting stock',
  'Partially Confirmed': 'awaiting stock',
  Confirmed: 'since fulfilled',
  Completed: 'since fulfilled',
  Processing: 'being fulfilled',
  Expired: 'since expired',
  Cancelled: 'since cancelled',
};

/**
 * An indent, or a booking request still waiting to be confirmed.
 *
 * Neither moves stock, so `quantity` is what was ASKED FOR and `affectsStock`
 * is false. Showing a previous/updated pair here would be inventing a stock
 * change that never happened.
 */
export const describeReservation = (r, extra = {}) => {
  const isIndent = Boolean(r.indentNumber);

  // The indent came into being when the booking was confirmed, not when the
  // customer first added the line — confirmedAt where we have it, and the
  // document's own last write where we do not (status 'Pending' sets no
  // confirmedAt). reservationDate is the right answer for a pending request.
  const at = isIndent
    ? (r.confirmedAt || r.updatedAt || r.reservationDate || r.createdAt)
    : (r.reservationDate || r.createdAt);

  const outcome = INDENT_OUTCOME[r.status] || null;

  return {
    id: `RES-${r.reservationId}`,
    source: 'indent',
    activityType: isIndent ? 'INDENT_RAISED' : 'BOOKING_PENDING',
    movementType: null,
    label: isIndent ? ACTIVITY_LABELS.INDENT : ACTIVITY_LABELS.BOOKING,
    direction: DIRECTIONS.NONE,
    description: isIndent
      ? `${units(r.quantity)} indented${outcome ? ` — ${outcome}` : ''}`
      : `${units(r.quantity)} requested — booking not yet confirmed`,
    action: isIndent ? 'Indent raised' : 'Booking pending',
    // True only while the indent is still open. The row records the RAISING,
    // which happened either way; this says whether it is still outstanding.
    open: isIndent ? INDENT_OPEN_STATUSES.has(r.status) : true,
    skuCode: r.skuCode,
    productName: extra.productName || null,
    brand: extra.brand || null,
    locationCode: null,
    quantity: r.quantity,
    // The flag the screens read before drawing a sign or a before/after pair.
    affectsStock: false,
    balanceKind: null,
    previousStock: null,
    updatedStock: null,
    referenceType: isIndent ? 'reservation' : 'booking',
    referenceLabel: isIndent ? 'Indent' : 'Booking request',
    referenceNumber: isIndent ? (r.indentNumber || r.reservationId) : r.reservationId,
    batchId: null,
    at,
    postedAt: r.updatedAt || at,
    backdated: false,
    actor: { name: extra.actorName || null, type: 'user' },
    reasonCode: null,
    remarks: r.cancellationReason || r.scheduleNote || null,
    status: r.status,
  };
};

// ─── Lookups ─────────────────────────────────────────────────────────────────
/** SKU → display name. One query for the whole page, never one per row. */
const productNames = async (skuCodes) => {
  if (skuCodes.length === 0) return new Map();
  const rows = await Product.find(
    { skuCode: { $in: skuCodes } }, 'skuCode description brand',
  ).lean();
  return new Map(rows.map((p) => [p.skuCode, { name: p.description || null, brand: p.brand }]));
};

const userNames = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (unique.length === 0) return new Map();
  const rows = await User.find({ _id: { $in: unique } }, 'name user email').lean();
  return new Map(rows.map((u) => [String(u._id), u.name || u.user || u.email]));
};

const batchWorkflows = async (batchIds) => {
  const unique = [...new Set(batchIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await StockBatch.find({ batchId: { $in: unique } }, 'batchId workflowType').lean();
  return new Map(rows.map((b) => [b.batchId, b.workflowType]));
};

// ─── The merged feed ─────────────────────────────────────────────────────────
/**
 * Build the activity feed.
 *
 * MERGING TWO SOURCES UNDER PAGINATION. The two collections cannot be joined,
 * so each is asked for the first `skip + limit` rows in date order and the
 * merged result is sliced. That is exact — the nth row overall cannot come from
 * deeper than position n in either source — and both queries are served by an
 * index. Depth is bounded by the `limit` cap in the controller.
 *
 * @param {object}   q
 * @param {string}   [q.skuCode]      one SKU, or every SKU the user may see
 * @param {string[]} q.brands         the user's brand scope — never optional
 * @param {string}   [q.activityType]
 * @param {Date}     [q.from] [q.to]
 * @param {number}   [q.page=1] [q.limit=20]
 */
export const getActivity = async ({
  skuCode = null, brands, activityType = null, from = null, to = null,
  page = 1, limit = 20,
} = {}) => {
  if (!Array.isArray(brands) || brands.length === 0) {
    return { records: [], total: 0, page: 1, pages: 1, limit };
  }

  const skip = (page - 1) * limit;
  const take = skip + limit;

  // Which sources can contribute at all, given the type filter.
  const wantsIndent = !activityType || INDENT_TYPES.includes(activityType);
  const wantsLedger = !activityType || Boolean(MOVEMENTS_FOR_TYPE[activityType]);

  const dateRange = {};
  if (from) dateRange.$gte = from;
  if (to) dateRange.$lte = to;
  const hasRange = Object.keys(dateRange).length > 0;

  // ── Ledger side ──
  const movementFilter = { brand: { $in: brands } };
  if (skuCode) movementFilter.skuCode = skuCode;
  if (hasRange) movementFilter.effectiveDate = dateRange;
  if (activityType && MOVEMENTS_FOR_TYPE[activityType]) {
    movementFilter.movementType = { $in: MOVEMENTS_FOR_TYPE[activityType] };
  }

  const [movements, movementTotal] = wantsLedger
    ? await Promise.all([
      StockMovement.find(movementFilter)
        .sort({ effectiveDate: -1, transactionId: -1 })
        .limit(take)
        .populate('user', 'name user email')
        .lean(),
      StockMovement.countDocuments(movementFilter),
    ])
    : [[], 0];

  // ── Indent side ──
  // Reservations carry no brand, so the SKU set is the brand fence: when no SKU
  // was named, only reservations for SKUs in the user's brands may appear.
  let reservations = [];
  let reservationTotal = 0;
  if (wantsIndent) {
    const reservationFilter = activityType
      ? { ...RESERVATION_MATCH[activityType] }
      // No filter means BOTH kinds, and only those two. A reservation that is
      // neither — a plain Confirmed one — is already in the ledger as a RESERVE
      // movement, and listing it here as well showed one booking twice.
      : { $or: [RESERVATION_MATCH.INDENT_RAISED, RESERVATION_MATCH.BOOKING_PENDING] };

    if (skuCode) reservationFilter.skuCode = skuCode;

    let fenced = true;
    if (!skuCode) {
      // A user with every brand needs no fence, which is the common case; one
      // with a subset pays a single projection query over the product master.
      const visible = await Product.find({ brand: { $in: brands } }, 'skuCode').lean();
      if (visible.length === 0) fenced = false;
      else reservationFilter.skuCode = { $in: visible.map((p) => p.skuCode) };
    }

    if (fenced) {
      /**
       * Sorting and date-filtering on the date the ROW ACTUALLY SHOWS.
       *
       * An aggregation rather than find(), because that date is a fallback
       * chain (confirmedAt, else the last write, else the booking date) and no
       * find() filter can express it. Matching on `$or` over the four fields
       * instead and re-checking in JavaScript was close, but it made the total
       * count rows the page then dropped — which is how a date-filtered view
       * ends on an empty last page.
       */
      const at = {
        $cond: [
          { $ne: [{ $ifNull: ['$indentNumber', null] }, null] },
          { $ifNull: ['$confirmedAt', { $ifNull: ['$updatedAt', { $ifNull: ['$reservationDate', '$createdAt'] }] }] },
          { $ifNull: ['$reservationDate', '$createdAt'] },
        ],
      };
      const pipeline = [{ $match: reservationFilter }, { $addFields: { _at: at } }];
      if (hasRange) pipeline.push({ $match: { _at: dateRange } });

      [reservations, reservationTotal] = await Promise.all([
        Reservation.aggregate([...pipeline, { $sort: { _at: -1, _id: -1 } }, { $limit: take }]),
        Reservation.aggregate([...pipeline, { $count: 'n' }]).then((r) => r[0]?.n ?? 0),
      ]);
    }
  }

  // ── Shape both sides ──
  const skus = [...new Set([
    ...movements.map((m) => m.skuCode),
    ...reservations.map((r) => r.skuCode),
  ])];
  const [names, workflows, actors] = await Promise.all([
    productNames(skus),
    batchWorkflows(movements.map((m) => m.batchId)),
    userNames(reservations.map((r) => r.reservedBy)),
  ]);

  const ledgerRecords = movements.map((m) => describeMovement(m, {
    workflowType: workflows.get(m.batchId) || null,
    productName: names.get(m.skuCode)?.name || null,
  }));

  const indentRecords = reservations
    .map((r) => describeReservation(r, {
      productName: names.get(r.skuCode)?.name || null,
      brand: names.get(r.skuCode)?.brand || null,
      actorName: actors.get(String(r.reservedBy)) || null,
    }));
  // No post-filtering: RESERVATION_MATCH and `describeReservation` split the
  // two kinds on the same condition, and the aggregation above already sorted
  // and date-filtered on the date each row shows. Anything re-checked here
  // would be a row the count had already included.

  const merged = [...ledgerRecords, ...indentRecords]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(skip, skip + limit);

  const total = movementTotal + reservationTotal;
  return { records: merged, total, page, pages: Math.ceil(total / limit) || 1, limit };
};

// ─── Period summary ──────────────────────────────────────────────────────────
/**
 * Opening stock, what came in, what went out, closing stock — for one SKU.
 *
 * PHYSICAL movements only. Including reservations is what makes a stock summary
 * stop adding up: a booking does not change how much is in the building, so
 * counting it as "out" would leave closing ≠ opening + in − out. The reserved
 * figure is reported alongside, labelled as what it is.
 *
 * Opening is read from the earliest movement's own beforeQuantity rather than
 * recomputed, so it is the figure the ledger recorded at the time. With no
 * movements in the window there is nothing to read, and the current balance is
 * both the opening and the closing.
 */
export const getStockSummary = async (skuCode, brands, { from = null, to = null } = {}) => {
  if (!Array.isArray(brands) || brands.length === 0) return null;

  const filter = {
    skuCode,
    brand: { $in: brands },
    movementClass: MOVEMENT_CLASS.PHYSICAL,
  };
  if (from || to) {
    filter.effectiveDate = {};
    if (from) filter.effectiveDate.$gte = from;
    if (to) filter.effectiveDate.$lte = to;
  }

  const [rows, balance] = await Promise.all([
    StockMovement.find(filter, 'quantity beforeQuantity afterQuantity effectiveDate transactionId')
      .sort({ effectiveDate: 1, transactionId: 1 })
      .lean(),
    getSkuBalance(skuCode, brands),
  ]);

  const onHand = balance?.total?.onHand ?? 0;
  const reserved = balance?.total?.reserved ?? 0;

  if (rows.length === 0) {
    return {
      skuCode,
      openingStock: onHand, stockIn: 0, stockOut: 0, closingStock: onHand,
      netChange: 0, movementCount: 0, reserved, available: balance?.total?.available ?? 0,
      // Says plainly that the figures were read from the balance, not from
      // movements — otherwise "0 in, 0 out" on a stocked SKU looks like a bug.
      derivedFromBalance: true,
    };
  }

  let stockIn = 0;
  let stockOut = 0;
  for (const r of rows) {
    if (r.quantity > 0) stockIn += r.quantity;
    else stockOut += -r.quantity;
  }
  const net = stockIn - stockOut;

  // Fall back to arithmetic only where the ledger row did not carry the figure
  // (beforeQuantity is nullable by design — see models/StockMovement.js).
  const opening = rows[0].beforeQuantity ?? (onHand - net);
  const closing = rows[rows.length - 1].afterQuantity ?? (opening + net);

  return {
    skuCode,
    openingStock: opening,
    stockIn,
    stockOut,
    closingStock: closing,
    netChange: net,
    movementCount: rows.length,
    reserved,
    available: balance?.total?.available ?? null,
    derivedFromBalance: false,
  };
};

export default {
  getActivity, getStockSummary, describeMovement, describeReservation, ACTIVITY_TYPES,
};
