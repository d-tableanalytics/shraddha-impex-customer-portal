import Order from '../../models/Order.js';
import Reservation from '../../models/Reservation.js';
import User from '../../models/User.js';
import { recordAudit } from '../../utils/auditLog.js';
import { notifyUser } from '../../utils/notify.js';
import { findProductBySku } from '../../utils/stockLedger.js';
import { isMsilCustomer, supplyDecision } from '../../utils/msilSupply.js';
import { parseIstDay, istDayStart, formatIstDate } from '../../utils/businessDay.js';
import { processAvailableIndents } from '../inventory/indentAvailability.service.js';
import { assignToIndent } from '../inventory/indentAssignment.service.js';

/**
 * The Sales Desk side of the MSIL supply check (rule: utils/msilSupply.js).
 *
 *   setSupplyDate   record the date the MSIL customer needs the goods by,
 *                   against the booking and its open indents;
 *   convertIndent   the desk's "Convert" — book an indent the check refused;
 *   cancelIndent    the desk's "Cancel" — drop it instead.
 *
 * Convert goes through assignToIndent(), the same guarded allocation the
 * Indent Stock Assignment screen uses, so a manual conversion lands exactly
 * where an automatic one would and can never take stock that is not free.
 */

const OPEN = ['Pending', 'Partially Confirmed'];
const AWAITING = 'Awaiting decision';

const fail = (status, message, code = 'MSIL_SUPPLY') =>
  Object.assign(new Error(message), { statusCode: status, code });

/** BO-2026-000009 -> PI-2026-000009, the indent raised alongside a booking. */
const indentNumberFor = (orderId) => `PI-${String(orderId).replace(/^[A-Z]+-/, '')}`;

// 'YYYY-MM-DD' is a day in INDIA, whatever zone the server runs in — see
// utils/businessDay.js for what goes wrong otherwise.
const parseDay = parseIstDay;
const startOfDay = istDayStart;

/**
 * Set or clear the MSIL Supply Date for a booking.
 *
 * Written to every row of the booking and mirrored onto its open indents. MSIL
 * customers only: for anyone else the date would be a field with no effect.
 * Afterwards the booking's indent SKUs are re-checked, so an indent the old
 * date held back converts now if the new date allows it and stock is free.
 */
export const setSupplyDate = async ({ orderId, supplyDate, actor, req }) => {
  const clearing = supplyDate === null || supplyDate === undefined || String(supplyDate).trim() === '';
  const day = clearing ? null : parseDay(supplyDate);
  if (!clearing && !day) throw fail(400, 'Enter the Supply Date as a date (YYYY-MM-DD).');

  const [rows, indents] = await Promise.all([
    Order.find({ orderId }, 'user orderTimestamp createdAt status').lean(),
    Reservation.find(
      { indentNumber: indentNumberFor(orderId) },
      'customerId status skuCode reservationDate createdAt supplyCheck',
    ).lean(),
  ]);
  if (!rows.length && !indents.length) throw fail(404, 'Booking not found.', 'NOT_FOUND');

  const customerId = rows[0]?.user ?? indents[0]?.customerId;
  const customer = customerId ? await User.findById(customerId, 'customerCategory company user email').lean() : null;
  if (!isMsilCustomer(customer)) {
    throw fail(400, 'A Supply Date applies to MSIL customer bookings only.', 'NOT_MSIL');
  }

  // The booking's own date: its rows and its indent, which is raised with it —
  // a booking with nothing in stock has no rows at all.
  const bookedOn = [
    ...rows.map((r) => r.orderTimestamp || r.createdAt),
    ...indents.map((i) => i.reservationDate || i.createdAt),
  ].filter(Boolean).map((d) => new Date(d)).sort((a, b) => a - b)[0];
  if (day && bookedOn && day < startOfDay(bookedOn)) {
    throw fail(400, 'The Supply Date cannot be before the booking was made.');
  }

  const now = new Date();
  const callStarted = now;
  await Order.updateMany({ orderId }, {
    $set: { msilSupplyDate: day, msilSupplyDateSetBy: actor?._id ?? null, msilSupplyDateSetAt: now },
  });
  const open = indents.filter((i) => OPEN.includes(i.status));
  if (open.length) {
    await Reservation.updateMany({ _id: { $in: open.map((i) => i._id) } }, { $set: { supplyDate: day } });

    // A HELD indent is re-judged against the new date — at the time its stock
    // actually ARRIVED (recorded when it was held), never at "now": moving the
    // date later must not turn an on-time arrival into a late one just because
    // the desk took a few days to do it. No notification either way.
    //   - now on time (or no date at all): no longer held. Its arrival stays on
    //     record, so the pass below converts it if stock is free, and the next
    //     pass does if not.
    //   - still late: still held, with the reason restated for the new date.
    for (const indent of open.filter((i) => i.supplyCheck?.status === AWAITING)) {
      const verdict = supplyDecision({
        customer, supplyDate: day, bookingDate: bookedOn, at: indent.supplyCheck.arrivedAt || now,
      });
      const cleared = !verdict.applies || verdict.onTime;
      await Reservation.updateOne(
        { _id: indent._id, 'supplyCheck.status': AWAITING },
        cleared
          ? { $set: { 'supplyCheck.status': null, 'supplyCheck.reason': null } }
          : { $set: { 'supplyCheck.reason': verdict.reason } },
      );
    }
  }

  await recordAudit(actor, 'MSIL Supply Date Set',
    day
      ? `Supply Date for ${orderId} set to ${formatIstDate(day)}.`
      : `Supply Date for ${orderId} cleared.`,
    req, { meta: { orderId, supplyDate: day } });

  // Re-run the conversion pass for this booking's waiting SKUs: the same pass a
  // stock movement triggers, so it honours FIFO and the manual-assignment mode.
  if (open.length) {
    await processAvailableIndents(open.map((i) => i.skuCode), { event: 'supply-date' });
  }

  // What happened to THIS booking. The pass covers every indent on those SKUs,
  // other customers' included, so its own totals are not this booking's story.
  const after = await Reservation.find(
    { _id: { $in: open.map((i) => i._id) } }, 'status supplyCheck',
  ).lean();
  return {
    orderId,
    msilSupplyDate: day,
    openIndents: open.length,
    convertedLines: after.filter((i) => i.supplyCheck?.status === 'Auto-converted'
      && i.supplyCheck?.decidedAt && new Date(i.supplyCheck.decidedAt) >= callStarted).length,
    awaitingLines: after.filter((i) => OPEN.includes(i.status) && i.supplyCheck?.status === AWAITING).length,
  };
};

/** The open indent a desk decision is about — only one the check is holding. */
const heldIndent = async (id) => {
  const indent = await Reservation.findOne({
    $or: [{ reservationId: id }, ...(/^[0-9a-f]{24}$/i.test(String(id)) ? [{ _id: id }] : [])],
  });
  if (!indent || !OPEN.includes(indent.status)) throw fail(404, 'This indent is no longer open.', 'NOT_FOUND');
  if (indent.supplyCheck?.status !== AWAITING) {
    throw fail(409, 'This indent is not waiting for a decision.', 'NOT_AWAITING');
  }
  return indent;
};

/**
 * "Convert": book the indent although the stock arrived late.
 *
 * Takes what is free now, up to the indent's quantity. An indent whose booking
 * was cancelled can only become a booking whole (assignToIndent enforces that).
 */
export const convertIndent = async ({ id, actor, req }) => {
  const indent = await heldIndent(id);
  const product = await findProductBySku(indent.skuCode);
  const free = Math.max(0, product?.availableForSale ?? 0);
  if (free === 0) {
    throw fail(409, `No stock of ${indent.skuCode} is free right now, so the indent cannot be converted yet.`);
  }

  // Claim the decision first, atomically. A second click, or a Cancel arriving
  // at the same moment, then finds the indent no longer waiting and is refused,
  // instead of both acting on it.
  const decidedAt = new Date();
  const claimed = await Reservation.updateOne(
    { _id: indent._id, status: { $in: OPEN }, 'supplyCheck.status': AWAITING },
    {
      $set: {
        'supplyCheck.status': 'Converted manually',
        'supplyCheck.decidedBy': actor?._id ?? null,
        'supplyCheck.decidedAt': decidedAt,
      },
    },
  );
  if (!claimed.modifiedCount) throw fail(409, 'This indent was decided a moment ago. Refresh to see what happened.');

  let result;
  try {
    result = await assignToIndent({
      indentId: indent._id,
      quantity: Math.min(free, indent.quantity),
      actor,
      req,
    });
  } catch (error) {
    // Nothing was allocated: put the decision back so the desk can try again.
    await Reservation.updateOne(
      { _id: indent._id, 'supplyCheck.status': 'Converted manually', 'supplyCheck.decidedAt': decidedAt },
      { $set: { 'supplyCheck.status': AWAITING, 'supplyCheck.decidedBy': null, 'supplyCheck.decidedAt': null } },
    );
    throw error;
  }
  await recordAudit(actor, 'MSIL Indent Converted',
    `${indent.indentNumber || indent.reservationId} ${indent.skuCode}: converted manually `
    + `(${result.quantity} unit(s) onto ${result.orderId}) after the supply check held it.`,
    req, { meta: { reservationId: indent.reservationId, ...result } });

  return { ...result, remaining: indent.quantity - result.quantity };
};

/** "Cancel": drop the indent instead of converting it. Nothing is reserved, so nothing is released. */
export const cancelIndent = async ({ id, reason = null, actor, req }) => {
  const indent = await heldIndent(id);
  const now = new Date();
  const why = String(reason ?? '').trim() || 'Stock arrived after the MSIL Supply Date / 7-day window.';

  const res = await Reservation.updateOne(
    { _id: indent._id, status: { $in: OPEN }, 'supplyCheck.status': AWAITING },
    {
      $set: {
        status: 'Cancelled',
        cancelledAt: now,
        expiredAt: now,
        cancellationReason: why,
        'supplyCheck.status': 'Cancelled',
        'supplyCheck.decidedBy': actor?._id ?? null,
        'supplyCheck.decidedAt': now,
      },
    },
  );
  if (!res.modifiedCount) throw fail(409, 'The indent changed a moment ago. Refresh and try again.');

  const ref = indent.indentNumber || indent.reservationId;
  await recordAudit(actor, 'MSIL Indent Cancelled',
    `${ref} ${indent.skuCode} x${indent.quantity} cancelled after the supply check held it: ${why}`,
    req, { meta: { reservationId: indent.reservationId, skuCode: indent.skuCode, quantity: indent.quantity, reason: why } });

  notifyUser(indent.customerId, {
    title: 'Indent Cancelled',
    message: `Indent line ${indent.skuCode} x${indent.quantity} (${ref}) has been cancelled.`,
    type: 'reservation',
  });

  return { reservationId: indent.reservationId, status: 'Cancelled' };
};

export default { setSupplyDate, convertIndent, cancelIndent };
