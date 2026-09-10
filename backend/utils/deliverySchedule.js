/**
 * Sending a customer their delivery schedule.
 *
 * `deliveryScheduleMail.js` renders; this gathers and sends. Kept apart because
 * the renderer is pure and testable without a database, and because the gather
 * step is the half that has to know about two collections.
 *
 * ---------------------------------------------------------------------------
 * THE TRIGGER, AND WHY IT IS THE SAVE RATHER THAN THE ROW
 * ---------------------------------------------------------------------------
 *
 * One admin save produces one email. That is not a new rule — it is the one the
 * indent schedule was already built on, and the reasoning is written on the
 * screen that drives it:
 *
 *     "One save for the whole indent rather than a control per row. An admin
 *      scheduling against an inbound delivery sets several dates in one sitting,
 *      and saving each separately would send the customer an email per line for
 *      what was a single decision."
 *
 * So there is no debounce, no queue and no dedupe key: the natural unit of
 * "a decision" is the Save button, and an admin who saves twice has genuinely
 * decided twice. What each email CONTAINS is the customer's whole current
 * schedule across bookings and indents, so a second save re-states the complete
 * picture rather than sending a fragment.
 */

import Order, { LINE_ORDER } from '../models/Order.js';
import Reservation from '../models/Reservation.js';
import User from '../models/User.js';
import { sendEmail } from './mailer.js';
import { COMPANY_CC } from './mailRecipients.js';
import { buildDeliveryScheduleMail } from './deliveryScheduleMail.js';

/**
 * Statuses whose lines still have a delivery ahead of them.
 *
 * A cancelled or delivered line is history: it may still carry the date it was
 * once promised for, and including it would tell the customer to expect goods
 * they have already had, or that were called off.
 */
const OPEN_BOOKING_STATUSES = ['Booked', 'PO Received', 'Ready for Dispatch'];
const OPEN_INDENT_STATUSES = ['Pending', 'Partially Confirmed', 'Reserved'];

/**
 * Every scheduled line this customer currently has, from both collections.
 *
 * @param {string|object} customerId
 * @returns {Promise<{indentLines: object[], bookingLines: object[]}>}
 */
export async function gatherSchedule(customerId) {
  const [bookings, indents] = await Promise.all([
    Order.find({
      user: customerId,
      scheduledDate: { $ne: null },
      status: { $in: OPEN_BOOKING_STATUSES },
    })
      .sort(LINE_ORDER)
      .lean(),
    Reservation.find({
      customerId,
      scheduledDate: { $ne: null },
      status: { $in: OPEN_INDENT_STATUSES },
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
  ]);

  return {
    // Mapped into the renderer's neutral shape here, so that file never has to
    // know which collection a line came from.
    bookingLines: bookings.map((o) => ({
      // '-' is the established "no PO yet" placeholder; it is not a reference.
      reference: o.poNumber && o.poNumber !== '-' ? o.poNumber : o.orderId,
      skuCode: o.skuCode,
      product: o.category || null,
      quantity: o.confirmedQty ?? o.requestedQty ?? 0,
      scheduledDate: o.scheduledDate,
      note: o.scheduleNote || null,
    })),
    indentLines: indents.map((r) => ({
      reference: r.indentNumber || r.reservationId || null,
      skuCode: r.skuCode,
      product: r.category || null,
      quantity: r.quantity ?? 0,
      scheduledDate: r.scheduledDate,
      note: r.scheduleNote || null,
    })),
  };
}

/**
 * Send one customer their complete delivery schedule.
 *
 * Never throws and never rejects. The dates are already saved by the time this
 * runs — the callers write first and mail afterwards, so a mail failure cannot
 * lose a schedule that was already agreed with the customer.
 *
 * @param {object} customer  a User document or lean object, or an id
 * @returns {Promise<{sent: boolean, total: number, reason?: string}>}
 */
export async function sendDeliverySchedule(customer) {
  try {
    const record =
      customer && typeof customer === 'object' && customer.email
        ? customer
        : await User.findById(customer?._id ?? customer).select('user company email').lean();

    if (!record?.email) return { sent: false, total: 0, reason: 'no email on file' };

    const { indentLines, bookingLines } = await gatherSchedule(record._id);
    const mail = buildDeliveryScheduleMail({
      customer: { name: record.user || record.customerName, company: record.company, email: record.email },
      indentLines,
      bookingLines,
    });

    // Nothing dated. Clearing the last date is a legitimate outcome and must not
    // send a table of nothing.
    if (!mail) return { sent: false, total: 0, reason: 'nothing scheduled' };

    await sendEmail(record.email, mail.subject, mail.html, { cc: COMPANY_CC });
    return { sent: true, total: mail.total };
  } catch (err) {
    console.error('[DeliverySchedule] email failed:', err.message);
    return { sent: false, total: 0, reason: err.message };
  }
}

export default { gatherSchedule, sendDeliverySchedule };
