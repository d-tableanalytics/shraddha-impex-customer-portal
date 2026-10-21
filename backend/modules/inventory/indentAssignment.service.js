/**
 * INDENT STOCK ASSIGNMENT — choosing which customer indent arriving stock goes to.
 *
 * Arriving stock has always gone to waiting indents oldest-first (FIFO), by
 * itself (indentAvailability.service.js). With the inventory setting
 * `indentAssignmentMode: 'manual'` it is held instead, and Admin, Sales and the
 * Import Team (permission `assign_indent_stock`) decide here:
 *
 *   autoAssign   run the same FIFO pass for chosen SKUs, on demand;
 *   assign       put N units on one specific indent (partial allowed);
 *   reassign     move an allocation from one customer's indent to another's —
 *                before the first booking's PO only, while the stock is still
 *                merely reserved.
 *
 * NOTHING HERE ALLOCATES BY ITSELF. Every assignment goes through
 * allocateToBooking(), the code the FIFO pass uses, so the result is the same
 * however it was chosen: units land on the booking the indent belongs to as an
 * inward allocation, under its PO, with its own pick list — and stock is taken
 * with the same guarded writes, so it cannot be allocated twice or beyond what
 * is free.
 *
 * Every action is written to the audit trail with who did it.
 */

import Reservation from '../../models/Reservation.js';
import Order from '../../models/Order.js';
import AuditLog from '../../models/AuditLog.js';
import { findProductBySku, releaseStock } from '../../utils/stockLedger.js';
import { isPlaceholderPo } from '../../utils/bookingLock.js';
import { runInTransaction } from '../../utils/transaction.js';
import {
  allocateToBooking, allocationModeFor, parentBookingIdOf, bookForCustomer,
  processAvailableIndents, announceIndentBooking,
} from './indentAvailability.service.js';
import { indentAssignmentMode } from './config.service.js';

const OPEN = ['Pending', 'Partially Confirmed'];
// What the booking path needs to know about a customer (as the FIFO pass reads it).
const CUSTOMER_FIELDS = 'user name email company role phone preferences bookingCcEmails customerCategory '
  + 'customerName shippingAddress billingAddress shopNumber gstNumber';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status });

const audit = (actor, action, remarks, meta, req) => AuditLog.create({
  user: actor?._id || null,
  action,
  method: req?.method || 'SYSTEM',
  endpoint: req?.originalUrl || 'N/A',
  ipAddress: req?.ip || '127.0.0.1',
  userAgent: req?.headers?.['user-agent'] || 'ERP SYSTEM',
  remarks,
  meta,
}).catch((e) => console.error(`[IndentAssignment] audit "${action}" failed:`, e.message));

const customerLabel = (c) => c?.customerName || c?.company || c?.user || c?.name || c?.email || '—';

/** No PO on any line of the booking — the only state an allocation may be moved in. */
const bookingHasPo = (rows) => rows.some((r) => Boolean(r.poGeneratedAt) || !isPlaceholderPo(r.poNumber));

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the screen shows: per SKU with waiting indents, the free stock,
 * the indents (oldest first) and the allocations that may still be moved.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.skuCodes]  Only these SKUs.
 */
export const assignmentQueue = async ({ skuCodes = null } = {}) => {
  const filter = { status: { $in: OPEN } };
  if (skuCodes?.length) filter.skuCode = { $in: skuCodes };
  const indents = await Reservation.find(filter)
    .populate('customerId', CUSTOMER_FIELDS)
    .sort({ reservationDate: 1, _id: 1 })
    .lean();

  const bySku = new Map();
  for (const r of indents) {
    if (!bySku.has(r.skuCode)) bySku.set(r.skuCode, []);
    bySku.get(r.skuCode).push(r);
  }
  const skus = [...bySku.keys()];

  // The booking lines behind these indents: what the customer asked for, and
  // the allocations already made — read once for the whole page.
  const bookingIds = [...new Set(indents.map(parentBookingIdOf).filter(Boolean))];
  const bookingRows = bookingIds.length ? await Order.find({ orderId: { $in: bookingIds } }).lean() : [];
  const rowsOf = new Map();
  for (const r of bookingRows) {
    if (!rowsOf.has(r.orderId)) rowsOf.set(r.orderId, []);
    rowsOf.get(r.orderId).push(r);
  }
  const lineOf = new Map(bookingRows.map((l) => [`${l.orderId}::${l.skuCode}`, l]));

  // Allocations that can still be moved: booking without a PO, line and
  // allocation not yet moving towards dispatch, stock only reserved.
  const movable = await Order.find({
    skuCode: { $in: skus },
    status: 'PO Received',
    stockState: { $in: ['reserved', null] },
    'allocations.0': { $exists: true },
  }).populate('user', CUSTOMER_FIELDS).lean();
  const poByBooking = new Map();
  for (const id of [...new Set(movable.map((m) => m.orderId))]) {
    poByBooking.set(id, bookingHasPo(await Order.find({ orderId: id }, 'poNumber poGeneratedAt').lean()));
  }

  const out = [];
  for (const sku of skus) {
    const product = await findProductBySku(sku);
    const available = Math.max(0, product?.availableForSale ?? 0);
    out.push({
      skuCode: sku,
      brand: product?.brand || null,
      available,
      indents: bySku.get(sku).map((r) => {
        const bookingId = parentBookingIdOf(r);
        const line = bookingId ? lineOf.get(`${bookingId}::${sku}`) : null;
        const allocated = (line?.allocations || [])
          .filter((a) => a.indentNumber === r.indentNumber)
          .reduce((n, a) => n + a.quantity, 0);
        return {
          id: String(r._id),
          reservationId: r.reservationId,
          indentNumber: r.indentNumber || null,
          bookingId,
          customer: customerLabel(r.customerId),
          // What the customer asked for on this line, and what still waits.
          requested: line?.bookedQty || r.quantity + allocated,
          pending: r.quantity,
          date: r.reservationDate || r.createdAt,
          scheduledDate: r.scheduledDate || null,
          // The MSIL supply check, so this screen can say a line arrived late
          // before someone assigns it (doing so counts as the desk's Convert).
          supplyDate: r.supplyDate || null,
          supplyCheck: r.supplyCheck?.status
            ? { status: r.supplyCheck.status, reason: r.supplyCheck.reason || null }
            : null,
          // With no live booking to join (none, or it was cancelled) the indent
          // can only become a booking of its own, and only whole.
          wholeOnly: !allocationModeFor(r, rowsOf.get(bookingId) || []),
        };
      }),
      reassignable: movable
        .filter((m) => m.skuCode === sku && !poByBooking.get(m.orderId))
        .flatMap((m) => (m.allocations || [])
          .filter((a) => (a.status || 'PO Received') === 'PO Received')
          .map((a) => ({
            orderId: m.orderId,
            lineId: String(m._id),
            seq: a.seq,
            quantity: a.quantity,
            indentNumber: a.indentNumber || null,
            customer: customerLabel(m.user),
            at: a.at,
          }))),
    });
  }

  // Stock to hand out first; then by SKU.
  out.sort((a, b) => (b.available > 0) - (a.available > 0) || a.skuCode.localeCompare(b.skuCode));
  return { mode: await indentAssignmentMode(), skus: out };
};

/**
 * Run the FIFO pass now for these SKUs — the same pass that runs by itself in
 * 'auto' mode — whatever the mode.
 */
export const autoAssign = async ({ skuCodes, actor, req }) => {
  const skus = [...new Set((skuCodes || []).map((s) => String(s).trim()).filter(Boolean))];
  if (!skus.length) throw fail(400, 'Choose at least one SKU to auto-assign.');
  const result = await processAvailableIndents(skus, { force: true });
  await audit(
    actor,
    'Indent Stock Auto-Assigned',
    `FIFO auto-assign run for ${skus.join(', ')}: ${result.booked || 0} indent line(s) into ${result.bookings || 0} booking(s).`,
    { skuCodes: skus, mode: 'auto', result },
    req,
  );
  return result;
};

/**
 * Put `quantity` units of free stock on one indent.
 *
 * Refused when the indent is not open, the quantity is more than it is still
 * waiting for, or more than is free. The free-stock check here is for a clear
 * message; the guarded stock write inside allocateToBooking is what actually
 * prevents over-allocation, so a race lost in between is refused too.
 */
export const assignToIndent = async ({ indentId, quantity, actor, req, silent = false, label = 'manual' }) => {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) throw fail(400, 'Enter a whole quantity of at least 1.');

  const indent = await Reservation.findById(indentId).populate('customerId', CUSTOMER_FIELDS).lean();
  if (!indent || !OPEN.includes(indent.status)) throw fail(404, 'This indent is no longer waiting for stock.');
  if (qty > indent.quantity) {
    throw fail(400, `${indent.indentNumber || indent.reservationId} is waiting for ${indent.quantity} unit(s); you cannot assign ${qty}.`);
  }
  const product = await findProductBySku(indent.skuCode);
  const free = Math.max(0, product?.availableForSale ?? 0);
  if (qty > free) throw fail(409, `Only ${free} unit(s) of ${indent.skuCode} are free to assign.`);

  const customer = indent.customerId;
  const indentDoc = { ...indent, customerId: customer?._id };
  const parentId = parentBookingIdOf(indent);
  const parentRows = parentId ? await Order.find({ orderId: parentId }).lean() : [];
  const mode = allocationModeFor(indent, parentRows);

  let made;
  if (mode) {
    made = await allocateToBooking(customer, parentId, [{ indent: indentDoc, take: qty }], parentRows, { mode });
  } else {
    // No live booking to put the units on (none, or it was cancelled): the
    // indent becomes a booking of its own, which takes the whole quantity.
    if (qty !== indent.quantity) {
      throw fail(400, `This indent's booking was cancelled, so it can only be booked whole (${indent.quantity} unit(s)) as a new booking.`);
    }
    made = await bookForCustomer(customer, [indentDoc]);
  }
  if (!made) throw fail(409, 'The stock or the indent changed a moment ago. Refresh and try again.');

  // An MSIL indent the supply check was holding: assigning it here is the same
  // decision as Convert on the Sales Desk, and is recorded as one — otherwise
  // the desk keeps showing Convert / Cancel for a line someone already settled.
  if (indent.supplyCheck?.status === 'Awaiting decision') {
    await Reservation.updateOne({ _id: indent._id, 'supplyCheck.status': 'Awaiting decision' }, {
      $set: {
        'supplyCheck.status': 'Converted manually',
        'supplyCheck.decidedBy': actor?._id ?? null,
        'supplyCheck.decidedAt': new Date(),
      },
    });
  }

  if (!silent) await announceIndentBooking(customer, made);
  await audit(
    actor,
    label === 'manual' ? 'Indent Stock Assigned' : 'Indent Stock Reassigned (In)',
    `${qty} unit(s) of ${indent.skuCode} assigned to ${indent.indentNumber || indent.reservationId} `
    + `(${customerLabel(customer)}) on ${made.orderNumber}.`,
    {
      mode: label,
      skuCode: indent.skuCode,
      quantity: qty,
      indent: indent.indentNumber || indent.reservationId,
      indentId: String(indent._id),
      customer: customerLabel(customer),
      orderId: made.orderNumber,
    },
    req,
  );
  return { orderId: made.orderNumber, quantity: qty, skuCode: indent.skuCode };
};

/**
 * Move an inward allocation to another customer's indent.
 *
 * Allowed only while the allocation's booking has no PO and the units are still
 * merely reserved — once a PO is raised they are committed to that customer.
 *
 * In this order, so stock is never counted twice:
 *   1. one transaction takes the units off the source line, releases them, and
 *      puts the source indent back to waiting for them;
 *   2. they are assigned to the target indent like any manual assignment.
 * If step 2 is refused, step 1 is undone by assigning the units back.
 */
export const reassignAllocation = async ({ orderId, lineId, seq, toIndentId, quantity, actor, req }) => {
  const target = await Reservation.findById(toIndentId).lean();
  if (!target || !OPEN.includes(target.status)) throw fail(404, 'The indent you chose is no longer waiting for stock.');

  // ── 1. Release from the source ──────────────────────────────────────────
  const released = await runInTransaction(async (session) => {
    const opts = session ? { session } : {};
    const rows = await Order.find({ orderId }, null, opts).lean();
    const row = rows.find((r) => String(r._id) === String(lineId));
    if (!row) throw fail(404, 'Booking line not found.');
    if (bookingHasPo(rows)) throw fail(423, `${orderId} has a PO, so its stock is committed and cannot be moved.`);
    if (row.status !== 'PO Received' || !['reserved', null, undefined].includes(row.stockState)) {
      throw fail(409, `${row.skuCode} on ${orderId} is no longer movable (${row.status}).`);
    }
    if (row.skuCode !== target.skuCode) throw fail(400, 'Stock can only move to an indent for the same SKU.');
    const allocation = (row.allocations || []).find((a) => a.seq === Number(seq));
    if (!allocation || (allocation.status || 'PO Received') !== 'PO Received') {
      throw fail(404, 'That allocation is no longer movable.');
    }
    if (allocation.reservationId && allocation.reservationId === target.reservationId) {
      throw fail(400, 'That allocation already belongs to this indent.');
    }

    const qty = quantity === undefined || quantity === null || quantity === '' ? allocation.quantity : Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > allocation.quantity) {
      throw fail(400, `Move between 1 and ${allocation.quantity} unit(s).`);
    }
    if (qty > target.quantity) {
      throw fail(400, `${target.indentNumber || target.reservationId} is waiting for only ${target.quantity} unit(s).`);
    }

    // The line gives the units back, and its indent is owed them again.
    const left = (row.confirmedQty || 0) - qty;
    const remainingAllocations = qty === allocation.quantity
      ? (row.allocations || []).filter((a) => a.seq !== allocation.seq)
      : (row.allocations || []).map((a) => (a.seq === allocation.seq ? { ...a, quantity: a.quantity - qty } : a));
    if (left <= 0 && remainingAllocations.length === 0) {
      // A line that existed only to hold this allocation goes with it.
      await Order.deleteOne({ _id: row._id }, opts);
    } else {
      await Order.updateOne(
        { _id: row._id, stockState: { $in: ['reserved', null] } },
        {
          $set: {
            confirmedQty: left,
            requestedQty: Math.max(0, (row.requestedQty || 0) - qty),
            pendingQty: (row.pendingQty || 0) + qty,
            allocations: remainingAllocations,
          },
        },
        opts,
      );
    }

    const product = await findProductBySku(row.skuCode, session);
    if (!product || !(await releaseStock(product, qty, session, {
      workflow: 'indent-reassign-release', referenceType: 'booking', referenceId: orderId, actor, req,
    }))) {
      throw fail(500, `Stock for ${row.skuCode} could not be released.`);
    }

    // The source indent waits for these units again.
    let source = allocation.reservationId
      ? await Reservation.findOne({ reservationId: allocation.reservationId }, null, opts).lean()
      : null;
    if (source) {
      if (OPEN.includes(source.status)) {
        await Reservation.updateOne({ _id: source._id }, { $inc: { quantity: qty } }, opts);
      } else {
        await Reservation.updateOne(
          { _id: source._id },
          {
            $set: {
              status: left > 0 ? 'Partially Confirmed' : 'Pending',
              quantity: qty,
              autoBookedOrderId: null,
              autoBookedAt: null,
            },
          },
          opts,
        );
      }
      source = { ...source, id: String(source._id) };
    }
    return { row, allocation, qty, source };
  }, { label: 'reassignAllocation' });

  // ── 2. Assign to the target ─────────────────────────────────────────────
  try {
    const result = await assignToIndent({
      indentId: toIndentId, quantity: released.qty, actor, req, label: 'reassign',
    });
    await audit(
      actor,
      'Indent Stock Reassigned',
      `${released.qty} unit(s) of ${released.row.skuCode} moved from ${released.allocation.indentNumber || orderId} `
      + `(${orderId}) to ${target.indentNumber || target.reservationId} (${result.orderId}).`,
      {
        skuCode: released.row.skuCode,
        quantity: released.qty,
        from: { orderId, indent: released.allocation.indentNumber, seq: released.allocation.seq },
        to: { orderId: result.orderId, indent: target.indentNumber || target.reservationId },
      },
      req,
    );
    return { from: orderId, to: result.orderId, quantity: released.qty };
  } catch (err) {
    // Put the units back where they were, then report why the move failed.
    if (released.source) {
      await assignToIndent({
        indentId: released.source.id, quantity: released.qty, actor, req, silent: true, label: 'reassign-undo',
      }).catch((e) => console.error('[IndentAssignment] could not undo a failed reassignment:', e.message));
    }
    throw err;
  }
};

export default { assignmentQueue, autoAssign, assignToIndent, reassignAllocation };
