import Order from '../../models/Order.js';
import User from '../../models/User.js';
import AuditLog from '../../models/AuditLog.js';
import { sendEmail } from '../../utils/mailer.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';
import { notifyUser, notifyAdmins } from '../../utils/notify.js';
import { isPoGenerated, PO_DEADLINE_DAYS } from '../../utils/bookingLock.js';
import { findProductBySku, releaseStock, consumeStock } from '../../utils/stockLedger.js';
import { processAvailableIndents } from '../inventory/indentAvailability.service.js';

/**
 * Settles the stock held by confirmed bookings.
 *
 * Confirming a booking moves units available → booked. They stay there until one
 * of two things happens:
 *
 *   PO raised            → the units are CONSUMED: permanently removed from
 *                          inventory (total and booked both drop).
 *   No PO within 7 days  → the booking is AUTO-CANCELLED and the units are
 *                          RELEASED back to availableForSale.
 *
 * Every row carries `stockState`, so this is idempotent — a second run cannot
 * double-release or double-deduct. Rows predating that field read as 'reserved'.
 */

// Re-exported for callers that already import it from the job.
export { PO_DEADLINE_DAYS };

const isReserved = (row) => (row.stockState ?? 'reserved') === 'reserved';

// The clock starts at the booking date, falling back to the row's creation time.
const bookingDateOf = (row) => row.date || row.orderTimestamp || row.createdAt;

const daysSince = (date) => (Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000);

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
    console.error('[PO settlement audit error]', error);
  }
};

const cancellationEmail = ({ customerName, orderId, lines, bookingDate }) => {
  const cell = 'padding: 7px 12px; border-bottom: 1px solid #eee; font-size: 13px;';
  const head = 'padding: 7px 12px; background: #f4f6f8; color: #555; text-align: left; font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e3e7eb;';
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const rows = lines.map((l) => `
    <tr>
      <td style="${cell}"><strong>${esc(l.skuCode)}</strong></td>
      <td style="${cell}">${esc(l.msilCode || '—')}</td>
      <td style="${cell} text-align: right;">${l.confirmedQty} pcs</td>
    </tr>`).join('');

  return `
    <p>Hi ${esc(customerName)},</p>
    <p>Your booking <strong>${esc(orderId)}</strong> has been
       <strong>automatically cancelled</strong> because no PO was raised against it
       within ${PO_DEADLINE_DAYS} days of the booking date
       (${new Date(bookingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}).</p>

    <table style="border-collapse: collapse; margin: 16px 0; width: 100%;">
      <thead>
        <tr>
          <th style="${head}">SKU</th>
          <th style="${head}">MSIL Code</th>
          <th style="${head} text-align: right;">Quantity Released</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p>The reserved quantities have been returned to available stock. You are welcome
       to place a fresh booking for anything you still need.</p>
    <p>Thank you.</p>
  `;
};

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] Report what would change without writing.
 */
export const runPoSettlement = async ({ dryRun = false } = {}) => {
  console.log(`[Job] Starting PO settlement checks${dryRun ? ' (DRY RUN)' : ''}...`);
  const result = { consumed: [], cancelled: [], skipped: 0 };

  // SKUs whose availability this run moved, in either direction. A release
  // hands units back and may make somebody's indent fulfillable; a consume
  // takes them away and must clear any "now available" notice already sent, so
  // a later restock is announced afresh. Collected across the whole run and
  // acted on once at the end — a SKU freed by two bookings is then judged
  // against the final figure rather than an intermediate one.
  const settledSkus = new Set();

  try {
    // Only rows whose stock is still sitting in 'reserved' need settling.
    const rows = await Order.find({
      status: { $ne: 'Cancelled' },
      $or: [{ stockState: 'reserved' }, { stockState: { $exists: false } }],
    });

    // Group into bookings — the PO, and the cancellation, apply per booking.
    const byBooking = new Map();
    for (const r of rows) {
      if (!isReserved(r)) continue;
      if (!byBooking.has(r.orderId)) byBooking.set(r.orderId, []);
      byBooking.get(r.orderId).push(r);
    }

    for (const [orderId, lines] of byBooking) {
      const locked = lines.some(isPoGenerated);
      const age = daysSince(bookingDateOf(lines[0]));

      // ── PO raised → consume permanently ──────────────────────────────────
      if (locked) {
        if (!dryRun) {
          for (const row of lines) {
            const product = await findProductBySku(row.skuCode);
            if (product) {
              await consumeStock(product, row.confirmedQty || 0, null, {
                workflow: 'po-settlement-consume',
                referenceType: 'booking',
                referenceId: orderId,
              });
              settledSkus.add(row.skuCode);
            }
            row.stockState = 'consumed';
            row.stockSettledAt = new Date();
            await row.save();
          }
          await logSystemEvent(
            'Booking Stock Consumed',
            `PO raised for ${orderId} — ${lines.reduce((n, l) => n + (l.confirmedQty || 0), 0)} unit(s) permanently deducted from inventory.`,
            { orderId, lines: lines.map((l) => ({ skuCode: l.skuCode, qty: l.confirmedQty })) },
          );
        }
        result.consumed.push({
          orderId,
          units: lines.reduce((n, l) => n + (l.confirmedQty || 0), 0),
          lines: lines.map((l) => ({ skuCode: l.skuCode, qty: l.confirmedQty })),
        });
        continue;
      }

      // ── No PO yet, still inside the window → leave alone ─────────────────
      if (age < PO_DEADLINE_DAYS) {
        result.skipped++;
        continue;
      }

      // ── Deadline passed → cancel and release ─────────────────────────────
      const units = lines.reduce((n, l) => n + (l.confirmedQty || 0), 0);
      if (!dryRun) {
        const now = new Date();
        for (const row of lines) {
          const product = await findProductBySku(row.skuCode);
          if (product) {
            await releaseStock(product, row.confirmedQty || 0, null, {
              workflow: 'po-settlement-release',
              referenceType: 'booking',
              referenceId: orderId,
              reasonCode: 'REVERSAL',
            });
            settledSkus.add(row.skuCode);
          }
          row.stockState = 'released';
          row.stockSettledAt = now;
          row.status = 'Cancelled';
          row.autoCancelledAt = now;
          row.remarks = `Auto-cancelled: no PO raised within ${PO_DEADLINE_DAYS} days. ${row.remarks || ''}`.trim();
          await row.save();
        }

        await logSystemEvent(
          'Booking Auto-Cancelled (No PO)',
          `Booking ${orderId} cancelled after ${PO_DEADLINE_DAYS} days without a PO. ${units} unit(s) returned to stock.`,
          { orderId, units, lines: lines.map((l) => ({ skuCode: l.skuCode, qty: l.confirmedQty })) },
        );

        // Tell the customer and the admins.
        const customer = lines[0].user ? await User.findById(lines[0].user).lean() : null;
        if (customer?._id) {
          notifyUser(customer._id, {
            title: 'Booking Auto-Cancelled',
            message: `Booking ${orderId} was cancelled — no PO was raised within ${PO_DEADLINE_DAYS} days. ${units} unit(s) returned to stock.`,
            type: 'order',
          });
        }
        notifyAdmins({
          title: 'Booking Auto-Cancelled (No PO)',
          message: `${orderId} (${lines[0].company || 'customer'}) cancelled after ${PO_DEADLINE_DAYS} days without a PO — ${units} unit(s) released.`,
          type: 'order',
        });

        const to = customer?.email || lines[0].emailId;
        if (to && customer?.preferences?.emailNotifications !== false) {
          await sendEmail(
            to,
            `Booking ${orderId} auto-cancelled — no PO raised`,
            cancellationEmail({
              customerName: customer?.user || customer?.company || lines[0].company || 'Customer',
              orderId,
              lines,
              bookingDate: bookingDateOf(lines[0]),
            }),
            { cc: [...(customer?.bookingCcEmails || []), ...COMPANY_CC] },
          ).catch((e) => console.error('[poSettlement] email error', e));
        }
      }

      result.cancelled.push({ orderId, units, lines: lines.map((l) => ({ skuCode: l.skuCode, qty: l.confirmedQty })) });
    }

    // Units handed back by an auto-cancellation are real availability, so any
    // PO-less indent they now cover is booked automatically — the same thing
    // that happens when an admin adjusts stock up by hand. Runs last, after
    // every booking has been settled and saved, and never throws.
    //
    // This cannot re-book the indents these cancellations came from: an indent
    // is closed when its booking is raised, and cancelling the booking does not
    // reopen it. Only indents still waiting are eligible.
    if (!dryRun && settledSkus.size) {
      const auto = await processAvailableIndents([...settledSkus]);
      if (auto.bookings) {
        console.log(`[Job] PO settlement: released stock auto-booked `
          + `${auto.booked} indent line(s) into ${auto.bookings} booking(s).`);
      }
    }

    console.log(
      `[Job] PO settlement complete${dryRun ? ' (DRY RUN)' : ''}: ` +
      `${result.consumed.length} booking(s) consumed, ` +
      `${result.cancelled.length} auto-cancelled, ${result.skipped} still within the window.`,
    );
    return result;
  } catch (error) {
    console.error('[Job Error] PO settlement failed:', error);
    return result;
  }
};

export default runPoSettlement;
