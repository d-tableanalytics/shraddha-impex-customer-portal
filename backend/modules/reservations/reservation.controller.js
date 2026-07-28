import mongoose from 'mongoose';
import Reservation from '../../models/Reservation.js';
import { ProductKoken, ProductBIX, ProductIMADA } from '../../models/Product.js';
import Order from '../../models/Order.js';
import AuditLog from '../../models/AuditLog.js';
import MsilCode from '../../models/MsilCode.js';
import { nextSequence } from '../../models/Counter.js';
import { io } from '../../server.js';
import { sendEmail } from '../../utils/mailer.js';
import { notifyUser, notifyAdmins } from '../../utils/notify.js';

// The product collection is split one-per-brand; the brand is implied by which
// collection a doc lives in (there is no brand field on the schema).
const BRAND_MODELS = [
  [ProductKoken, 'Koken'],
  [ProductBIX, 'BIX'],
  [ProductIMADA, 'IMADA'],
];

// Helper to find product across all brands. Pass a session to read within a
// transaction so the stock value is consistent for the read-modify-write cycle.
const findProductById = async (productId, session = null) => {
  const opts = session ? { session } : {};
  for (const [Model] of BRAND_MODELS) {
    const p = await Model.findById(productId, null, opts);
    if (p) return p;
  }
  return null;
};

// Derive the brand from a live product doc's model (products_koken → 'Koken').
// The brand is not a schema field — it is implied by which collection it lives in.
const brandFromModel = (doc) => {
  const name = (doc?.constructor?.modelName || '').toLowerCase();
  if (name.includes('bix')) return 'BIX';
  if (name.includes('imada')) return 'IMADA';
  return 'Koken';
};

// Read-side lookup that also resolves the brand (derived from the collection).
// Returns a plain object so callers can safely spread extra fields onto it.
const findProductWithBrand = async (productId) => {
  for (const [Model, brand] of BRAND_MODELS) {
    const p = await Model.findById(productId);
    if (p) return { product: { ...p.toObject(), brand }, brand };
  }
  return { product: null, brand: null };
};

// Atomically fulfil as much of `wantQty` as live stock allows. Uses a guarded
// $inc so two concurrent confirmations can never oversell (drive stock < 0).
// Mutates product.availableForSale to the fresh post-decrement value and
// returns the quantity actually deducted (0..wantQty).
const deductStockAtomic = async (product, wantQty, session = null) => {
  const Model = product.constructor;
  const opts = session ? { session } : {};
  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = await Model.findById(product._id, null, opts);
    if (!fresh) return 0;
    const avail = Math.max(0, fresh.availableForSale);
    const take = Math.min(wantQty, avail);
    if (take === 0) {
      product.availableForSale = fresh.availableForSale;
      return 0;
    }
    const updated = await Model.findOneAndUpdate(
      { _id: product._id, availableForSale: { $gte: take } },
      { $inc: { availableForSale: -take, bookedQuantity: take } },
      { new: true, ...opts }
    );
    if (updated) {
      product.availableForSale = updated.availableForSale;
      return take;
    }
    // Stock changed underneath us between read and write — retry with fresh value.
  }
  return 0;
};

// Detects the "transactions not supported" error thrown by a standalone
// (non-replica-set) MongoDB, so we can gracefully fall back to a non-transactional run.
const isTransactionUnsupported = (err) => {
  if (!err) return false;
  const msg = err.message || '';
  return (
    err.code === 20 || // IllegalOperation
    err.codeName === 'IllegalOperation' ||
    /Transaction numbers are only allowed on a replica set member or mongos/i.test(msg) ||
    /Transactions are not supported/i.test(msg)
  );
};

// Helper to create audit logs
const logEvent = async (user, action, remarks, req, session = null) => {
  try {
    await AuditLog.create([{
      user: user._id,
      action: action,
      method: req?.method || 'SYSTEM',
      endpoint: req?.originalUrl || 'N/A',
      ipAddress: req?.ip || '127.0.0.1',
      userAgent: req?.headers?.['user-agent'] || 'ERP SYSTEM',
      remarks: remarks // If schema has remarks
    }], session ? { session } : {});
  } catch (error) {
    console.error('[Audit Log helper error]', error);
  }
};

// Persist + deliver a notification to a single user (their own room only).
const sendNotification = (userId, title, message, type = 'reservation') => {
  notifyUser(userId, { title, message, type });
};

// MOQ (Minimum Order Quantity) is enforced only for Non-MSIL customers: the
// quantity must be at least the MOQ (any amount at or above it is allowed).
// MSIL customers are exempt. Throws when the rule is violated.
const enforceMoq = (user, product, quantity) => {
  if (user?.customerCategory === 'MSIL') return; // MSIL users are MOQ-exempt.
  const moq = Number(product?.moq) || 0;
  if (moq > 1 && quantity < moq) {
    throw new Error(`Quantity must be at least the Minimum Order Quantity (${moq}) for ${product.skuCode}.`);
  }
};

// MSIL Codes are only meaningful to Admins, MSIL customers (who order by them),
// and anyone explicitly flagged. For everyone else the code is ignored entirely:
// a Non-MSIL customer is never failed on an MSIL Code being missing, unknown,
// mismatched, or inactive, because it does not apply to them.
const msilAppliesTo = (user) =>
  user?.role === 'Admin' ||
  user?.customerCategory === 'MSIL' ||
  user?.showMsilCode === true;

export const getReservations = async (req, res, next) => {
  try {
    const reservations = await Reservation.find({ customerId: req.user._id, status: 'Reserved' });
    // Manually populate since refs don't span multiple models
    const populated = await Promise.all(reservations.map(async r => {
      const { product } = await findProductWithBrand(r.productId);
      return { ...r.toObject(), productId: product };
    }));
    res.status(200).json({ success: true, data: populated });
  } catch (error) {
    next(error);
  }
};

// Backorders: quantities that could not be fulfilled at confirmation time.
// Admins see backorders across all customers; customers see only their own.
export const getPendingReservations = async (req, res, next) => {
  try {
    const filter = { status: { $in: ['Pending', 'Partially Confirmed'] } };
    if (req.user.role !== 'Admin') {
      filter.customerId = req.user._id;
    }

    const reservations = await Reservation.find(filter)
      .populate('customerId', 'name email company')
      .sort({ updatedAt: -1 });

    const populated = await Promise.all(reservations.map(async r => {
      const obj = r.toObject();
      const { product } = await findProductWithBrand(r.productId);
      return { ...obj, productId: product };
    }));
    res.status(200).json({ success: true, data: populated });
  } catch (error) {
    next(error);
  }
};

// Count of cancelled bookings — selection-list items that never became an
// order: auto-cancelled after the 7-day window ('Expired') or removed by the
// customer ('Cancelled'). Count only; used for the Booking History metric tile.
export const getCancelledCount = async (req, res, next) => {
  try {
    const filter = { status: { $in: ['Expired', 'Cancelled'] } };
    if (req.user.role !== 'Admin') {
      filter.customerId = req.user._id;
    }
    const count = await Reservation.countDocuments(filter);
    res.status(200).json({ success: true, data: { count } });
  } catch (error) {
    next(error);
  }
};

// Admin action: when fresh stock arrives, a Pending backorder can be moved back
// into the customer's active selection list so they can re-confirm it. The
// customer is emailed and notified to go confirm it from their dashboard.
// Stock is NOT deducted here — that still happens at confirmation time. We only
// verify enough stock exists so the customer's confirmation will actually succeed.
export const restoreBackorder = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, message: 'Only an admin can move a indent to the selection list.' });
    }

    const reservation = await Reservation.findById(req.params.id).populate('customerId', 'user email company');
    if (!reservation) {
      throw new Error('Indent not found.');
    }

    if (!['Pending', 'Partially Confirmed'].includes(reservation.status)) {
      throw new Error('Only indents can be moved to the selection list.');
    }

    const product = await findProductById(reservation.productId);
    if (!product) {
      throw new Error(`Product ${reservation.skuCode} not found.`);
    }

    const available = Math.max(0, product.availableForSale);
    if (available < reservation.quantity) {
      throw new Error(
        `Not enough stock to restore this indent. Requires ${reservation.quantity}, only ${available} available.`
      );
    }

    // Move it back into the active selection list with a fresh 7-day window.
    const now = new Date();
    reservation.status = 'Reserved';
    reservation.reservationDate = now;
    reservation.expiryDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    reservation.confirmedAt = undefined;
    reservation.expiredAt = undefined;
    reservation.lastReminderSent = null;
    await reservation.save();

    const customer = reservation.customerId || {};
    const customerName = customer.user || customer.company || 'Customer';

    await logEvent(
      req.user,
      'Indent Restored',
      `Moved indent ${reservation.reservationId} (${reservation.skuCode} x${reservation.quantity}) back to selection list.`,
      req
    );

    // Notify the customer in-app and by email.
    sendNotification(
      customer._id || reservation.customerId,
      'Indent Back in Stock',
      `${reservation.skuCode} (${reservation.quantity} units) is back in stock and moved to your selection list. Confirm it from your dashboard.`,
      'reservation'
    );

    if (customer.email) {
      const subject = `Your indent ${reservation.skuCode} is back in stock — confirm it now`;
      const body = `
        <p>Hi ${customerName},</p>
        <p>Good news! An item that was previously <strong>out of stock</strong> in your booking is now available again:</p>
        <table style="border-collapse: collapse; margin: 12px 0;">
          <tr><td style="padding: 4px 12px; color: #777;">SKU Code</td><td style="padding: 4px 12px; font-weight: bold;">${reservation.skuCode}</td></tr>
          <tr><td style="padding: 4px 12px; color: #777;">MSIL Code</td><td style="padding: 4px 12px; font-weight: bold;">${reservation.msilCode || '—'}</td></tr>
          <tr><td style="padding: 4px 12px; color: #777;">Quantity</td><td style="padding: 4px 12px; font-weight: bold;">${reservation.quantity}</td></tr>
          <tr><td style="padding: 4px 12px; color: #777;">Reference</td><td style="padding: 4px 12px; font-weight: bold;">${reservation.reservationId}</td></tr>
        </table>
        <p>It has been moved back to your <strong>selection list</strong>. Please log in to your dashboard and <strong>confirm this booking</strong> to secure the stock. Note this selection will expire in 7 days if not confirmed.</p>
        <p>Thank you.</p>
      `;
      // Fire-and-forget: email failure should not fail the request.
      sendEmail(customer.email, subject, body).catch((e) =>
        console.error('[restoreBackorder] email error', e)
      );
    }

    io.emit('backorder-restored', { reservationId: reservation.reservationId });

    res.status(200).json({ success: true, data: reservation });
  } catch (error) {
    next(error);
  }
};

export const createReservation = async (req, res, next) => {

  try {
    const { productId } = req.body;
    const quantity = Number(req.body.quantity);

    if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('Valid Product ID and a whole-number Quantity are required.');
    }

    const product = await findProductById(productId);
    if (!product) {
      throw new Error('Product not found.');
    }

    // Adding a product that is already in the selection list tops up that line
    // rather than creating a second row for the same SKU.
    const existing = await Reservation.findOne({
      customerId: req.user._id,
      productId: product._id,
      status: 'Reserved',
    });
    const mergedQuantity = (existing?.quantity || 0) + quantity;

    // MOQ applies to Non-MSIL customers only; MSIL customers are exempt. It is
    // checked against the merged total, since that is the quantity that will
    // actually be booked — topping up a line must not fail on the increment alone.
    enforceMoq(req.user, product, mergedQuantity);

    // NOTE: Stock availability is intentionally NOT validated here. Customers may
    // book any quantity, even beyond availableForSale. Stock is only checked and
    // deducted at confirmation time (see confirmBooking), where any unfulfillable
    // quantity is moved to a Indent.

    // MSIL Code Validation — only enforced for users MSIL Codes apply to, and
    // only when a code is actually assigned. Products without an MSIL Code are
    // allowed to be booked; the MSIL field is simply left blank throughout the UI.
    if (msilAppliesTo(req.user) && product.msilCode) {
      const msilDoc = await MsilCode.findOne({ code: product.msilCode });
      if (!msilDoc || msilDoc.status !== 'Active') {
        throw new Error(`MSIL Code ${product.msilCode} for product ${product.skuCode} is inactive or does not exist.`);
      }
    }

    // Stock is NOT allocated/deducted at booking time — only at confirmation.

    const who = req.user.company || req.user.user || req.user.email;

    if (existing) {
      // $inc so a concurrent add (e.g. a bulk import landing alongside a manual
      // one) cannot lose quantity. The status guard skips a line that was
      // confirmed or cancelled since it was read; that falls through to a fresh
      // reservation below. The original expiry date is kept, so topping up a
      // line does not extend its 7-day window.
      const updated = await Reservation.findOneAndUpdate(
        { _id: existing._id, status: 'Reserved' },
        { $inc: { quantity } },
        { new: true },
      );

      if (updated) {
        await logEvent(req.user, 'Reservation Updated', `Added ${quantity} units of ${product.skuCode} to an existing reservation (now ${updated.quantity})`, req);
        sendNotification(req.user._id, 'Item Booked', `${product.skuCode} updated to ${updated.quantity} units in your selection list. Confirm within 7 days — it is auto-cancelled after that.`, 'reservation');
        notifyAdmins({ title: 'New Booking', message: `${who} added ${quantity} more of ${product.skuCode} (now ${updated.quantity} units in their selection list).`, type: 'reservation' });
        return res.status(200).json({ success: true, data: updated });
      }
    }

    const year = new Date().getFullYear();
    const seq = await nextSequence(`reservation-${year}`);
    const reservationId = `RES-${year}-${String(seq).padStart(6, '0')}`;
    const reservationDate = new Date();
    const expiryDate = new Date(reservationDate.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 Days

    const reservation = await Reservation.create([{
      reservationId,
      customerId: req.user._id,
      productId: product._id,
      skuCode: product.skuCode,
      msilCode: product.msilCode,
      quantity,
      reservationDate,
      expiryDate,
      status: 'Reserved',
      reservedBy: req.user._id
    }]);

    await logEvent(req.user, 'Reservation Created', `Reserved ${quantity} units of ${product.skuCode}`, req);
    sendNotification(req.user._id, 'Item Booked', `${product.skuCode} (${quantity} units) added to your selection list. Confirm within 7 days — it is auto-cancelled after that.`, 'reservation');
    notifyAdmins({ title: 'New Booking', message: `${who} booked ${product.skuCode} (${quantity} units). It is now in their selection list.`, type: 'reservation' });

    res.status(201).json({ success: true, data: reservation[0] });
  } catch (error) {
    next(error);
  }
};

export const updateReservationQuantity = async (req, res, next) => {

  try {
    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('Quantity must be a whole number greater than zero.');
    }

    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) {
      throw new Error('Reservation not found.');
    }

    if (reservation.status !== 'Reserved') {
      throw new Error('Only active reservations can be edited.');
    }

    const product = await findProductById(reservation.productId);
    if (!product) {
      throw new Error('Product not found.');
    }

    // MOQ applies to Non-MSIL customers only; MSIL customers are exempt.
    enforceMoq(req.user, product, quantity);

    // No stock validation/adjustment — stock is only allocated at confirmation time.
    reservation.quantity = quantity;
    await reservation.save();

    await logEvent(req.user, 'Reservation Updated', `Adjusted quantity of reservation ${reservation.reservationId} to ${quantity}`, req);

    res.status(200).json({ success: true, data: reservation });
  } catch (error) {
    next(error);
  }
};

export const cancelReservation = async (req, res, next) => {
  try {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) {
      throw new Error('Reservation not found.');
    }

    if (reservation.status !== 'Reserved') {
      throw new Error('Only active reservations can be cancelled.');
    }

    // No stock was allocated at booking time, so there is nothing to release.
    reservation.status = 'Cancelled';
    reservation.expiredAt = new Date();
    await reservation.save();

    await logEvent(req.user, 'Reservation Cancelled', `Cancelled reservation ${reservation.reservationId}`, req);
    sendNotification(req.user._id, 'Reservation Cancelled', `Reservation ${reservation.reservationId} has been cancelled and removed from your selection list.`, 'reservation');

    res.status(200).json({ success: true, data: reservation });
  } catch (error) {
    next(error);
  }
};

// Core confirmation logic. All DB writes accept an optional `session` so the
// whole read-modify-write cycle (stock deduction + order creation + reservation
// updates) is atomic when transactions are available.
const runConfirmBooking = async (req, session) => {
  const reservations = await Reservation.find(
    { customerId: req.user._id, status: 'Reserved' },
    null,
    session ? { session } : {}
  );
  if (reservations.length === 0) {
    throw new Error('No active reservations to confirm.');
  }

  const year = new Date().getFullYear();
  const orderSeq = await nextSequence(`order-${year}`, session);
  const seqStr = String(orderSeq).padStart(6, '0');
  // One confirmation produces THREE identifiers:
  //   Booking ID       BO-2026-001312   (the booking)
  //   Indent   PI-2026-001312   (same number, different 2-char prefix)
  //   PO Number        PO-260713-4821   (DIFFERENT, time-based, its own sequence)
  // The booking id and pending-indent id share the sequence so they line up;
  // the PO number is independent so it can be an externally-meaningful ref.
  const orderNumber = `BO-${year}-${seqStr}`;
  const indentId = `PI-${year}-${seqStr}`;
  // Time-based PO number: PO-YYMMDD-<4 digit seq> (customer-supplied wins).
  const now = new Date();
  const stamp = `${String(year).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const poNumber = req.body.poNumber || "-";
  const ordersToCreate = [];
  const summary = [];
  const dateNow = new Date();

  for (let resItem of reservations) {
    const product = await findProductById(resItem.productId, session);
    if (!product) {
      throw new Error(`Product ${resItem.skuCode} not found.`);
    }

    const requestedQty = resItem.quantity;

    // Fulfill as much as live stock allows (atomically, so concurrent
    // confirmations cannot oversell); the rest becomes a Pending backorder.
    const confirmedQty = await deductStockAtomic(product, requestedQty, session);
    const pendingQty = requestedQty - confirmedQty;

    if (confirmedQty > 0) {
      ordersToCreate.push({
        orderId: orderNumber,
        brand: brandFromModel(product),
        user: req.user._id,
        status: 'PO Received',
        orderTimestamp: dateNow,
        company: req.user.company || 'Shraddha Impex',
        role: req.user.role || 'user',
        date: dateNow,
        skuCode: product.skuCode,
        category: Array.isArray(product.category) ? product.category.join(', ') : (product.category || 'Unknown'),
        requestedQty: confirmedQty, // kept = confirmedQty for back-compat
        bookedQty: requestedQty,    // what the customer originally booked
        confirmedQty,               // what was actually fulfilled from stock
        pendingQty,                 // unfulfilled remainder (indent)
        poNumber,
        remarks: pendingQty > 0
          ? `Partially confirmed (${confirmedQty}/${requestedQty}). ${pendingQty} moved to Indent. ${req.body.remarks || ''}`.trim()
          : (req.body.remarks || 'Confirmed ERP reservation booking.'),
        msilCode: product.msilCode || null,
        boxNo: product.boxNo || null,
        vendorCode: product.vendorCode || null,
        emailId: req.user.email || null,
        phoneNumber: req.user.phone || null
      });
    }

    // Update the reservation to reflect what actually happened.
    if (pendingQty === 0) {
      // Fully fulfilled.
      resItem.status = 'Confirmed';
      resItem.confirmedAt = dateNow;
      resItem.quantity = confirmedQty;
    } else {
      // Some (or all) of the quantity could not be fulfilled — keep the
      // unfulfilled remainder as a Indent reservation. Tag it with the
      // PI id (matches the booking id's number) and the PO number for linkage.
      resItem.status = confirmedQty > 0 ? 'Partially Confirmed' : 'Pending';
      resItem.quantity = pendingQty;
      resItem.indentNumber = indentId;
      resItem.poNumber = poNumber;
      if (confirmedQty > 0) resItem.confirmedAt = dateNow;
    }
    await resItem.save({ session });

    await logEvent(
      req.user,
      'Reservation Confirmed',
      `Reservation ${resItem.reservationId}: confirmed ${confirmedQty}, pending ${pendingQty} (requested ${requestedQty})`,
      req,
      session
    );

    summary.push({
      reservationId: resItem.reservationId,
      skuCode: product.skuCode,
      msilCode: product.msilCode || null,
      requestedQty,
      confirmedQty,
      pendingQty,
      availableStockAfter: product.availableForSale
    });
  }

  const createdOrders = ordersToCreate.length
    ? await Order.insertMany(ordersToCreate, session ? { session } : {})
    : [];

  const totalConfirmed = summary.reduce((sum, s) => sum + s.confirmedQty, 0);
  const totalPending = summary.reduce((sum, s) => sum + s.pendingQty, 0);

  return { orderNumber, poNumber, indentId, createdOrders, summary, totalConfirmed, totalPending };
};

// Company address copied on every booking confirmation, so Shraddha Impex keeps
// a record of each confirmed booking. Override via BOOKING_CC_EMAILS in .env
// (comma-separated) to change or add addresses without touching this file.
const COMPANY_CC = (process.env.BOOKING_CC_EMAILS ?? 'Contact@shraddhaimpex.net')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Escape values that originate from user/product data before dropping them into
// the email HTML.
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Builds the booking-confirmation email body. One mail per confirmation: a short
// confirmation line, the Booking ID generated when the booking was made, and the
// items the customer actually booked. Every value comes from the live booking.
const buildConfirmationEmail = ({ customerName, orderNumber, indentId, summary, totalConfirmed, totalPending }) => {
  const cell = 'padding: 7px 12px; border-bottom: 1px solid #eee; font-size: 13px;';
  const head = 'padding: 7px 12px; background: #f4f6f8; color: #555; text-align: left; font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e3e7eb;';

  const totalRequested = summary.reduce((n, s) => n + s.requestedQty, 0);

  const rows = summary.map((s) => `
    <tr>
      <td style="${cell}"><strong>${esc(s.skuCode)}</strong></td>
      <td style="${cell}">${esc(s.msilCode || '—')}</td>
      <td style="${cell} text-align: right;">${s.requestedQty}</td>
      <td style="${cell} text-align: right; color: #1a7f37; font-weight: bold;">${s.confirmedQty}</td>
      <td style="${cell} text-align: right; ${s.pendingQty > 0 ? 'color: #b54708; font-weight: bold;' : 'color: #bbb;'}">${s.pendingQty}</td>
    </tr>`).join('');

  return `
    <p>Hi ${esc(customerName)},</p>
    <p>Your booking is <strong>confirmed</strong>.</p>

    <div style="margin: 18px 0; padding: 14px 18px; background: #f0f6ff; border: 1px solid #cfe0f7; border-radius: 4px;">
      <div style="font-size: 11px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">Booking ID</div>
      <div style="font-size: 22px; font-weight: bold; color: #1a5b9e; font-family: monospace; margin-top: 2px;">${esc(orderNumber)}</div>
      ${totalPending > 0 ? `<div style="margin-top: 8px; font-size: 12px; color: #5a7ca8;">Indent reference: <strong style="font-family: monospace; color: #b54708;">${esc(indentId)}</strong></div>` : ''}
    </div>

    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead>
        <tr>
          <th style="${head}">SKU</th>
          <th style="${head}">MSIL Code</th>
          <th style="${head} text-align: right;">Booked</th>
          <th style="${head} text-align: right;">Confirmed</th>
          <th style="${head} text-align: right;">On Indent</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="${cell} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold;">${totalRequested}</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold; color: #1a7f37;">${totalConfirmed}</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold; ${totalPending > 0 ? 'color: #b54708;' : 'color: #bbb;'}">${totalPending}</td>
        </tr>
      </tfoot>
    </table>

    ${totalPending > 0
      ? `<p>Of the ${totalRequested} unit(s) booked, <strong>${totalConfirmed}</strong> were confirmed from available stock and <strong>${totalPending}</strong> could not be fulfilled. The shortfall has been moved to indent <strong>${esc(indentId)}</strong> — we will notify you as soon as it is back in stock, and it will return to your selection list for confirmation.</p>`
      : ''}

    <p style="margin: 16px 0; padding: 12px 16px; background: #fff8e6; border-left: 4px solid #f0a500; font-size: 14px;">
      <strong>Please note:</strong> the turnaround time (TAT) for this booking is
      <strong>7 days</strong> from the date of confirmation.
    </p>

    <p>Thank you for your business.</p>
  `;
};

export const confirmBooking = async (req, res, next) => {
  const session = await mongoose.startSession();
  let result;
  try {
    try {
      // Preferred path: run everything inside a single ACID transaction.
      session.startTransaction();
      result = await runConfirmBooking(req, session);
      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      if (isTransactionUnsupported(txErr)) {
        // Standalone MongoDB (no replica set) — transactions unavailable.
        // Nothing was committed, so it's safe to re-run without a session.
        console.warn('[confirmBooking] Transactions unsupported — running without a transaction.');
        result = await runConfirmBooking(req, null);
      } else {
        throw txErr;
      }
    } finally {
      session.endSession();
    }

    const { orderNumber, poNumber, indentId, createdOrders, summary, totalConfirmed, totalPending } = result;

    // Side effects run only after a successful commit.
    const notifMessage = totalPending > 0
      ? `Booking ${orderNumber} (PO ${poNumber}): ${totalConfirmed} units confirmed, ${totalPending} units moved to Indent ${indentId}.`
      : `Your booking ${orderNumber} (PO ${poNumber}) is confirmed.`;
    sendNotification(req.user._id, 'Booking Confirmed', notifMessage, 'order');

    const who = req.user.company || req.user.user || req.user.email;
    notifyAdmins({
      title: totalPending > 0 ? 'Booking Confirmed (with Indent)' : 'Booking Confirmed',
      message: `${who} confirmed booking ${orderNumber} — ${totalConfirmed} units confirmed${totalPending > 0 ? `, ${totalPending} units on indent` : ''}.`,
      type: 'order',
    });

    // Booking confirmation email to the customer who placed it. Sent once per
    // confirmation (not per line), and only after the transaction has committed
    // so we never email about a booking that was rolled back.
    if (req.user.email && req.user.preferences?.emailNotifications !== false) {
      const subject = totalPending > 0
        ? `Booking ${orderNumber} confirmed (${totalConfirmed} units) — ${totalPending} on indent`
        : `Booking ${orderNumber} confirmed — ${totalConfirmed} units`;

      const body = buildConfirmationEmail({
        customerName: req.user.user || req.user.company || 'Customer',
        orderNumber, indentId, summary, totalConfirmed, totalPending,
      });

      // Fire-and-forget: a mail failure must not fail an already-committed booking.
      sendEmail(req.user.email, subject, body, {
        cc: [...(req.user.bookingCcEmails || []), ...COMPANY_CC],
      }).catch((e) => console.error('[confirmBooking] email error', e));
    }

    if (createdOrders.length) {
      io.emit('order-created', { orderId: createdOrders[0]._id, orderNumber });
    }

    res.status(201).json({
      success: true,
      data: {
        orderId: orderNumber,
        poNumber,
        indentId,
        order: createdOrders[0] || null,
        orders: createdOrders,
        summary,
        totals: {
          totalRequested: totalConfirmed + totalPending,
          totalConfirmed,
          totalPending
        },
        fullyConfirmed: totalPending === 0
      }
    });
  } catch (error) {
    next(error);
  }
};

export const validateBulk = async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) {
      throw new Error('Rows must be an array.');
    }

    const validatedRows = [];

    const msilApplies = msilAppliesTo(req.user);

    // Prefetch every referenced SKU / MSIL code with one $in query per brand
    // collection, so validation stays fast for large uploads.
    const skuList = [...new Set(rows.map(r => r.skuCode?.trim()).filter(Boolean))];
    const msilList = msilApplies
      ? [...new Set(rows.map(r => r.msilCode?.trim()).filter(Boolean))]
      : [];
    const bySku = new Map();
    const byMsil = new Map();
    for (const Model of [ProductKoken, ProductBIX, ProductIMADA]) {
      if (skuList.length) {
        const found = await Model.find({ skuCode: { $in: skuList } });
        for (const p of found) if (!bySku.has(p.skuCode)) bySku.set(p.skuCode, p);
      }
      if (msilList.length) {
        const found = await Model.find({ msilCode: { $in: msilList } });
        for (const p of found) if (p.msilCode && !byMsil.has(p.msilCode)) byMsil.set(p.msilCode, p);
      }
    }

    for (let row of rows) {
      const errors = [];
      const warnings = [];
      let status = 'valid';

      const skuCode = row.skuCode?.trim();
      const msilCode = msilApplies ? row.msilCode?.trim() : undefined;
      const quantity = Number(row.quantity) || 0;

      if (!skuCode && !msilCode) {
        errors.push(msilApplies ? "Missing both SKU and MSIL Code." : "Missing SKU Code.");
        validatedRows.push({ ...row, status: 'error', errors });
        continue;
      }

      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors.push("Quantity must be a whole number greater than zero.");
      }

      // Lookup product. A provided SKU must exist — a row is never silently
      // rebadged onto a different product via its MSIL code.
      let product = null;
      if (skuCode) {
        product = bySku.get(skuCode) || null;
        if (!product) {
          const viaMsil = msilCode ? byMsil.get(msilCode) : null;
          errors.push(viaMsil
            ? `SKU Code ${skuCode} does not exist in the database (MSIL Code ${msilCode} belongs to SKU ${viaMsil.skuCode} — correct the SKU or clear it to import by MSIL Code).`
            : `SKU Code ${skuCode} does not exist in the database.`);
          validatedRows.push({ ...row, status: 'error', errors });
          continue;
        }
      } else {
        product = byMsil.get(msilCode) || null;
        if (!product) {
          errors.push(`MSIL Code ${msilCode} does not exist in the database.`);
          validatedRows.push({ ...row, status: 'error', errors });
          continue;
        }
      }

      // If both provided, verify they identify the same product.
      if (skuCode && msilCode && product.msilCode !== msilCode) {
        errors.push(`Provided MSIL Code (${msilCode}) does not match Product MSIL Code (${product.msilCode}).`);
      }

      // Check Stock — no longer a hard error. Over-booking is allowed; any
      // shortfall becomes a Indent at confirmation time.
      if (product.availableForSale < quantity) {
        const shortfall = quantity - Math.max(0, product.availableForSale);
        warnings.push(`Only ${Math.max(0, product.availableForSale)} in stock. ${shortfall} unit(s) will move to Indent.`);
      }

      // Check MSIL Active — only enforced for users MSIL Codes apply to, and
      // only when the product actually has one assigned. A product with no MSIL
      // Code is valid; the field is left blank.
      const targetMsil = msilApplies ? product.msilCode : null;
      if (targetMsil) {
        const msilDoc = await MsilCode.findOne({ code: targetMsil });
        if (!msilDoc || msilDoc.status !== 'Active') {
          errors.push(`MSIL Code ${targetMsil} is inactive or does not exist.`);
        }
      }

      // MOQ applies to Non-MSIL customers only; MSIL customers are exempt.
      // The quantity must be at least the MOQ.
      if (req.user?.customerCategory !== 'MSIL') {
        const moq = Number(product.moq) || 0;
        if (moq > 1 && Number.isInteger(quantity) && quantity < moq) {
          errors.push(`Quantity must be at least the Minimum Order Quantity (${moq}).`);
        }
      }

      if (errors.length > 0) {
        status = 'error';
      } else if (warnings.length > 0) {
        status = 'warning';
      }

      // Auto-map both directions: SKU→MSIL and MSIL→SKU. When the product has
      // no MSIL Code, surface "-" in the preview rather than a blank/null.
      const resolvedMsil = msilApplies ? (product.msilCode || "-") : "-";

      validatedRows.push({
        ...row,
        // Auto-fill codes from the matched product so rows imported by MSIL
        // Code alone (or with a mistyped SKU) carry the canonical SKU Code.
        skuCode: product.skuCode,
        msilCode: resolvedMsil,
        status,
        errors,
        warnings,
        product: product ? {
          id: product._id,
          code: product.skuCode,
          msilCode: resolvedMsil,
          name: product.skuCode,
          category: product.category,
          availableStock: product.availableForSale,
          price: 0
        } : null
      });
    }

    res.status(200).json({ success: true, data: validatedRows });
  } catch (error) {
    next(error);
  }
};
