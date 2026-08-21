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
import { allowedBrandModels, canAccessBrand } from '../../utils/brandAccess.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';
import { termsFor } from '../../utils/transactionTerms.js';
import { recordAudit } from '../../utils/auditLog.js';
import { isTransactionUnsupported } from '../../utils/mongoSession.js';
import { recordStockMovement } from '../../utils/dualWrite.js';
import { msilAppliesTo } from '../../utils/msilVisibility.js';
import { enforceMoq, moqError } from '../../utils/moq.js';
import { sendIndentRaisedMails, sendBookingMails } from '../../utils/indentMail.js';

// The product collection is split one-per-brand; the brand is implied by which
// collection a doc lives in (there is no brand field on the schema).
const BRAND_MODELS = [
  [ProductKoken, 'Koken'],
  [ProductBIX, 'BIX'],
  [ProductIMADA, 'IMADA'],
];

// Helper to find product across brands. Pass a session to read within a
// transaction so the stock value is consistent for the read-modify-write cycle.
//
// Pass `user` to restrict the search to that user's permitted brands: a product
// in a brand they cannot access then resolves to null, exactly as if it did not
// exist. Omitting `user` searches every brand and must only be done for
// internal/system callers (e.g. the expiry job), never for a request path.
const findProductById = async (productId, session = null, user = null) => {
  const opts = session ? { session } : {};
  const models = user ? allowedBrandModels(user) : BRAND_MODELS;
  for (const [Model] of models) {
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
// Scoped to the user's permitted brands when `user` is supplied.
const findProductWithBrand = async (productId, user = null) => {
  const models = user ? allowedBrandModels(user) : BRAND_MODELS;
  for (const [Model, brand] of models) {
    const p = await Model.findById(productId);
    if (p) return { product: { ...p.toObject(), brand }, brand };
  }
  return { product: null, brand: null };
};

// Atomically fulfil as much of `wantQty` as live stock allows. Uses a guarded
// $inc so two concurrent confirmations can never oversell (drive stock < 0).
// Mutates product.availableForSale to the fresh post-decrement value and
// returns the quantity actually deducted (0..wantQty).
const deductStockAtomic = async (product, wantQty, session = null, ctx = null) => {
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
      // Dual-write: a partial fill is still an allocation. `take` rather than
      // `wantQty` — the ledger records what actually moved.
      await recordStockMovement({
        product,
        workflow: ctx?.workflow || 'deduct',
        referenceType: ctx?.referenceType, referenceId: ctx?.referenceId,
        actor: ctx?.actor, req: ctx?.req,
        movements: [{
          movementType: 'RESERVE',
          quantity: take,
          beforeQuantity: updated.bookedQuantity - take,
          afterQuantity: updated.bookedQuantity,
        }],
      });
      return take;
    }
    // Stock changed underneath us between read and write — retry with fresh value.
  }
  return 0;
};

// Transaction-support detection lives in utils/mongoSession.js.

// Audit writing lives in utils/auditLog.js — see recordAudit().

// Persist + deliver a notification to a single user (their own room only).
const sendNotification = (userId, title, message, type = 'reservation') => {
  notifyUser(userId, { title, message, type });
};

// MOQ (Minimum Order Quantity) is enforced only for Regular customers; MSIL
// customers are exempt. Both the rule and the classification behind it live in
// utils/moq.js — see enforceMoq()/moqError() there — so this file, the bulk
// validator below and the front end cannot drift apart on who MOQ applies to.

// MSIL Code visibility lives in utils/msilVisibility.js — see msilAppliesTo().

export const getReservations = async (req, res, next) => {
  try {
    const reservations = await Reservation.find({ customerId: req.user._id, status: 'Reserved' });
    // Manually populate since refs don't span multiple models. The lookup is
    // brand-scoped, so a line whose brand access was revoked resolves to null.
    const populated = await Promise.all(reservations.map(async r => {
      const { product } = await findProductWithBrand(r.productId, req.user);
      return { ...r.toObject(), productId: product };
    }));
    // Drop rows the user may no longer see, rather than returning a line with a
    // null product that the UI would render as a blank row.
    res.status(200).json({ success: true, data: populated.filter((r) => r.productId) });
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
      // `user` is the customer's display name on this schema; `name` does not
      // exist, so the drawer and the tables were showing the company or the
      // email in its place.
      .populate('customerId', 'user name email company customerCategory')
      .sort({ updatedAt: -1 });

    // WHICH INDENTS ACTUALLY HAVE A BOOKING.
    //
    // An indent id and its booking id share a sequence number and differ only
    // in the prefix (PI-2026-000042 ↔ BO-2026-000042), and the client used to
    // derive one from the other by string substitution. That is right for an
    // indent raised alongside a booking and WRONG for a standalone one: the
    // sequence number is allocated whether or not anything could be fulfilled,
    // so a request that fulfilled nothing displayed a Booking ID for an order
    // that was never created, and searching Booking History for it found
    // nothing. Asked of the orders collection instead of guessed — one query
    // for the whole page.
    const candidateBookingIds = [...new Set(
      reservations
        .map((r) => r.indentNumber)
        .filter(Boolean)
        .map((id) => id.replace(/^PI-/, 'BO-')),
    )];
    const realBookingIds = candidateBookingIds.length
      ? new Set(await Order.distinct('orderId', { orderId: { $in: candidateBookingIds } }))
      : new Set();

    const populated = await Promise.all(reservations.map(async r => {
      const obj = r.toObject();
      const { product } = await findProductWithBrand(r.productId, req.user);
      const derived = r.indentNumber ? r.indentNumber.replace(/^PI-/, 'BO-') : null;
      return {
        ...obj,
        productId: product,
        // null when this indent stands alone — the client must not invent one.
        bookingId: derived && realBookingIds.has(derived) ? derived : null,
        standalone: !derived || !realBookingIds.has(derived),
      };
    }));
    // Brand-scoped: an indent for a brand this user cannot access is omitted.
    res.status(200).json({ success: true, data: populated.filter((r) => r.productId) });
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
/**
 * A scheduled date that has not arrived yet, compared by calendar day.
 *
 * Measured against the START of the promised day. A date of today means the
 * indent is available today — comparing against 23:59 would refuse the release
 * for the whole of the very day the customer was told to expect it.
 */
const isScheduledForLater = (date) => {
  if (!date) return false;
  const due = new Date(date);
  const startOfDue = new Date(due.getFullYear(), due.getMonth(), due.getDate(), 0, 0, 0, 0);
  return Date.now() < startOfDue.getTime();
};

/**
 * POST /api/v1/reservations/schedule
 *
 * Set the date each indented SKU is expected to become available, and tell the
 * customer.
 *
 * Takes a LIST, because an indent is a list — an admin scheduling a delivery
 * sets dates for several SKUs in one sitting, and sending one email per line
 * for a single decision is how people learn to ignore emails.
 *
 * The dates are written FIRST and the mail sent afterwards, so a mail failure
 * cannot lose a schedule that was already agreed.
 */
export const scheduleIndent = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, message: 'Only an admin can schedule an indent.' });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Send an items array of { id, scheduledDate }.' });
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const wanted = [];
    for (const raw of items) {
      const id = typeof raw?.id === 'string' ? raw.id.trim() : null;
      if (!id) continue;

      // A null date CLEARS the schedule — that is how a promise is withdrawn.
      if (raw.scheduledDate === null || raw.scheduledDate === '') {
        wanted.push({ id, date: null, note: null });
        continue;
      }
      const date = new Date(raw.scheduledDate);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ success: false, message: 'One of the dates could not be read.' });
      }
      if (date < startOfToday) {
        return res.status(400).json({
          success: false,
          message: 'An availability date cannot be in the past — it is what the customer is told to expect.',
        });
      }
      wanted.push({ id, date, note: typeof raw.note === 'string' ? raw.note.trim() || null : null });
    }
    if (wanted.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid lines were sent.' });
    }

    const reservations = await Reservation.find({ _id: { $in: wanted.map((w) => w.id) } })
      .populate('customerId', 'name email company');
    const byId = new Map(reservations.map((r) => [String(r._id), r]));

    const now = new Date();
    const updated = [];
    const skipped = [];
    let cleared = 0;

    for (const w of wanted) {
      const r = byId.get(w.id);
      if (!r) { skipped.push({ id: w.id, reason: 'Not found.' }); continue; }
      if (!['Pending', 'Partially Confirmed'].includes(r.status)) {
        skipped.push({ id: w.id, skuCode: r.skuCode, reason: 'Status is ' + r.status + ', not an open indent.' });
        continue;
      }
      r.scheduledDate = w.date;
      r.scheduledBy = w.date ? req.user._id : null;
      r.scheduledAt = w.date ? now : null;
      r.scheduleNote = w.note;
      await r.save();
      if (!w.date) cleared += 1;
      updated.push(r);
    }

    // Grouped per customer: one indent can span more than one, and nobody
    // should be shown another customer's lines.
    const byCustomer = new Map();
    for (const r of updated) {
      if (!r.scheduledDate || !r.customerId?.email) continue;
      const key = String(r.customerId._id);
      if (!byCustomer.has(key)) byCustomer.set(key, { customer: r.customerId, lines: [] });
      byCustomer.get(key).lines.push(r);
    }

    const fmt = (d) => new Date(d).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });

    let emailed = 0;
    for (const entry of byCustomer.values()) {
      const { customer, lines } = entry;
      const rows = lines.map((l) => [
        '<tr>',
        '<td style="padding:8px 12px;border-bottom:1px solid #eee;"><b>' + l.skuCode + '</b></td>',
        '<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">' + l.quantity + '</td>',
        '<td style="padding:8px 12px;border-bottom:1px solid #eee;">' + fmt(l.scheduledDate) + '</td>',
        '</tr>',
      ].join('')).join('');

      const notes = lines.filter((l) => l.scheduleNote)
        .map((l) => l.skuCode + ': ' + l.scheduleNote).join('<br>');

      // Which transaction is this schedule against? An indent carries the PO of
      // the confirmation that produced it, so once that PO exists this IS a
      // purchase order schedule and has to say so. Only when every line in the
      // mail belongs to the SAME PO can it be named — a mixed batch is still
      // just indent scheduling, and claiming otherwise would be wrong for half
      // the rows.
      const poNumbers = [...new Set(lines.map((l) => l.poNumber).filter((n) => n && n !== '-'))];
      const onOnePo = poNumbers.length === 1 && lines.every((l) => l.poNumber === poNumbers[0]);
      const terms = termsFor({ poNumber: onOnePo ? poNumbers[0] : null });

      const html = [
        '<p>Dear ' + (customer.name || customer.company || 'Customer') + ',</p>',
        terms.isPo
          ? '<p>The <strong>' + terms.scheduleNoun + '</strong> for <strong>'
            + terms.reference + '</strong> has been updated. The expected availability for the '
            + 'following item' + (lines.length === 1 ? ' is' : 's are') + ' shown below:</p>'
          : '<p>We have scheduled the expected availability for the following indented item'
            + (lines.length === 1 ? '' : 's') + ':</p>',
        '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">',
        '<thead><tr style="background:#f5f5f5;">',
        '<th style="padding:8px 12px;text-align:left;">SKU</th>',
        '<th style="padding:8px 12px;">Quantity</th>',
        '<th style="padding:8px 12px;text-align:left;">Expected available</th>',
        '</tr></thead><tbody>' + rows + '</tbody></table>',
        notes ? '<p style="color:#555;">' + notes + '</p>' : '',
        '<p>We will be in touch when the stock is ready to move to your selection list.</p>',
        '<p>Thank you.</p>',
      ].join('');

      const scheduleSubject = terms.isPo
        ? 'Purchase Order ' + terms.reference + ' - schedule updated ('
          + lines.length + ' item' + (lines.length === 1 ? '' : 's') + ')'
        : 'Indent availability scheduled - ' + lines.length + ' item' + (lines.length === 1 ? '' : 's');

      // Fire-and-forget: the schedule is saved, and a mail failure must not
      // report the whole operation as failed.
      sendEmail(
        customer.email,
        scheduleSubject,
        html,
        { cc: COMPANY_CC },
      ).catch((e) => console.error('[Indent] schedule email failed:', e.message));

      sendNotification(
        customer._id,
        terms.isPo ? 'Purchase Order schedule updated' : 'Indent availability scheduled',
        lines.length + ' indented item' + (lines.length === 1 ? ' has' : 's have') + ' an expected availability date.',
      );
      emailed += 1;
    }

    await recordAudit(req.user, 'Indent Scheduled',
      'Availability scheduled for ' + updated.length + ' indent line(s).',
      req, { meta: { updated: updated.length, skipped: skipped.length, emailed } });

    res.status(200).json({
      success: true,
      message: (cleared === updated.length && cleared > 0
        ? cleared + ' schedule(s) cleared.'
        : updated.length + ' line(s) scheduled.')
        + (emailed ? ' ' + emailed + ' customer' + (emailed === 1 ? '' : 's') + ' notified.' : ''),
      data: {
        updated: updated.map((r) => ({
          id: r._id, skuCode: r.skuCode, scheduledDate: r.scheduledDate, scheduleNote: r.scheduleNote,
        })),
        skipped,
        emailed,
      },
    });
  } catch (error) { next(error); }
};

export const restoreBackorder = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, message: 'Only an admin can move a indent to the selection list.' });
    }

    // bookingCcEmails is selected because the notification below copies the
    // customer's own Cc list, as every other customer-facing mail does.
    const reservation = await Reservation.findById(req.params.id)
      .populate('customerId', 'user email company bookingCcEmails');
    if (!reservation) {
      throw new Error('Indent not found.');
    }

    if (!['Pending', 'Partially Confirmed'].includes(reservation.status)) {
      throw new Error('Only indents can be moved to the selection list.');
    }

    const product = await findProductById(reservation.productId, null, req.user);
    if (!product) {
      throw new Error(`Product ${reservation.skuCode} not found.`);
    }

    // A scheduled date is a promise made to the customer. Stock on the shelf
    // before that date may be spoken for, or the promise may have been made
    // against an inbound delivery — either way the indent is not available
    // until the day it was scheduled for.
    if (isScheduledForLater(reservation.scheduledDate)) {
      const due = new Date(reservation.scheduledDate)
        .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      // 409, not a bare Error: this is a business rule saying "not yet", and the
      // surrounding pattern here throws plain Errors that surface as 500s — a
      // server fault, which this is not.
      const err = new Error('This indent is scheduled to become available on ' + due
        + '. Clear or change the schedule to release it sooner.');
      // The shared error handler reads `statusCode`, not `status` — setting the
      // wrong one is why this surfaced as a 500 despite being a business rule.
      err.statusCode = 409;
      err.status = 409;
      err.code = 'SCHEDULED_FOR_LATER';
      throw err;
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

    await recordAudit(
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
          <tr><td style="padding: 4px 12px; color: #777;">Quantity</td><td style="padding: 4px 12px; font-weight: bold;">${reservation.quantity}</td></tr>
          <tr><td style="padding: 4px 12px; color: #777;">Reference</td><td style="padding: 4px 12px; font-weight: bold;">${reservation.reservationId}</td></tr>
        </table>
        <p>It has been moved back to your <strong>selection list</strong>. Please log in to your dashboard and <strong>confirm this booking</strong> to secure the stock. Note this selection will expire in 7 days if not confirmed.</p>
        <p>Thank you.</p>
      `;
      // Fire-and-forget: email failure should not fail the request.
      // Copied to the company addresses like every other customer-facing mail —
      // this one was going out with no Cc at all.
      sendEmail(customer.email, subject, body, {
        cc: [...(customer.bookingCcEmails || []), ...COMPANY_CC],
      }).catch((e) =>
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

    // Brand-scoped: a product in a brand this customer has no access to is
    // indistinguishable from one that does not exist, so it cannot be booked
    // by guessing its id.
    const product = await findProductById(productId, null, req.user);
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

    // MOQ applies to Regular customers only; MSIL customers are exempt. It is
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
        await recordAudit(req.user, 'Reservation Updated', `Added ${quantity} units of ${product.skuCode} to an existing reservation (now ${updated.quantity})`, req);
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

    await recordAudit(req.user, 'Reservation Created', `Reserved ${quantity} units of ${product.skuCode}`, req);
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

    const product = await findProductById(reservation.productId, null, req.user);
    if (!product) {
      throw new Error('Product not found.');
    }

    // MOQ applies to Regular customers only; MSIL customers are exempt.
    enforceMoq(req.user, product, quantity);

    // No stock validation/adjustment — stock is only allocated at confirmation time.
    reservation.quantity = quantity;
    await reservation.save();

    await recordAudit(req.user, 'Reservation Updated', `Adjusted quantity of reservation ${reservation.reservationId} to ${quantity}`, req);

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

    await recordAudit(req.user, 'Reservation Cancelled', `Cancelled reservation ${reservation.reservationId}`, req);
    sendNotification(req.user._id, 'Reservation Cancelled', `Reservation ${reservation.reservationId} has been cancelled and removed from your selection list.`, 'reservation');

    res.status(200).json({ success: true, data: reservation });
  } catch (error) {
    next(error);
  }
};

/**
 * Reserve the lines of a DIRECT booking, inside the caller's transaction.
 *
 * Used by the bulk-upload flow, which books a whole sheet in one action. The
 * reservation documents still exist — they are what an unfulfilled line becomes
 * (the indent), and the confirmation loop below is written against them — but
 * they are created and consumed within a single request, so the customer's
 * Selection List is never a place the upload passes through.
 *
 * Nothing is merged into lines the customer already holds. A sheet is a
 * self-contained booking: sweeping in whatever happened to be sitting in the
 * Selection List is what made an uploaded booking arrive with lines nobody put
 * in the file. Repeats WITHIN the sheet are merged, because one SKU listed
 * twice is one line of demand and MOQ has to be judged on the total.
 *
 * @param {object[]} items [{ productId, quantity }]
 */
const reserveDirectBookingLines = async (req, session, items) => {
  // Bad lines in an upload are the CUSTOMER's to fix, not a server fault, so
  // they answer 400 and the upload screen shows the reason against the file.
  // A bare Error would fall through to the handler's default 500 and read as an
  // outage for what is usually a mistyped quantity.
  const badRequest = (message) => {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
  };

  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest('At least one booking line is required.');
  }

  // Merge repeats in the sheet, preserving first-seen order so the summary the
  // customer gets back reads in the order they uploaded.
  const byProduct = new Map();
  for (const item of items) {
    const productId = item?.productId;
    const quantity = Number(item?.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
      throw badRequest('Every booking line needs a product and a whole-number quantity greater than zero.');
    }
    byProduct.set(String(productId), (byProduct.get(String(productId)) || 0) + quantity);
  }

  const year = new Date().getFullYear();
  const reservationDate = new Date();
  const expiryDate = new Date(reservationDate.getTime() + 7 * 24 * 60 * 60 * 1000);
  const docs = [];

  for (const [productId, quantity] of byProduct) {
    // Brand-scoped, exactly as the single-line path is: a SKU in a brand this
    // customer cannot access resolves to null and is reported as missing rather
    // than being bookable by id.
    const product = await findProductById(productId, session, req.user);
    if (!product) {
      throw badRequest(`Product ${productId} not found.`);
    }

    // The same two gates the individual booking screen applies. They are
    // re-checked here rather than trusted from validate-bulk: that response is
    // a preview the client holds, and stock, MOQ and MSIL status can all move
    // between the preview and the click.
    enforceMoq(req.user, product, quantity);

    if (msilAppliesTo(req.user) && product.msilCode) {
      const msilDoc = await MsilCode.findOne({ code: product.msilCode }, null, session ? { session } : {});
      if (!msilDoc || msilDoc.status !== 'Active') {
        throw badRequest(`MSIL Code ${product.msilCode} for product ${product.skuCode} is inactive or does not exist.`);
      }
    }

    const seq = await nextSequence(`reservation-${year}`, session);
    docs.push({
      reservationId: `RES-${year}-${String(seq).padStart(6, '0')}`,
      customerId: req.user._id,
      productId: product._id,
      skuCode: product.skuCode,
      msilCode: product.msilCode,
      quantity,
      reservationDate,
      expiryDate,
      status: 'Reserved',
      reservedBy: req.user._id,
    });
  }

  // insertMany returns hydrated documents, which is what the confirmation loop
  // needs — it calls .save() on each to record the outcome.
  return Reservation.insertMany(docs, session ? { session } : {});
};

// Core confirmation logic. All DB writes accept an optional `session` so the
// whole read-modify-write cycle (stock deduction + order creation + reservation
// updates) is atomic when transactions are available.
//
// `items` selects WHICH lines are committed:
//   omitted — the Selection List confirmation: everything the customer holds.
//   given   — a direct booking: these lines only, reserved here and confirmed
//             in the same breath, never touching the Selection List.
// Everything after the line set is identical for both, so a booking made from a
// sheet and one made from the list cannot diverge in what they produce.
const runConfirmBooking = async (req, session, { items = null } = {}) => {
  const reservations = items
    ? await reserveDirectBookingLines(req, session, items)
    : await Reservation.find(
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
    const product = await findProductById(resItem.productId, session, req.user);
    if (!product) {
      throw new Error(`Product ${resItem.skuCode} not found.`);
    }

    const requestedQty = resItem.quantity;

    // Fulfill as much as live stock allows (atomically, so concurrent
    // confirmations cannot oversell); the rest becomes a Pending backorder.
    const confirmedQty = await deductStockAtomic(product, requestedQty, session, {
      workflow: 'booking-confirm',
      referenceType: 'booking',
      referenceId: orderNumber,
      actor: req.user,
      req,
    });
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

    await recordAudit(
      req.user,
      'Reservation Confirmed',
      `Reservation ${resItem.reservationId}: confirmed ${confirmedQty}, pending ${pendingQty} (requested ${requestedQty})`,
      req,
      { session },
    );

    summary.push({
      reservationId: resItem.reservationId,
      skuCode: product.skuCode,
      msilCode: product.msilCode || null,
      // Carried so the notification can name the material, not just its code —
      // "SKU 09008" tells a support mailbox nothing on its own.
      category: Array.isArray(product.category) ? product.category.join(', ') : (product.category || null),
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

  return {
    orderNumber, poNumber, indentId, createdOrders, summary,
    totalConfirmed, totalPending,
    // The moment the confirmation happened — the indent date the customer is
    // told, read from the same value the reservations were stamped with rather
    // than from a second `new Date()` in the mail builder.
    confirmedAt: dateNow,
  };
};

// The notification bodies live in utils/indentMail.js. One module builds the
// customer copy and the Support Team copy from the same facts, so a confirmation
// that raises an indent cannot tell the two audiences different things — see
// sendBookingMails() and sendIndentRaisedMails() there.

/**
 * Commit a confirmation and report what it produced.
 *
 * Shared by both entry points — the Selection List's Confirm and the bulk
 * upload's Continue to Booking — because everything from the commit onwards is
 * the same job: work out whether a booking, an indent, or both were created,
 * notify, email, and answer with the outcome. The two differ only in where
 * their lines come from, which is `options.items`.
 *
 * @param {object}   [options.items] Direct-booking lines. Omit to confirm the
 *                                   customer's Selection List.
 */
const runConfirmationRequest = async (req, res, next, { items = null } = {}) => {
  const session = await mongoose.startSession();
  const tag = items ? 'createDirectBooking' : 'confirmBooking';
  let result;
  try {
    try {
      // Preferred path: run everything inside a single ACID transaction.
      session.startTransaction();
      result = await runConfirmBooking(req, session, { items });
      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      if (isTransactionUnsupported(txErr)) {
        // Standalone MongoDB (no replica set) — transactions unavailable.
        // Nothing was committed, so it's safe to re-run without a session.
        console.warn(`[${tag}] Transactions unsupported — running without a transaction.`);
        result = await runConfirmBooking(req, null, { items });
      } else {
        throw txErr;
      }
    } finally {
      session.endSession();
    }

    const {
      orderNumber, poNumber, indentId, createdOrders, summary,
      totalConfirmed, totalPending, confirmedAt,
    } = result;

    // WHAT WAS ACTUALLY CREATED. A confirmation produces one of three outcomes,
    // and they are not interchangeable — a request where nothing could be
    // fulfilled creates an INDENT and no booking at all, and calling that
    // "Booking BO-… confirmed — 0 units" is both untrue and alarming. It is also
    // why a standalone indent appeared to send nothing useful.
    const isStandaloneIndent = totalConfirmed === 0 && totalPending > 0;
    const isCombined = totalConfirmed > 0 && totalPending > 0;

    // Side effects run only after a successful commit.
    const notifMessage = isStandaloneIndent
      ? `Indent ${indentId} raised for ${totalPending} unit(s). We will notify you when material is inwarded.`
      : isCombined
        ? `Booking ${orderNumber} (PO ${poNumber}): ${totalConfirmed} units confirmed, ${totalPending} units moved to Indent ${indentId}.`
        : `Your booking ${orderNumber} (PO ${poNumber}) is confirmed.`;
    sendNotification(
      req.user._id,
      isStandaloneIndent ? 'Indent Raised' : 'Booking Confirmed',
      notifMessage,
      'order',
    );

    const who = req.user.company || req.user.user || req.user.email;
    notifyAdmins({
      title: isStandaloneIndent
        ? 'Indent Raised'
        : isCombined ? 'Booking Confirmed (with Indent)' : 'Booking Confirmed',
      message: isStandaloneIndent
        ? `${who} raised indent ${indentId} — ${totalPending} units awaiting stock.`
        : `${who} confirmed booking ${orderNumber} — ${totalConfirmed} units confirmed${totalPending > 0 ? `, ${totalPending} units on indent` : ''}.`,
      type: 'order',
    });

    // ── Email: the customer AND the Support Team ───────────────────────────
    //
    // EXACTLY ONE mail each way per confirmation, whichever of the three
    // outcomes it was. The branch picks the wording, not the number of mails —
    // sending "a booking mail" and "an indent mail" for a combined confirmation
    // is precisely the duplicate the brief rules out.
    //
    // Sent after the transaction has committed, so nothing is ever announced
    // that was rolled back. Awaited rather than fire-and-forget: the whole
    // reported defect was mail that silently did not go, and a promise nobody
    // waits on cannot report that. The wait is a second or two on an
    // already-saved record, and both helpers swallow their own failures.
    const mailArgs = {
      customer: req.user,
      indentDate: confirmedAt,
      poNumber,
    };
    const delivery = isStandaloneIndent
      ? await sendIndentRaisedMails({
          ...mailArgs,
          indentId,
          lines: summary
            .filter((s) => s.pendingQty > 0)
            .map((s) => ({
              skuCode: s.skuCode,
              msilCode: s.msilCode,
              category: s.category,
              quantity: s.pendingQty,
              reference: s.reservationId,
            })),
        })
      : await sendBookingMails({
          ...mailArgs,
          orderNumber,
          indentId,
          bookingDate: confirmedAt,
          summary,
          totalConfirmed,
          totalPending,
        });

    if (createdOrders.length) {
      io.emit('order-created', { orderId: createdOrders[0]._id, orderNumber });
    }
    // An indent with no booking still changes what Indent History shows, and
    // the screen had no reason to refetch because no order-created ever fired.
    if (totalPending > 0) {
      io.emit('indent-raised', { indentId, customerId: String(req.user._id) });
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
        fullyConfirmed: totalPending === 0,
        // Told plainly so the client can route to Booking History or Indent
        // History on fact rather than by re-deriving it from the totals.
        outcome: isStandaloneIndent ? 'indent' : isCombined ? 'booking+indent' : 'booking',
        bookingCreated: totalConfirmed > 0,
        indentCreated: totalPending > 0,
        notified: delivery,
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/reservations/confirm
 *
 * Confirm everything in the customer's Selection List.
 */
export const confirmBooking = (req, res, next) => runConfirmationRequest(req, res, next);

/**
 * POST /api/v1/reservations/direct-booking
 *
 * Book a set of lines outright, with no Selection List step. This is what the
 * bulk upload's "Continue to Booking" calls: an uploaded sheet is already an
 * explicit instruction to book, so staging it in the Selection List asked the
 * customer to say yes to the same thing twice — and left the whole sheet
 * stranded in their list if they closed the page at the second prompt.
 *
 * All-or-nothing. One transaction covers reserving and confirming every line, so
 * a sheet cannot half-book: either the whole file becomes a booking (and, for
 * anything short of stock, an indent) or nothing is written and the rows stay on
 * the upload screen with the reason.
 *
 * Body: { items: [{ productId, quantity }], poNumber?, remarks? }
 */
export const createDirectBooking = (req, res, next) =>
  runConfirmationRequest(req, res, next, { items: req.body?.items });

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
    // Only the user's permitted brands are searched, so a bulk upload cannot
    // smuggle in a SKU from a brand they have no access to — such a row simply
    // reports as an unknown SKU.
    for (const [Model] of allowedBrandModels(req.user)) {
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

      // MOQ applies to Regular customers only; MSIL customers are exempt.
      // Asked of utils/moq.js rather than re-derived here — a bulk upload that
      // disagreed with the individual booking screen about who MOQ applies to
      // is how an MSIL customer's file came back full of MOQ errors.
      if (Number.isInteger(quantity)) {
        const moqMessage = moqError(req.user, product, quantity);
        if (moqMessage) errors.push(moqMessage);
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
