/**
 * Turn a waiting indent into a booking the moment stock can cover it.
 *
 * Runs off the back of every movement that raises availability — a manual stock
 * update, a counted variance, an import, or units handed back when a booking is
 * auto-cancelled. An indent qualifies when:
 *
 *   • it is still open (Pending or Partially Confirmed)
 *   • it has NO PO number — a PO already commits the customer to a booking that
 *     exists, so there is nothing to raise on their behalf
 *   • enough stock is available to cover the WHOLE quantity
 *   • it is not scheduled for a later date — a promised date is a promise, and
 *     booking early would contradict what the customer was already told
 *
 * The booking is raised, the stock is reserved against it, and the customer is
 * emailed. This replaces the earlier "your item is available, please raise a PO"
 * notice: the two would have fired on identical conditions and told the customer
 * contradictory things.
 *
 * SEQUENCING. Availability is consumed oldest-indent-first, so two customers
 * waiting on the same SKU cannot both be promised the same units. The optimistic
 * choice made here is only a shortlist — `reserveStock` re-checks atomically and
 * refuses to oversell, so a line that loses a race is skipped and retried on the
 * next movement rather than double-booked.
 *
 * NEVER THROWS. It runs after stock has already been written; a mail failure or
 * a missing product must not turn a completed stock posting into an error.
 */

import Reservation from '../../models/Reservation.js';
import StockBalance from '../../models/StockBalance.js';
import Order from '../../models/Order.js';
import AuditLog from '../../models/AuditLog.js';
import { nextSequence } from '../../models/Counter.js';
import { findProductBySku, reserveStock, releaseStock } from '../../utils/stockLedger.js';
import { isPlaceholderPo, PO_DEADLINE_DAYS } from '../../utils/bookingLock.js';
import { sendEmail } from '../../utils/mailer.js';
import { notifyUser } from '../../utils/notify.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';

const OPEN_STATUSES = ['Pending', 'Partially Confirmed'];

/**
 * A scheduled date that has not arrived yet, compared by calendar day.
 *
 * Measured against the START of the promised day, not its end. "Available from
 * 5 Aug" has arrived at 00:00 on 5 Aug — comparing against 23:59 would hold the
 * indent back for the whole of the day it was promised for, so the customer
 * would be booked on the 6th for stock they were told to expect on the 5th.
 */
const scheduledForLater = (date) => {
  if (!date) return false;
  const d = new Date(date);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  return Date.now() < startOfDay.getTime();
};

// The brand is not a schema field — it is implied by which collection the
// product lives in, so it is derived the same way the confirmation path does.
const brandFromModel = (doc) => {
  const name = (doc?.constructor?.modelName || '').toLowerCase();
  if (name.includes('bix')) return 'BIX';
  if (name.includes('imada')) return 'IMADA';
  return 'Koken';
};

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const logSystemEvent = async (action, remarks, meta = null) => {
  try {
    await AuditLog.create({
      action,
      method: 'SYSTEM_JOB',
      endpoint: 'N/A',
      ipAddress: '127.0.0.1',
      userAgent: 'ERP BACKGROUND JOB',
      remarks,
      meta,
    });
  } catch (error) {
    console.error('[Indent auto-book audit error]', error);
  }
};

const bookingEmail = ({ customerName, orderNumber, lines, dueAt }) => {
  const cell = 'padding: 7px 12px; border-bottom: 1px solid #eee; font-size: 13px;';
  const head = 'padding: 7px 12px; background: #f4f6f8; color: #555; text-align: left; '
    + 'font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e3e7eb;';

  const rows = lines.map((l) => `
    <tr>
      <td style="${cell}"><strong>${esc(l.skuCode)}</strong></td>
      <td style="${cell}">${esc(l.msilCode || '—')}</td>
      <td style="${cell} text-align: right; color: #1a7f37; font-weight: bold;">${l.quantity}</td>
      <td style="${cell}">${esc(l.indentNumber || l.reservationId)}</td>
    </tr>`).join('');

  const total = lines.reduce((n, l) => n + l.quantity, 0);

  return `
    <p>Hi ${esc(customerName)},</p>
    <p>Stock has arrived for ${lines.length === 1 ? 'an item you were' : 'items you were'}
       waiting on, so we have <strong>created the booking for you</strong> and reserved the stock
       against it. No action was needed from your side.</p>

    <div style="margin: 18px 0; padding: 14px 18px; background: #f0f6ff; border: 1px solid #cfe0f7; border-radius: 4px;">
      <div style="font-size: 11px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">Booking ID</div>
      <div style="font-size: 22px; font-weight: bold; color: #1a5b9e; font-family: monospace; margin-top: 2px;">${esc(orderNumber)}</div>
    </div>

    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead>
        <tr>
          <th style="${head}">SKU</th>
          <th style="${head}">MSIL Code</th>
          <th style="${head} text-align: right;">Reserved</th>
          <th style="${head}">From Indent</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="${cell} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold; color: #1a7f37;">${total}</td>
          <td style="${cell} border-bottom: none;"></td>
        </tr>
      </tfoot>
    </table>

    <p style="margin: 16px 0; padding: 12px 16px; background: #fff8e6; border-left: 4px solid #f0a500; font-size: 14px;">
      <strong>Please raise your PO by ${esc(dueAt)}.</strong> The stock stays reserved for
      ${PO_DEADLINE_DAYS} days. If no PO is raised by then the booking is cancelled automatically
      and the stock returns to general availability.
    </p>

    <p>If you no longer need this, you can cancel the booking from
       <strong>Booking History</strong> in your portal and the stock will be released straight away.</p>

    <p>Thank you for your business.</p>
  `;
};

/**
 * Raise one booking covering everything of this customer's that is now
 * fulfillable. One booking rather than one per SKU, matching what a manual
 * confirmation produces — a customer who was waiting on four items gets one
 * booking id and one email, not four of each.
 *
 * @returns {{orderNumber: string, lines: object[]}|null} null when nothing could
 *          be reserved, so the caller does not report a booking that isn't there.
 */
const bookForCustomer = async (customer, indents) => {
  const year = new Date().getFullYear();
  const seq = await nextSequence(`order-${year}`);
  const orderNumber = `BO-${year}-${String(seq).padStart(6, '0')}`;
  const now = new Date();

  const rows = [];
  const taken = [];
  const undo = [];

  for (const indent of indents) {
    // CLAIM THE INDENT FIRST, atomically, before any stock moves.
    //
    // This function runs off stock movements, and two of those can land at the
    // same instant — the nightly settlement job while an admin posts an
    // adjustment, or two imports finishing together. Both invocations read the
    // same open indent, and without a claim both would reserve stock and raise
    // a booking: one indent, two bookings, twice the stock committed, and the
    // customer emailed twice.
    //
    // The status filter is what makes it safe. Only the first writer matches an
    // open indent and gets a document back; the loser matches nothing, gets
    // null, and moves on. Reserving the stock first would not help — the stock
    // guard stops an oversell, not a second booking of the same request.
    const claimed = await Reservation.findOneAndUpdate(
      { _id: indent._id, status: { $in: OPEN_STATUSES } },
      {
        $set: {
          status: 'Confirmed',
          confirmedAt: now,
          autoBookedOrderId: orderNumber,
          autoBookedAt: now,
          availabilityNotifiedAt: now,
        },
      },
      { new: true },
    );
    if (!claimed) continue; // another invocation got there first

    // Put the indent back exactly as it was if the booking cannot be completed.
    // Snapshotted from the pre-claim document rather than assumed: an indent
    // reached here as 'Pending' or as 'Partially Confirmed', and the latter
    // legitimately already carries a confirmedAt from its original booking.
    const restore = () => Reservation.updateOne(
      { _id: indent._id },
      {
        $set: {
          status: indent.status,
          confirmedAt: indent.confirmedAt ?? null,
          autoBookedOrderId: indent.autoBookedOrderId ?? null,
          autoBookedAt: indent.autoBookedAt ?? null,
          availabilityNotifiedAt: indent.availabilityNotifiedAt ?? null,
        },
      },
    ).catch((e) => console.error(`[Indent] could not reopen ${indent.reservationId}:`, e.message));

    const product = await findProductBySku(indent.skuCode);
    if (!product) {
      console.error(`[Indent] auto-book skipped ${indent.skuCode}: product not found.`);
      await restore();
      continue;
    }

    // All-or-nothing and atomic. A partial fill is deliberately NOT taken: the
    // indent is a request for a specific quantity, and quietly booking less
    // than asked for would leave a remainder nobody agreed to.
    const reserved = await reserveStock(product, indent.quantity, null, {
      workflow: 'indent-auto-book',
      referenceType: 'booking',
      referenceId: orderNumber,
    });
    if (!reserved) {
      // Stock went elsewhere between the shortlist and here.
      await restore();
      continue;
    }

    undo.push(async () => {
      await releaseStock(product, indent.quantity, null, {
        workflow: 'indent-auto-book-rollback',
        referenceType: 'booking',
        referenceId: orderNumber,
        reasonCode: 'REVERSAL',
      });
      await restore();
    });

    rows.push({
      orderId: orderNumber,
      brand: brandFromModel(product),
      user: customer._id,
      status: 'PO Received',
      orderTimestamp: now,
      company: customer.company || 'Shraddha Impex',
      role: customer.role || 'user',
      date: now,
      skuCode: product.skuCode,
      category: Array.isArray(product.category)
        ? product.category.join(', ')
        : (product.category || 'Unknown'),
      requestedQty: indent.quantity,
      bookedQty: indent.quantity,
      confirmedQty: indent.quantity,
      pendingQty: 0,
      // '-' is the established "no PO yet" placeholder. The settlement job reads
      // it to decide whether this booking is still awaiting a PO.
      poNumber: '-',
      remarks: `Auto-booked from indent ${indent.indentNumber || indent.reservationId} when stock became available.`,
      msilCode: product.msilCode || null,
      boxNo: product.boxNo || null,
      vendorCode: product.vendorCode || null,
      emailId: customer.email || null,
      phoneNumber: customer.phone || null,
      stockState: 'reserved',
    });
    taken.push(indent);
  }

  if (rows.length === 0) return null;

  try {
    await Order.insertMany(rows);
  } catch (error) {
    // The indents are already claimed and the stock already reserved, so a
    // failed insert would otherwise strand both: a closed indent with no
    // booking, and units committed to a booking that does not exist. Unwind
    // both, then let the caller record the failure.
    console.error(`[Indent] auto-book insert failed for ${orderNumber}, rolling back:`, error.message);
    for (const rollback of undo) await rollback();
    throw error;
  }

  return { orderNumber, lines: taken };
};

/**
 * @param {string[]} skuCodes  SKUs whose stock just moved.
 */
export const processAvailableIndents = async (skuCodes) => {
  const empty = { checked: 0, booked: 0, bookings: 0, emailed: 0 };
  try {
    const skus = [...new Set((skuCodes || []).filter(Boolean))];
    if (skus.length === 0) return empty;

    const indents = await Reservation.find({
      skuCode: { $in: skus },
      status: { $in: OPEN_STATUSES },
    }).populate('customerId', 'user name email company role phone preferences bookingCcEmails');
    if (indents.length === 0) return empty;

    // Availability summed across locations, matching what every other screen
    // reports for a SKU.
    const balances = await StockBalance.aggregate([
      { $match: { skuCode: { $in: skus } } },
      { $group: { _id: '$skuCode', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
    ]);
    const remaining = new Map(
      balances.map((b) => [b._id, Math.max(0, b.onHand - b.reserved)]),
    );

    // Oldest first, so the queue is honoured — booking a request made today
    // ahead of one that has been waiting a fortnight is how a customer learns
    // the queue means nothing.
    const byOldest = [...indents].sort(
      (a, b) => new Date(a.reservationDate) - new Date(b.reservationDate),
    );

    const eligible = [];
    for (const r of byOldest) {
      const left = remaining.get(r.skuCode) ?? 0;
      if (left < r.quantity) continue;
      if (!isPlaceholderPo(r.poNumber)) continue;
      if (scheduledForLater(r.scheduledDate)) continue;
      if (!r.customerId?._id) continue;

      remaining.set(r.skuCode, left - r.quantity);
      eligible.push(r);
    }

    if (eligible.length === 0) return { ...empty, checked: indents.length };

    const byCustomer = new Map();
    for (const r of eligible) {
      const key = String(r.customerId._id);
      if (!byCustomer.has(key)) byCustomer.set(key, { customer: r.customerId, lines: [] });
      byCustomer.get(key).lines.push(r);
    }

    let bookings = 0;
    let booked = 0;
    let emailed = 0;
    let emailFailed = 0;
    let emailSkipped = 0;

    for (const { customer, lines } of byCustomer.values()) {
      let made;
      try {
        made = await bookForCustomer(customer, lines);
      } catch (error) {
        // One customer's booking failing must not stop the rest.
        console.error(`[Indent] auto-book failed for ${customer.email || customer._id}:`, error.message);
        continue;
      }
      if (!made) continue;

      bookings += 1;
      booked += made.lines.length;

      const dueAt = new Date(Date.now() + PO_DEADLINE_DAYS * 24 * 60 * 60 * 1000)
        .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const customerName = customer.user || customer.name || customer.company || 'Customer';

      await logSystemEvent(
        'Indent Auto-Booked',
        `Booking ${made.orderNumber} raised automatically for ${customerName} — `
        + `${made.lines.length} indent line(s) became available.`,
        {
          orderId: made.orderNumber,
          lines: made.lines.map((l) => ({
            skuCode: l.skuCode, qty: l.quantity, indent: l.indentNumber || l.reservationId,
          })),
        },
      );

      notifyUser(customer._id, {
        title: 'Booking created from your indent',
        message: `${made.lines.length} indented item${made.lines.length === 1 ? '' : 's'} came back in stock. `
          + `Booking ${made.orderNumber} has been raised and the stock reserved for you.`,
        type: 'order',
      });

      if (customer.email && customer.preferences?.emailNotifications !== false) {
        // AWAITED, and the result believed. This was fire-and-forget with a
        // .catch attached — but sendEmail handles its own errors and resolves
        // false rather than rejecting, so that catch was dead code and `emailed`
        // counted attempts while reading like deliveries. A booking whose
        // notification silently failed looked identical to one that reached the
        // customer, which is what made a real "no mail arrived" report
        // impossible to diagnose after the fact.
        //
        // The wait costs a second or two, after stock is already committed, and
        // buys an answer to "was the customer actually told".
        const delivered = await sendEmail(
          customer.email,
          `Booking ${made.orderNumber} created — your indented stock is available`,
          bookingEmail({ customerName, orderNumber: made.orderNumber, lines: made.lines, dueAt }),
          { cc: [...(customer.bookingCcEmails || []), ...COMPANY_CC] },
        );
        if (delivered) {
          emailed += 1;
        } else {
          emailFailed += 1;
          console.error(
            `[Indent] availability email FAILED for ${customer.email} — booking `
            + `${made.orderNumber} exists and its stock is reserved, but the customer `
            + 'has NOT been told. See the mailer error above.',
          );
        }
      } else {
        emailSkipped += 1;
        console.warn(
          `[Indent] no email for booking ${made.orderNumber}: `
          + (customer.email
            ? 'the customer has email notifications switched off.'
            : 'no address on the account.'),
        );
      }
    }

    // `emailed` counts messages the SMTP server accepted, not attempts.
    return { checked: indents.length, booked, bookings, emailed, emailFailed, emailSkipped };
  } catch (error) {
    // Swallowed by design — see the note at the top.
    console.error('[Indent] auto-book check failed:', error.message);
    return { ...empty, error: error.message };
  }
};

export default { processAvailableIndents };
