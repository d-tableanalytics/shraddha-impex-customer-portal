import Order, { LINE_ORDER } from '../models/Order.js';
import Reservation from '../models/Reservation.js';
import { findProductBySku, releaseStock, consumeStock, adjustConsumedQty } from './stockLedger.js';
import { isPlaceholderPo } from './bookingLock.js';

/**
 * Settling the stock a booking holds, safely under concurrency.
 *
 * A confirmed booking's units sit in `reserved` until exactly one of three
 * things happens to each line:
 *   cancel (customer or staff)  → released back to availability
 *   7 days with no PO           → released back to availability
 *   PO raised                   → consumed (leave inventory for good)
 *
 * All three used to read the lines, then move stock, then save — so two of them
 * running together (a customer cancelling as the nightly job expires the
 * booking, a desk raising the PO as it expires) could both act on the same
 * line: stock released twice, or released and consumed.
 *
 * settleBooking() is meant to run inside runInTransaction() (utils/transaction.js).
 * It RE-READS the lines through the session, moves stock only for lines still
 * reserved, and flips each line with a write conditional on it still being
 * reserved. A competing settlement either commits first — and this one, on its
 * retry, finds nothing left to move — or conflicts and is retried. The stock
 * counters move in the same transaction as the line, so neither can commit
 * without the other.
 */

/** A line whose stock is still held. Missing (legacy rows) reads as reserved. */
export const RESERVED = { stockState: { $in: ['reserved', null] } };

/**
 * A released line's INWARD ALLOCATIONS, marked as released too.
 *
 * An allocation is indent stock that arrived later and was booked onto this
 * line; releasing the line releases its units as well (confirmedQty includes
 * them). Each allocation says so, with when, so the allocation records match
 * the stock rather than showing a stage the units will never reach.
 */
export const releasedAllocations = (row, at) => (
  row.allocations?.length
    ? { allocations: row.allocations.map((a) => ({ ...a, status: 'Cancelled', statusAt: at })) }
    : {}
);

/**
 * The indents a set of released lines' stock came from, for the audit trail:
 * [{ skuCode, indentNumber, quantity }] — one entry per inward allocation.
 */
export const indentsReleased = (rows) => rows.flatMap((row) => (row.allocations || []).map((a) => ({
  skuCode: row.skuCode,
  indentNumber: a.indentNumber || a.reservationId || null,
  allocation: a.seq,
  quantity: a.quantity,
})));

/**
 * Cancel the booking's open indent (PI-x for BO-x). An indent holds no stock,
 * so this releases nothing; it stops the remainder of a cancelled booking from
 * being assigned stock — or bought for — later.
 *
 * @returns {Promise<object[]>} the indent lines it cancelled.
 */
export const closeBookingIndent = async ({ orderId, reason, session = null, at = new Date() }) => {
  const opts = session ? { session } : {};
  const indentNumber = orderId.replace(/^[A-Z]+-/, 'PI-');
  const open = { indentNumber, status: { $in: ['Pending', 'Partially Confirmed'] } };
  const lines = await Reservation.find(open, 'reservationId indentNumber skuCode quantity', opts).lean();
  if (lines.length) {
    await Reservation.updateMany(
      open,
      { $set: { status: 'Cancelled', cancelledAt: at, cancellationReason: reason } },
      opts,
    );
  }
  return lines;
};

/** No PO on the line — the placeholders '-' and '' count as none. */
export const hasPo = (row) => Boolean(row?.poGeneratedAt) || !isPlaceholderPo(row?.poNumber);

/**
 * @param {object}   args
 * @param {string}   args.orderId
 * @param {'release'|'consume'} args.action
 * @param {object}   args.session   From runInTransaction (null on a standalone server).
 * @param {(row) => boolean} [args.eligible]  Further per-line condition, checked
 *        on the freshly read line (e.g. "no PO" for an expiry).
 * @param {(row) => object}  [args.set]       Extra fields to write on each settled line.
 * @param {object}   [args.ctx]     Ledger provenance for the stock movement.
 * @param {(rows) => string|null} [args.precheck]  Booking-level condition on the
 *        freshly read lines; a non-null answer settles nothing and is returned
 *        as `blocked` (e.g. "a PO was raised in the meantime").
 * @param {boolean}  [args.includeConsumed]  Release only: also take back lines
 *        whose PO already consumed their stock — a cancellation after the PO
 *        (allowed at any stage, decided 2026-10-19). Their units go back into
 *        inventory: available and total both rise again.
 * @param {string}   [args.closeIndent]  Release only: also close the booking's
 *        open indent (PI-x for BO-x), with this as the reason — a cancelled or
 *        expired booking's remainder must not be booked later for a customer
 *        who no longer wants it. Done only if this call settled something.
 * @returns {Promise<{ rows: object[], settled: object[], blocked: string|null, indentsClosed: object[] }>}
 *          every line as read, the lines this call settled (possibly none), and
 *          the indent lines it closed.
 */
export const settleBooking = async ({
  orderId, action, session, eligible = () => true, set = () => ({}), ctx = {}, precheck = () => null,
  closeIndent = null, includeConsumed = false,
}) => {
  const opts = session ? { session } : {};
  const rows = await Order.find({ orderId }, null, opts).sort(LINE_ORDER).lean();
  const now = new Date();
  const settled = [];

  const blocked = rows.length ? precheck(rows) : 'Booking not found.';
  if (blocked) return { rows, settled, blocked, indentsClosed: [] };

  for (const row of rows) {
    if (row.status === 'Cancelled') continue;
    const wasConsumed = row.stockState === 'consumed';
    const movable = ['reserved', null, undefined].includes(row.stockState)
      || (wasConsumed && includeConsumed && action === 'release');
    if (!movable) continue;
    if (!eligible(row)) continue;

    // Claim the line first. Conditional on it still being reserved, so a line
    // settled by someone else in the meantime is left alone.
    const claimed = await Order.updateOne(
      // Conditional on the state it was read in, so a line settled by someone
      // else in the meantime is left alone.
      { _id: row._id, ...(wasConsumed ? { stockState: 'consumed' } : RESERVED), status: { $ne: 'Cancelled' } },
      {
        $set: {
          stockState: action === 'release' ? 'released' : 'consumed',
          stockSettledAt: now,
          ...set(row),
        },
      },
      opts,
    );
    if (claimed.modifiedCount !== 1) continue;

    const qty = row.confirmedQty || 0;
    const product = await findProductBySku(row.skuCode, session);
    if (product && qty > 0) {
      const ok = action !== 'release'
        ? await consumeStock(product, qty, session, ctx)
        : wasConsumed
          // The PO had taken these units out of inventory; put them back.
          ? (await adjustConsumedQty(product, qty, 0, session, ctx)).ok
          : await releaseStock(product, qty, session, ctx);
      if (!ok) throw new Error(`Stock for ${row.skuCode} could not be ${action}d on ${orderId}.`);
    }
    settled.push(row);
  }

  // The booking's own indent: what stock could not cover when it was placed.
  // It holds no stock (indents never do), so closing it releases nothing — it
  // just stops it from being assigned stock later.
  let indentsClosed = [];
  if (closeIndent && action === 'release' && settled.length) {
    indentsClosed = await closeBookingIndent({ orderId, reason: closeIndent, session, at: now });
  }

  return { rows, settled, blocked: null, indentsClosed };
};

export default { settleBooking, RESERVED, hasPo, releasedAllocations, indentsReleased, closeBookingIndent };
