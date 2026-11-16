import Reservation from '../../models/Reservation.js';
import AuditLog from '../../models/AuditLog.js';
import { sendEmail } from '../../utils/mailer.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';
import { notifyUser } from '../../utils/notify.js';

// Helper to log audit events
const logSystemEvent = async (action, remarks) => {
  try {
    await AuditLog.create({
      action: action,
      method: 'SYSTEM_JOB',
      endpoint: 'N/A',
      ipAddress: '127.0.0.1',
      userAgent: 'ERP BACKGROUND JOB',
      remarks: remarks
    });
  } catch (error) {
    console.error('[System Audit Log Error]', error);
  }
};

// Deliver a reminder/expiry notification to the customer's own room.
const sendSystemNotification = (userId, title, message) => {
  notifyUser(userId, { title, message, type: 'reservation' });
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const formatDate = (date) =>
  new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// One row per reservation line, so a customer with ten pending items sees them
// all in a single mail instead of receiving ten near-identical ones.
const itemsTable = (items, { showExpiry }) => `
  <table style="border-collapse: collapse; margin: 12px 0; font-size: 13px;">
    <tr style="background: #f5f5f5;">
      <th align="left" style="padding: 6px 12px; border: 1px solid #e5e5e5;">Reservation</th>
      <th align="left" style="padding: 6px 12px; border: 1px solid #e5e5e5;">SKU Code</th>
      <th align="right" style="padding: 6px 12px; border: 1px solid #e5e5e5;">Qty</th>
      ${showExpiry ? '<th align="left" style="padding: 6px 12px; border: 1px solid #e5e5e5;">Expires</th>' : ''}
    </tr>
    ${items
      .map(
        (r) => `
    <tr>
      <td style="padding: 6px 12px; border: 1px solid #e5e5e5;">${r.reservationId}</td>
      <td style="padding: 6px 12px; border: 1px solid #e5e5e5; font-weight: bold;">${r.skuCode}</td>
      <td align="right" style="padding: 6px 12px; border: 1px solid #e5e5e5;">${r.quantity}</td>
      ${showExpiry ? `<td style="padding: 6px 12px; border: 1px solid #e5e5e5;">${formatDate(r.expiryDate)}</td>` : ''}
    </tr>`,
      )
      .join('')}
  </table>`;

// Each stage sends at most one mail + one in-app notification per customer,
// covering every reservation line that reached that stage today.
const STAGES = {
  expired: {
    action: 'Reservation Expired',
    notificationTitle: 'Booking Auto-Cancelled',
    notification: (items) =>
      `${plural(items.length, 'item')} in your selection list ${items.length === 1 ? 'was' : 'were'} removed after 7 days without confirmation.`,
    subject: (items) => (items.length === 1 ? 'Booking Auto-Cancelled' : 'Bookings Auto-Cancelled'),
    showExpiry: false,
    intro: (items) =>
      `${items.length === 1 ? 'The following item was' : `The following ${plural(items.length, 'item')} were`}
       automatically cancelled and removed from your selection list because
       ${items.length === 1 ? 'it was' : 'they were'} not confirmed within 7 days.`,
    outro: () => 'You can re-add anything you still need to a new booking at any time.',
  },
  finalReminder: {
    action: 'Final Reminder Sent',
    notificationTitle: 'Booking Expiring Soon',
    notification: (items) =>
      `Final reminder: confirm ${plural(items.length, 'item')} in your selection list before ${items.length === 1 ? 'it is' : 'they are'} auto-cancelled.`,
    subject: () => 'Final Reminder — Booking Expires Tomorrow',
    showExpiry: true,
    intro: (items) =>
      `This is the final reminder to confirm ${items.length === 1 ? 'your booking' : `these ${plural(items.length, 'item')}`}:`,
    outro: (items) =>
      `${items.length === 1 ? 'It is' : 'They are'} still in your selection list and will be
       <b>automatically cancelled</b> if not confirmed. Please confirm before then to place your booking.`,
  },
  firstReminder: {
    action: 'Reminder Sent (Day 5)',
    notificationTitle: 'Booking Awaiting Confirmation',
    notification: (items) =>
      `${plural(items.length, 'item')} in your selection list ${items.length === 1 ? 'is' : 'are'} still awaiting confirmation.`,
    subject: () => 'Reminder — Booking Awaiting Confirmation',
    showExpiry: true,
    intro: (items) =>
      `You have ${plural(items.length, 'item')} still in your selection list that ${items.length === 1 ? 'has' : 'have'} not been confirmed:`,
    outro: () =>
      'Please confirm soon — un-confirmed bookings are automatically cancelled after 7 days.',
  },
};

/**
 * @param {object} recipient  the account whose Selection List the lines are in
 * @param {object} [onBehalfOf] the customer, when `recipient` is a staff member
 *        building a list FOR them (see reservation.controller.js). The lines
 *        sat in the staff member's private list — the customer never saw them
 *        — so the reminder goes to the person who can act on it, and says
 *        whose booking it would be.
 */
const notifyStage = async (stageKey, recipient, items, onBehalfOf = null) => {
  const stage = STAGES[stageKey];
  const name = recipient.user || recipient.company || 'there';
  const customerName = onBehalfOf
    ? (onBehalfOf.customerName || onBehalfOf.user || onBehalfOf.company || onBehalfOf.email)
    : null;

  await logSystemEvent(
    stage.action,
    `${plural(items.length, 'reservation')} for ${recipient.email || recipient._id}`
      + (customerName ? ` (selection list for ${customerName})` : '')
      + `: ${items.map((r) => r.reservationId).join(', ')}`,
  );

  sendSystemNotification(
    recipient._id,
    stage.notificationTitle,
    (customerName ? `Selection list for ${customerName}: ` : '') + stage.notification(items),
  );

  if (!recipient.email) return;

  await sendEmail(
    recipient.email,
    stage.subject(items) + (customerName ? ` — ${customerName}` : ''),
    `<p>Hi ${name},</p>
     ${customerName
      ? `<p>These lines are in the Selection List you are building on behalf of
         <strong>${customerName}</strong> from Create Booking.</p>`
      : ''}
     <p>${stage.intro(items)}</p>
     ${itemsTable(items, { showExpiry: stage.showExpiry })}
     <p>${stage.outro(items)}</p>`,
    // Copied to the company addresses like every other customer-facing mail —
    // these expiry warnings were going out with no Cc at all.
    { cc: [...(recipient.bookingCcEmails || []), ...COMPANY_CC] },
  );
};

export const runReservationExpiryChecks = async () => {
  console.log('[Job] Starting Daily Reservation Lifecycle checks...');
  try {
    const now = new Date();
    const activeReservations = await Reservation.find({ status: 'Reserved' })
      .populate('customerId')
      // Who put the line in the list. The customer themselves on every line
      // they reserved; a staff account on a line the desk is building for
      // them, which lives in the staff member's own Selection List.
      .populate('reservedBy', 'user company email bookingCcEmails');

    // Collect each account's due lines first, then send one mail per stage —
    // otherwise a ten-item selection list produces ten identical day-5 emails.
    //
    // Keyed by the account the list belongs to AND the customer it is for, so
    // a salesperson building lists for two customers gets one mail per
    // customer rather than one that mixes them.
    const byCustomer = new Map();
    const bucketFor = (customer, onBehalfOf) => {
      const key = `${customer._id}|${onBehalfOf ? onBehalfOf._id : ''}`;
      if (!byCustomer.has(key)) {
        byCustomer.set(key, { customer, onBehalfOf, expired: [], finalReminder: [], firstReminder: [] });
      }
      return byCustomer.get(key);
    };

    for (let reservation of activeReservations) {
      const owner = reservation.customerId;
      if (!owner) continue;
      // The desk's own list for this customer: the desk is told, not the customer.
      const staff = reservation.reservedBy;
      const stagedByDesk = staff?._id && String(staff._id) !== String(owner._id);
      const customer = stagedByDesk ? staff : owner;
      const onBehalfOf = stagedByDesk ? owner : null;

      const timeDiff = now.getTime() - reservation.reservationDate.getTime();
      const daysElapsed = timeDiff / (24 * 60 * 60 * 1000);

      // Each step is CLAIMED with a write conditional on the state it moves
      // from, and only the run whose write lands notifies. Two runs at once (a
      // second server on the same database) used to both read the old state
      // and both send the same reminder.
      const claim = async (from, set) => (await Reservation.updateOne(
        { _id: reservation._id, status: 'Reserved', ...from },
        { $set: set },
      )).modifiedCount === 1;

      // 1. Auto-cancel after 7 days (now >= expiryDate).
      // Note: stock is NOT deducted when an item is added to the selection list
      // (only at confirmation), so there is nothing to release here — we simply
      // drop the un-confirmed item from the list and notify the customer.
      if (now >= reservation.expiryDate) {
        if (await claim({}, { status: 'Expired', expiredAt: now })) {
          bucketFor(customer, onBehalfOf).expired.push(reservation);
        }
        continue;
      }

      // 2. Final reminder — fires the day before the 7-day auto-cancel so it always
      //    lands before the item is dropped (daily cron + 7-day expiry window).
      if (daysElapsed >= 6 && reservation.lastReminderSent !== 'day7') {
        if (await claim({ lastReminderSent: { $ne: 'day7' } }, { lastReminderSent: 'day7' })) {
          bucketFor(customer, onBehalfOf).finalReminder.push(reservation);
        }
        continue;
      }

      // 3. Day 5 reminder — first nudge, ~2 days before auto-cancel.
      if (daysElapsed >= 5 && reservation.lastReminderSent !== 'day5' && reservation.lastReminderSent !== 'day7') {
        if (await claim({ lastReminderSent: { $nin: ['day5', 'day7'] } }, { lastReminderSent: 'day5' })) {
          bucketFor(customer, onBehalfOf).firstReminder.push(reservation);
        }
      }
    }

    for (const { customer, onBehalfOf, expired, finalReminder, firstReminder } of byCustomer.values()) {
      // A customer can legitimately hit more than one stage on the same run —
      // e.g. one line expiring while another is only on day 5.
      if (expired.length) await notifyStage('expired', customer, expired, onBehalfOf);
      if (finalReminder.length) await notifyStage('finalReminder', customer, finalReminder, onBehalfOf);
      if (firstReminder.length) await notifyStage('firstReminder', customer, firstReminder, onBehalfOf);
    }

    console.log('[Job] Completed Daily Reservation Lifecycle checks.');
  } catch (error) {
    console.error('[Job Error] Failed to run reservation checks:', error);
  }
};
