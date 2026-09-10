/**
 * The delivery schedule a customer is sent — indent items and booking items, in
 * ONE email.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * Indent scheduling already worked: an admin sets availability dates on the
 * indent's lines, and `scheduleIndent` mails the customer a table of them. That
 * HTML was built inline in the reservations controller, which was fine while it
 * was the only schedule in the system.
 *
 * Bookings now carry the same per-line date (`Order.scheduledDate`), and a
 * customer with both should not receive two emails describing one delivery
 * picture. So the rendering moved here, where both callers can reach it, and it
 * takes BOTH lists at once.
 *
 * ---------------------------------------------------------------------------
 * WHAT DECIDES WHAT APPEARS
 * ---------------------------------------------------------------------------
 *
 * The email always shows the customer's COMPLETE current schedule, not the rows
 * that happened to change in the save that triggered it. That is what makes
 * "2 indent items + 3 booking items → one email listing all 5" true, and it is
 * the shape the requirement asks for.
 *
 * The two are separable in the writing but not in the reading:
 *
 *   - only lines with a date appear. A cleared date withdraws the promise, and
 *     a line that never had one has no schedule to report;
 *   - a section with no lines is omitted entirely, so an indent-only customer
 *     gets an indent-only email and never an empty "Booking Items" heading;
 *   - if BOTH are empty the caller is told to send nothing at all, rather than
 *     mailing a customer a table of nothing.
 *
 * Writes stay surgical — only the rows an admin actually edited are saved. It is
 * only the EMAIL that is a complete picture, which is why updating one item's
 * date cannot disturb another's.
 */

import { termsFor } from './transactionTerms.js';

/**
 * `15 Sep 2026` — the day-first Indian format the portal uses everywhere.
 *
 * Spelled out rather than left to `toLocaleDateString('en-IN', {month:'short'})`,
 * which is what the inline indent mail used. That call depends on the ICU data
 * compiled into whichever Node the server happens to run: on Node 24 it renders
 * September as "Sept" while every other month gets three letters, and a
 * small-icu build would produce something different again. An email that is
 * generated on the server and read for years should not change its wording when
 * the runtime is upgraded.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmtDate = (d) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return `${String(date.getDate()).padStart(2, '0')} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CELL = 'padding:8px 12px;border-bottom:1px solid #eee;';
const HEAD = 'padding:8px 12px;text-align:left;';

/**
 * One line, normalised.
 *
 * `Reservation` and `Order` name these differently — an indent line has
 * `quantity` and `reservationId`, a booking line has `confirmedQty` and
 * `orderId` — so each caller maps its own rows into this shape rather than this
 * file learning both schemas.
 *
 * @typedef {{reference: string|null, skuCode: string, product: string|null,
 *            quantity: number, scheduledDate: Date, note: string|null}} ScheduleLine
 */

/** One `<table>` of lines, with the reference column only when it varies. */
const tableFor = (lines) => {
  // A single reference across every row is stated once above the table instead
  // of repeated down a column that never changes.
  const refs = [...new Set(lines.map((l) => l.reference).filter(Boolean))];
  const showRef = refs.length > 1;

  const head = [
    '<thead><tr style="background:#f5f5f5;">',
    showRef ? `<th style="${HEAD}">Reference</th>` : '',
    `<th style="${HEAD}">SKU</th>`,
    `<th style="${HEAD}">Product</th>`,
    '<th style="padding:8px 12px;">Quantity</th>',
    `<th style="${HEAD}">Available From</th>`,
    '</tr></thead>',
  ].join('');

  const body = lines
    .map((l) =>
      [
        '<tr>',
        showRef ? `<td style="${CELL}">${esc(l.reference || '—')}</td>` : '',
        `<td style="${CELL}"><b>${esc(l.skuCode)}</b></td>`,
        `<td style="${CELL}">${esc(l.product || '—')}</td>`,
        `<td style="${CELL}text-align:center;">${esc(l.quantity)}</td>`,
        `<td style="${CELL}">${esc(fmtDate(l.scheduledDate))}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('');

  return {
    html:
      '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">'
      + head
      + `<tbody>${body}</tbody></table>`,
    singleReference: refs.length === 1 ? refs[0] : null,
  };
};

/** Per-line notes, printed under their table so a date can carry a reason. */
const notesFor = (lines) => {
  const noted = lines.filter((l) => l.note);
  if (!noted.length) return '';
  return `<p style="color:#555;">${noted.map((l) => `${esc(l.skuCode)}: ${esc(l.note)}`).join('<br>')}</p>`;
};

/**
 * Build the delivery schedule email.
 *
 * @param {object}          customer       { name, company, email }
 * @param {ScheduleLine[]}  indentLines    lines from Reservation, dated only
 * @param {ScheduleLine[]}  bookingLines   lines from Order, dated only
 * @returns {{subject: string, html: string, total: number}|null}
 *          null when there is nothing to tell the customer.
 */
export function buildDeliveryScheduleMail({ customer, indentLines = [], bookingLines = [] }) {
  const indents = indentLines.filter((l) => l?.scheduledDate);
  const bookings = bookingLines.filter((l) => l?.scheduledDate);
  const total = indents.length + bookings.length;

  // Nothing scheduled. The caller must not send an empty table.
  if (total === 0) return null;

  const sections = [];

  if (bookings.length) {
    const t = tableFor(bookings);
    /*
     * A booking whose PO has been raised IS a purchase order, and the mail has
     * to say so — the same rule the indent mail already applied. Only when every
     * row shares ONE reference can it be named; a mixed batch stays generic,
     * because naming one PO over rows belonging to another would be wrong for
     * half the table.
     */
    const terms = termsFor({ poNumber: t.singleReference });
    sections.push(
      `<h3 style="font-family:Arial,sans-serif;font-size:15px;margin:18px 0 6px;">Booking Items${
        t.singleReference ? ` — ${esc(t.singleReference)}` : ''
      }</h3>`,
      terms.isPo
        ? `<p style="margin:0 0 8px;color:#555;">Against ${esc(terms.scheduleNoun)} <strong>${esc(terms.reference)}</strong>.</p>`
        : '',
      t.html,
      notesFor(bookings),
    );
  }

  if (indents.length) {
    const t = tableFor(indents);
    sections.push(
      `<h3 style="font-family:Arial,sans-serif;font-size:15px;margin:18px 0 6px;">Indent Items${
        t.singleReference ? ` — ${esc(t.singleReference)}` : ''
      }</h3>`,
      t.html,
      notesFor(indents),
    );
  }

  const html = [
    `<p>Dear ${esc(customer?.name || customer?.company || 'Customer')},</p>`,
    `<p>Please find below the updated delivery schedule for your item${total === 1 ? '' : 's'}:</p>`,
    ...sections,
    '<p style="margin-top:16px;">We will be in touch as each item becomes ready to move.</p>',
    '<p>Thank you.</p>',
  ]
    .filter(Boolean)
    .join('');

  /*
   * The subject names what is actually inside, so a customer scanning an inbox
   * can tell a booking update from an indent one without opening it — and a
   * combined mail says so rather than under-reporting itself as one or the
   * other.
   */
  const what =
    bookings.length && indents.length
      ? `${bookings.length} booking + ${indents.length} indent item${total === 1 ? '' : 's'}`
      : bookings.length
        ? `${bookings.length} booking item${bookings.length === 1 ? '' : 's'}`
        : `${indents.length} indent item${indents.length === 1 ? '' : 's'}`;

  return { subject: `Delivery Schedule Update — ${what}`, html, total };
}

export default { buildDeliveryScheduleMail };
