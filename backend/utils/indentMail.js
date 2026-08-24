/**
 * Indent and booking notifications — one module, both audiences.
 *
 * WHY ONE MODULE. Three separate flows raise an indent (a confirmation that
 * fulfils nothing, a confirmation that fulfils part of a booking, and material
 * arriving against an indent already waiting), and each one previously decided
 * for itself whether to mail, whom to mail, and what to put in the body. The
 * result was the reported set of gaps: a standalone indent produced a mail
 * headed "Booking confirmed — 0 units", the Support Team was never a recipient
 * of anything, and the body named a SKU and a quantity but not the customer it
 * belonged to. Those are three symptoms of one cause, so they are fixed in one
 * place rather than patched at three call sites.
 *
 * THE CONTRACT EVERY CALLER GETS
 *   • exactly ONE mail to the customer and ONE to the Support Team per event —
 *     never one per line, never one per SKU;
 *   • the same facts in both bodies, so a support agent reading their copy sees
 *     what the customer was told;
 *   • customer identity in every body — name, account, email — because a
 *     support mailbox receives these for every customer at once and "SKU X, 40
 *     units" identifies nothing;
 *   • never throws. These run after the transaction has committed. A mail
 *     failure must not turn a saved indent into a failed request.
 */

import { sendEmail } from './mailer.js';
import { COMPANY_CC, supportRecipients } from './mailRecipients.js';
import { isPurchaseOrder } from './transactionTerms.js';
import { buildBookingJourney, indentOnlyJourney, journeyTablesHtml } from './bookingJourney.js';

// ── Presentation helpers ───────────────────────────────────────────────────

// Escape values that originate from user/product data before dropping them
// into the email HTML.
export const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const fmtDate = (d) => {
  const date = d ? new Date(d) : new Date();
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const CELL = 'padding: 7px 12px; border-bottom: 1px solid #eee; font-size: 13px;';
const HEAD = 'padding: 7px 12px; background: #f4f6f8; color: #555; text-align: left; '
  + 'font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e3e7eb;';

const label = 'padding: 4px 12px 4px 0; color: #777; font-size: 13px; white-space: nowrap;';
const value = 'padding: 4px 0; font-weight: bold; font-size: 13px;';

/**
 * Who this is about — the block that was missing.
 *
 * Rendered in BOTH copies rather than only support's. A customer with several
 * ship-to accounts needs to see which of them the indent was raised against,
 * and a body that is identical for both audiences is one body to keep correct.
 */
export const customerBlock = (customer = {}, { audience = 'customer' } = {}) => {
  // Phone and Customer Category are for the people who have to ACT on the mail,
  // not for the customer it is addressed to. Reading their own phone number
  // back is noise, and "Customer Category" is an internal classification
  // (MSIL / Regular Customer) that drives our pricing and MOQ rules — it is not
  // something the customer asked to be told about themselves.
  //
  // Support keeps both: its copy is the operational record, and a support
  // mailbox with no phone number on it cannot pick the phone up.
  const forSupport = audience === 'support';

  const rows = [
    ['Customer Name', customer.user || customer.name || customer.company || '—'],
    ['Account / Company', customer.company || '—'],
    ['Email', customer.email || '—'],
    ...(forSupport ? [
      ['Phone', customer.phone || '—'],
      ['Customer Category', customer.customerCategory || '—'],
    ] : []),
  ];
  return `
    <table style="border-collapse: collapse; margin: 0 0 16px;">
      ${rows.map(([k, v]) => `
        <tr>
          <td style="${label}">${esc(k)}</td>
          <td style="${value}">${esc(v)}</td>
        </tr>`).join('')}
    </table>`;
};

/** The highlighted reference box at the top of a mail. */
const referenceBox = ({ heading, reference, sub }) => `
  <div style="margin: 18px 0; padding: 14px 18px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 4px;">
    <div style="font-size: 11px; color: #b54708; text-transform: uppercase; letter-spacing: 0.5px;">${esc(heading)}</div>
    <div style="font-size: 22px; font-weight: bold; color: #b54708; font-family: monospace; margin-top: 2px;">${esc(reference)}</div>
    ${sub ? `<div style="margin-top: 8px; font-size: 12px; color: #92400e;">${sub}</div>` : ''}
  </div>`;

/**
 * The indent lines: SKU/material, MSIL code, category and the quantity on
 * indent, plus the per-line reference so a single line can be quoted back.
 */
const indentTable = (lines = [], { audience = 'customer' } = {}) => {
  // The MSIL code is our cross-reference to the customer's own part numbering,
  // used internally to reconcile their codes against ours. The customer orders
  // by SKU and does not need a second code beside it, so their copy drops the
  // column; support keeps it because reconciling is exactly its job.
  const showMsil = audience === 'support';

  const rows = lines.map((l) => `
    <tr>
      <td style="${CELL}"><strong>${esc(l.skuCode)}</strong></td>
      ${showMsil ? `<td style="${CELL}">${esc(l.msilCode || '—')}</td>` : ''}
      <td style="${CELL}">${esc(l.category || '—')}</td>
      <td style="${CELL} text-align: right; color: #b54708; font-weight: bold;">${l.quantity}</td>
      <td style="${CELL} font-family: monospace; font-size: 12px;">${esc(l.reference || '—')}</td>
    </tr>`).join('');

  const total = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  // The Total label spans every column left of the quantity. Dropping MSIL
  // shortens that span — a stale colspan is how a footer ends up one cell out.
  const labelSpan = showMsil ? 3 : 2;

  return `
    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead>
        <tr>
          <th style="${HEAD}">SKU / Material</th>
          ${showMsil ? `<th style="${HEAD}">MSIL Code</th>` : ''}
          <th style="${HEAD}">Category</th>
          <th style="${HEAD} text-align: right;">Qty on Indent</th>
          <th style="${HEAD}">Line Ref</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="${labelSpan}" style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
          <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; color: #b54708;">${total}</td>
          <td style="${CELL} border-bottom: none;"></td>
        </tr>
      </tfoot>
    </table>`;
};

/** The booking lines: what was booked, fulfilled now, and left on indent. */
const bookingTable = (summary = [], { audience = 'customer' } = {}) => {
  const showMsil = audience === 'support';

  const rows = summary.map((s) => `
    <tr>
      <td style="${CELL}"><strong>${esc(s.skuCode)}</strong></td>
      ${showMsil ? `<td style="${CELL}">${esc(s.msilCode || '—')}</td>` : ''}
      <td style="${CELL} text-align: right;">${s.requestedQty}</td>
      <td style="${CELL} text-align: right; color: #1a7f37; font-weight: bold;">${s.confirmedQty}</td>
      <td style="${CELL} text-align: right; ${s.pendingQty > 0 ? 'color: #b54708; font-weight: bold;' : 'color: #bbb;'}">${s.pendingQty}</td>
    </tr>`).join('');

  const totalRequested = summary.reduce((n, s) => n + s.requestedQty, 0);
  const totalConfirmed = summary.reduce((n, s) => n + s.confirmedQty, 0);
  const totalPending = summary.reduce((n, s) => n + s.pendingQty, 0);

  return `
    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead>
        <tr>
          <th style="${HEAD}">SKU</th>
          ${showMsil ? `<th style="${HEAD}">MSIL Code</th>` : ''}
          <th style="${HEAD} text-align: right;">Booked</th>
          <th style="${HEAD} text-align: right;">Confirmed</th>
          <th style="${HEAD} text-align: right;">On Indent</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="${showMsil ? 2 : 1}" style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
          <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">${totalRequested}</td>
          <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; color: #1a7f37;">${totalConfirmed}</td>
          <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; ${totalPending > 0 ? 'color: #b54708;' : 'color: #bbb;'}">${totalPending}</td>
        </tr>
      </tfoot>
    </table>`;
};

// ── Delivery ───────────────────────────────────────────────────────────────

/**
 * Send one mail to the customer and one to the Support Team.
 *
 * The two bodies are built from the same facts and differ only in their opening
 * line, so nothing can be true in one copy and absent from the other.
 *
 * A customer who has switched email notifications off is skipped — but SUPPORT
 * IS NOT. Support's copy is an operational record, not a marketing preference,
 * and losing it because the customer muted their own mail is how an indent goes
 * unworked.
 *
 * @returns {{customer: 'sent'|'failed'|'skipped', support: 'sent'|'failed'|'skipped'}}
 */
const deliver = async ({ customer, subject, customerBody, supportSubject, supportBody, tag }) => {
  const toCustomer = async () => {
    if (!customer?.email || customer?.preferences?.emailNotifications === false) {
      console.warn(`[${tag}] no customer mail: `
        + (customer?.email ? 'email notifications are switched off for this account.' : 'no address on the account.'));
      return 'skipped';
    }
    const ok = await sendEmail(customer.email, subject, customerBody, {
      cc: [...(customer.bookingCcEmails || []), ...COMPANY_CC],
    }).catch((e) => {
      console.error(`[${tag}] customer mail threw for ${customer.email}:`, e.message);
      return false;
    });
    if (!ok) {
      console.error(`[${tag}] customer mail FAILED for ${customer.email} — the record `
        + 'exists but the customer has NOT been told.');
    }
    return ok ? 'sent' : 'failed';
  };

  const toSupport = async () => {
    const support = supportRecipients();
    if (!support) {
      console.warn(`[${tag}] no Support Team address is configured (set SUPPORT_TEAM_EMAILS).`);
      return 'skipped';
    }
    const ok = await sendEmail(support.to, supportSubject, supportBody, { cc: support.cc })
      .catch((e) => {
        console.error(`[${tag}] support mail threw:`, e.message);
        return false;
      });
    if (!ok) console.error(`[${tag}] support mail FAILED — no support address was reached.`);
    return ok ? 'sent' : 'failed';
  };

  // Concurrently, not one after the other. The caller waits on this so it can
  // report whether the notification actually went — and two sequential SMTP
  // round trips would put that wait on the customer's Confirm button twice
  // over. Neither branch throws, so Promise.all cannot reject here.
  const [customerResult, supportResult] = await Promise.all([toCustomer(), toSupport()]);
  return { customer: customerResult, support: supportResult };
};

// ── The three events ───────────────────────────────────────────────────────

/**
 * A STANDALONE INDENT — the customer asked for stock, none of it could be
 * fulfilled, and no booking exists.
 *
 * This is the case that sent nothing at all. The generic booking mail was
 * skipped or, worse, went out headed "Booking confirmed — 0 units", which is
 * both wrong and alarming.
 */
export const sendIndentRaisedMails = async ({ customer, indentId, indentDate, poNumber, lines }) => {
  const name = customer?.user || customer?.name || customer?.company || 'Customer';
  const count = lines.length;
  const units = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);

  // The shared three-table journey. A standalone indent has no booking, so
  // tables 1 and 3 render their "nothing was confirmed" state — the structure
  // stays identical to every other booking mail.
  const journey = indentOnlyJourney({ indentId, lines });

  const facts = (audience) => `
    ${referenceBox({
      heading: 'Indent Number',
      reference: indentId,
      sub: `Indent date: <strong>${esc(fmtDate(indentDate))}</strong>`
        + (poNumber && poNumber !== '-' ? ` &nbsp;·&nbsp; PO: <strong>${esc(poNumber)}</strong>` : ''),
    })}
    ${customerBlock(customer, { audience })}
    ${journeyTablesHtml(journey, { audience })}`;

  const customerBody = `
    <p>Hi ${esc(name)},</p>
    <p>Your indent has been <strong>raised successfully</strong>. The ${units} unit(s) below are
       not in stock today, so they have been recorded as an indent and will be fulfilled as soon
       as fresh stock is received.</p>
    ${facts('customer')}
    <p>We will email you the moment material is inwarded against this indent, and the booking
       will be raised for you automatically — no action is needed from your side.</p>
    <p>Thank you for your business.</p>`;

  const supportBody = `
    <p><strong>A new indent has been raised and needs to be actioned.</strong></p>
    <p>${esc(name)} requested ${units} unit(s) across ${count} line(s) that could not be
       fulfilled from available stock. No booking exists for this request.</p>
    ${facts('support')}
    <p>Please arrange procurement or set an expected availability date from
       <strong>Indent History</strong>.</p>`;

  return deliver({
    customer,
    subject: `Indent ${indentId} raised — ${count} item${count === 1 ? '' : 's'} (${units} units)`,
    customerBody,
    supportSubject: `[Support] Indent ${indentId} raised by ${name} — ${units} units`,
    supportBody,
    tag: 'Indent Raised',
  });
};

/**
 * A BOOKING, with or without an indent attached.
 *
 * One event, one mail each way, whether the confirmation fulfilled everything
 * or split into a booking plus an indent. Splitting it into "a booking mail and
 * an indent mail" is what would produce the duplicates the brief rules out.
 */
export const sendBookingMails = async ({
  customer, orderNumber, poNumber, indentId, bookingDate,
  summary, totalConfirmed, totalPending,
}) => {
  const name = customer?.user || customer?.name || customer?.company || 'Customer';
  const totalRequested = totalConfirmed + totalPending;
  const hasIndent = totalPending > 0;

  // The shared three-table journey, loaded from the rows the confirmation just
  // committed. If the load fails the mail still goes, with the classic single
  // booking table — a mail outage over a table is the wrong trade.
  let journeyByAudience = null;
  try {
    const journey = await buildBookingJourney({ orderId: orderNumber });
    if (journey) {
      journeyByAudience = {
        customer: journeyTablesHtml(journey, { audience: 'customer' }),
        support: journeyTablesHtml(journey, { audience: 'support' }),
      };
    }
  } catch (e) {
    console.error('[Mail] booking journey build failed, falling back to summary table:', e.message);
  }

  const facts = (audience) => `
    <div style="margin: 18px 0; padding: 14px 18px; background: #f0f6ff; border: 1px solid #cfe0f7; border-radius: 4px;">
      <div style="font-size: 11px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">Booking ID</div>
      <div style="font-size: 22px; font-weight: bold; color: #1a5b9e; font-family: monospace; margin-top: 2px;">${esc(orderNumber)}</div>
      <div style="margin-top: 8px; font-size: 12px; color: #5a7ca8;">
        Booking date: <strong>${esc(fmtDate(bookingDate))}</strong>
        ${poNumber && poNumber !== '-' ? ` &nbsp;·&nbsp; PO: <strong>${esc(poNumber)}</strong>` : ''}
        ${hasIndent ? ` &nbsp;·&nbsp; Indent reference: <strong style="font-family: monospace; color: #b54708;">${esc(indentId)}</strong>` : ''}
      </div>
    </div>
    ${customerBlock(customer, { audience })}
    ${journeyByAudience ? journeyByAudience[audience] : bookingTable(summary, { audience })}`;

  const customerBody = `
    <p>Hi ${esc(name)},</p>
    <p>Your booking is <strong>confirmed</strong>.</p>
    ${facts('customer')}
    ${hasIndent
      ? `<p>Of the ${totalRequested} unit(s) booked, <strong>${totalConfirmed}</strong> were confirmed
         from available stock and <strong>${totalPending}</strong> could not be fulfilled. The shortfall
         has been recorded as indent <strong>${esc(indentId)}</strong> — we will notify you as soon as
         material is inwarded against it.</p>`
      : ''}
    ${isPurchaseOrder(poNumber) ? '' : `
    <p style="margin: 16px 0; padding: 12px 16px; background: #fff8e6; border-left: 4px solid #f0a500; font-size: 14px;">
      <strong>Please note:</strong> the turnaround time (TAT) for this booking is
      <strong>7 days</strong> from the date of confirmation.
    </p>`}
    <p>Thank you for your business.</p>`;

  const supportBody = `
    <p><strong>${hasIndent
      ? 'A booking has been confirmed with an indent attached.'
      : 'A booking has been confirmed.'}</strong></p>
    <p>${esc(name)} confirmed ${totalRequested} unit(s): ${totalConfirmed} fulfilled from stock${
      hasIndent ? `, ${totalPending} recorded against indent ${esc(indentId)}` : ''}.</p>
    ${facts('support')}
    ${hasIndent
      ? '<p>Please arrange procurement for the indented lines, or set an expected availability date '
        + 'from <strong>Indent History</strong>.</p>'
      : ''}`;

  const subject = hasIndent
    ? `Booking ${orderNumber} confirmed (${totalConfirmed} units) — ${totalPending} on indent ${indentId}`
    : `Booking ${orderNumber} confirmed — ${totalConfirmed} units`;

  return deliver({
    customer,
    subject,
    customerBody,
    supportSubject: `[Support] ${subject} — ${name}`,
    supportBody,
    tag: 'Booking Confirmed',
  });
};

/**
 * MATERIAL INWARD against an indent that is still open.
 *
 * Sent for the indents that stock arrived for but which could not be booked
 * outright — a part delivery, or units that went to an older indent in the
 * queue. Indents that WERE auto-booked are deliberately excluded here: their
 * booking mail already opens with "stock has arrived for items you were waiting
 * on", and sending this as well would be the duplicate the brief rules out.
 */
export const sendMaterialInwardMails = async ({ customer, lines, reference }) => {
  const name = customer?.user || customer?.name || customer?.company || 'Customer';
  const count = lines.length;

  // Built per audience, because the MSIL column is support-only — see
  // indentTable(). One `rows` string shared by both copies could not drop it.
  const rowsFor = (audience) => lines.map((l) => `
    <tr>
      <td style="${CELL}"><strong>${esc(l.skuCode)}</strong></td>
      ${audience === 'support' ? `<td style="${CELL}">${esc(l.msilCode || '—')}</td>` : ''}
      <td style="${CELL} text-align: right; color: #1a7f37; font-weight: bold;">${l.receivedQty}</td>
      <td style="${CELL} text-align: right;">${l.quantity}</td>
      <td style="${CELL} text-align: right; font-weight: bold;">${l.availableQty}</td>
      <td style="${CELL} font-family: monospace; font-size: 12px;">${esc(l.indentNumber || l.reference || '—')}</td>
    </tr>`).join('');

  const facts = (audience) => `
    ${customerBlock(customer, { audience })}
    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead>
        <tr>
          <th style="${HEAD}">SKU / Material</th>
          ${audience === 'support' ? `<th style="${HEAD}">MSIL Code</th>` : ''}
          <th style="${HEAD} text-align: right;">Inwarded</th>
          <th style="${HEAD} text-align: right;">On Indent</th>
          <th style="${HEAD} text-align: right;">Available</th>
          <th style="${HEAD}">Indent Ref</th>
        </tr>
      </thead>
      <tbody>${rowsFor(audience)}</tbody>
    </table>
    ${reference ? `<p style="font-size: 12px; color: #777;">Inward reference: <strong>${esc(reference)}</strong></p>` : ''}`;

  const customerBody = `
    <p>Hi ${esc(name)},</p>
    <p><strong>Material has been inwarded</strong> against ${count === 1 ? 'an item' : 'items'} you
       have on indent. The received quantity does not yet cover the full indented quantity, so the
       indent stays open and the balance is still on order.</p>
    ${facts('customer')}
    <p>As soon as the available quantity covers an indented line in full, the booking is raised for
       you automatically and we will email you the booking reference.</p>
    <p>Thank you for your patience.</p>`;

  const supportBody = `
    <p><strong>Material inwarded against an open indent.</strong></p>
    <p>${esc(name)} has ${count} indent line(s) on ${count === 1 ? 'a SKU' : 'SKUs'} that were just
       inwarded. The receipt does not cover the indented quantity in full, so ${count === 1 ? 'the line remains' : 'the lines remain'}
       open and no booking has been raised.</p>
    ${facts('support')}
    <p>Please confirm whether the balance is on order, and update the expected availability date
       from <strong>Indent History</strong>.</p>`;

  return deliver({
    customer,
    subject: `Material inwarded against your indent — ${count} item${count === 1 ? '' : 's'}`,
    customerBody,
    supportSubject: `[Support] Material inwarded against ${name}'s open indent — ${count} line(s)`,
    supportBody,
    tag: 'Material Inward',
  });
};

/**
 * The Support Team copy of an auto-booking raised from an indent.
 *
 * The customer's copy is sent by the auto-book service itself, which owns the
 * booking wording; this adds only the copy support was never getting.
 */
export const sendAutoBookSupportMail = async ({ customer, orderNumber, lines, dueAt }) => {
  const support = supportRecipients();
  if (!support) {
    console.warn('[Indent Auto-Book] no Support Team address is configured (set SUPPORT_TEAM_EMAILS).');
    return 'skipped';
  }

  const name = customer?.user || customer?.name || customer?.company || 'Customer';
  const total = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);

  const body = `
    <p><strong>A booking has been raised automatically from an indent.</strong></p>
    <p>Stock was inwarded for ${lines.length} indented line(s) belonging to ${esc(name)},
       so booking <strong>${esc(orderNumber)}</strong> was created and the stock reserved
       against it.</p>
    ${customerBlock(customer, { audience: 'support' })}
    ${indentTable(lines.map((l) => ({
      skuCode: l.skuCode,
      msilCode: l.msilCode,
      category: l.category,
      quantity: l.quantity,
      reference: l.indentNumber || l.reservationId,
    })), { audience: 'support' })}
    <p>Total reserved: <strong>${total}</strong> unit(s). The customer has been asked to raise
       their PO by <strong>${esc(dueAt)}</strong>; the booking is cancelled automatically if
       none arrives.</p>`;

  const ok = await sendEmail(
    support.to,
    `[Support] Booking ${orderNumber} auto-raised from ${name}'s indent — ${total} units`,
    body,
    { cc: support.cc },
  ).catch((e) => {
    console.error('[Indent Auto-Book] support mail threw:', e.message);
    return false;
  });
  if (!ok) console.error('[Indent Auto-Book] support mail FAILED — no support address was reached.');
  return ok ? 'sent' : 'failed';
};

export default {
  sendIndentRaisedMails,
  sendBookingMails,
  sendMaterialInwardMails,
  sendAutoBookSupportMail,
  customerBlock,
  esc,
  fmtDate,
};
