import mongoose from 'mongoose';
import Order, { LINE_ORDER } from '../../models/Order.js';
import User from '../../models/User.js';
import Reservation from '../../models/Reservation.js';
import { nextSequence } from '../../models/Counter.js';
import { io } from '../../server.js';
import { notifyUser } from '../../utils/notify.js';
import { sendEmail } from '../../utils/mailer.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';
import { assertBookingEditable, isPlaceholderPo } from '../../utils/bookingLock.js';
import { hasPermission, PERMISSIONS } from '../../middlewares/rbac.js';
import { boxKey, currentBoxNumbers, shapeBooking, pricingSummary } from './booking.shape.js';
import { quoteBooking, applyPricing, valueBooking } from './pricing.service.js';
import { PRICE_TYPES, normalisePriceType } from '../../config/pricing.js';
import {
  findProductBySku, reserveStock, releaseStock, consumeStock,
  adjustReservedQty, adjustConsumedQty,
} from '../../utils/stockLedger.js';
import { recordAudit } from '../../utils/auditLog.js';
import { attachCustomerDetails } from '../../utils/customerContact.js';
import {
  QTY_EDIT_ACTIONS, buildBookingJourney, journeyTablesHtml,
  openIndentBySku, openIndentsByOrder,
} from '../../utils/bookingJourney.js';
import { isTransactionUnsupported } from '../../utils/mongoSession.js';
import {
  buildScheduleMailParts, OPEN_BOOKING_STATUSES as SCHEDULABLE_STATUSES,
} from '../../utils/deliverySchedule.js';
import { reorderLines, updateDetails } from './bookingEdit.service.js';
import { FieldValidationError } from '../../utils/bookingFields.js';

/**
 * Sales desk: review confirmed bookings, amend them while the PO is pending,
 * then raise the PO — which locks the booking.
 *
 * Sales Users see every customer and every brand (an explicit product decision),
 * so no brand filter is applied here. Route-level `authorize()` keeps everyone
 * else out; each handler re-checks the lock so a stale UI cannot bypass it.
 */

// A booking is a set of Order rows sharing one orderId.
const loadBooking = async (orderId, session = null) => {
  const opts = session ? { session } : {};
  return Order.find({ orderId }, null, opts).sort(LINE_ORDER);
};

// Audit writing lives in utils/auditLog.js — see recordAudit().

/**
 * One booking, shaped, with its indent balance and full order value attached.
 *
 * Five call sites were each doing the same three awaits, and the one that
 * forgot an option would have shipped a booking whose Total Amount section
 * silently read "not priced". One helper means the whole response shape is
 * decided in a single place.
 */
const shapedWithValue = async (rows, req, { includePricing, boxNumbers = null } = {}) => {
  const indentBySku = await openIndentBySku(rows[0]?.orderId);
  return shapeBooking(rows, boxNumbers ?? await currentBoxNumbers(rows), {
    includePricing,
    indentBySku,
    value: includePricing ? await valueBooking({ rows, indentBySku }) : null,
  });
};

/**
 * May this actor see what a customer is charged, and choose it?
 *
 * Asked of every booking response rather than trusted to the client. A role
 * with the booking desk but not view_pricing gets a payload with no money in
 * it — nothing to hide in the UI, because nothing was sent.
 */
const mayPrice = (user) => hasPermission(user, PERMISSIONS.VIEW_PRICING);

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The quantity breakdown the customer is shown when a PO is raised.
 *
 * Five figures per SKU, because three different things move a quantity and
 * blurring them is what made this mail wrong before:
 *
 *   onPo   — what the CUSTOMER asked for, indent included (`bookedQty`)
 *   booked — what the booking holds now, after any desk edit (`confirmedQty`)
 *   change — what SALES/ADMIN did, and nothing else
 *   indent — what is STILL open on the indent, read live
 *
 * `change` is measured against the BOOKING-STAGE quantity — what the booking
 * held once stock was checked — not against `bookedQty`. Booking 50 against 2
 * in stock writes bookedQty 50, confirmedQty 2, pendingQty 48 and moves the 48
 * to an indent. Diffing bookedQty against confirmedQty therefore reported
 * "changed from 50 pcs to 2 pcs" on a booking nobody had touched. The automatic
 * split is not an adjustment; it now shows up in the Indent column, where it
 * belongs, and leaves `change` at zero.
 *
 * The audit trail is what proves a desk edit happened. Every edit is written as
 * 'Booking Edited (Sales)' with fromQty/toQty recorded against confirmedQty
 * (see runUpdateItems), so replaying those entries recovers each line's
 * booking-stage quantity exactly. A line with no entry was never edited.
 *
 * Removed lines no longer exist as rows and come from the same trail. A SKU the
 * desk both added and later removed is ignored — the customer never saw it.
 */
// QTY_EDIT_ACTIONS, buildChangeSummary and changeLabel moved to
// utils/bookingJourney.js so every booking mail (confirmation, status, PO)
// can replay the same edit trail. Re-exported here because order.controller
// imports QTY_EDIT_ACTIONS from this module.
export { QTY_EDIT_ACTIONS };

/**
 * `03 Aug 2026` — spelled out, for the reason given in deliveryScheduleMail.js:
 * `toLocaleDateString` renders from whatever ICU data the running Node was
 * built with, so the same mail would word its dates differently after a runtime
 * upgrade.
 */
const MAIL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMailDate = (d) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getDate()).padStart(2, '0')} ${MAIL_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

const buildPoRaisedEmail = ({
  customerName, orderId, poNumber, summary, journeyHtml,
  scheduleHtml = '', deliveryScheduleDate = null, attachmentNames = [],
}) => {
  // THE CONVERSION EMAIL. Deliberately carries NO booking TAT line: this mail
  // exists only because a PO has been raised, and the 7-day booking turnaround
  // stops applying at that point. Quoting it against a purchase order tells the
  // customer a deadline that is not theirs.
  //
  // From here on the transaction is a Purchase Order, so
  // this mail leads with the PO number — that is the reference the customer will
  // quote from now on. The booking id stays, demoted to a back-reference, purely
  // so they can reconcile which booking became this PO; it is the one mail that
  // legitimately spans both names.
  //
  // The line detail is the shared booking table (utils/bookingJourney.js):
  // booked, confirmed, indent and change in one row per SKU — the same table
  // every booking mail shows.
  return `
    <p>Hi ${esc(customerName)},</p>
    <p>Your booking has been processed and converted into a Purchase Order.
       <strong>PO No. ${esc(poNumber)}</strong> has been raised against it, and
       all further updates will refer to this purchase order.</p>

    <div style="margin: 18px 0; padding: 14px 18px; background: #f0f6ff; border: 1px solid #cfe0f7; border-radius: 4px;">
      <div style="font-size: 11px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">Purchase Order No.</div>
      <div style="font-size: 22px; font-weight: bold; color: #1a5b9e; font-family: monospace;">${esc(poNumber)}</div>
      <div style="margin-top: 10px; font-size: 11px; color: #5a7ca8; letter-spacing: 0.3px;">
        Raised against booking reference <strong style="font-family: monospace;">${esc(orderId)}</strong>
      </div>
      ${deliveryScheduleDate
      ? `<div style="margin-top: 10px; font-size: 11px; color: #5a7ca8; letter-spacing: 0.3px;">
             Delivery scheduled from
             <strong style="color:#1a5b9e;">${esc(fmtMailDate(deliveryScheduleDate))}</strong>
           </div>`
      : ''}
    </div>

    ${summary.changed
      ? `<p><strong>Please note:</strong> our team adjusted some quantities before this purchase order was raised. The adjustments are shown in the Change column below.</p>`
      : ''}

    ${journeyHtml}

    ${/*
       * THE DELIVERY SCHEDULE, in the layout the customer files purchase orders
       * in — every SKU, the ordered quantity, what has been dispatched and what
       * is still outstanding against a date.
       *
       * It does NOT replace the journey table above it, which answers a
       * different question: that one is what the desk CHANGED between the
       * booking and this purchase order, and it is the only place a customer
       * sees a quantity they asked for next to the quantity they are getting.
       * This one is what happens next. Both, or the mail answers half of what
       * the customer opens it to find out.
       */''}
    ${scheduleHtml
      ? `<h3 style="font-family:Arial,sans-serif;font-size:15px;margin:22px 0 8px;color:#1a5b9e;">
           Delivery Schedule
         </h3>
         ${scheduleHtml}`
      : ''}

    ${attachmentNames.length
      ? `<p style="margin-top:12px;font-size:13px;color:#555;">
           The same schedule is attached as ${attachmentNames.map((n) => esc(n)).join(' and ')},
           so you can file it or share it with your team.
         </p>`
      : ''}

    <p>Thank you for your business.</p>
  `;
};

/**
 * Sent to the customer the moment ADMIN OR SALES amends a quantity.
 *
 * The customer can no longer change a booking themselves, so an adjustment they
 * did not make must not wait for the PO mail to surface it — by then the
 * quantities are committed and the conversation is too late. This mail is that
 * notice, and it carries the same booking table every other booking mail
 * shows, so the Change column tells them exactly what moved and by how much.
 */
const buildQuantityAmendedEmail = ({ customerName, orderId, editorName, journeyHtml }) => `
    <p>Hi ${esc(customerName)},</p>
    <p>The quantities on your booking
       <strong style="font-family: monospace;">${esc(orderId)}</strong>
       have been updated by our team${editorName ? ` (${esc(editorName)})` : ''}.</p>

    <div style="margin: 18px 0; padding: 12px 16px; background: #fff8ec; border: 1px solid #f2d9a8; border-radius: 4px; font-size: 13px; color: #7a5b1e;">
      The <strong>Change</strong> column in the table below shows exactly what was
      adjusted and by how much. Everything else on your booking is unchanged.
    </div>

    ${journeyHtml}

    <p style="font-size: 13px; color: #666;">
      No purchase order has been raised yet — you will receive a separate mail
      when it is. If any of this looks wrong, reply to your usual contact and we
      will put it right before the PO goes out.
    </p>
  `;

// Profile fallback for phone/location — shared with order.controller.

/**
 * GET /api/v1/sales/bookings?status=pending|generated|all
 * Bookings grouped by orderId. Defaults to those still awaiting a PO.
 */
export const getBookings = async (req, res, next) => {
  try {
    const scope = String(req.query.status || 'all').toLowerCase();
    const search = String(req.query.search || '').trim();

    const query = {};
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
        { skuCode: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { poNumber: { $regex: search, $options: 'i' } },
      ];
    }

    const rows = await Order.find(query).sort({ createdAt: -1, ...LINE_ORDER });

    const byBooking = new Map();
    for (const r of rows) {
      if (!byBooking.has(r.orderId)) byBooking.set(r.orderId, []);
      byBooking.get(r.orderId).push(r);
    }

    // One lookup for every row on the screen, not one per booking.
    const boxNumbers = await currentBoxNumbers(rows);
    const all = await attachCustomerDetails(
      // One indent query for the whole page rather than one per booking - see
      // openIndentsByOrder.
      await (async () => {
        const groups = [...byBooking.values()];
        const indents = await openIndentsByOrder(groups.map((g) => g[0]?.orderId));
        // Sequential rather than Promise.all: valueBooking only queries for a
        // booking that has an indent SKU its own rows cannot rate, so most
        // iterations touch no database at all.
        const shaped = [];
        for (const b of groups) {
          const indentBySku = indents.get(String(b[0]?.orderId)) ?? new Map();
          shaped.push(shapeBooking(b, boxNumbers, {
            includePricing: mayPrice(req.user),
            indentBySku,
            value: mayPrice(req.user) ? await valueBooking({ rows: b, indentBySku }) : null,
          }));
        }
        return shaped;
      })(),
    );

    // Counts come from the UNFILTERED set (search still applies) so the tabs
    // keep showing the same totals whichever one is selected — otherwise
    // "PO Generated" would read 0 while the Pending tab was open.
    const meta = {
      total: all.length,
      pendingPo: all.filter((b) => !b.locked).length,
      generated: all.filter((b) => b.locked).length,
    };

    let bookings = all;
    if (scope === 'pending') bookings = all.filter((b) => !b.locked);
    else if (scope === 'generated') bookings = all.filter((b) => b.locked);

    // Newest first; grouping above loses the sort order of the flat rows.
    bookings.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.status(200).json({ success: true, data: bookings, meta });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/sales/bookings/:orderId — full detail for the review screen. */
export const getBookingDetail = async (req, res, next) => {
  try {
    const rows = await loadBooking(req.params.orderId);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }
    res.status(200).json({
      success: true,
      data: (await attachCustomerDetails([
        await shapedWithValue(rows, req, { includePricing: mayPrice(req.user) }),
      ]))[0],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Move the unfulfillable part of a quantity increase to an indent.
 *
 * Mirrors what runConfirmBooking does at booking time: the indent id is the
 * booking id with a PI- prefix, so the edit's remainder lands on the SAME
 * indent the original confirmation would have raised — Indent History shows
 * one indent per booking, not one per edit. An open line for the same SKU is
 * topped up rather than duplicated, because one SKU on one booking is one line
 * of demand however many edits produced it.
 */
const setIndentShortfall = async (row, product, indentQty, session, req) => {
  const opts = session ? { session } : {};
  const indentNumber = `PI-${String(row.orderId).replace(/^[A-Z]+-/, '')}`;
  const openFilter = {
    customerId: row.user,
    skuCode: row.skuCode,
    indentNumber,
    status: { $in: ['Pending', 'Partially Confirmed'] },
  };

  // SET, never increment. The desk's quantity is the line's TOTAL, so this
  // booking's indent for the SKU is exactly the part stock could not cover --
  // editing twice must not stack two shortfalls (2 confirmed + 18 indented on
  // a line the desk had just set to 5 is how that looked in production).
  if (indentQty <= 0) {
    await Reservation.updateMany(
      openFilter,
      { $set: { status: 'Cancelled', expiredAt: new Date() } },
      opts,
    );
    return null;
  }

  const existing = await Reservation.findOneAndUpdate(
    openFilter,
    { $set: { quantity: indentQty } },
    { new: true, ...opts },
  );
  if (existing) return existing;

  const year = new Date().getFullYear();
  const seq = await nextSequence(`reservation-${year}`, session);
  const now = new Date();
  const [created] = await Reservation.create([{
    reservationId: `RES-${year}-${String(seq).padStart(6, '0')}`,
    customerId: row.user,
    productId: product._id,
    skuCode: row.skuCode,
    msilCode: product.msilCode || null,
    quantity: indentQty,
    reservationDate: now,
    // Indents do not expire — the expiry job only sweeps 'Reserved' — but the
    // schema requires a date, so use the same 7-day stamp the booking flow does.
    expiryDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    status: 'Pending',
    reservedBy: row.user,
    indentNumber,
    poNumber: row.poNumber || null,
  }], opts);
  return created;
};

/**
 * PUT /api/v1/sales/bookings/:orderId/items
 * Body: { lines: [{ id?, skuCode, quantity }] }
 *
 * Replaces the booking's line set. Every difference against the stored rows is
 * applied to inventory in the same transaction:
 *   quantity up   → reserve the delta   (rejected if stock is short)
 *   quantity down → release the excess
 *   SKU changed   → release the old SKU in full, reserve on the new one
 *   line added    → reserve the quantity
 *   line removed  → release the quantity
 *
 * Rejected outright once the PO is generated, unless the caller can override.
 */
const runUpdateItems = async (req, session) => {
  const { orderId } = req.params;
  // Staff work the whole queue; everyone else may only touch their own booking,
  // and only its quantities. See assertMayAmend() below.
  const isStaff = hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS);
  const incoming = Array.isArray(req.body?.lines) ? req.body.lines : null;
  if (!incoming) throw Object.assign(new Error('lines must be an array.'), { status: 400 });
  if (incoming.length === 0) {
    throw Object.assign(new Error('A booking must keep at least one line.'), { status: 400 });
  }

  for (const l of incoming) {
    const qty = Number(l.quantity);
    if (!l.skuCode || !Number.isInteger(qty) || qty <= 0) {
      throw Object.assign(
        new Error('Each line needs a skuCode and a whole quantity greater than zero.'),
        { status: 400 },
      );
    }
  }

  // Reject duplicate SKUs — two lines for one SKU makes the stock delta ambiguous.
  const skus = incoming.map((l) => String(l.skuCode).trim());
  if (new Set(skus).size !== skus.length) {
    throw Object.assign(new Error('The same SKU appears more than once. Combine the quantities into one line.'), { status: 400 });
  }

  const existing = await loadBooking(orderId, session);

  // OWNERSHIP FIRST, before the lock. 404 rather than 403, matching
  // getOrderById and the timeline. Order matters: checking the lock first would
  // answer 423 for a real booking and 404 for one that does not exist, and the
  // difference between those two replies is enough to enumerate booking ids
  // from an account that owns none of them.
  if (!isStaff && (existing.length === 0
    || !existing.every((r) => String(r.user) === String(req.user._id)))) {
    throw Object.assign(new Error('Booking not found.'), { status: 404 });
  }

  assertBookingEditable(existing, req.user);

  if (!isStaff) {
    // A customer may revise QUANTITIES on their own booking and nothing else.
    // The desk composes a booking — adds lines, drops them, swaps a SKU for
    // another; letting the same request body do all that on the customer's
    // side would turn "edit my quantity" into "rewrite my order", so each
    // incoming line has to name a row that already exists and carry the SKU it
    // already has, and no row may be left out.
    const byId = new Map(existing.map((r) => [String(r._id), r]));
    if (incoming.length !== existing.length) {
      throw Object.assign(
        new Error('Send every line of the booking. Lines cannot be added or removed here.'),
        { status: 400 },
      );
    }
    for (const l of incoming) {
      const row = l.id ? byId.get(String(l.id)) : null;
      if (!row) {
        throw Object.assign(
          new Error('Lines cannot be added here — only the quantity of an existing line may be changed.'),
          { status: 400 },
        );
      }
      if (String(l.skuCode).trim() !== row.skuCode) {
        throw Object.assign(
          new Error('The SKU of a line cannot be changed here — only its quantity.'),
          { status: 400 },
        );
      }
    }
  }

  // A line whose PO was raised has already left inventory ('consumed'); one
  // still awaiting a PO is merely held ('reserved'). The two need different
  // ledger operations, so dispatch on the row's state rather than assuming.
  const isConsumed = (row) => (row?.stockState ?? 'reserved') === 'consumed';
  const ledgerCtx = {
    workflow: 'sales-desk-edit',
    referenceType: 'booking',
    referenceId: orderId,
    actor: req.user,
    req,
  };
  const giveBack = (product, row, qty) =>
    isConsumed(row)
      ? adjustConsumedQty(product, qty, 0, session, ledgerCtx).then((r) => r.ok)
      : releaseStock(product, qty, session, ledgerCtx);
  const takeFor = (product, row, qty) =>
    isConsumed(row)
      ? adjustConsumedQty(product, 0, qty, session, ledgerCtx).then((r) => r.ok)
      : reserveStock(product, qty, session, ledgerCtx);

  const template = existing[0];
  const byId = new Map(existing.map((r) => [String(r._id), r]));
  const changes = [];

  // Rows the caller kept, by id. Anything not referenced is a removal.
  const keptIds = new Set(
    incoming.map((l) => (l.id ? String(l.id) : null)).filter(Boolean),
  );

  // ── removals ────────────────────────────────────────────────────────────
  for (const row of existing) {
    if (keptIds.has(String(row._id))) continue;
    const product = await findProductBySku(row.skuCode, session);
    if (product) await giveBack(product, row, row.confirmedQty || 0);
    changes.push({ type: 'removed', skuCode: row.skuCode, fromQty: row.confirmedQty, toQty: 0 });
    await Order.deleteOne({ _id: row._id }, session ? { session } : {});
  }

  // ── updates and additions ───────────────────────────────────────────────
  for (const line of incoming) {
    const qty = Number(line.quantity);
    const skuCode = String(line.skuCode).trim();
    const row = line.id ? byId.get(String(line.id)) : null;

    const product = await findProductBySku(skuCode, session);
    if (!product) {
      throw Object.assign(new Error(`SKU ${skuCode} not found.`), { status: 400 });
    }

    if (!row) {
      // New line. On a locked (already-consumed) booking under admin override
      // the units must leave inventory outright, matching the rest of that
      // booking — `template` carries its settled state.
      if (!(await takeFor(product, template, qty))) {
        throw Object.assign(
          new Error(`Not enough stock for ${skuCode}. Available: ${Math.max(0, product.availableForSale)}, requested: ${qty}.`),
          { status: 409 },
        );
      }
      /*
       * A desk-added line goes to the END of the booking.
       *
       * It was never part of the customer's original request, so it has no
       * position in it — appending is the only honest answer, and it keeps the
       * customer's own sequence intact above it. `nextLineSeq` reads the current
       * maximum for this booking rather than counting rows, because the sequence
       * is deliberately sparse (see models/Order.js) and a count would collide
       * with an existing index.
       */
      const lastLine = await Order.findOne({ orderId: template.orderId })
        .sort({ lineSeq: -1 })
        .select('lineSeq')
        .session(session)
        .lean();
      const nextLineSeq = Number.isFinite(lastLine?.lineSeq) ? lastLine.lineSeq + 1 : 0;

      await Order.create([{
        lineSeq: nextLineSeq,
        // Inherited from the booking, NOT re-read from the customer record: a
        // line added to an existing booking must ship to the same address as
        // the rest of it, even if the customer has since moved.
        shippingAddress: template.shippingAddress || null,
        billingAddress: template.billingAddress || null,
        shopNumber: template.shopNumber || null,
        gstCode: template.gstCode || null,
        orderId: template.orderId,
        brand: product.constructor.modelName.toLowerCase().includes('bix') ? 'BIX'
          : product.constructor.modelName.toLowerCase().includes('imada') ? 'IMADA' : 'Koken',
        user: template.user,
        status: template.status,
        orderTimestamp: template.orderTimestamp,
        company: template.company,
        role: template.role,
        date: template.date,
        skuCode,
        category: Array.isArray(product.category) ? product.category.join(', ') : (product.category || null),
        requestedQty: qty,
        // The customer never booked this line — the sales desk added it. Keeping
        // bookedQty at 0 is what makes "originally booked vs final" meaningful
        // in the PO email.
        bookedQty: 0,
        confirmedQty: qty,
        pendingQty: 0,
        poNumber: template.poNumber,
        msilCode: product.msilCode || null,
        boxNo: product.boxNo || null,
        emailId: template.emailId,
        phoneNumber: template.phoneNumber,
        location: template.location,
        remarks: `Line added at the sales desk by ${req.user.user || req.user.email}.`,
      }], session ? { session } : {});
      changes.push({ type: 'added', skuCode, fromQty: 0, toQty: qty });
      continue;
    }

    const oldSku = row.skuCode;
    const oldQty = row.confirmedQty || 0;
    const oldPending = row.pendingQty || 0;
    // The quantity the desk types is the line's TOTAL -- confirmed plus
    // indent. That is what the drawers display and what a person means by
    // "make this line 15": fifteen units for the customer, however stock
    // splits them, never fifteen on top of an indent nobody remembers.
    const oldTotal = oldQty + oldPending;

    // What this line will actually hold from stock once the edit lands.
    let fulfilledQty = qty;

    if (oldSku === skuCode) {
      if (qty === oldTotal) continue; // untouched
      if (isConsumed(row)) {
        // Post-PO the units have left inventory; there is no reservation to
        // split, so the confirmed part absorbs the whole change and a
        // shortfall stays a hard refusal. The indent, if any, is untouched.
        const targetConfirmed = Math.max(0, qty - oldPending);
        const { ok } = await adjustConsumedQty(product, oldQty, targetConfirmed, session, ledgerCtx);
        if (!ok) {
          throw Object.assign(
            new Error(`Not enough stock for ${skuCode}. Available: ${Math.max(0, product.availableForSale)}, additional needed: ${targetConfirmed - oldQty}.`),
            { status: 409 },
          );
        }
        fulfilledQty = targetConfirmed;
        row.bookedQty = qty;
        changes.push({ type: 'quantity', skuCode, fromQty: oldTotal, toQty: qty });
      } else {
        // Confirm as much of the new total as stock allows; the remainder IS
        // the indent (set, not added -- see setIndentShortfall).
        const available = Math.max(0, product.availableForSale);
        fulfilledQty = Math.min(qty, oldQty + available);
        const indentQty = qty - fulfilledQty;

        if (fulfilledQty !== oldQty) {
          const { ok } = await adjustReservedQty(product, oldQty, fulfilledQty, session, ledgerCtx);
          if (!ok) {
            // Stock moved between the read and the take -- refuse rather than
            // guess again inside one request.
            throw Object.assign(
              new Error(`Not enough stock for ${skuCode}. Available: ${Math.max(0, product.availableForSale)}, requested: ${qty}.`),
              { status: 409 },
            );
          }
        }

        await setIndentShortfall(row, product, indentQty, session, req);
        row.bookedQty = qty;
        row.pendingQty = indentQty;
        if (indentQty > 0) {
          changes.push({
            type: 'quantity-split', skuCode,
            fromQty: oldTotal, toQty: qty,
            confirmed: fulfilledQty, indentQty,
          });
        } else {
          changes.push({ type: 'quantity', skuCode, fromQty: oldTotal, toQty: qty });
        }
      }
    } else {
      // SKU swap: take the new one FIRST, so a failure leaves the original
      // holding intact rather than giving back stock we then cannot re-take.
      if (!(await takeFor(product, row, qty))) {
        throw Object.assign(
          new Error(`Not enough stock for ${skuCode}. Available: ${Math.max(0, product.availableForSale)}, requested: ${qty}.`),
          { status: 409 },
        );
      }
      const oldProduct = await findProductBySku(oldSku, session);
      if (oldProduct) await giveBack(oldProduct, row, oldQty);
      changes.push({ type: 'sku', skuCode, fromSku: oldSku, toSku: skuCode, fromQty: oldQty, toQty: qty });
    }

    row.skuCode = skuCode;
    row.msilCode = product.msilCode || null;
    row.boxNo = product.boxNo || null;
    row.category = Array.isArray(product.category) ? product.category.join(', ') : (product.category || null);
    row.confirmedQty = fulfilledQty;
    row.requestedQty = fulfilledQty; // kept equal to confirmedQty, as runConfirmBooking does
    await row.save(session ? { session } : {});
  }

  const updated = await loadBooking(orderId, session);
  return { updated, changes };
};

export const updateBookingItems = async (req, res, next) => {
  const session = await mongoose.startSession();
  let result;
  try {
    try {
      session.startTransaction();
      result = await runUpdateItems(req, session);
      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      // Standalone MongoDB has no transactions; nothing was committed, so a
      // re-run without a session is safe. Mirrors confirmBooking's fallback.
      if (isTransactionUnsupported(txErr)) {
        console.warn('[updateBookingItems] Transactions unsupported — running without one.');
        result = await runUpdateItems(req, null);
      } else {
        throw txErr;
      }
    } finally {
      session.endSession();
    }

    const { updated, changes } = result;

    if (changes.length) {
      // Desk edits and customer edits are recorded under different actions —
      // see QTY_EDIT_ACTIONS. Both feed the quantity history; only the desk's
      // reach the Change column of the PO mail.
      const byCustomer = !hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS);
      await recordAudit(
        req.user,
        byCustomer ? QTY_EDIT_ACTIONS.customer : QTY_EDIT_ACTIONS.desk,
        `Booking ${req.params.orderId}: ` +
        changes.map((c) =>
          c.type === 'sku' ? `${c.fromSku} → ${c.toSku} (qty ${c.fromQty} → ${c.toQty})`
            : c.type === 'quantity' ? `${c.skuCode} qty ${c.fromQty} → ${c.toQty}`
              : c.type === 'quantity-split' ? `${c.skuCode} qty ${c.fromQty} → ${c.toQty} (${c.confirmed} confirmed, ${c.indentQty} on indent)`
                : c.type === 'added' ? `added ${c.skuCode} x${c.toQty}`
                  : `removed ${c.skuCode} x${c.fromQty}`,
        ).join('; '),
        req,
        { meta: { orderId: req.params.orderId, changes } },
      );

      io.emit('booking-updated', { orderId: req.params.orderId });

      // TELL THE CUSTOMER. Quantity edits are Admin/Sales-only, so every one
      // of them is a change made TO the customer's booking without them — the
      // notice cannot wait for the PO mail, which only goes out once the
      // quantities are already committed.
      //
      // Fire-and-forget, and wrapped: the edit and its stock movement are
      // already committed, so a mail failure must not fail the request or roll
      // anything back.
      (async () => {
        const owner = updated[0]?.user;
        if (!owner) return;
        const customer = await User.findById(owner).lean();
        const to = customer?.email || updated[0].emailId;
        if (!to || customer?.preferences?.emailNotifications === false) return;

        const journey = await buildBookingJourney({ orderId: req.params.orderId, rows: updated });
        const body = buildQuantityAmendedEmail({
          customerName: customer?.user || customer?.company || updated[0].company || 'Customer',
          orderId: req.params.orderId,
          editorName: req.user.user || req.user.email || null,
          journeyHtml: journeyTablesHtml(journey, { audience: 'customer' }),
        });
        await sendEmail(to, `Quantities updated on your booking ${req.params.orderId}`, body, {
          cc: [...(customer?.bookingCcEmails || []), ...COMPANY_CC],
        });
      })().catch((e) =>
        console.error('[updateBookingItems] quantity-change email failed:', e.message));

      // Splits are worth a nudge of their own: the customer asked for a
      // quantity and got part of it, and silence here reads as "it worked".
      const splits = changes.filter((c) => c.type === 'quantity-split');
      if (splits.length) {
        const owner = result.updated[0]?.user;
        if (owner) {
          notifyUser(owner, {
            title: 'Quantity moved to indent',
            message: splits
              .map((s) => `${s.skuCode}: quantity set to ${s.toQty} — ${s.confirmed} confirmed, ${s.indentQty} on indent (stock short).`)
              .join(' '),
            type: 'reservation',
          }).catch((e) => console.error('[updateBookingItems] split notification failed:', e.message));
        }
      }
    }

    res.status(200).json({
      success: true,
      data: (await attachCustomerDetails([
        await shapedWithValue(updated, req, { includePricing: mayPrice(req.user) }),
      ]))[0],
      changes,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * POST /api/v1/sales/bookings/:orderId/po
 * Body: { poNumber? }  — omitted means auto-generate PO-YYYY-######.
 *
 * Stamps every row of the booking and locks it.
 */
export const raisePo = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const rows = await loadBooking(orderId);
    // Re-uses the edit guard: an already-raised PO cannot be overwritten by a
    // second raise unless the caller can override the lock.
    assertBookingEditable(rows, req.user);

    let poNumber = String(req.body?.poNumber || '').trim();
    if (isPlaceholderPo(poNumber)) {
      const year = new Date().getFullYear();
      const seq = await nextSequence(`po-${year}`);
      poNumber = `PO-${year}-${String(seq).padStart(6, '0')}`;
    } else {
      // A manually entered PO must be unique across other bookings.
      const clash = await Order.findOne({ poNumber, orderId: { $ne: orderId } });
      if (clash) {
        return res.status(409).json({
          success: false,
          message: `PO Number ${poNumber} is already used by booking ${clash.orderId}.`,
        });
      }
    }

    const now = new Date();

    // Re-stamp the box numbers from the product master before the PO is
    // committed. Each row carries the box number that was mapped when the line
    // was BOOKED, which can be weeks old; if an admin has since re-boxed the
    // SKU, the PO must quote where the goods are now or the warehouse picks the
    // wrong shelf. This is the point at which the snapshot stops being stale
    // data and becomes the record of what was ordered, so it is the point at
    // which it has to be right.
    const boxNumbers = await currentBoxNumbers(rows);
    const reBoxed = [];
    for (const row of rows) {
      const current = boxNumbers.get(boxKey(row.skuCode, row.brand));
      // `undefined` means the product could not be resolved at all — leave the
      // existing snapshot alone rather than blanking it.
      if (current === undefined || current === (row.boxNo || null)) continue;
      reBoxed.push({ skuCode: row.skuCode, from: row.boxNo || null, to: current });
      await Order.updateOne({ _id: row._id }, { $set: { boxNo: current } });
    }

    const {
      customerName,
      phoneNumber,
      location,
      shippingAddress,
      billingAddress,
      shopNumber,
      gstCode,
      vendorCode,
      poDate,
      paymentTerm,
      promiseDate,
      deliveryScheduleDate,
    } = req.body || {};

    /**
     * ── The delivery schedule date, set as the PO is raised ─────────────────
     *
     * DELIBERATELY NOT promiseDate, which is collected two fields above it on
     * the same screen and means something else. `promiseDate` is a BOOKING-LEVEL
     * commitment written to `promiseDate`/`supplyByDate`, printed on the pick
     * list as "Supply By" and read by every consumer as one date for the whole
     * order. The delivery schedule is PER SKU LINE — that is the entire point of
     * `Order.scheduledDate`, and why the model has a separate field for it
     * rather than overloading the promise (see the note there).
     *
     * What this screen collects is the OPENING position: one date applied across
     * every line, because at the moment a PO is raised the desk has one date and
     * has not yet had to split it. From there the Delivery schedule panel on the
     * booking refines individual lines, and each refinement re-mails the
     * customer. Collecting it here rather than making the desk raise the PO and
     * then go to a second screen is what makes "raise a PO with a delivery date"
     * one action instead of two.
     *
     * Validated the same way `scheduleBooking` validates its dates, and for the
     * same reason: a date in the past is not a schedule, it is a typo, and it is
     * about to be emailed to the customer as a commitment.
     */
    let scheduleDate = null;
    if (deliveryScheduleDate) {
      scheduleDate = new Date(deliveryScheduleDate);
      if (Number.isNaN(scheduleDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'The delivery schedule date could not be read.',
        });
      }
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      if (scheduleDate < startOfToday) {
        return res.status(400).json({
          success: false,
          message: 'The delivery schedule date cannot be in the past — it is what the customer is told to expect.',
        });
      }
    }

    const setFields = {
      poNumber,
      poGeneratedAt: now,
      poGeneratedBy: req.user._id,
    };
    if (customerName) setFields.company = customerName;
    // Contact pair for the pick list, which prints location and phone together
    // for whoever carries it to the customer. Both are stamped on every row of
    // the booking so a row read on its own still carries them.
    if (phoneNumber !== undefined) setFields.phoneNumber = String(phoneNumber).trim() || null;
    if (location !== undefined) setFields.location = String(location).trim() || null;
    if (shippingAddress) setFields.shippingAddress = shippingAddress;
    if (billingAddress) setFields.billingAddress = billingAddress;
    if (shopNumber) setFields.shopNumber = shopNumber;
    if (gstCode) setFields.gstCode = gstCode;
    if (vendorCode) setFields.vendorCode = vendorCode;
    if (poDate) setFields.poDate = new Date(poDate);
    if (paymentTerm) setFields.paymentTerm = paymentTerm;
    if (promiseDate) {
      setFields.promiseDate = new Date(promiseDate);
      setFields.supplyByDate = new Date(promiseDate);
    }

    await Order.updateMany(
      { orderId },
      { $set: setFields },
    );

    /*
     * A SEPARATE WRITE, SCOPED BY STATUS, rather than another key in setFields.
     *
     * Everything in setFields is a fact about the purchase order and belongs on
     * every row of it, cancelled and delivered rows included — that is the
     * record of what was ordered. A delivery date is not a fact, it is a
     * PROMISE, and promising a delivery on a line that has already been
     * delivered or called off is telling the customer to expect goods they have
     * had, or that nobody is sending. The same three statuses `scheduleBooking`
     * confines itself to, so the two paths cannot disagree about which lines can
     * carry a date.
     */
    if (scheduleDate) {
      await Order.updateMany(
        { orderId, status: { $in: SCHEDULABLE_STATUSES } },
        { $set: { scheduledDate: scheduleDate, scheduledBy: req.user._id, scheduledAt: now } },
      );
    }

    /**
     * The price this customer is being given.
     *
     * The desk sends a price TYPE and the server looks the rate up; an amount
     * posted by a client would be an amount a client chose. Applied only when
     * the caller may price at all — a role that can raise a PO but does not
     * hold view_pricing has its `priceType` ignored rather than obeyed.
     *
     * Omitting the field leaves the booking unpriced, which is what every PO
     * raised before this feature existed is. It can be priced afterwards
     * through PUT .../pricing without reopening the booking.
     */
    let pricing = null;
    if (mayPrice(req.user) && req.body?.priceType !== undefined) {
      pricing = await applyPricing({
        orderId, rows, priceType: req.body.priceType, actor: req.user,
      });
    }

    // Raising the PO commits the goods: the reserved units leave inventory for
    // good (total and booked both drop). Done here so stock is correct the
    // instant the PO exists, rather than waiting for the nightly job.
    // stockState guards against double-deducting on a retry.
    for (const row of rows) {
      if ((row.stockState ?? 'reserved') !== 'reserved') continue;
      const product = await findProductBySku(row.skuCode);
      if (product) {
        await consumeStock(product, row.confirmedQty || 0, null, {
          workflow: 'po-raise',
          referenceType: 'booking',
          referenceId: orderId,
          actor: req.user,
          req,
        });
      }
      await Order.updateOne(
        { _id: row._id },
        { $set: { stockState: 'consumed', stockSettledAt: now } },
      );
    }

    const updated = await loadBooking(orderId);

    await recordAudit(
      req.user,
      'PO Generated',
      `PO ${poNumber} raised for booking ${orderId} by ${req.user.user || req.user.email}. `
      + `Booking is now locked.`
      + (reBoxed.length
        ? ` ${reBoxed.length} line(s) picked up a box number changed since booking.`
        : '')
      // The price offered is part of what was agreed, so it belongs in the
      // trail beside the lock rather than only on the rows it was written to.
      + (pricing?.priceType
        ? ` Priced at the ${pricing.priceTypeLabel} rate — ${pricing.pricedLines} of ${pricing.lines} line(s) rated, total ₹${pricing.totalAmount}.`
        : '')
      // A delivery date given to the customer is a commitment, so it goes on
      // the trail beside the lock and the price rather than only on the rows.
      + (scheduleDate
        ? ` Delivery scheduled from ${scheduleDate.toISOString().slice(0, 10)}.`
        : ''),
      req,
      {
        meta: {
          orderId, poNumber, poGeneratedAt: now, reBoxed,
          priceType: pricing?.priceType ?? null,
          totalAmount: pricing?.totalAmount ?? null,
          deliveryScheduleDate: scheduleDate,
        },
      },
    );

    // Tell the customer their PO is through — in-app, and by email with a
    // line-by-line account of anything the sales desk changed.
    const journey = await buildBookingJourney({ orderId, rows: updated });
    const summary = journey.summary;

    if (updated[0]?.user) {
      notifyUser(updated[0].user, {
        title: 'Purchase Order Raised',
        message: summary.changed
          ? `Purchase Order ${poNumber} has been raised. Some quantities were adjusted — see your email.`
          : `Purchase Order ${poNumber} has been raised and is now being processed.`,
        type: 'order',
      });

      const customer = await User.findById(updated[0].user).lean();
      const to = customer?.email || updated[0].emailId;
      if (to && customer?.preferences?.emailNotifications !== false) {
        /*
         * The whole mail — body table and both attachments — is assembled off
         * the request path.
         *
         * The PO is already committed and the response is already owed to the
         * desk; rendering a spreadsheet and a PDF is tens of milliseconds of
         * work that the person who clicked "Confirm & lock" should not wait on,
         * and a font that will not load or a booking large enough to be slow
         * must not be able to fail a purchase order that has already deducted
         * stock. Fire-and-forget, exactly as the mail already was — the `await`
         * has simply moved inside it.
         */
        (async () => {
          const parts = await buildScheduleMailParts(orderId, { customer, rows: updated });

          const body = buildPoRaisedEmail({
            customerName: customer?.user || customer?.company || updated[0].company || 'Customer',
            orderId,
            poNumber,
            summary,
            journeyHtml: journeyTablesHtml(journey, { audience: 'customer' }),
            scheduleHtml: parts.tableHtml,
            deliveryScheduleDate: parts.doc?.deliveryScheduleDate ?? null,
            attachmentNames: parts.attachments.map((a) => a.filename),
          });
          // Subject names the PURCHASE ORDER, not the booking: this is the mail
          // that tells the customer the reference has changed, and every mail
          // after it uses the PO number.
          const subject = summary.changed
            ? `Your Purchase Order #${poNumber} has been raised — items adjusted`
            : `Your Purchase Order #${poNumber} has been raised`;

          await sendEmail(to, subject, body, {
            cc: [...(customer?.bookingCcEmails || []), ...COMPANY_CC],
            ...(parts.attachments.length ? { attachments: parts.attachments } : {}),
          });
        })().catch((e) => console.error('[raisePo] email error', e));
      }
    }

    io.emit('po-generated', { orderId, poNumber });

    res.status(200).json({
      success: true,
      data: (await attachCustomerDetails([
        await shapedWithValue(updated, req, { includePricing: mayPrice(req.user), boxNumbers: new Map() }),
      ]))[0],
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * GET /api/v1/sales/bookings/:orderId/pricing
 *
 * Every tier price for every line of this booking, and what each tier would
 * total. THE INTERNAL VIEW — this is the one response in the application that
 * carries more than one price for a SKU, which is why its route is the only one
 * behind view_pricing and why nothing else calls quoteBooking().
 *
 * Read-only. Choosing a tier is the PUT below, or the PO dialog.
 */
export const getBookingPricing = async (req, res, next) => {
  try {
    const rows = await loadBooking(req.params.orderId);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    const quote = await quoteBooking(rows);
    res.status(200).json({
      success: true,
      data: {
        orderId: req.params.orderId,
        customer: rows[0].company || null,
        locked: rows.some((r) => Boolean(r.poGeneratedAt)) || Boolean(rows[0].poNumber && rows[0].poNumber !== '-'),
        // What is on the booking NOW, so the dialog opens on the current
        // choice rather than making the desk remember it.
        current: pricingSummary(rows),
        ...quote,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/sales/bookings/:orderId/pricing   { priceType }
 *
 * Set — or change, or clear — the tier this customer is being offered.
 *
 * DELIBERATELY NOT BLOCKED BY THE PO LOCK, which every other write on a raised
 * booking is. The lock exists to freeze WHAT IS BEING SUPPLIED: quantities,
 * SKUs, line composition. A price is not that, and two ordinary cases need this
 * to work after the PO exists — every PO raised before this feature shipped is
 * unpriced, and a tier chosen in error has to be correctable without reopening
 * a locked booking. It is confined to view_pricing holders and every change is
 * audited with the old and new tier.
 *
 * `priceType: null` clears the pricing.
 */
export const setBookingPricing = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const rows = await loadBooking(orderId);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    const raw = req.body?.priceType ?? null;
    const priceType = normalisePriceType(raw);
    // Blank and null mean "clear it". Anything else that does not resolve is a
    // mistake worth refusing rather than silently treating as a clear.
    if (raw !== null && String(raw).trim() !== '' && !priceType) {
      return res.status(400).json({
        success: false,
        message: `"${raw}" is not a price type. Use one of: ${PRICE_TYPES.map((t) => t.label).join(', ')}.`,
      });
    }

    const before = pricingSummary(rows);
    const result = await applyPricing({ orderId, rows, priceType, actor: req.user });

    await recordAudit(
      req.user,
      'Booking Priced',
      priceType
        ? `Booking ${orderId} priced at the ${result.priceTypeLabel} rate`
          + (before?.priceType && before.priceType !== priceType
            ? ` (was ${before.priceTypeLabel})` : '')
          + `. ${result.pricedLines} of ${result.lines} line(s) rated, total ₹${result.totalAmount}.`
        : `Pricing removed from booking ${orderId}`
          + (before?.priceType ? ` (was ${before.priceTypeLabel}).` : '.'),
      req,
      {
        meta: {
          orderId,
          from: before?.priceType ?? null,
          to: result.priceType,
          totalAmount: result.totalAmount,
          unpricedLines: result.unpricedLines,
        },
      },
    );

    const updated = await loadBooking(orderId);
    res.status(200).json({
      success: true,
      data: (await attachCustomerDetails([
        await shapedWithValue(updated, req, { includePricing: true }),
      ]))[0],
      pricing: result,
    });
  } catch (error) {
    next(error);
  }
};



// ---------------------------------------------------------------------------
// Line order and header details
// ---------------------------------------------------------------------------

/**
 * The rules for both live in `bookingEdit.service.js`, not here.
 *
 * This module imports `io` from `server.js`, and `server.js` mounts
 * `order.routes.js`, which imports back from this module. That cycle makes this
 * file impossible to import from a test — which is why the existing suites
 * assert on its SOURCE TEXT rather than calling anything. Keeping the rules in
 * a module free of that cycle is what lets them be tested by being run.
 *
 * What stays here is what a controller should own: the socket broadcast and the
 * response shape.
 */

/** Errors from the service already carry `.status`; pass them through unchanged. */
const sendServiceError = (error, res, next) => {
  if (error instanceof FieldValidationError) {
    return res.status(400).json({ success: false, message: error.message, field: error.field });
  }
  if (error?.status) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  return next(error);
};

/** The booking, shaped exactly as every other sales response shapes it. */
const respondWithBooking = async (rows, req, res) =>
  res.status(200).json({
    success: true,
    data: (await attachCustomerDetails([
      await shapedWithValue(rows, req, { includePricing: mayPrice(req.user) }),
    ]))[0],
  });

/** PUT /api/sales/bookings/:orderId/line-order */
export const reorderBookingLines = async (req, res, next) => {
  try {
    const { rows, changed } = await reorderLines({
      orderId: req.params.orderId,
      lineIds: req.body?.lineIds,
      actor: req.user,
      req,
    });
    if (changed) io.emit('booking-updated', { orderId: req.params.orderId });
    return respondWithBooking(rows, req, res);
  } catch (error) {
    return sendServiceError(error, res, next);
  }
};

/** PATCH /api/sales/bookings/:orderId/details */
export const updateBookingDetails = async (req, res, next) => {
  try {
    const { rows, changes } = await updateDetails({
      orderId: req.params.orderId,
      patch: req.body,
      actor: req.user,
      req,
    });
    if (changes.length) io.emit('booking-updated', { orderId: req.params.orderId });
    return respondWithBooking(rows, req, res);
  } catch (error) {
    return sendServiceError(error, res, next);
  }
};

export default {
  getBookings, getBookingDetail, updateBookingItems, raisePo,
  reorderBookingLines, updateBookingDetails,
  getBookingPricing, setBookingPricing,
};
