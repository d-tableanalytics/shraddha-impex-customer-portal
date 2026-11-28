import Order from '../models/Order.js';
import { openIndentsByOrder, indentIdFor } from './bookingJourney.js';
import Reservation from '../models/Reservation.js';

/**
 * BOOKING DATA BIFURCATION — the one place the three numbers are derived.
 *
 * ===========================================================================
 * THE THREE NUMBERS
 * ===========================================================================
 *
 *   Total Bookings     what the customer still has on order for this SKU
 *   Allocated          the part of it covered by stock set aside for them
 *   Pending Indent     the part of it nobody has stock for yet
 *
 * and the identity that must hold everywhere they are shown:
 *
 *   totalBookedQty = allocatedQty + pendingIndentQty
 *
 * It is an identity BY CONSTRUCTION here — `totalBookedQty` is computed as the
 * sum of the other two, never summed independently — because the one thing
 * worse than a missing figure is three figures that do not add up on screen.
 *
 * ===========================================================================
 * WHY THIS MODULE EXISTS
 * ===========================================================================
 *
 * The data was already there and already correct. What was missing was ONE
 * derivation of it. Before this, the split was computed in three places that
 * disagreed:
 *
 *   • the sales desk (modules/sales/booking.shape.js) summed `confirmedQty`
 *     and added the LIVE open indent — correct;
 *   • the Customer Portal derived `totalIndentQuantity` IN THE BROWSER
 *     (frontend/src/services/orders.js) by summing each row's `pendingQty`,
 *     the shortfall FROZEN at confirmation;
 *   • nothing at all offered the split per SKU across bookings.
 *
 * ===========================================================================
 * THE THREE TRAPS, AND WHICH ONES THE SNAPSHOT ACTUALLY FELL INTO
 * ===========================================================================
 *
 * 1. `pendingQty` AND the reservation are the SAME UNITS. At the confirmation
 *    split, `resItem.quantity = pendingQty` (reservation.controller.js), so
 *    `confirmedQty + pendingQty + indent` counts the shortfall twice. Exactly
 *    one of them may be read.
 *
 * 2. A line stock could not cover AT ALL never becomes an order row: the
 *    confirmation only pushes one when `confirmedQty > 0`. It exists solely as
 *    a reservation under the booking's indent number. Deriving the indent per
 *    order row therefore reports ZERO for the very booking whose shortfall is
 *    total. The indent is read from the reservations, which have it.
 *
 * 3. CLOSING AN INDENT DOES NOT TOUCH THE ROW. An indent holds no stock, so
 *    `closeBookingIndent()` cancels the reservations and leaves the order
 *    rows alone — there is nothing on them to settle. `pendingQty` therefore
 *    keeps its confirmation-time value for ever, and a cancelled or expired
 *    booking goes on reporting units nobody is waiting for. Same for an MSIL
 *    supply-check cancellation.
 *
 * Trap 1 is why both must never be summed. Traps 2 and 3 are the two the
 * browser's arithmetic was actually falling into, and both are pinned in
 * tests/booking-bifurcation-e2e.test.js against the live routes.
 *
 * WHAT IS *NOT* A DIVERGENCE, so nobody re-derives it from a wrong premise:
 * automatic allocation (indentAvailability.service.js) DOES decrement the
 * row's `pendingQty` as it fills the indent. The snapshot and the reservation
 * stay in step on that path. It is the closing paths that leave it behind.
 *
 * ===========================================================================
 * WHAT COUNTS AS "OUTSTANDING"
 * ===========================================================================
 *
 * `allocatedQty` is stock set aside AND STILL SET ASIDE. A line contributes
 * only when all three hold:
 *
 *   • its status is not 'Cancelled'          — the customer no longer wants it
 *   • its `stockState` is not 'released'     — the units went back to the shelf
 *     (a cancellation, or the 7-day no-PO expiry — utils/stockSettlement.js)
 *   • it has not been dispatched or delivered — the goods have LEFT; they are
 *     no longer inventory held against a booking, and counting them keeps a
 *     SKU looking committed for ever.
 *
 * `stockState: 'consumed'` DOES count. Consumed means a PO was raised and the
 * units left the available pool for good — they are still owed to this
 * customer and still waiting to go out of the door. Excluding them would make
 * a booking's allocated quantity collapse to nothing the moment it was
 * actually committed, which is precisely backwards.
 *
 * Dispatched and cancelled quantities are not discarded: they are returned as
 * their own figures, so a screen can show what has already gone and what was
 * called off without either of them polluting the outstanding split. Together
 * with `bookedQtyEver` — the historical total the customer originally asked
 * for, never adjusted — that preserves accurate historical booking totals,
 * which is a separate requirement from the outstanding split and must not be
 * served by the same number.
 *
 * ===========================================================================
 * COST
 * ===========================================================================
 *
 * ONE extra query for a whole page of bookings (`openIndentsByOrder` is
 * batched for exactly this), or one for a SKU across every booking. Nothing
 * here queries per row, and nothing here writes.
 */

/** Line statuses whose stock has physically left the building. */
export const DISPATCHED_STATUSES = Object.freeze(['Dispatched', 'Delivered']);

/** A line whose allocated units are still held for the customer. */
export const isOutstandingLine = (row) => {
  if (!row) return false;
  if (row.status === 'Cancelled') return false;
  if (DISPATCHED_STATUSES.includes(row.status)) return false;
  // Legacy rows predate the field; absent means never settled, i.e. still held.
  return (row.stockState ?? 'reserved') !== 'released';
};

/** A line whose allocated units have gone out of the door. */
export const isDispatchedLine = (row) =>
  Boolean(row) && row.status !== 'Cancelled' && DISPATCHED_STATUSES.includes(row.status);

const qty = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/**
 * The empty split. Returned for a SKU or booking with nothing on it, so a
 * caller never has to decide what "no rows" looks like.
 */
export const emptyBifurcation = () => ({
  totalBookedQty: 0,
  allocatedQty: 0,
  pendingIndentQty: 0,
  dispatchedQty: 0,
  cancelledQty: 0,
  bookedQtyEver: 0,
});

/**
 * Bifurcate a set of order rows against a live open-indent map.
 *
 * PURE. Rows and a Map in, plain objects out — nothing here queries, so it can
 * be unit-tested on its own and can be called once per booking inside a list
 * response without hiding an N+1.
 *
 * @param {object[]} rows           Order documents for ONE booking (or for one
 *                                  SKU across bookings — the arithmetic is the
 *                                  same either way).
 * @param {Map<string, number>} indentBySku  skuCode -> live open indent qty.
 *                                  Pass `null` when it is genuinely unknown.
 * @returns {{ totals: object, bySku: object[] }}
 *
 * `totals.pendingIndentQty` is `null`, never `0`, when no indent map was
 * supplied — and `totalBookedQty` is then `null` too. A figure the desk uses
 * to decide whether a booking matches the customer's PO must not report a
 * confident total that silently omits the part nobody has stock for. Nobody
 * re-checks a number that looks fine.
 */
export const bifurcateRows = (rows = [], indentBySku = null) => {
  const bySku = new Map();

  const bucket = (skuCode, brand) => {
    const key = `${skuCode}`;
    if (!bySku.has(key)) {
      bySku.set(key, { skuCode, brand: brand ?? null, ...emptyBifurcation() });
    }
    return bySku.get(key);
  };

  for (const row of rows) {
    if (!row?.skuCode) continue;
    const b = bucket(row.skuCode, row.brand);
    if (!b.brand && row.brand) b.brand = row.brand;

    const confirmed = qty(row.confirmedQty);

    // The historical ask. `bookedQty` is what the customer originally booked;
    // older rows predate the field and carry only `requestedQty`.
    b.bookedQtyEver += qty(row.bookedQty ?? row.requestedQty);

    if (row.status === 'Cancelled') {
      b.cancelledQty += confirmed;
      continue;
    }
    if (isDispatchedLine(row)) {
      b.dispatchedQty += confirmed;
      continue;
    }
    if (isOutstandingLine(row)) b.allocatedQty += confirmed;
    // A line that is neither cancelled, dispatched, nor still holding stock is
    // a RELEASED line — expired without a PO. Its units went back to the shelf
    // and belong in no bucket; its `bookedQtyEver` above still records the ask.
  }

  // The indent is attached per SKU, and SKUs that have ONLY an indent (trap 2)
  // are added here — they have no order row to have created a bucket.
  if (indentBySku) {
    for (const [skuCode, pending] of indentBySku) {
      const b = bucket(skuCode, null);
      b.pendingIndentQty += qty(pending);
    }
  }

  const lines = [...bySku.values()].map((b) => ({
    ...b,
    pendingIndentQty: indentBySku ? b.pendingIndentQty : null,
    // The identity, by construction.
    totalBookedQty: indentBySku ? b.allocatedQty + b.pendingIndentQty : null,
  }));

  const sum = (key) => lines.reduce((n, l) => n + qty(l[key]), 0);
  const allocatedQty = sum('allocatedQty');
  const pendingIndentQty = indentBySku ? sum('pendingIndentQty') : null;

  return {
    totals: {
      totalBookedQty: indentBySku ? allocatedQty + pendingIndentQty : null,
      allocatedQty,
      pendingIndentQty,
      dispatchedQty: sum('dispatchedQty'),
      cancelledQty: sum('cancelledQty'),
      bookedQtyEver: sum('bookedQtyEver'),
    },
    bySku: lines.sort((a, b) => String(a.skuCode).localeCompare(String(b.skuCode))),
  };
};

/**
 * Booking-wise bifurcation for a set of bookings, in ONE extra query.
 *
 * @param {object[]} rows  Order documents across any number of bookings.
 * @returns {Promise<Map<string, {totals: object, bySku: object[]}>>} orderId -> split
 */
export const bifurcateBookings = async (rows = []) => {
  const byOrder = new Map();
  for (const row of rows) {
    const orderId = row?.orderId;
    if (!orderId) continue;
    if (!byOrder.has(orderId)) byOrder.set(orderId, []);
    byOrder.get(orderId).push(row);
  }
  if (!byOrder.size) return new Map();

  const indents = await openIndentsByOrder([...byOrder.keys()]);

  const out = new Map();
  for (const [orderId, bookingRows] of byOrder) {
    out.set(
      orderId,
      bifurcateRows(bookingRows, indents.get(String(orderId)) ?? new Map()),
    );
  }
  return out;
};

/**
 * Stamp `bifurcation` onto each row of each booking, for a list response.
 *
 * Every row of a booking carries the SAME booking-level object, which is how
 * `attachBookingValues` already hands the browser a booking-level `value`:
 * the client groups the flat rows back into bookings and reads the field off
 * whichever row is to hand. Keeping to that shape means no endpoint has to
 * change the envelope it returns.
 *
 * Deliberately NOT gated on a permission. These are quantities on a booking
 * the caller is already being shown — the reader is either its owner or a
 * desk role that can see every booking — and the brand/ownership fence that
 * decided which rows to return has already been applied by the caller. There
 * is no money in it: `value` remains separately gated.
 *
 * @param {object[]|object} rows    the rows being returned (possibly redacted)
 * @param {object[]} [source=rows]  the UNREDACTED rows to derive from
 */
export const attachBookingBifurcation = async (rows, source = null) => {
  const list = Array.isArray(rows) ? rows : [rows];
  const from = source ?? list;
  if (!list.length) return rows;

  const splits = await bifurcateBookings(from);
  if (!splits.size) return rows;

  for (const row of list) {
    const split = splits.get(row?.orderId);
    if (!split) continue;
    row.bifurcation = {
      ...split.totals,
      // Per-SKU, so a drawer can show the split line by line without asking
      // again. Small — one entry per SKU on the booking.
      bySku: split.bySku,
    };
  }
  return rows;
};

/**
 * SKU-WISE bifurcation: one SKU's position across every live booking.
 *
 * The question the inventory side asks — "of the 180 units of this SKU people
 * are waiting for, how many are covered and how many need buying" — which no
 * booking-level figure can answer, because it spans bookings.
 *
 * Reads the SAME two sources as the booking-wise path, in the same way, so the
 * two can never disagree: sum one SKU's splits across every booking and you get
 * this. That is asserted in tests rather than assumed.
 *
 * @param {string}   skuCode
 * @param {string[]} [brands]  brand scope; omit for no brand fence (internal
 *                             callers only — a request path must pass one).
 */
export const bifurcateSku = async (skuCode, brands = null) => {
  const sku = String(skuCode ?? '').trim();
  if (!sku) return { skuCode: sku, ...emptyBifurcation(), bookings: [] };

  const filter = { skuCode: sku };
  if (Array.isArray(brands)) filter.brand = { $in: brands };

  const rows = await Order.find(
    filter,
    'orderId skuCode brand status stockState bookedQty requestedQty confirmedQty pendingQty company date createdAt',
  ).lean();

  /**
   * The open indent for this SKU.
   *
   * Read straight from the reservations rather than through
   * `openIndentsByOrder`, because a booking whose line was ENTIRELY short has
   * no order row at all (trap 2) and so would never appear in the orderId list
   * the batched helper is given. Matching on the indent number's shape —
   * `PI-...`, raised at confirmation — is what distinguishes a raised indent
   * from a selection-list line that holds nothing and is not yet a commitment.
   */
  const open = await Reservation.find(
    {
      skuCode: sku,
      indentNumber: { $ne: null },
      status: { $in: ['Pending', 'Partially Confirmed'] },
    },
    'indentNumber skuCode quantity customerId',
  ).lean();

  const indentByOrder = new Map();
  for (const r of open) {
    // PI-2026-000012 -> BO-2026-000012. The two ids share their sequence.
    const orderId = String(r.indentNumber).replace(/^[A-Z]+-/, 'BO-');
    indentByOrder.set(orderId, (indentByOrder.get(orderId) || 0) + qty(r.quantity));
  }

  const orderIds = new Set([
    ...rows.map((r) => r.orderId),
    ...indentByOrder.keys(),
  ]);

  const bookings = [];
  const totals = emptyBifurcation();
  for (const orderId of orderIds) {
    const bookingRows = rows.filter((r) => r.orderId === orderId);
    const indentBySku = new Map();
    if (indentByOrder.has(orderId)) indentBySku.set(sku, indentByOrder.get(orderId));
    const { totals: t } = bifurcateRows(bookingRows, indentBySku);
    for (const key of Object.keys(totals)) totals[key] += qty(t[key]);
    bookings.push({
      orderId,
      company: bookingRows[0]?.company ?? null,
      date: bookingRows[0]?.date ?? bookingRows[0]?.createdAt ?? null,
      indentNumber: indentByOrder.has(orderId) ? indentIdFor(orderId) : null,
      ...t,
    });
  }

  bookings.sort((a, b) => String(b.orderId).localeCompare(String(a.orderId)));
  return { skuCode: sku, ...totals, bookings };
};

export default {
  DISPATCHED_STATUSES,
  isOutstandingLine,
  isDispatchedLine,
  emptyBifurcation,
  bifurcateRows,
  bifurcateBookings,
  attachBookingBifurcation,
  bifurcateSku,
};
