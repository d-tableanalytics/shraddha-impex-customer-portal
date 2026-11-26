import StockMovement, { MOVEMENT_CLASS } from '../../models/StockMovement.js';
import StockBatch from '../../models/StockBatch.js';
import Reservation from '../../models/Reservation.js';
import { Product } from '../../models/Product.js';
import User from '../../models/User.js';
import { getSkuBalance } from './balance.service.js';

const loadBookingModels = async () => ({
  Order: (await import('../../models/Order.js')).default,
  BookingStatusEvent: (await import('../../models/BookingStatusEvent.js')).default,
});


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
  { type: 'SELECTION_CLOSED', label: 'Selection List Closed', source: 'indent', movementType: null },
  { type: 'BOOKING_CREATED', label: 'Booking Created', source: 'booking', movementType: null },
  { type: 'PO_RAISED', label: 'PO Raised', source: 'booking', movementType: null },
  { type: 'STATUS_CHANGED', label: 'Status Changed', source: 'booking', movementType: null },
]);

/**
 * The business-event types, as opposed to the ledger's stock movements.
 *
 * A booking is TWO things that happen at once: a commitment to a customer, and
 * a quantity of stock being set aside. The ledger records the second and has
 * no vocabulary for the first — it cannot say who the customer was, what they
 * asked for versus what they got, or that a PO was raised against it.
 *
 * So these are read from the booking documents themselves and carry
 * `affectsStock: false`. Nothing here pretends a quantity moved; the movement
 * that went with it is its own row, as it already was. Showing both is the
 * point: "Booking confirmed — 7 requested, 3 from stock, 4 to indent" next to
 * "3 Units set aside for a booking" is the sentence a person was missing.
 */
export const BOOKING_EVENT_TYPES = ['BOOKING_CREATED', 'PO_RAISED', 'STATUS_CHANGED'];

/** activityType → the movement types that produce it, for the type filter. */
const MOVEMENTS_FOR_TYPE = Object.entries(FROM_MOVEMENT).reduce((acc, [movementType, m]) => {
  (acc[m.activityType] ||= []).push(movementType);
  return acc;
}, {});

export const INDENT_TYPES = ['BOOKING_PENDING', 'INDENT_RAISED', 'SELECTION_CLOSED'];

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
  // Remediation workflows (Phases 3 and 4). Without these the rows produced by
  // a backfill or a reconciliation would read as "—", which is exactly the
  // kind of unexplained entry this screen exists to stop.
  'ledger-backfill': 'Ledger backfill — movement recorded after the fact',
  'stock-reconciliation': 'Stock reconciliation correction',
};

export const workflowLabel = (w) => WORKFLOW_LABEL[w] || null;

/** Reference type → the document a client would name. */
const REFERENCE_LABEL = {
  booking: 'Booking', order: 'Booking', reservation: 'Indent',
  receipt: 'Goods receipt', adjustment: 'Adjustment', count: 'Stock count',
  transfer: 'Transfer', import: 'Import', migration: 'Migration', system: 'System',
};

const units = (n) => `${Math.abs(n).toLocaleString('en-IN')} Unit${Math.abs(n) === 1 ? '' : 's'}`;

/**
 * Who or what caused an activity: a person, a scheduled job, or the system
 * acting on its own.
 *
 * Derived from the workflow rather than stored, because the workflows already
 * say it unambiguously and a stored flag would be a second thing to keep in
 * step. An admin reading "released" needs to know whether somebody decided
 * that or the 7-day job did.
 */
const AUTOMATIC_WORKFLOWS = new Set([
  'po-settlement-release', 'po-settlement-consume', 'po-expiry',
  'indent-auto-book', 'indent-auto-book-rollback', 'auto-booking-to-allocation',
]);
const SYSTEM_WORKFLOWS = new Set([
  'ledger-backfill', 'stock-reconciliation', 'reversal',
]);

export const triggerOf = (workflowType, actorType) => {
  if (SYSTEM_WORKFLOWS.has(workflowType)) return 'system';
  if (AUTOMATIC_WORKFLOWS.has(workflowType)) return 'automatic';
  if (actorType === 'system') return 'automatic';
  return 'manual';
};
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
    trigger: triggerOf(extra.workflowType, m.actorType),
    // The same shape every other source carries, so one renderer serves all.
    // A movement knows its reference and its own balance pair; it does not
    // know the customer, and nothing here invents one.
    details: {
      customer: extra.customerName ?? null,
      company: extra.company ?? null,
      actorRole: null,
      placedBy: null,
      requestedQty: null,
      confirmedQty: null,
      pendingQty: null,
      bookingId: m.referenceType === 'booking' || m.referenceType === 'order' ? m.referenceId : null,
      indentNumber: m.referenceType === 'reservation' ? m.referenceId : null,
      poNumber: null,
      reservationId: null,
      statusFrom: null,
      statusTo: null,
      sourceModule: extra.workflowType ? (workflowLabel(extra.workflowType) || extra.workflowType) : 'Stock ledger',
    },
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
  /**
   * A selection-list line that was removed or expired without ever becoming a
   * booking.
   *
   * Previously invisible: the filter only admitted lines still pending, so a
   * customer who put 40 units in their list and took them out again left no
   * trace on this screen at all. It holds no stock either way, which is why it
   * was easy to leave out and why leaving it out was wrong — "nothing
   * happened" and "something happened that moved no stock" are different
   * answers to an admin asking what became of a SKU.
   */
  SELECTION_CLOSED: { indentNumber: null, status: { $in: ['Cancelled', 'Expired'] } },
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
  // A list line that was taken out or timed out, rather than one still open.
  const closed = !isIndent && ['Cancelled', 'Expired'].includes(r.status);

  return {
    id: `RES-${r.reservationId}`,
    source: 'indent',
    activityType: isIndent ? 'INDENT_RAISED' : (closed ? 'SELECTION_CLOSED' : 'BOOKING_PENDING'),
    movementType: null,
    label: isIndent ? ACTIVITY_LABELS.INDENT : ACTIVITY_LABELS.BOOKING,
    direction: DIRECTIONS.NONE,
    description: closed
      ? `${units(r.quantity)} removed from the selection list (${String(r.status).toLowerCase()})`
      : isIndent
      ? `${units(r.quantity)} indented${outcome ? ` — ${outcome}` : ''}`
      : `${units(r.quantity)} requested — booking not yet confirmed`,
    action: closed ? 'Selection list line closed' : (isIndent ? 'Indent raised' : 'Booking pending'),
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
    trigger: r.autoBookedOrderId ? 'automatic' : 'manual',
    details: {
      customer: extra.customerName ?? null,
      company: extra.company ?? null,
      actorRole: null,
      placedBy: extra.actorName || null,
      requestedQty: r.quantity ?? null,
      confirmedQty: null,
      pendingQty: isIndent ? (r.quantity ?? null) : null,
      bookingId: r.indentNumber ? String(r.indentNumber).replace(/^PI-/, 'BO-') : null,
      indentNumber: r.indentNumber || null,
      poNumber: r.poNumber && r.poNumber !== '-' ? r.poNumber : null,
      reservationId: r.reservationId,
      statusFrom: null,
      statusTo: r.status,
      sourceModule: isIndent ? 'Pending Indent' : 'Selection List',
    },
  };
};

// ─── Business events ─────────────────────────────────────────────────────────
/**
 * The details a stock movement cannot carry.
 *
 * Attached to every record as `details`, always the same shape, so a screen
 * can render it without knowing which source the row came from. Fields that
 * are genuinely unknown stay null — a booking placed before a field existed
 * does not get a plausible-looking value invented for it.
 */
const detailsOf = ({
  customer = null, company = null, actorRole = null, placedBy = null,
  requestedQty = null, confirmedQty = null, pendingQty = null,
  bookingId = null, indentNumber = null, poNumber = null, reservationId = null,
  statusFrom = null, statusTo = null, sourceModule = null,
} = {}) => ({
  customer, company, actorRole, placedBy,
  requestedQty, confirmedQty, pendingQty,
  bookingId, indentNumber, poNumber, reservationId,
  statusFrom, statusTo, sourceModule,
});

/** Who a booking was FOR, and who actually keyed it in. */
const partiesOf = (line, userName) => ({
  customer: userName ?? null,
  company: line.company || null,
  // Set only when the desk booked on someone's behalf; null for a customer's
  // own booking, which is how the booking flow already records it.
  placedBy: line.createdByName || null,
  actorRole: line.role || null,
});

/**
 * An order line's creation, as a business event.
 *
 * `bookedQty` is what the customer asked for, `confirmedQty` what stock could
 * cover, `pendingQty` what became an indent. The ledger only ever saw the
 * middle one, which is why a partially-filled booking was impossible to
 * explain from this screen.
 */
export const describeBookingCreated = (line, extra = {}) => {
  const requested = line.bookedQty ?? line.requestedQty ?? 0;
  const confirmed = line.confirmedQty ?? 0;
  const pending = line.pendingQty ?? 0;
  const parts = [`${units(requested)} requested`];
  if (confirmed) parts.push(`${units(confirmed)} confirmed from stock`);
  if (pending) parts.push(`${units(pending)} to indent`);

  return {
    id: `ORD-${line.orderId}-${line.skuCode}-created`,
    source: 'booking',
    activityType: 'BOOKING_CREATED',
    movementType: null,
    label: ACTIVITY_LABELS.BOOKING,
    direction: DIRECTIONS.NONE,
    description: parts.join(', '),
    action: pending > 0 && confirmed > 0 ? 'Booking partially confirmed'
      : pending > 0 ? 'Booking moved to indent' : 'Booking confirmed',
    skuCode: line.skuCode,
    productName: extra.productName || null,
    brand: line.brand || null,
    locationCode: null,
    quantity: requested,
    affectsStock: false,
    balanceKind: null,
    previousStock: null,
    updatedStock: null,
    referenceType: 'booking',
    referenceLabel: 'Booking',
    referenceNumber: line.orderId,
    batchId: null,
    at: line.orderTimestamp || line.createdAt || line.date || null,
    postedAt: line.createdAt || null,
    backdated: false,
    actor: { name: extra.actorName || line.createdByName || extra.customerName || null, type: 'user' },
    reasonCode: null,
    remarks: line.remarks || null,
    status: line.status || null,
    trigger: line.createdByName ? 'manual' : 'manual',
    details: detailsOf({
      ...partiesOf(line, extra.customerName),
      requestedQty: requested,
      confirmedQty: confirmed,
      pendingQty: pending,
      bookingId: line.orderId,
      indentNumber: pending > 0 ? String(line.orderId).replace(/^[A-Z]+-/, 'PI-') : null,
      poNumber: isRealPo(line.poNumber) ? line.poNumber : null,
      sourceModule: line.createdByName ? 'Sales Desk (on behalf)' : 'Customer Portal',
    }),
  };
};

/** A placeholder PO is not a PO. '-' and '' mean none was raised. */
const isRealPo = (po) => Boolean(po) && String(po).trim() !== '-' && String(po).trim() !== '';

/** The PO that locked a booking line and took its stock out of inventory. */
export const describePoRaised = (line, extra = {}) => ({
  id: `ORD-${line.orderId}-${line.skuCode}-po`,
  source: 'booking',
  activityType: 'PO_RAISED',
  movementType: null,
  label: ACTIVITY_LABELS.BOOKING,
  direction: DIRECTIONS.NONE,
  description: `PO ${line.poNumber} raised — ${units(line.confirmedQty ?? 0)} committed for dispatch`,
  action: 'PO raised',
  skuCode: line.skuCode,
  productName: extra.productName || null,
  brand: line.brand || null,
  locationCode: null,
  quantity: line.confirmedQty ?? 0,
  affectsStock: false,
  balanceKind: null,
  previousStock: null,
  updatedStock: null,
  referenceType: 'booking',
  referenceLabel: 'Booking',
  referenceNumber: line.orderId,
  batchId: null,
  at: line.poGeneratedAt,
  postedAt: line.poGeneratedAt,
  backdated: false,
  actor: { name: extra.poActorName || null, type: 'user' },
  reasonCode: null,
  remarks: null,
  status: line.status || null,
  trigger: 'manual',
  details: detailsOf({
    ...partiesOf(line, extra.customerName),
    confirmedQty: line.confirmedQty ?? 0,
    bookingId: line.orderId,
    poNumber: line.poNumber,
    sourceModule: 'Sales Desk',
  }),
});

/**
 * A recorded status transition.
 *
 * Read from `bookingstatusevents`, which is the only place a transition is
 * written down. It carries no SKU — a booking spans several — so each event is
 * attributed to every line of its booking that this SKU appears on.
 */
export const describeStatusEvent = (event, line, extra = {}) => ({
  id: `BSE-${event._id}-${line.skuCode}`,
  source: 'booking',
  activityType: 'STATUS_CHANGED',
  movementType: null,
  label: ACTIVITY_LABELS.BOOKING,
  direction: DIRECTIONS.NONE,
  description: event.previousStatus
    ? `Status changed from ${event.previousStatus} to ${event.status}`
    : `Status set to ${event.status}`,
  action: 'Status changed',
  skuCode: line.skuCode,
  productName: extra.productName || null,
  brand: line.brand || null,
  locationCode: null,
  quantity: null,
  affectsStock: false,
  balanceKind: null,
  previousStock: null,
  updatedStock: null,
  referenceType: 'booking',
  referenceLabel: 'Booking',
  referenceNumber: event.orderId,
  batchId: null,
  at: event.changedAt || event.createdAt,
  postedAt: event.createdAt || null,
  backdated: false,
  actor: {
    name: event.changedByName || 'System',
    type: event.changedByName && event.changedByName !== 'System' ? 'user' : 'system',
  },
  reasonCode: null,
  remarks: event.remarks || null,
  status: event.status,
  trigger: (!event.changedByName || event.changedByName === 'System') ? 'automatic' : 'manual',
  details: detailsOf({
    ...partiesOf(line, extra.customerName),
    actorRole: event.changedByRole || null,
    statusFrom: event.previousStatus || null,
    statusTo: event.status,
    bookingId: event.orderId,
    poNumber: isRealPo(line.poNumber) ? line.poNumber : null,
    sourceModule: 'Booking lifecycle',
  }),
});

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

/**
 * Booking id → who it was for. One query for the page, never one per row.
 */
const bookingParties = async (orderIds) => {
  if (orderIds.length === 0) return new Map();
  const { Order } = await loadBookingModels();
  const rows = await Order.find(
    { orderId: { $in: orderIds } },
    'orderId user company createdByName',
  ).lean();
  const users = await userNames(rows.map((r) => r.user));
  return new Map(rows.map((r) => [r.orderId, {
    customer: users.get(String(r.user)) || null,
    company: r.company || null,
    placedBy: r.createdByName || null,
  }]));
};
const batchWorkflows = async (batchIds) => {
  const unique = [...new Set(batchIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await StockBatch.find({ batchId: { $in: unique } }, 'batchId workflowType').lean();
  return new Map(rows.map((b) => [b.batchId, b.workflowType]));
};

/**
 * The booking side of a SKU's history.
 *
 * Three kinds of record, from the two places that actually write them down:
 *
 *   orders               the line itself — created, and PO raised
 *   bookingstatusevents  every recorded transition
 *
 * All of them carry `affectsStock: false`. The stock that moved alongside is
 * already in the ledger as its own row, and showing a quantity here too would
 * be the same unit counted twice on one screen.
 */
const bookingEvents = async ({
  skuCode, brands, from, to, take, activityType, reference, customerId, userId,
}) => {
  const wanted = activityType ? [activityType] : BOOKING_EVENT_TYPES;
  if (!wanted.some((t) => BOOKING_EVENT_TYPES.includes(t))) return { records: [], total: 0 };

  const { Order, BookingStatusEvent } = await loadBookingModels();
  const lineFilter = { brand: { $in: brands } };
  if (skuCode) lineFilter.skuCode = skuCode;
  if (customerId) lineFilter.user = customerId;
  if (reference) lineFilter.$or = [{ orderId: reference }, { poNumber: reference }];

  // Bounded the same way the other sources are: the nth row overall cannot
  // come from deeper than position n in any one source.
  const lines = await Order.find(lineFilter)
    .sort({ orderTimestamp: -1, _id: -1 })
    .limit(Math.max(take, 1) * 3)
    .lean();
  if (lines.length === 0) return { records: [], total: 0 };

  const customerIds = lines.map((l) => l.user).filter(Boolean);
  const [names, customers] = await Promise.all([
    productNames([...new Set(lines.map((l) => l.skuCode))]),
    userNames(customerIds),
  ]);
  const extraFor = (line) => ({
    productName: names.get(line.skuCode)?.name || null,
    customerName: customers.get(String(line.user)) || null,
  });

  const records = [];
  if (wanted.includes('BOOKING_CREATED')) {
    for (const line of lines) records.push(describeBookingCreated(line, extraFor(line)));
  }
  if (wanted.includes('PO_RAISED')) {
    for (const line of lines) {
      if (line.poGeneratedAt && isRealPo(line.poNumber)) {
        records.push(describePoRaised(line, extraFor(line)));
      }
    }
  }
  if (wanted.includes('STATUS_CHANGED')) {
    const orderIds = [...new Set(lines.map((l) => l.orderId))];
    const events = await BookingStatusEvent.find({ orderId: { $in: orderIds } })
      .sort({ changedAt: -1 }).limit(Math.max(take, 1) * 3).lean();
    // One event covers a whole booking, so it is attributed to each line of
    // that booking for this SKU — which is what makes it visible here at all.
    const linesByOrder = new Map();
    for (const l of lines) {
      if (!linesByOrder.has(l.orderId)) linesByOrder.set(l.orderId, []);
      linesByOrder.get(l.orderId).push(l);
    }
    for (const e of events) {
      for (const line of linesByOrder.get(e.orderId) || []) {
        records.push(describeStatusEvent(e, line, extraFor(line)));
      }
    }
  }

  const inRange = records.filter((r) => {
    if (!r.at) return false;
    // The actor on a booking event is a name, not an id, so this one is
    // matched in memory — the set is already bounded by the line query.
    if (userId && r.actor?.id && String(r.actor.id) !== String(userId)) return false;
    const at = new Date(r.at).getTime();
    if (from && at < new Date(from).getTime()) return false;
    if (to && at > new Date(to).getTime()) return false;
    return true;
  });
  inRange.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { records: inRange.slice(0, take), total: inRange.length };
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
/**
 * @param {string}   [q.reference]  a booking, indent, PO or reservation id
 * @param {string}   [q.customerId] whose activity to show
 * @param {string}   [q.userId]     who performed it
 *
 * The three filters above are pushed into each SOURCE query rather than
 * applied to the merged page. Filtering after the merge would make `total`
 * the count of what survived in one window rather than the count of what
 * matches, and the last page would come back empty.
 */
export const getActivity = async ({
  skuCode = null, brands, activityType = null, from = null, to = null,
  reference = null, customerId = null, userId = null,
  page = 1, limit = 20,
} = {}) => {
  if (!Array.isArray(brands) || brands.length === 0) {
    return { records: [], total: 0, page: 1, pages: 1, limit };
  }

  const skip = (page - 1) * limit;
  const take = skip + limit;

  // Which sources can contribute at all, given the type filter.
  const wantsIndent = !activityType || INDENT_TYPES.includes(activityType);
  const wantsBooking = !activityType || BOOKING_EVENT_TYPES.includes(activityType);
  const wantsLedger = !activityType || Boolean(MOVEMENTS_FOR_TYPE[activityType]);

  /**
   * A customer is not written on a stock movement — only on the booking the
   * movement belongs to. So "show me this customer" becomes "show me these
   * booking and reservation ids", resolved once and pushed into each source.
   */
  let customerRefs = null;
  if (customerId) {
    const [orderIds, reservationIds] = await Promise.all([
      (await import('../../models/Order.js')).default.distinct('orderId', { user: customerId }),
      Reservation.distinct('reservationId', { customerId }),
    ]);
    customerRefs = { orderIds, reservationIds };
  }

  const dateRange = {};
  if (from) dateRange.$gte = from;
  if (to) dateRange.$lte = to;
  const hasRange = Object.keys(dateRange).length > 0;

  // ── Ledger side ──
  const movementFilter = { brand: { $in: brands } };
  if (skuCode) movementFilter.skuCode = skuCode;
  if (reference) movementFilter.referenceId = reference;
  if (userId) movementFilter.user = userId;
  if (customerRefs) movementFilter.referenceId = { $in: customerRefs.orderIds };
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
      : {
        $or: [
          RESERVATION_MATCH.INDENT_RAISED,
          RESERVATION_MATCH.BOOKING_PENDING,
          RESERVATION_MATCH.SELECTION_CLOSED,
        ],
      };

    if (skuCode) reservationFilter.skuCode = skuCode;
    if (reference) {
      reservationFilter.$and = [
        ...(reservationFilter.$and || []),
        { $or: [{ indentNumber: reference }, { reservationId: reference }, { poNumber: reference }] },
      ];
    }
    if (userId) reservationFilter.reservedBy = userId;
    if (customerId) reservationFilter.customerId = customerId;

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

  // ── Booking side ──
  const booking = wantsBooking
    ? await bookingEvents({ skuCode, brands, from, to, take, activityType, reference, customerId, userId })
    : { records: [], total: 0 };

  // ── Shape every side ──
  const skus = [...new Set([
    ...movements.map((m) => m.skuCode),
    ...reservations.map((r) => r.skuCode),
  ])];
  const [names, workflows, actors] = await Promise.all([
    productNames(skus),
    batchWorkflows(movements.map((m) => m.batchId)),
    userNames(reservations.map((r) => r.reservedBy)),
  ]);

  // The customer a booking-referenced movement belongs to, looked up once for
  // the page. A movement with no booking reference simply has none.
  const bookingRefs = [...new Set(movements
    .filter((m) => ['booking', 'order'].includes(m.referenceType))
    .map((m) => m.referenceId).filter(Boolean))];
  const partyByBooking = await bookingParties(bookingRefs);

  const ledgerRecords = movements.map((m) => describeMovement(m, {
    workflowType: workflows.get(m.batchId) || null,
    productName: names.get(m.skuCode)?.name || null,
    customerName: partyByBooking.get(m.referenceId)?.customer || null,
    company: partyByBooking.get(m.referenceId)?.company || null,
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

  const merged = [...ledgerRecords, ...indentRecords, ...booking.records]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(skip, skip + limit);

  const total = movementTotal + reservationTotal + booking.total;
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
