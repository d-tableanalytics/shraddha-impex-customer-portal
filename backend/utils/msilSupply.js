import { PO_DEADLINE_DAYS } from './bookingLock.js';
import { istDayEnd, formatIstDate } from './businessDay.js';

/**
 * The MSIL supply check: may arriving stock convert this indent by itself?
 *
 * An MSIL customer tells us the date they need the goods by (the Supply Date,
 * entered on the Sales Desk). When stock for one of their indents arrives, the
 * indent is converted into the booking AUTOMATICALLY only if the stock arrived
 *
 *   1. on or before the Supply Date (any time that day counts), and
 *   2. within PO_DEADLINE_DAYS (7) days of the booking being made.
 *
 * Otherwise it is NOT converted. It is marked "Awaiting decision" and the desk
 * chooses: Convert it anyway, or Cancel it.
 *
 * THE CHECK IS MADE AT ARRIVAL. The system has no expected-arrival date for
 * stock, so "expected to arrive" is judged by when it actually does: the
 * moment the stock posting runs the indent pass.
 *
 * WHO IT APPLIES TO: MSIL customers with a Supply Date entered. Everyone else —
 * including an MSIL booking with no date yet — converts exactly as before.
 *
 * PURE. Dates in, a decision out; nothing here reads or writes.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Is this a customer the supply check is for? */
export const isMsilCustomer = (customer) => customer?.customerCategory === 'MSIL';

/**
 * The last instant of the date's calendar day IN INDIA — "on or before" includes
 * the whole Supply Date, and the Supply Date is an Indian business day whatever
 * zone the server runs in (see businessDay.js).
 */
export const endOfDay = (date) => istDayEnd(date);

const fmt = (date) => formatIstDate(date);

/**
 * @param {object}  args
 * @param {object}  args.customer     needs `customerCategory`
 * @param {Date?}   args.supplyDate   the booking's MSIL Supply Date
 * @param {Date?}   args.bookingDate  when the booking was made
 * @param {Date}    [args.at]         when the stock arrived (default: now)
 * @returns {{ applies: false } | { applies: true, onTime: boolean, reason: string|null,
 *            supplyBy: Date, windowEnd: Date|null }}
 */
export const supplyDecision = ({ customer, supplyDate, bookingDate, at = new Date() }) => {
  if (!isMsilCustomer(customer) || !supplyDate) return { applies: false };

  const arrived = new Date(at);
  const supplyBy = endOfDay(supplyDate);
  const windowEnd = bookingDate ? new Date(new Date(bookingDate).getTime() + PO_DEADLINE_DAYS * DAY_MS) : null;

  const problems = [];
  if (arrived > supplyBy) {
    problems.push(`stock arrived on ${fmt(arrived)}, after the Supply Date of ${fmt(supplyDate)}`);
  }
  if (windowEnd && arrived > windowEnd) {
    problems.push(`stock arrived more than ${PO_DEADLINE_DAYS} days after the booking `
      + `(booked ${fmt(bookingDate)}; the window closed ${fmt(windowEnd)})`);
  }

  return {
    applies: true,
    onTime: problems.length === 0,
    reason: problems.length
      ? `Not converted automatically: ${problems.join(', and ')}. Convert or cancel it.`
      : null,
    supplyBy,
    windowEnd,
  };
};

export default { isMsilCustomer, endOfDay, supplyDecision };
