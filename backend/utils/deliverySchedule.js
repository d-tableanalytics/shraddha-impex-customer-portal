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
import { termsFor } from './transactionTerms.js';
import {
  buildScheduleXlsx, buildSchedulePdf, scheduleTableHtml,
} from '../modules/orders/deliverySchedule.render.js';

/**
 * Statuses whose lines still have a delivery ahead of them.
 *
 * A cancelled or delivered line is history: it may still carry the date it was
 * once promised for, and including it would tell the customer to expect goods
 * they have already had, or that were called off.
 *
 * EXPORTED because it is also the answer to "which lines may be GIVEN a date",
 * and the two must be the same list. It was previously written out a third and
 * fourth time — inline in `scheduleBooking` and again in the screen that drives
 * it — so a status added to one and not the others would have produced lines
 * that could be scheduled but never appeared on a schedule.
 */
export const OPEN_BOOKING_STATUSES = ['Booked', 'PO Received', 'Ready for Dispatch'];
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

/* ─────────────────────────────────────────────────────────────────────────────
 * ONE BOOKING'S SCHEDULE, AS A DOCUMENT
 *
 * Everything above answers "what has this CUSTOMER got coming", across every
 * booking and indent they hold. What follows answers a narrower question —
 * "what is the state of THIS purchase order" — because that is the question a
 * spreadsheet or a PDF has to answer to be filed against the PO it belongs to.
 *
 * The gather lives here rather than in the renderer so the renderer stays pure
 * and testable without a database, which is the same split deliveryScheduleMail
 * already uses and the reason it is worth keeping.
 * ────────────────────────────────────────────────────────────────────────────*/

/**
 * Statuses that mean the goods on a line have physically left.
 *
 * THERE IS NO PER-LINE DISPATCHED QUANTITY IN THIS SYSTEM. Dispatch is a
 * lifecycle STAGE — a line is 'Dispatched' or it is not — so "Qty Dispatch" is
 * derived: a dispatched line has dispatched all of its quantity, and anything
 * short of that stage has dispatched none of it. That is exactly what the stage
 * means today, and inventing a partial figure the database cannot support would
 * put a number on a customer's document that nothing could reconcile.
 *
 * 'Delivered' counts as dispatched. It is a LATER stage, not a different one,
 * and a delivered line that reported nothing dispatched would read as an error.
 */
const DISPATCHED_STATUSES = ['Dispatched', 'Delivered'];

/**
 * What the Pending Schedule column says when a line has no date on it.
 *
 * Taken from the reference document the customer already reads these in, where
 * an undated pending line says exactly this. It is a statement of where the
 * commitment stands — we are asking the manufacturer — and it is a great deal
 * more useful than a blank cell, which reads as an oversight.
 */
const NO_SCHEDULE_YET = 'CHECKING WITH OEM';

/** The Pending Schedule column's date, in the same format the table uses. */
const fmtScheduleDate = (d) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return NO_SCHEDULE_YET;
  return `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
};

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Does this customer's paperwork carry the Maruti (MSIL) part number?
 *
 * Deliberately NOT msilVisibility.msilAppliesTo(). That function answers a
 * different question — may this USER, who may be an admin or a salesperson,
 * SEE MSIL codes anywhere in the portal — and it says yes to every Sales and
 * inventory role. Asked of a customer's own document it would put a Maruti
 * column on a non-MSIL customer's schedule whenever the desk generated it,
 * which is the exact thing the requirement rules out.
 *
 * So the test is a property of the CUSTOMER and nothing else: their category,
 * or the explicit per-account override that already exists for an account that
 * trades MSIL parts without being filed under that category.
 */
export const showsMsilCode = (customer) =>
  customer?.customerCategory === 'MSIL' || customer?.showMsilCode === true;

/**
 * What to head the SKU column with.
 *
 * The reference document says "Koken Code" because Koken is what that customer
 * buys. The portal also carries BIX and IMADA, and heading an IMADA line "Koken
 * Code" is wrong in the particular way that makes a customer doubt the rest of
 * the sheet. A booking that spans brands gets the neutral heading rather than
 * having one of its brands speak for the others.
 */
const skuLabelFor = (rows) => {
  const brands = [...new Set(rows.map((r) => r.brand).filter(Boolean))];
  return brands.length === 1 ? `${brands[0]} Code` : 'SKU Code';
};

/**
 * Build the delivery-schedule document for one booking.
 *
 * @param {string} orderId   the booking id — every Order row sharing it is a line
 * @param {object} [options]
 * @param {object} [options.customer]  the User record, when the caller already
 *        has it. Saves a round trip; looked up here when it does not.
 * @param {object[]} [options.rows]    the Order rows, when the caller already
 *        holds them (raisePo does). Re-read here otherwise.
 * @returns {Promise<object|null>} the document, or null when the booking has no
 *          live lines at all — there is nothing to send a schedule for.
 */
export async function buildBookingScheduleDoc(orderId, { customer = null, rows = null } = {}) {
  const all = rows?.length
    ? rows
    : await Order.find({ orderId }).sort(LINE_ORDER).lean();

  // A cancelled line is not on the schedule: it was called off, and printing it
  // alongside live lines would have the customer expecting goods nobody is
  // sending. Everything else stays, INCLUDING delivered lines — a schedule that
  // dropped a line the moment it completed would stop reconciling against the
  // purchase order it belongs to.
  const lines = all.filter((r) => r.status !== 'Cancelled');
  if (!lines.length) return null;

  const first = lines[0];
  const owner = customer
    || (first.user
      ? await User.findById(first.user)
        .select('user company customerName email customerCategory showMsilCode bookingCcEmails preferences')
        .lean()
      : null);

  const terms = termsFor({ orderId, poNumber: first.poNumber });

  const docLines = lines.map((row, i) => {
    const qty = row.confirmedQty ?? row.requestedQty ?? 0;
    const dispatched = DISPATCHED_STATUSES.includes(row.status) ? qty : 0;
    const pending = Math.max(0, qty - dispatched);
    return {
      // Renumbered densely from 1. `lineSeq` is deliberately sparse — a line
      // that became an indent leaves a gap in it — and a customer's document
      // reading 1, 2, 4 invites a question about a row that was never theirs.
      sr: i + 1,
      poNumber: terms.isPo ? row.poNumber : orderId,
      msilCode: row.msilCode || '',
      skuCode: row.skuCode,
      qty,
      qtyDispatched: dispatched,
      // Only a dispatched line has a dispatch date, and statusTimestamp is when
      // the stage was last set. On a line still being prepared it is the date of
      // some earlier stage, which is not a dispatch date and must not print as
      // one.
      dispatchDate: dispatched ? row.statusTimestamp || null : null,
      qtyPending: pending,
      pendingSchedule: pending === 0
        ? ''
        : row.scheduledDate
          ? fmtScheduleDate(row.scheduledDate)
          : row.scheduleNote || NO_SCHEDULE_YET,
      scheduledDate: row.scheduledDate || null,
    };
  });

  const dated = docLines.map((l) => l.scheduledDate).filter(Boolean).map((d) => new Date(d));

  return {
    title: terms.isPo ? 'Purchase Order Delivery Schedule' : 'Booking Delivery Schedule',
    orderId,
    reference: terms.reference,
    referenceLabel: terms.referenceLabel,
    poDate: first.poDate || first.poGeneratedAt || null,
    /**
     * THE BOOKING-LEVEL DELIVERY SCHEDULE DATE, which is what the PO screen
     * collects and the mail headline quotes.
     *
     * The EARLIEST dated line, not the latest and not the first row's. Every
     * line may carry its own date once the desk has refined the schedule, and
     * of the several possible summaries the earliest is the only one that is
     * never a promise we have not made: it is the date from which the customer
     * starts seeing goods. The latest would read as the whole order's date and
     * overstate the wait; the first row's is an accident of ordering.
     */
    deliveryScheduleDate: dated.length ? new Date(Math.min(...dated)) : null,
    customer: {
      name: owner?.customerName || owner?.company || owner?.user || first.company || 'Customer',
      email: owner?.email || first.emailId || null,
      customerCategory: owner?.customerCategory || null,
    },
    showMsilCode: showsMsilCode(owner),
    skuLabel: skuLabelFor(lines),
    generatedAt: new Date(),
    lines: docLines,
    totals: {
      qty: docLines.reduce((n, l) => n + l.qty, 0),
      dispatched: docLines.reduce((n, l) => n + l.qtyDispatched, 0),
      pending: docLines.reduce((n, l) => n + Math.max(0, l.qty - l.qtyDispatched), 0),
    },
  };
}

/**
 * The .xlsx and .pdf of a document, as nodemailer attachments.
 *
 * ONE FORMAT FAILING DOES NOT SINK THE MAIL — the same rule the weekly reports
 * apply. A PDF that will not draw is no reason to withhold the spreadsheet, and
 * neither is a reason to withhold the email itself, whose body already carries
 * the whole table.
 *
 * @returns {Promise<Array<{filename: string, content: Buffer, contentType: string}>>}
 */
export async function buildScheduleAttachments(doc) {
  if (!doc) return [];
  const out = [];
  for (const [format, build] of [['xlsx', buildScheduleXlsx], ['pdf', buildSchedulePdf]]) {
    try {
      const built = await build(doc);
      out.push({ filename: built.fileName, content: built.content, contentType: built.contentType });
    } catch (error) {
      console.error(`[DeliverySchedule] could not generate the ${format.toUpperCase()}:`, error.message);
    }
  }
  return out;
}

/**
 * The whole package for one booking: the table as HTML, and both attachments.
 *
 * The single call every mail path makes, so the body and the files can never be
 * built from two different reads of the booking.
 */
export async function buildScheduleMailParts(orderId, options = {}) {
  const doc = await buildBookingScheduleDoc(orderId, options);
  if (!doc) return { doc: null, tableHtml: '', attachments: [] };
  return {
    doc,
    tableHtml: scheduleTableHtml(doc),
    attachments: await buildScheduleAttachments(doc),
  };
}

/**
 * Send one customer their complete delivery schedule.
 *
 * Never throws and never rejects. The dates are already saved by the time this
 * runs — the callers write first and mail afterwards, so a mail failure cannot
 * lose a schedule that was already agreed with the customer.
 *
 * ---------------------------------------------------------------------------
 * `orderId` — WHEN THE SCHEDULE CHANGED ON A PARTICULAR BOOKING
 * ---------------------------------------------------------------------------
 *
 * Optional, and it adds rather than replaces. The email keeps the customer's
 * COMPLETE picture across bookings and indents, which is the whole reason this
 * function exists; naming a booking additionally attaches THAT booking's full
 * SKU table in the format the customer files purchase orders in, as a
 * spreadsheet, a PDF, and a table in the body.
 *
 * The indent path (reservations) passes nothing and is unchanged — an indent has
 * no purchase order to draw a PO document for, so there is nothing to attach.
 *
 * @param {object} customer  a User document or lean object, or an id
 * @param {object} [options]
 * @param {string} [options.orderId]  attach this booking's schedule document
 * @returns {Promise<{sent: boolean, total: number, attachments?: number, reason?: string}>}
 */
export async function sendDeliverySchedule(customer, { orderId = null } = {}) {
  try {
    const record =
      customer && typeof customer === 'object' && customer.email
        ? customer
        : await User.findById(customer?._id ?? customer)
          .select('user company customerName email customerCategory showMsilCode bookingCcEmails')
          .lean();

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

    /*
     * The booking that triggered this, in full.
     *
     * The section above is a summary across everything the customer holds — SKU,
     * quantity, date. This is the purchase order itself: every line, what has
     * been dispatched, what is outstanding and when each outstanding line is
     * expected, in the layout the customer files POs in. Both belong in the same
     * email; sending the summary and making them ask for the detail is what the
     * attachments exist to avoid.
     */
    let html = mail.html;
    let attachments = [];
    if (orderId) {
      const parts = await buildScheduleMailParts(orderId, { customer: record });
      if (parts.doc) {
        attachments = parts.attachments;
        html += [
          `<h3 style="font-family:Arial,sans-serif;font-size:15px;margin:22px 0 6px;">`
          + `${esc(parts.doc.referenceLabel)} ${esc(parts.doc.reference)} — full schedule</h3>`,
          parts.tableHtml,
          attachments.length
            ? `<p style="margin-top:10px;color:#555;font-size:13px;">Attached: `
              + `${attachments.map((a) => esc(a.filename)).join(' and ')}.</p>`
            : '',
        ].join('');
      }
    }

    await sendEmail(record.email, mail.subject, html, {
      cc: [...(record.bookingCcEmails || []), ...COMPANY_CC],
      ...(attachments.length ? { attachments } : {}),
    });
    return { sent: true, total: mail.total, attachments: attachments.length };
  } catch (err) {
    console.error('[DeliverySchedule] email failed:', err.message);
    return { sent: false, total: 0, reason: err.message };
  }
}

export default {
  gatherSchedule,
  sendDeliverySchedule,
  buildBookingScheduleDoc,
  buildScheduleAttachments,
  buildScheduleMailParts,
};
