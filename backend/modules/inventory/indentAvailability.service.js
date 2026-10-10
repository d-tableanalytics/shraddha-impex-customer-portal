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
import {
  findProductBySku, reserveStock, releaseStock, adjustConsumedQty,
} from '../../utils/stockLedger.js';
import { ratesForSkus } from '../sales/pricing.service.js';
import { isPlaceholderPo, PO_DEADLINE_DAYS } from '../../utils/bookingLock.js';
import { sendEmail } from '../../utils/mailer.js';
import { notifyUser, notifyAdmins } from '../../utils/notify.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';
import { sendAutoBookSupportMail, sendMaterialInwardMails } from '../../utils/indentMail.js';

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

const bookingEmail = ({ customerName, orderNumber, lines, dueAt, allocation = false }) => {
  const cell = 'padding: 7px 12px; border-bottom: 1px solid #eee; font-size: 13px;';
  const head = 'padding: 7px 12px; background: #f4f6f8; color: #555; text-align: left; '
    + 'font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e3e7eb;';

  const rows = lines.map((l) => `
    <tr>
      <td style="${cell}"><strong>${esc(l.skuCode)}</strong></td>
      <td style="${cell} text-align: right; color: #1a7f37; font-weight: bold;">${l.quantity}</td>
      <td style="${cell}">${esc(l.indentNumber || l.reservationId)}</td>
    </tr>`).join('');

  const total = lines.reduce((n, l) => n + l.quantity, 0);

  return `
    <p>Hi ${esc(customerName)},</p>
    <p>Stock has arrived for ${lines.length === 1 ? 'an item you were' : 'items you were'}
       waiting on, so we have ${allocation
    ? '<strong>allocated it to your existing booking</strong>'
    : '<strong>created the booking for you</strong>'} and reserved the stock
       against it. No action was needed from your side.</p>

    <div style="margin: 18px 0; padding: 14px 18px; background: #f0f6ff; border: 1px solid #cfe0f7; border-radius: 4px;">
      <div style="font-size: 11px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">Booking ID</div>
      <div style="font-size: 22px; font-weight: bold; color: #1a5b9e; font-family: monospace; margin-top: 2px;">${esc(orderNumber)}</div>
    </div>

    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead>
        <tr>
          <th style="${head}">SKU</th>
          <th style="${head} text-align: right;">Reserved</th>
          <th style="${head}">From Indent</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold; color: #1a7f37;">${total}</td>
          <td style="${cell} border-bottom: none;"></td>
        </tr>
      </tfoot>
    </table>

    ${dueAt ? `
    <p style="margin: 16px 0; padding: 12px 16px; background: #fff8e6; border-left: 4px solid #f0a500; font-size: 14px;">
      <strong>Please raise your PO by ${esc(dueAt)}.</strong> The stock stays reserved for
      ${PO_DEADLINE_DAYS} days. If no PO is raised by then the booking is cancelled automatically
      and the stock returns to general availability.
    </p>

    <p>If you no longer need this, you can cancel the booking from
       <strong>Booking History</strong> in your portal and the stock will be released straight away.</p>
    ` : ''}

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
      // These rows ARE the whole booking and are pushed in indent order, so the
      // running length is the line's position. See models/Order.js on `lineSeq`.
      lineSeq: rows.length,
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
      // Snapshotted for the picklist, as on every other creation path.
      shippingAddress: customer.shippingAddress || null,
      billingAddress: customer.billingAddress || null,
      shopNumber: customer.shopNumber || null,
      gstCode: customer.gstNumber || null,
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

/** The booking an indent was raised alongside: PI-2026-000009 -> BO-2026-000009. */
export const parentBookingIdOf = (indent) => (
  /^PI-/.test(indent?.indentNumber || '') ? indent.indentNumber.replace(/^PI-/, 'BO-') : null
);

/**
 * Where arriving stock for an indent goes.
 *
 *   'allocate' — the booking the indent was raised with is live: the units are
 *                allocated onto it, under its ID and its PO.
 *   'create'   — that booking id was allocated but nothing on it was ever
 *                confirmed, so it has no rows yet; they are created under it.
 *   null       — no booking to go back to (none, or it was cancelled): a new
 *                booking is raised for the full indent, as before.
 *
 * @param {object[]|undefined} parentRows  Every Order row of the booking.
 */
export const allocationModeFor = (indent, parentRows) => {
  if (!parentBookingIdOf(indent)) return null;
  if (!parentRows?.length) return 'create';
  return parentRows.some((r) => r.status !== 'Cancelled') ? 'allocate' : null;
};

/**
 * Take `take` units off an open indent, atomically.
 *
 * The indent's own quantity is the live remainder. Taking all of it closes the
 * indent; taking part leaves it open for the rest. Guarded on the quantity read
 * a moment ago, so two allocations racing for the same indent cannot both
 * succeed - the loser matches nothing and moves on.
 *
 * @returns {Promise<Function|null>} a function that puts the indent back, or
 *          null when it changed underneath us.
 */
const claimIndentQuantity = async (indent, take, orderId, now) => {
  const guard = { _id: indent._id, status: { $in: OPEN_STATUSES }, quantity: indent.quantity };
  const full = take >= indent.quantity;
  const claimed = await Reservation.findOneAndUpdate(
    guard,
    full
      ? {
        $set: {
          status: 'Confirmed',
          confirmedAt: now,
          autoBookedOrderId: orderId,
          autoBookedAt: now,
          availabilityNotifiedAt: now,
        },
      }
      : { $inc: { quantity: -take }, $set: { status: 'Partially Confirmed' } },
    { new: true },
  );
  if (!claimed) return null;

  return () => Reservation.updateOne(
    { _id: indent._id },
    {
      $set: {
        status: indent.status,
        quantity: indent.quantity,
        confirmedAt: indent.confirmedAt ?? null,
        autoBookedOrderId: indent.autoBookedOrderId ?? null,
        autoBookedAt: indent.autoBookedAt ?? null,
        availabilityNotifiedAt: indent.availabilityNotifiedAt ?? null,
      },
    },
  ).catch((e) => console.error(`[Indent] could not reopen ${indent.reservationId}:`, e.message));
};

/**
 * Allocate arriving stock to indents, ONTO THE BOOKING THEY BELONG TO.
 *
 * A booking that fell short keeps its remainder on its indent (BO-x -> PI-x).
 * When stock arrives, as much as is available goes back onto BO-x as an
 * "inward allocation" of the line it belongs to: same booking ID, same PO, no
 * duplicate booking. Each allocation is a record on the line with its own
 * quantity, date, source indent and dispatch status, so it can be picked and
 * dispatched on its own with its own pick list.
 *
 * The line's confirmedQty includes its allocations (it is what the booking
 * holds and what the PO charges for); `confirmedQty - sum(allocations)` is what
 * was confirmed at booking time.
 *
 * Stock follows the line: reserved on a booking still awaiting its PO, issued
 * outright on one whose PO has already consumed its stock (the settlement job
 * only consumes rows that are still reserved).
 *
 * A SKU the booking never got a line for (nothing was in stock at booking time)
 * gets a line here, with nothing initially confirmed and this allocation on it.
 *
 * @param {Array<{indent: object, take: number}>} items  What to allocate.
 * @param {object} [options]
 * @param {string}   [options.mode]   'allocate' (default) or 'create'.
 * @param {Function} [options.claim]  (indent, take) Claims the units; returns a
 *        restore function, or null to skip. Defaults to claimIndentQuantity.
 * @param {Function} [options.take]   ({product, qty, consumed}) Takes the stock.
 * @param {Function} [options.untake] Reverses `take` if the booking write fails.
 * @returns {object|null} null when nothing could be allocated.
 */
export const allocateToBooking = async (customer, orderId, items, parentRows = [], options = {}) => {
  const now = options.now || new Date();
  const mode = options.mode || 'allocate';
  const live = parentRows.filter((r) => r.status !== 'Cancelled');
  const template = live[0] || null;
  const lineBySku = new Map(live.map((r) => [r.skuCode, r]));
  const seqs = parentRows.map((r) => r.lineSeq).filter(Number.isFinite);
  let nextLineSeq = seqs.length ? Math.max(...seqs) + 1 : 0;

  const ctx = { workflow: 'indent-allocation', referenceType: 'booking', referenceId: orderId };
  const rollbackCtx = { ...ctx, workflow: 'indent-allocation-rollback', reasonCode: 'REVERSAL' };
  const claim = options.claim || ((indent, take) => claimIndentQuantity(indent, take, orderId, now));

  const bySku = new Map();
  const allocated = [];
  const undo = [];

  for (const { indent, take } of items) {
    if (!(take > 0)) continue;
    const restore = await claim(indent, take);
    if (!restore) continue;

    const product = await findProductBySku(indent.skuCode);
    if (!product) {
      console.error(`[Indent] allocation to ${orderId} skipped ${indent.skuCode}: product not found.`);
      await restore();
      continue;
    }

    const row = lineBySku.get(product.skuCode) || null;
    const consumed = (row || template)?.stockState === 'consumed';
    const ok = options.take
      ? await options.take({ product, qty: take, consumed, indent })
      : consumed
        ? (await adjustConsumedQty(product, 0, take, null, ctx)).ok
        : await reserveStock(product, take, null, ctx);
    if (!ok) {
      // Stock went elsewhere between the shortlist and here.
      await restore();
      continue;
    }
    undo.push(async () => {
      if (options.take) await options.untake?.({ product, qty: take, consumed, indent });
      else if (consumed) await adjustConsumedQty(product, take, 0, null, rollbackCtx);
      else await releaseStock(product, take, null, rollbackCtx);
      await restore();
    });

    if (!bySku.has(product.skuCode)) {
      bySku.set(product.skuCode, { row, product, consumed, qty: 0, booked: 0, allocations: [], indents: [] });
    }
    const entry = bySku.get(product.skuCode);
    const seq = (row?.allocations?.length || 0) + entry.allocations.length + 1;
    entry.qty += take;
    entry.booked += indent.quantity;
    entry.indents.push(indent);
    entry.allocations.push({
      seq,
      quantity: take,
      indentNumber: indent.indentNumber || null,
      reservationId: indent.reservationId || null,
      at: now,
      status: 'PO Received',
      statusAt: now,
    });
    allocated.push({
      skuCode: product.skuCode,
      msilCode: product.msilCode || null,
      category: Array.isArray(product.category) ? product.category.join(', ') : (product.category || null),
      quantity: take,
      remaining: indent.quantity - take,
      indentNumber: indent.indentNumber || null,
      reservationId: indent.reservationId || null,
      seq,
    });
  }

  if (allocated.length === 0) return null;

  // A new line on a priced booking is priced at the same tier, so the booking
  // total and the PO keep adding up.
  const newSkus = [...bySku.values()].filter((e) => !e.row).map((e) => e.product.skuCode);
  const rates = template?.priceType && newSkus.length
    ? await ratesForSkus({ rows: live, skus: newSkus })
    : new Map();

  const ops = [];
  for (const { row, product, consumed, qty, booked, allocations, indents } of bySku.values()) {
    if (row) {
      ops.push({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $inc: { requestedQty: qty, confirmedQty: qty },
            // The remainder frozen at confirmation; these are the same units.
            $set: { pendingQty: Math.max(0, (row.pendingQty || 0) - qty) },
            $push: { allocations: { $each: allocations } },
          },
        },
      });
      continue;
    }

    const base = template
      ? {
        // Inherited from the booking, like a desk-added line: same customer,
        // same address, same PO and price tier.
        user: template.user,
        orderTimestamp: template.orderTimestamp,
        company: template.company,
        role: template.role,
        date: template.date,
        poNumber: template.poNumber,
        poGeneratedAt: template.poGeneratedAt ?? null,
        poDate: template.poDate ?? null,
        emailId: template.emailId ?? null,
        phoneNumber: template.phoneNumber ?? null,
        shippingAddress: template.shippingAddress ?? null,
        billingAddress: template.billingAddress ?? null,
        shopNumber: template.shopNumber ?? null,
        gstCode: template.gstCode ?? null,
        location: template.location ?? null,
        priceType: template.priceType ?? null,
        unitPrice: rates.get(product.skuCode) ?? null,
      }
      : {
        // Nothing on this booking was ever confirmed: built as the booking
        // would have been, under its original id.
        user: customer._id,
        orderTimestamp: now,
        company: customer.company || 'Shraddha Impex',
        role: customer.role || 'user',
        date: now,
        poNumber: isPlaceholderPo(indents[0].poNumber) ? '-' : indents[0].poNumber,
        emailId: customer.email || null,
        phoneNumber: customer.phone || null,
        shippingAddress: customer.shippingAddress || null,
        billingAddress: customer.billingAddress || null,
        shopNumber: customer.shopNumber || null,
        gstCode: customer.gstNumber || null,
      };

    ops.push({
      insertOne: {
        document: {
          ...base,
          status: 'PO Received',
          lineSeq: nextLineSeq++,
          orderId,
          brand: brandFromModel(product),
          skuCode: product.skuCode,
          category: Array.isArray(product.category)
            ? product.category.join(', ')
            : (product.category || 'Unknown'),
          // What the customer asked for on this line is what was on indent;
          // none of it was confirmed at booking time.
          requestedQty: qty,
          bookedQty: booked,
          confirmedQty: qty,
          pendingQty: booked - qty,
          msilCode: product.msilCode || null,
          boxNo: product.boxNo || null,
          vendorCode: product.vendorCode || null,
          remarks: `Nothing was in stock at booking time; allocated from indent ${indents.map((i) => i.indentNumber || i.reservationId).join(', ')} as stock arrived.`,
          stockState: consumed ? 'consumed' : 'reserved',
          stockSettledAt: consumed ? now : null,
          allocations,
        },
      },
    });
  }

  try {
    await Order.bulkWrite(ops, { ordered: true });
  } catch (error) {
    console.error(`[Indent] allocation to ${orderId} failed, rolling back:`, error.message);
    for (const rollback of undo) await rollback();
    throw error;
  }

  await logSystemEvent(
    'Indent Allocated',
    `${allocated.reduce((n, a) => n + a.quantity, 0)} unit(s) of arriving stock allocated to ${orderId} `
    + `from its indent (${allocated.map((a) => `${a.skuCode} ${a.quantity}`).join(', ')}).`,
    { orderId, allocations: allocated },
  );

  return {
    orderNumber: orderId,
    allocation: true,
    lines: allocated,
    indentIds: [...bySku.values()].flatMap((e) => e.indents.map((i) => i._id)),
    poRaised: template ? !isPlaceholderPo(template.poNumber) || Boolean(template.poGeneratedAt) : false,
    bookingDate: template?.date || now,
  };
};

/**
 * MATERIAL INWARD against indents that are STILL OPEN after the auto-book pass.
 *
 * The auto-booker only acts on an indent when the arriving stock covers it in
 * full. Everything else — a part delivery, or units that went to an older
 * indent in the queue — left the customer and the Support Team with no word at
 * all that their material had started arriving. That is the reported gap, and
 * it is filled here rather than by loosening the all-or-nothing booking rule,
 * which exists for a good reason.
 *
 * Indents that WERE auto-booked are excluded by construction: this runs after
 * the booking pass and re-reads what is still open, so a line that became a
 * booking has already left the set and cannot be told about the same receipt
 * twice.
 *
 * @param {string[]}            skus         SKUs the receipt touched.
 * @param {Map<string,number>}  inwardBySku  Units received, per SKU.
 * @param {string|null}         reference    The posting's id (ledger batch or
 *                                           import job). Replays of the same
 *                                           posting are silently skipped.
 */
const notifyMaterialInward = async ({ skus, inwardBySku, reference, exclude = [] }) => {
  const stats = { inwardLines: 0, inwardCustomers: 0, inwardEmailed: 0, inwardFailed: 0 };

  const received = skus.filter((s) => (inwardBySku?.get(s) ?? 0) > 0);
  if (received.length === 0) return stats;

  // A posting that has already been announced to this indent is skipped. With
  // no reference to compare, every open indent qualifies — the caller has not
  // given us anything to recognise a replay by, and silence would be worse.
  const notAlreadyTold = reference
    ? { $or: [{ materialInwardNotifiedRef: null }, { materialInwardNotifiedRef: { $ne: reference } }] }
    : {};

  const open = await Reservation.find({
    skuCode: { $in: received },
    status: { $in: OPEN_STATUSES },
    // A part-allocated indent is still open, but its customer has just been
    // told about this receipt by the allocation mail.
    ...(exclude.length ? { _id: { $nin: exclude } } : {}),
    ...notAlreadyTold,
  }).populate(
    'customerId',
    'user name email company role phone preferences bookingCcEmails customerCategory',
  );
  if (open.length === 0) return stats;

  // Read the position back rather than reusing the pre-booking figures — the
  // auto-booker has just consumed some of this stock, and telling a customer
  // that units are available when they have been reserved to somebody else is
  // the kind of wrong number that generates a phone call.
  const balances = await StockBalance.aggregate([
    { $match: { skuCode: { $in: received } } },
    { $group: { _id: '$skuCode', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
  ]);
  const availableBySku = new Map(
    balances.map((b) => [b._id, Math.max(0, b.onHand - b.reserved)]),
  );

  const byCustomer = new Map();
  for (const r of open) {
    if (!r.customerId?._id) continue;
    const key = String(r.customerId._id);
    if (!byCustomer.has(key)) byCustomer.set(key, { customer: r.customerId, lines: [] });
    byCustomer.get(key).lines.push(r);
  }

  const now = new Date();
  for (const { customer, lines } of byCustomer.values()) {
    const rows = lines.map((l) => ({
      skuCode: l.skuCode,
      msilCode: l.msilCode,
      quantity: l.quantity,
      receivedQty: inwardBySku.get(l.skuCode) ?? 0,
      availableQty: availableBySku.get(l.skuCode) ?? 0,
      indentNumber: l.indentNumber,
      reference: l.reservationId,
    }));

    const result = await sendMaterialInwardMails({ customer, lines: rows, reference });
    stats.inwardCustomers += 1;
    stats.inwardLines += lines.length;
    if (result.customer === 'sent') stats.inwardEmailed += 1;
    if (result.customer === 'failed' || result.support === 'failed') stats.inwardFailed += 1;

    notifyUser(customer._id, {
      title: 'Material inwarded against your indent',
      message: `Stock has been received for ${lines.length} indented item`
        + `${lines.length === 1 ? '' : 's'}. The indent stays open until the full quantity is covered.`,
      type: 'reservation',
    });

    // Stamped whatever the mail did. The stamp records "this receipt has been
    // handled for this indent", and a replayed import must not have another go
    // at it just because SMTP was down the first time — that would produce the
    // duplicate the brief rules out, not a recovery.
    await Reservation.updateMany(
      { _id: { $in: lines.map((l) => l._id) } },
      { $set: { materialInwardNotifiedRef: reference ?? null, materialInwardNotifiedAt: now } },
    ).catch((e) => console.error('[Indent] could not stamp material-inward notice:', e.message));
  }

  if (stats.inwardCustomers > 0) {
    notifyAdmins({
      title: 'Material inwarded against open indents',
      message: `${stats.inwardLines} open indent line(s) across ${stats.inwardCustomers} customer(s) `
        + 'had material inwarded but are not yet fully covered.',
      type: 'reservation',
    });
  }

  return stats;
};

/**
 * @param {string[]} skuCodes  SKUs whose stock just moved.
 * @param {object}  [options]
 * @param {string}  [options.event]        'material-inward' when the movement was
 *                                         goods being received. Anything else is
 *                                         a stock change that only auto-books.
 * @param {string}  [options.reference]    The posting's id, used to recognise a
 *                                         replay of the same receipt.
 * @param {Map<string,number>} [options.inwardBySku]  Units received, per SKU.
 */
export const processAvailableIndents = async (skuCodes, options = {}) => {
  const { event = 'stock-change', reference = null, inwardBySku = null } = options;
  const empty = { checked: 0, booked: 0, bookings: 0, emailed: 0 };
  try {
    const skus = [...new Set((skuCodes || []).filter(Boolean))];
    if (skus.length === 0) return empty;

    const indents = await Reservation.find({
      skuCode: { $in: skus },
      status: { $in: OPEN_STATUSES },
    }).populate(
      'customerId',
      'user name email company role phone preferences bookingCcEmails customerCategory',
    );
    if (indents.length === 0) return empty;

    // The material-inward notice covers whatever is STILL open once the
    // auto-booker has taken what it can, so it always runs last — including on
    // the paths that book nothing at all, which is the common case for a part
    // delivery and exactly where the customer was previously told nothing.
    const allocatedIds = [];
    const inwardNotice = async () => (
      event === 'material-inward'
        ? notifyMaterialInward({ skus, inwardBySku: inwardBySku ?? new Map(), reference, exclude: allocatedIds })
        : {}
    );

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

    // The booking each indent was raised with, read once for the batch.
    const parentIds = [...new Set(byOldest.map(parentBookingIdOf).filter(Boolean))];
    const rowsByParent = new Map();
    if (parentIds.length) {
      for (const row of await Order.find({ orderId: { $in: parentIds } }).lean()) {
        if (!rowsByParent.has(row.orderId)) rowsByParent.set(row.orderId, []);
        rowsByParent.get(row.orderId).push(row);
      }
    }
    const modeOf = (r) => allocationModeFor(r, rowsByParent.get(parentBookingIdOf(r)));

    // An indent with a booking to go back to takes WHATEVER is available, oldest
    // first: 10 arriving against an indent of 20 allocates 10 and leaves 10.
    // One without (its booking was cancelled) still needs its whole quantity,
    // because it becomes a booking of its own.
    const eligible = [];
    for (const r of byOldest) {
      const left = remaining.get(r.skuCode) ?? 0;
      if (left <= 0) continue;
      if (scheduledForLater(r.scheduledDate)) continue;
      if (!r.customerId?._id) continue;
      const mode = modeOf(r);
      let take;
      if (mode) {
        take = Math.min(left, r.quantity);
      } else {
        if (left < r.quantity) continue;
        // A PO on the indent means a booking for it exists; never raise an
        // unrelated one.
        if (!isPlaceholderPo(r.poNumber)) continue;
        take = r.quantity;
      }

      remaining.set(r.skuCode, left - take);
      eligible.push({ indent: r, take, mode });
    }

    if (eligible.length === 0) {
      return { ...empty, checked: indents.length, ...(await inwardNotice()) };
    }

    const byCustomer = new Map();
    for (const e of eligible) {
      const key = String(e.indent.customerId._id);
      if (!byCustomer.has(key)) byCustomer.set(key, { customer: e.indent.customerId, lines: [] });
      byCustomer.get(key).lines.push(e);
    }

    let bookings = 0;
    let booked = 0;
    let emailed = 0;
    let emailFailed = 0;
    let emailSkipped = 0;

    for (const { customer, lines } of byCustomer.values()) {
      // One allocation per booking the indents belong to; whatever has no
      // booking to go back to is raised as one new booking, as before.
      const byBooking = new Map();
      const fresh = [];
      for (const e of lines) {
        if (!e.mode) { fresh.push(e.indent); continue; }
        const orderId = parentBookingIdOf(e.indent);
        if (!byBooking.has(orderId)) byBooking.set(orderId, []);
        byBooking.get(orderId).push(e);
      }
      const jobs = [
        ...[...byBooking].map(([orderId, group]) => () => allocateToBooking(
          customer, orderId, group, rowsByParent.get(orderId), { mode: group[0].mode },
        )),
        ...(fresh.length ? [() => bookForCustomer(customer, fresh)] : []),
      ];

      for (const job of jobs) {
      let made;
      try {
        made = await job();
      } catch (error) {
        // One customer's booking failing must not stop the rest.
        console.error(`[Indent] auto-book failed for ${customer.email || customer._id}:`, error.message);
        continue;
      }
      if (!made) continue;
      if (made.allocation) allocatedIds.push(...made.indentIds);

      bookings += 1;
      booked += made.lines.length;

      // No deadline once the booking's PO is raised; a booking still waiting
      // for one keeps the deadline it already had.
      const dueAt = made.poRaised
        ? null
        : new Date(new Date(made.bookingDate || Date.now()).getTime() + PO_DEADLINE_DAYS * 24 * 60 * 60 * 1000)
          .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const customerName = customer.user || customer.name || customer.company || 'Customer';

      // An allocation logged its own audit entry; this one is for new bookings.
      if (!made.allocation) await logSystemEvent(
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
        title: made.allocation ? 'Indented stock allocated to your booking' : 'Booking created from your indent',
        message: made.allocation
          ? `${made.lines.reduce((n, l) => n + l.quantity, 0)} unit(s) of your indent came in and were allocated to booking ${made.orderNumber}.`
          : `${made.lines.length} indented item${made.lines.length === 1 ? '' : 's'} came back in stock. `
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
          made.allocation
            ? `Booking ${made.orderNumber} — indented stock allocated`
            : `Booking ${made.orderNumber} created — your indented stock is available`,
          bookingEmail({
            customerName, orderNumber: made.orderNumber, lines: made.lines, dueAt, allocation: made.allocation,
          }),
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

      // The Support Team's copy. Support was never a recipient of anything on
      // this path, so an indent that quietly turned into a booking with stock
      // committed against it was invisible to the people who work indents.
      // Sent regardless of the customer's own notification preference — it is
      // an operational record, not a subscription.
      await sendAutoBookSupportMail({
        customer,
        orderNumber: made.orderNumber,
        lines: made.lines,
        dueAt,
        allocation: made.allocation,
      });
      }
    }

    // `emailed` counts messages the SMTP server accepted, not attempts.
    return {
      checked: indents.length, booked, bookings, emailed, emailFailed, emailSkipped,
      ...(await inwardNotice()),
    };
  } catch (error) {
    // Swallowed by design — see the note at the top.
    console.error('[Indent] auto-book check failed:', error.message);
    return { ...empty, error: error.message };
  }
};

export default { processAvailableIndents };
