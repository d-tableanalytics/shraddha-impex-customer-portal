import mongoose from 'mongoose';
import Order from '../../models/Order.js';
import User from '../../models/User.js';
import Reservation from '../../models/Reservation.js';
import { nextSequence } from '../../models/Counter.js';
import { io } from '../../server.js';
import { notifyUser } from '../../utils/notify.js';
import { sendEmail } from '../../utils/mailer.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';
import { assertBookingEditable, isPlaceholderPo } from '../../utils/bookingLock.js';
import { hasPermission, PERMISSIONS } from '../../middlewares/rbac.js';
import { boxKey, currentBoxNumbers, shapeBooking } from './booking.shape.js';
import {
  findProductBySku, reserveStock, releaseStock, consumeStock,
  adjustReservedQty, adjustConsumedQty,
} from '../../utils/stockLedger.js';
import { recordAudit } from '../../utils/auditLog.js';
import { fillCustomerContact } from '../../utils/customerContact.js';
import {
  QTY_EDIT_ACTIONS, buildBookingJourney, journeyTablesHtml,
} from '../../utils/bookingJourney.js';
import { isTransactionUnsupported } from '../../utils/mongoSession.js';

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
  return Order.find({ orderId }, null, opts).sort({ createdAt: 1 });
};

// Audit writing lives in utils/auditLog.js — see recordAudit().

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

const buildPoRaisedEmail = ({ customerName, orderId, poNumber, summary, journeyHtml }) => {
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
  // The line detail is the shared three-table journey (utils/bookingJourney.js):
  // what was confirmed at booking, what sits on indent / the PO facts, and the
  // final quantities this PO commits — the same tables every booking mail shows.
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
    </div>

    ${summary.changed
      ? `<p><strong>Please note:</strong> our team adjusted some quantities before this purchase order was raised. The adjustments are shown in the Change column of the Final Booking Details below.</p>`
      : `<p>No quantities were adjusted by our team${summary.totalIndent > 0 ? ' — the Indent table below shows what is still awaiting stock' : ''}.</p>`}

    ${journeyHtml}

    <p>Thank you for your business.</p>
  `;
};

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

    const rows = await Order.find(query).sort({ createdAt: -1 });

    const byBooking = new Map();
    for (const r of rows) {
      if (!byBooking.has(r.orderId)) byBooking.set(r.orderId, []);
      byBooking.get(r.orderId).push(r);
    }

    // One lookup for every row on the screen, not one per booking.
    const boxNumbers = await currentBoxNumbers(rows);
    const all = await fillCustomerContact(
      [...byBooking.values()].map((b) => shapeBooking(b, boxNumbers)),
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
      data: (await fillCustomerContact([shapeBooking(rows, await currentBoxNumbers(rows))]))[0],
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
const raiseIndentForShortfall = async (row, product, indentQty, session, req) => {
  const opts = session ? { session } : {};
  const indentNumber = `PI-${String(row.orderId).replace(/^[A-Z]+-/, '')}`;

  const existing = await Reservation.findOneAndUpdate(
    {
      customerId: row.user,
      skuCode: row.skuCode,
      indentNumber,
      status: { $in: ['Pending', 'Partially Confirmed'] },
    },
    { $inc: { quantity: indentQty } },
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
      await Order.create([{
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

    // What this line will actually hold from stock. Normally the requested
    // qty; when stock cannot cover an increase, the covered part — the rest
    // moves to an indent (see the split below).
    let fulfilledQty = qty;

    if (oldSku === skuCode) {
      if (oldQty === qty) continue; // untouched
      if (isConsumed(row)) {
        // Post-PO the units have left inventory; there is no reservation to
        // split, so a shortfall here stays a hard refusal.
        const { ok } = await adjustConsumedQty(product, oldQty, qty, session, ledgerCtx);
        if (!ok) {
          throw Object.assign(
            new Error(`Not enough stock for ${skuCode}. Available: ${Math.max(0, product.availableForSale)}, additional needed: ${qty - oldQty}.`),
            { status: 409 },
          );
        }
        changes.push({ type: 'quantity', skuCode, fromQty: oldQty, toQty: qty });
      } else {
        let { ok } = await adjustReservedQty(product, oldQty, qty, session, ledgerCtx);
        if (!ok) {
          // Mirror confirmBooking rather than refuse: take what stock covers
          // and move the remainder to an indent, so raising a quantity behaves
          // the same whether it happens at booking time or on a later edit.
          const available = Math.max(0, product.availableForSale);
          fulfilledQty = oldQty + available;
          const indentQty = qty - fulfilledQty;
          if (available > 0) {
            ({ ok } = await adjustReservedQty(product, oldQty, fulfilledQty, session, ledgerCtx));
            if (!ok) {
              // Stock moved between the read and the take — refuse rather than
              // guess again inside one request.
              throw Object.assign(
                new Error(`Not enough stock for ${skuCode}. Available: ${Math.max(0, product.availableForSale)}, additional needed: ${qty - oldQty}.`),
                { status: 409 },
              );
            }
          }
          await raiseIndentForShortfall(row, product, indentQty, session, req);
          // The customer now asks for `qty` in total; the indent carries what
          // stock could not. bookedQty is that ask, pendingQty the open rest.
          row.bookedQty = qty;
          row.pendingQty = (row.pendingQty || 0) + indentQty;
          changes.push({ type: 'quantity-split', skuCode, fromQty: oldQty, toQty: fulfilledQty, indentQty });
        } else {
          changes.push({ type: 'quantity', skuCode, fromQty: oldQty, toQty: qty });
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
              : c.type === 'quantity-split' ? `${c.skuCode} qty ${c.fromQty} → ${c.toQty} (+${c.indentQty} to indent)`
                : c.type === 'added' ? `added ${c.skuCode} x${c.toQty}`
                  : `removed ${c.skuCode} x${c.fromQty}`,
        ).join('; '),
        req,
        { meta: { orderId: req.params.orderId, changes } },
      );

      io.emit('booking-updated', { orderId: req.params.orderId });

      // Splits are worth a nudge of their own: the customer asked for a
      // quantity and got part of it, and silence here reads as "it worked".
      const splits = changes.filter((c) => c.type === 'quantity-split');
      if (splits.length) {
        const owner = result.updated[0]?.user;
        if (owner) {
          notifyUser(owner, {
            title: 'Quantity moved to indent',
            message: splits
              .map((s) => `${s.skuCode}: ${s.toQty} confirmed, ${s.indentQty} added to indent (stock short).`)
              .join(' '),
            type: 'reservation',
          }).catch((e) => console.error('[updateBookingItems] split notification failed:', e.message));
        }
      }
    }

    res.status(200).json({
      success: true,
      data: (await fillCustomerContact([shapeBooking(updated, await currentBoxNumbers(updated))]))[0],
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
      shippingAddress,
      billingAddress,
      shopNumber,
      gstCode,
      vendorCode,
      poDate,
      paymentTerm,
      promiseDate,
    } = req.body || {};

    const setFields = {
      poNumber,
      poGeneratedAt: now,
      poGeneratedBy: req.user._id,
    };
    if (customerName) setFields.company = customerName;
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
        : ''),
      req,
      { meta: { orderId, poNumber, poGeneratedAt: now, reBoxed } },
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
        const body = buildPoRaisedEmail({
          customerName: customer?.user || customer?.company || updated[0].company || 'Customer',
          orderId,
          poNumber,
          summary,
          journeyHtml: journeyTablesHtml(journey, { audience: 'customer' }),
        });
        // Subject names the PURCHASE ORDER, not the booking: this is the mail
        // that tells the customer the reference has changed, and every mail
        // after it uses the PO number.
        const subject = summary.changed
          ? `Your Purchase Order #${poNumber} has been raised — items adjusted`
          : `Your Purchase Order #${poNumber} has been raised`;

        // Fire-and-forget: the PO is already committed, so a mail failure must
        // not fail the request.
        sendEmail(to, subject, body, {
          cc: [...(customer?.bookingCcEmails || []), ...COMPANY_CC],
        }).catch((e) => console.error('[raisePo] email error', e));
      }
    }

    io.emit('po-generated', { orderId, poNumber });

    res.status(200).json({ success: true, data: (await fillCustomerContact([shapeBooking(updated)]))[0] });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export default { getBookings, getBookingDetail, updateBookingItems, raisePo };
