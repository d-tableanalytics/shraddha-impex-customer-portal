/**
 * The booking lifecycle status email.
 *
 * ONE mail per status change, to the customer, whatever the booking's shape —
 * a five-SKU booking is one booking and gets one email, not five. The caller
 * (modules/orders/bookingStatus.service.js) guarantees it is invoked once per
 * transition; this module's job is only to say the right thing and to report
 * honestly whether it went.
 *
 * Never throws. It runs after the status change has been committed, and a mail
 * server refusing a connection must not turn a saved status update into a
 * failed request — the failure is returned to the caller, which records it
 * against the timeline event so an admin can see it and resend.
 *
 * Presentation helpers are shared with indentMail.js rather than re-declared,
 * so every notification the portal sends looks like the same company wrote it.
 */

import { sendEmail } from './mailer.js';
import { COMPANY_CC } from './mailRecipients.js';
import { esc, customerBlock } from './indentMail.js';
import { stageOf, stageIndex, stageLabel, BOOKING_LIFECYCLE } from './bookingLifecycle.js';

const CELL = 'padding: 7px 12px; border-bottom: 1px solid #eee; font-size: 13px;';
const HEAD = 'padding: 7px 12px; background: #f4f6f8; color: #555; text-align: left; '
  + 'font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e3e7eb;';

/** Date AND time — a status update is a moment, not a day. */
export const fmtDateTime = (d) => {
  const date = d ? new Date(d) : new Date();
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
};

/** The headline box: booking id, the stage it has reached, and when. */
const statusBox = ({ orderId, status, changedAt, poNumber }) => `
  <div style="margin: 18px 0; padding: 14px 18px; background: #f0f6ff; border: 1px solid #cfe0f7; border-radius: 4px;">
    <div style="font-size: 11px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">Booking ID</div>
    <div style="font-size: 22px; font-weight: bold; color: #1a5b9e; font-family: monospace; margin-top: 2px;">${esc(orderId)}</div>
    <div style="margin-top: 10px; font-size: 13px; color: #1a5b9e;">
      Current status:
      <strong style="text-transform: uppercase; letter-spacing: 0.4px;">${esc(stageLabel(status))}</strong>
    </div>
    <div style="margin-top: 4px; font-size: 12px; color: #5a7ca8;">
      Updated on: <strong>${esc(fmtDateTime(changedAt))}</strong>
      ${poNumber && poNumber !== '-' ? ` &nbsp;·&nbsp; PO: <strong>${esc(poNumber)}</strong>` : ''}
    </div>
  </div>`;

/**
 * The lifecycle rendered as a progress list, with the stage just reached marked.
 *
 * The same four stages the customer sees on their booking page, in the same
 * order, so the email and the portal never appear to disagree about where the
 * booking is. Inline table markup rather than flexbox — Outlook.
 */
const lifecycleStrip = (status) => {
  const current = stageIndex(status);
  const rows = BOOKING_LIFECYCLE.map((stage, idx) => {
    const done = current >= 0 && idx < current;
    const isCurrent = idx === current;
    const mark = done ? '&#10003;' : isCurrent ? '&#9679;' : '&#9675;';
    const colour = isCurrent ? '#1a5b9e' : done ? '#1a7f37' : '#b9c0c8';
    const weight = isCurrent ? 'bold' : 'normal';
    return `
      <tr>
        <td style="padding: 5px 10px 5px 0; font-size: 15px; color: ${colour}; width: 18px;">${mark}</td>
        <td style="padding: 5px 0; font-size: 13px; color: ${isCurrent ? '#1a5b9e' : done ? '#444' : '#98a1ab'}; font-weight: ${weight};">
          ${esc(stage.label)}
          ${isCurrent ? '<span style="margin-left: 8px; font-size: 10px; background: #1a5b9e; color: #fff; padding: 2px 7px; border-radius: 10px; letter-spacing: 0.5px;">CURRENT STAGE</span>' : ''}
        </td>
      </tr>`;
  }).join('');

  return `
    <h4 style="margin: 22px 0 6px; font-size: 12px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">
      Booking progress
    </h4>
    <table style="border-collapse: collapse; margin: 0 0 16px;">${rows}</table>`;
};

/** What is in the booking. Included so the mail stands alone as a record. */
const linesTable = (lines = []) => {
  if (!lines.length) return '';
  const rows = lines.map((l) => `
    <tr>
      <td style="${CELL}"><strong>${esc(l.skuCode)}</strong></td>
      <td style="${CELL}">${esc(l.msilCode || '—')}</td>
      <td style="${CELL} text-align: right; font-weight: bold;">${l.quantity}</td>
    </tr>`).join('');
  const total = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);

  return `
    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead>
        <tr>
          <th style="${HEAD}">SKU / Material</th>
          <th style="${HEAD}">MSIL Code</th>
          <th style="${HEAD} text-align: right;">Qty</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
          <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; color: #1a5b9e;">${total}</td>
        </tr>
      </tfoot>
    </table>`;
};

/**
 * Build the subject and body for a status change.
 *
 * Exported separately from the sending so a resend reproduces the original mail
 * exactly, and so the wording can be unit-tested without an SMTP server.
 */
export const buildStatusMail = ({
  customer, orderId, status, previousStatus, changedAt, poNumber, lines = [],
}) => {
  const stage = stageOf(status);
  if (!stage) return null;

  const name = customer?.user || customer?.name || customer?.company || 'Customer';
  const movedFrom = previousStatus ? stageLabel(previousStatus) : null;

  const body = `
    <p>Hi ${esc(name)},</p>
    <p>There is an update on your booking. It has moved
       ${movedFrom ? `from <strong>${esc(movedFrom)}</strong> ` : ''}to
       <strong>${esc(stage.label)}</strong>.</p>

    ${statusBox({ orderId, status, changedAt, poNumber })}

    <p style="margin: 16px 0; padding: 12px 16px; background: #f6faf7; border-left: 4px solid #1a7f37; font-size: 14px;">
      ${esc(stage.description)}
      ${stage.nextStep ? ` ${esc(stage.nextStep)}` : ''}
    </p>

    ${lifecycleStrip(status)}
    ${customerBlock(customer)}
    ${linesTable(lines)}

    <p style="font-size: 13px; color: #666;">
      You can follow this booking's full timeline at any time from
      <strong>Booking History</strong> in your portal.
    </p>
    <p>Thank you for your business.</p>`;

  return { subject: stage.subject(orderId), body };
};

/**
 * Send the status change email to the customer.
 *
 * @returns {{state: 'sent'|'failed'|'skipped', recipient, cc, subject, error, reason}}
 *          Always resolves — the shape is what gets written to the notification
 *          log on the timeline event.
 */
export const sendBookingStatusMail = async ({
  customer, orderId, status, previousStatus, changedAt, poNumber, lines = [],
}) => {
  const mail = buildStatusMail({ customer, orderId, status, previousStatus, changedAt, poNumber, lines });
  if (!mail) {
    return { state: 'not_applicable', reason: `"${status}" is not a lifecycle stage, so no status email is sent.` };
  }

  if (!customer?.email) {
    const reason = 'No email address on the customer account.';
    console.warn(`[Booking Status] ${orderId} → ${status}: ${reason}`);
    return { state: 'skipped', subject: mail.subject, reason };
  }
  if (customer?.preferences?.emailNotifications === false) {
    const reason = 'Email notifications are switched off for this account.';
    console.warn(`[Booking Status] ${orderId} → ${status}: ${reason}`);
    return { state: 'skipped', recipient: customer.email, subject: mail.subject, reason };
  }

  const cc = [...(customer.bookingCcEmails || []), ...COMPANY_CC];

  // sendEmail already swallows SMTP errors and returns false; the catch is for
  // the ones it cannot — a transport that throws synchronously on a malformed
  // address, say. Either way the caller gets a verdict, never an exception.
  let error = null;
  const ok = await sendEmail(customer.email, mail.subject, mail.body, { cc }).catch((e) => {
    error = e?.message || String(e);
    return false;
  });

  if (!ok) {
    console.error(
      `[Booking Status] ${orderId} → ${status}: mail FAILED for ${customer.email}. `
      + 'The status change is saved but the customer has NOT been told.',
    );
    return {
      state: 'failed',
      recipient: customer.email,
      cc,
      subject: mail.subject,
      error: error || 'The mail server rejected the message or is unreachable.',
    };
  }

  return { state: 'sent', recipient: customer.email, cc, subject: mail.subject };
};

export default { sendBookingStatusMail, buildStatusMail, fmtDateTime };
