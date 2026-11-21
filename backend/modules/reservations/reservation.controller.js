import Reservation from '../../models/Reservation.js';
import Order from '../../models/Order.js';
import AuditLog from '../../models/AuditLog.js';
import MsilCode from '../../models/MsilCode.js';
import { nextSequence, nextSequenceBlock } from '../../models/Counter.js';
import { io } from '../../server.js';
import { sendEmail } from '../../utils/mailer.js';
import { notifyUser, notifyAdmins } from '../../utils/notify.js';
import {
  allowedBrandModels, allBrandModels, canAccessBrand, brandOfProduct,
} from '../../utils/brandAccess.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';
import { sendDeliverySchedule } from '../../utils/deliverySchedule.js';
import { recordAudit } from '../../utils/auditLog.js';
import { runInTransaction } from '../../utils/transaction.js';
import { recordStockMovement } from '../../utils/dualWrite.js';
import { msilAppliesTo } from '../../utils/msilVisibility.js';
import { hasPermission, PERMISSIONS, isSuperAdmin} from '../../middlewares/rbac.js';
import { enforceMoq, moqError } from '../../utils/moq.js';
import { sendIndentRaisedMails, sendBookingMails } from '../../utils/indentMail.js';
import { supplyCheckNow, holdForDecision } from '../inventory/indentAvailability.service.js';
import {
  resolveBookingCustomer, loadBookingCustomer, creatorStamp, actorName, customerLabel,
} from '../../utils/bookingActor.js';
import { creatorEmails } from '../../utils/bookingRecipients.js';
import { defaultDispatchDate } from '../../utils/dispatchDate.js';

/**
 * ── Booking on a customer's behalf ─────────────────────────────────────────
 *
 * A Sales Person or Admin may build and confirm a booking FOR a customer from
 * Create Booking. The request names the customer (`customerId` in the body, or
 * in the query for reads) and utils/bookingActor.js decides whether the caller
 * may act for them. From there every write treats the CUSTOMER as the account
 * the booking belongs to and the CALLER as the person who placed it:
 *
 *   Reservation.customerId  the customer   — whose booking this becomes
 *   Reservation.reservedBy  the caller     — who is building it
 *   Order.user              the customer   — their Booking History, their mail
 *   Order.createdBy*        the caller     — the "SI Team" column, a Cc on mail
 *
 * A staff-built Selection List is PRIVATE to the staff member building it —
 * it is keyed by (customer, reservedBy) — so a customer never finds half-built
 * lines in their own list, and two salespeople can work the same customer
 * without confirming each other's lines. The customer's own list is unchanged:
 * it is the lines they reserved themselves, as it always was.
 *
 * Without a `customerId` nothing here behaves differently.
 */

/** Which Selection List: the customer's own, or the one `actor` is building for them. */
const selectionListFilter = (customer, actor) => ({
  customerId: customer._id,
  reservedBy: actor._id,
  status: 'Reserved',
});

// Helper to find product across brands. Pass a session to read within a
// transaction so the stock value is consistent for the read-modify-write cycle.
//
// Pass `user` to restrict the search to that user's permitted brands: a product
// in a brand they cannot access then resolves to null, exactly as if it did not
// exist. Omitting `user` searches every brand and must only be done for
// internal/system callers (e.g. the expiry job), never for a request path.
const findProductById = async (productId, session = null, user = null) => {
  const opts = session ? { session } : {};
  const models = user ? allowedBrandModels(user) : allBrandModels();
  for (const [Model] of models) {
    const p = await Model.findById(productId, null, opts);
    if (p) return p;
  }
  return null;
};

// The brand a live product doc belongs to — the field the discriminator
// stores, so a brand created at runtime is reported as itself.
const brandFromModel = brandOfProduct;

// Read-side lookup that also resolves the brand (derived from the collection).
// Returns a plain object so callers can safely spread extra fields onto it.
// Scoped to the user's permitted brands when `user` is supplied.
const findProductWithBrand = async (productId, user = null) => {
  const models = user ? allowedBrandModels(user) : allBrandModels();
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

// MOQ (Minimum Order Quantity) is enforced only for non-MSIL customers; MSIL
// customers are exempt. Both the rule and the classification behind it live in
// utils/moq.js — see enforceMoq()/moqError() there — so this file, the bulk
// validator below and the front end cannot drift apart on who MOQ applies to.

// MSIL Code visibility lives in utils/msilVisibility.js — see msilAppliesTo().

export const getReservations = async (req, res, next) => {
  try {
    // `?customerId=` — the desk reading the list it is building for a customer.
    const { customer } = await resolveBookingCustomer(req, req.query?.customerId);
    // Oldest first — the order the customer built their selection in. Unsorted,
    // this returned natural order, which stops matching insertion order as soon
    // as a row is updated, so the list could reorder itself under the customer.
    const reservations = await Reservation.find(selectionListFilter(customer, req.user))
      .sort({ createdAt: 1, _id: 1 });
    // Manually populate since refs don't span multiple models. The lookup is
    // brand-scoped to the CUSTOMER the list is for, so a line whose brand
    // access was revoked resolves to null.
    const populated = await Promise.all(reservations.map(async r => {
      const { product } = await findProductWithBrand(r.productId, customer);
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
//
// Anyone holding VIEW_ALL_BOOKINGS — Admin AND Sales — sees every customer's
// indents; customers see only their own. Keyed off the permission rather than
// `role === 'Admin'`, which is what had Sales working the whole booking queue
// on the sales desk while Indent History showed them only their own rows.
export const getPendingReservations = async (req, res, next) => {
  try {
    const seesEverything = hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS);
    const filter = { status: { $in: ['Pending', 'Partially Confirmed'] } };
    if (!seesEverything) {
      filter.customerId = req.user._id;
    }

    const reservations = await Reservation.find(filter)
      // `user` is the customer's display name on this schema; `name` does not
      // exist, so the drawer and the tables were showing the company or the
      // email in its place.
      //
      // The master details ride along for the History export, which has to name
      // the customer, their shop, their location and their type on every row.
      // Read from the user record rather than stamped on the reservation for
      // the same reason attachCustomerDetails() does it on bookings: a detail
      // filled in after the indent was raised still appears on it.
      // `phone` rides along for the same reason `location` does: Indent History
      // names the customer the way Booking History does, and that cell carries
      // the contact pair under the name. Without it the indent table could show
      // half the pair and the two screens would disagree about the same person.
      .populate(
        'customerId',
        'user name email company customerCategory customerName shopNumber location phone',
      )
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
    // One row per booking, not per line: an Order document is a single line, so
    // the ids are grouped here rather than fetched and de-duplicated in memory.
    // This replaces a distinct() that answered only "does it exist" — the same
    // one query now also carries the booking's DATE and PO number, which the
    // Indent History export needs and the reservation itself does not hold.
    const bookingRows = candidateBookingIds.length
      ? await Order.aggregate([
        { $match: { orderId: { $in: candidateBookingIds } } },
        {
          $group: {
            _id: '$orderId',
            date: { $first: '$date' },
            createdAt: { $first: '$createdAt' },
            poNumber: { $first: '$poNumber' },
          },
        },
      ])
      : [];
    const bookingById = new Map(bookingRows.map((b) => [b._id, b]));
    const realBookingIds = new Set(bookingById.keys());

    /** A PO number that was actually raised. '-' and blanks are not. */
    const realPo = (value) => {
      const s = String(value ?? '').trim();
      return s === '' || s === '-' ? null : s;
    };

    const populated = await Promise.all(reservations.map(async r => {
      const obj = r.toObject();
      // Unscoped for the desk roles. Sales is not in `seesAllBrands`, so passing
      // req.user here would filter indents by the SALESPERSON's own brandAccess
      // flags — hiding rows they can already see on the sales desk, which spans
      // every brand by design. Customers stay brand-scoped.
      const { product } = await findProductWithBrand(r.productId, seesEverything ? null : req.user);
      const derived = r.indentNumber ? r.indentNumber.replace(/^PI-/, 'BO-') : null;
      const booking = derived ? bookingById.get(derived) : null;
      return {
        ...obj,
        productId: product,
        // null when this indent stands alone — the client must not invent one.
        bookingId: derived && realBookingIds.has(derived) ? derived : null,
        standalone: !derived || !realBookingIds.has(derived),
        // When this indent was raised alongside a booking. Distinct from the
        // reservation's own updatedAt, which moves every time a line is
        // touched — it is not the date anything was ordered on.
        bookingDate: booking ? (booking.date || booking.createdAt || null) : null,
        // The indent carries its own PO number once one is raised; the
        // booking's is the fallback for rows stamped before that, so the export
        // shows a PO wherever one actually exists.
        //
        // '-' is how "no PO" is stored on BOTH, and it has to be normalised on
        // the indent's own value before the fallback is considered — a literal
        // '-' is truthy, so leaving it in place would shadow the booking's real
        // PO number with a placeholder.
        poNumber: realPo(obj.poNumber) || realPo(booking?.poNumber),
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
    if (!hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS)) {
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
    if (!isSuperAdmin(req.user)) {
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

    /*
     * ── One email per customer, covering EVERYTHING they have scheduled ────
     *
     * This block used to build its own HTML table of the indent lines just
     * saved. It now delegates to the shared builder, which reads the customer's
     * complete current schedule — these indent lines AND any booking lines that
     * carry a date — and renders one email with a section for each.
     *
     * That is the change the requirement asked for: a customer with 2 indent
     * items and 3 booking items receives ONE email listing all 5, rather than
     * one email per system. Everything else is preserved deliberately:
     *
     *   - grouped per CUSTOMER, because one indent can span several and nobody
     *     may be shown another customer's lines;
     *   - only lines that HAVE a date appear, so clearing a date withdraws the
     *     promise instead of announcing it;
     *   - the PO wording (`termsFor`) still applies, and still only when every
     *     row in a section shares one reference;
     *   - fire-and-forget, because the schedule is already saved and a mail
     *     failure must not report the whole operation as failed.
     */
    const scheduledCustomers = new Map();
    for (const r of updated) {
      if (!r.customerId?.email) continue;
      scheduledCustomers.set(String(r.customerId._id), r.customerId);
    }

    let emailed = 0;
    for (const customer of scheduledCustomers.values()) {
      const result = await sendDeliverySchedule(customer);
      if (!result.sent) continue;
      emailed += 1;

      sendNotification(
        customer._id,
        'Delivery schedule updated',
        result.total + ' item' + (result.total === 1 ? ' has' : 's have') + ' an expected availability date.',
      );
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
    if (!isSuperAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Only an admin can move a indent to the selection list.' });
    }

    // bookingCcEmails is selected because the notification below copies the
    // customer's own Cc list, as every other customer-facing mail does.
    const reservation = await Reservation.findById(req.params.id)
      .populate('customerId', 'user email company bookingCcEmails customerCategory');
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

    // MSIL SUPPLY CHECK (utils/msilSupply.js) — the same rule the automatic
    // conversion applies, so an admin restore is not a way around it. Stock is
    // there (checked just above); if it is too late for the booking's Supply
    // Date or 7-day window, the indent is held for the desk's Convert / Cancel
    // instead of being restored. On time, it is restored as it always was.
    const supply = await supplyCheckNow(reservation);
    if (supply.applies && !supply.onTime) {
      await holdForDecision(reservation, supply.reason);
      const err = new Error(`Not restored. ${supply.reason} It is waiting on the Sales Desk for Convert or Cancel.`);
      err.statusCode = 409;
      err.status = 409;
      err.code = 'MSIL_SUPPLY_HELD';
      throw err;
    }

    // Move it back into the active selection list with a fresh 7-day window.
    const now = new Date();
    reservation.status = 'Reserved';
    // Into the CUSTOMER's own list: the mail below asks the customer to confirm
    // it, so it has to be where they can see it — even if the desk raised the
    // indent for them (reservedBy then names the staff member, whose private
    // list the customer cannot open).
    reservation.reservedBy = reservation.customerId?._id ?? reservation.customerId;
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

    // The customer this line is for — the caller, unless the desk named one.
    // Every rule below (brand access, MOQ, MSIL) is the CUSTOMER's, because the
    // booking will be theirs.
    const { customer, onBehalf } = await resolveBookingCustomer(req, req.body.customerId);

    // Brand-scoped: a product in a brand this customer has no access to is
    // indistinguishable from one that does not exist, so it cannot be booked
    // by guessing its id.
    const product = await findProductById(productId, null, customer);
    if (!product) {
      // The desk can see every brand, so for them the likelier cause is named.
      throw new Error(onBehalf
        ? 'Product not found, or this customer does not have access to its brand.'
        : 'Product not found.');
    }

    // Adding a product that is already in the selection list tops up that line
    // rather than creating a second row for the same SKU.
    const existing = await Reservation.findOne({
      ...selectionListFilter(customer, req.user),
      productId: product._id,
    });
    const mergedQuantity = (existing?.quantity || 0) + quantity;

    // MOQ applies to non-MSIL customers only; MSIL customers are exempt. It is
    // checked against the merged total, since that is the quantity that will
    // actually be booked — topping up a line must not fail on the increment alone.
    enforceMoq(customer, product, mergedQuantity);

    // NOTE: Stock availability is intentionally NOT validated here. Customers may
    // book any quantity, even beyond availableForSale. Stock is only checked and
    // deducted at confirmation time (see confirmBooking), where any unfulfillable
    // quantity is moved to a Indent.

    // MSIL Code Validation — only enforced for users MSIL Codes apply to, and
    // only when a code is actually assigned. Products without an MSIL Code are
    // allowed to be booked; the MSIL field is simply left blank throughout the UI.
    if (msilAppliesTo(customer) && product.msilCode) {
      const msilDoc = await MsilCode.findOne({ code: product.msilCode });
      if (!msilDoc || msilDoc.status !== 'Active') {
        throw new Error(`MSIL Code ${product.msilCode} for product ${product.skuCode} is inactive or does not exist.`);
      }
    }

    // Stock is NOT allocated/deducted at booking time — only at confirmation.

    const who = onBehalf
      ? `${actorName(req.user)} (for ${customerLabel(customer)})`
      : (req.user.company || req.user.user || req.user.email);
    const forWhom = onBehalf ? ` for ${customerLabel(customer)}` : '';

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
        await recordAudit(req.user, 'Reservation Updated', `Added ${quantity} units of ${product.skuCode} to an existing reservation${forWhom} (now ${updated.quantity})`, req);
        // The in-app notice goes to whoever is building the list — the desk's
        // own list for this customer is theirs to confirm, not the customer's.
        sendNotification(req.user._id, 'Item Booked', `${product.skuCode} updated to ${updated.quantity} units in your selection list${forWhom}. Confirm within 7 days — it is auto-cancelled after that.`, 'reservation');
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
      customerId: customer._id,
      productId: product._id,
      skuCode: product.skuCode,
      msilCode: product.msilCode,
      quantity,
      reservationDate,
      expiryDate,
      status: 'Reserved',
      reservedBy: req.user._id
    }]);

    await recordAudit(req.user, 'Reservation Created', `Reserved ${quantity} units of ${product.skuCode}${forWhom}`, req);
    sendNotification(req.user._id, 'Item Booked', `${product.skuCode} (${quantity} units) added to your selection list${forWhom}. Confirm within 7 days — it is auto-cancelled after that.`, 'reservation');
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

    // Owner, or the desk acting for the customer — the same rule the cancel
    // below applies, with the same 404 so ids cannot be probed.
    const isOwner = String(reservation.customerId) === String(req.user._id);
    const canActForOthers = isSuperAdmin(req.user)
      || hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS)
      || hasPermission(req.user, PERMISSIONS.MANAGE_ORDERS);
    if (!isOwner && !canActForOthers) {
      return res.status(404).json({ success: false, message: 'Reservation not found.' });
    }

    if (reservation.status !== 'Reserved') {
      throw new Error('Only active reservations can be edited.');
    }

    // The line's CUSTOMER sets the rules (brand, MOQ), not whoever is editing:
    // a desk-built line for an MSIL customer stays MOQ-exempt, and a line for a
    // regular customer keeps its multiple whoever types the number.
    const customer = await loadBookingCustomer(req, reservation.customerId);

    const product = await findProductById(reservation.productId, null, customer);
    if (!product) {
      throw new Error('Product not found.');
    }

    // MOQ applies to non-MSIL customers only; MSIL customers are exempt.
    enforceMoq(customer, product, quantity);

    // No stock validation/adjustment — stock is only allocated at confirmation time.
    reservation.quantity = quantity;
    await reservation.save();

    await recordAudit(req.user, 'Reservation Updated', `Adjusted quantity of reservation ${reservation.reservationId} to ${quantity}`, req);

    res.status(200).json({ success: true, data: reservation });
  } catch (error) {
    next(error);
  }
};

// Cancels a selection-list line ('Reserved', owner or staff) or an open indent
// line ('Pending' / 'Partially Confirmed', staff only). Neither holds allocated stock — stock
// is deducted only at confirmation, and an indent is by definition the part
// stock could NOT cover — so cancelling is a status change, never a release.
export const cancelReservation = async (req, res, next) => {
  try {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) {
      throw new Error('Reservation not found.');
    }

    // Owner, or staff acting on the customer's behalf — the same rule
    // cancelBooking applies. Answer 404 rather than 403 so this endpoint
    // cannot be used to probe which reservation ids exist.
    const isOwner = String(reservation.customerId) === String(req.user._id);
    const canActForOthers = isSuperAdmin(req.user)
      || hasPermission(req.user, PERMISSIONS.MANAGE_ORDERS);
    if (!isOwner && !canActForOthers) {
      return res.status(404).json({ success: false, message: 'Reservation not found.' });
    }

    const CANCELLABLE = ['Reserved', 'Pending', 'Partially Confirmed'];
    if (!CANCELLABLE.includes(reservation.status)) {
      throw new Error('Only active reservations and open indents can be cancelled.');
    }

    const isIndent = reservation.status !== 'Reserved';
    // A customer still removes lines from their own selection list, but an
    // indent is staff-only since 2026-10-27 — the same rule as cancelBooking.
    if (isIndent && !canActForOthers) {
      return res.status(403).json({
        success: false,
        message: 'Indents cannot be cancelled from the portal. Please contact support@shraddhaimpex.net with your Indent number.',
      });
    }
    const label = isIndent
      ? `indent ${reservation.indentNumber || reservation.reservationId}`
      : `reservation ${reservation.reservationId}`;

    reservation.status = 'Cancelled';
    reservation.expiredAt = new Date();
    await reservation.save();

    const byName = isOwner ? 'the customer' : (req.user.user || req.user.email || 'staff');
    await recordAudit(
      req.user,
      isIndent ? 'Indent Cancelled' : 'Reservation Cancelled',
      `Cancelled ${label} (${reservation.skuCode} x${reservation.quantity}) — by ${byName}.`,
      req,
    );

    // Tell the OWNER, not the caller — a desk cancel must land in the
    // customer's notifications, not the salesperson's.
    //
    // Except a line the desk was still building for the customer: that sat in
    // the staff member's private list, the customer never saw it, and "removed
    // from your selection list" would describe something that was never there.
    const stagedByDesk = !isIndent && String(reservation.reservedBy) !== String(reservation.customerId);
    if (!stagedByDesk) {
      sendNotification(
        reservation.customerId,
        isIndent ? 'Indent Cancelled' : 'Reservation Cancelled',
        isIndent
          ? `Indent line ${reservation.skuCode} x${reservation.quantity} (${reservation.indentNumber || reservation.reservationId}) has been cancelled.`
          : `Reservation ${reservation.reservationId} has been cancelled and removed from your selection list.`,
        'reservation',
      );
    }
    if (isOwner && isIndent) {
      notifyAdmins({
        title: 'Indent Cancelled',
        message: `${req.user.company || req.user.user || req.user.email} cancelled indent line ${reservation.skuCode} x${reservation.quantity} (${reservation.indentNumber || reservation.reservationId}).`,
        type: 'reservation',
      });
    }

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
 * @param {object}   customer the account the lines are for (see resolveBookingCustomer)
 */
const reserveDirectBookingLines = async (req, session, items, customer) => {
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
  // One counter round trip for the whole sheet rather than one per line.
  // Drawn OUTSIDE the transaction (no session). Every booking increments the
  // same counter document, so inside a transaction any two bookings at the same
  // moment — whatever they were for — conflicted on it, and a burst of them
  // retried until one gave up. A booking that rolls back now leaves a gap in
  // the numbering; numbers only ever needed to be unique.
  const seqs = await nextSequenceBlock(`reservation-${year}`, byProduct.size);

  for (const [productId, quantity] of byProduct) {
    // Brand-scoped, exactly as the single-line path is: a SKU in a brand this
    // customer cannot access resolves to null and is reported as missing rather
    // than being bookable by id.
    const product = await findProductById(productId, session, customer);
    if (!product) {
      throw badRequest(`Product ${productId} not found.`);
    }

    // The same two gates the individual booking screen applies. They are
    // re-checked here rather than trusted from validate-bulk: that response is
    // a preview the client holds, and stock, MOQ and MSIL status can all move
    // between the preview and the click.
    enforceMoq(customer, product, quantity);

    if (msilAppliesTo(customer) && product.msilCode) {
      const msilDoc = await MsilCode.findOne({ code: product.msilCode }, null, session ? { session } : {});
      if (!msilDoc || msilDoc.status !== 'Active') {
        throw badRequest(`MSIL Code ${product.msilCode} for product ${product.skuCode} is inactive or does not exist.`);
      }
    }

    const seq = seqs[docs.length];
    docs.push({
      reservationId: `RES-${year}-${String(seq).padStart(6, '0')}`,
      customerId: customer._id,
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

/** A 409 the confirmation popup can act on: what changed, line by line. */
const reviewConflict = (code, message, details) => {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = code;
  err.details = details;
  return err;
};

/**
 * The lines the customer approved in the confirmation popup, or null when the
 * caller sent none (older clients, and every caller other than the popup).
 *
 * Body: reviewed: [{ id: reservation _id, quantity, bookable }]
 * `bookable` is the part of `quantity` the popup said would come from stock.
 */
const parseReviewedLines = (body) => {
  if (body?.reviewed === undefined) return null;
  const lines = body.reviewed;
  const valid = Array.isArray(lines) && lines.every((l) => (
    l && typeof l.id === 'string'
    && Number.isInteger(l.quantity) && l.quantity > 0
    && Number.isInteger(l.bookable) && l.bookable >= 0
  ));
  if (!valid) {
    const err = new Error('The reviewed booking lines are malformed.');
    err.statusCode = 400;
    throw err;
  }
  return new Map(lines.map((l) => [l.id, l]));
};

/**
 * Refuse a confirmation whose Selection List is no longer what the customer
 * reviewed — a line added, removed or re-quantified from another tab, or
 * released by expiry, between opening the popup and pressing Confirm. What is
 * booked must be what was on screen.
 */
const assertSelectionMatchesReview = (reservations, reviewed) => {
  const changes = [];
  const seen = new Set();
  for (const r of reservations) {
    const id = String(r._id);
    seen.add(id);
    const line = reviewed.get(id);
    if (!line) changes.push({ skuCode: r.skuCode, change: 'added', quantity: r.quantity });
    else if (line.quantity !== r.quantity) {
      changes.push({ skuCode: r.skuCode, change: 'quantity', reviewed: line.quantity, quantity: r.quantity });
    }
  }
  for (const id of reviewed.keys()) {
    if (!seen.has(id)) changes.push({ id, change: 'removed' });
  }
  if (changes.length) {
    throw reviewConflict(
      'SELECTION_CHANGED',
      'Your Selection List changed after you opened the review. Check the updated lines and confirm again.',
      changes,
    );
  }
};

/** Lines whose bookable-from-stock quantity fell below what was reviewed. */
const stockConflict = (shortLines) => reviewConflict(
  'STOCK_CHANGED',
  `Stock changed while you were reviewing: ${shortLines
    .map((l) => `${l.skuCode} now has ${l.available} available (you reviewed ${l.reviewed})`)
    .join('; ')}. Adjust the quantities or confirm the updated split.`,
  shortLines,
);

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
//
// `customer` is the account the booking is FOR and `onBehalf` says whether the
// caller is the desk acting for them (see the note at the top of this file).
// Every row is the customer's; the caller is stamped as its creator.
const runConfirmBooking = async (req, session, { items = null, customer, onBehalf = false } = {}) => {
  const reviewed = items ? null : parseReviewedLines(req.body);
  const reservations = items
    ? await reserveDirectBookingLines(req, session, items, customer)
    : await Reservation.find(
        selectionListFilter(customer, req.user),
        null,
        session ? { session } : {}
      // The SAME sort the Selection List uses. This loop's index becomes each
      // Order row's `lineSeq`, so an arbitrary order here would be frozen into
      // the picklist forever — and if it disagreed with the list, the customer
      // would be shown one order and printed another.
      ).sort({ createdAt: 1, _id: 1 });
  if (reservations.length === 0) {
    // Also what a second click on Confirm meets once the first has committed.
    const err = new Error('No active reservations to confirm.');
    err.statusCode = 409;
    throw err;
  }

  // Products are read up front so a reviewed confirmation can be refused before
  // any stock moves: without a replica set runInTransaction falls back to no
  // transaction, and a refusal thrown after the deductions would keep them.
  const products = [];
  for (const resItem of reservations) {
    const product = await findProductById(resItem.productId, session, customer);
    if (!product) {
      throw new Error(`Product ${resItem.skuCode} not found.`);
    }
    products.push(product);
  }

  /**
   * MOQ, RE-CHECKED AT CONFIRMATION.
   *
   * Every line was checked against the customer's MOQ when it went into the
   * selection list — but a selection list is not a transaction. It can sit for
   * days, and in between an admin can switch the customer from MOQ Not
   * Applicable to Applicable, change their configured Multiple, or move them
   * off MSIL. Confirming is the moment stock is committed and the booking
   * becomes real, so it is the moment the rule has to be true, not merely to
   * have been true when the line was added.
   *
   * Reported for every offending line at once rather than one at a time: a
   * fifteen-line list fixed one refusal per attempt is fifteen round trips.
   *
   * Refused BEFORE any stock moves, for the reason given above the product
   * loop — without a replica set there is no transaction to roll back.
   */
  const moqFailures = reservations
    .map((r, i) => moqError(customer, products[i], r.quantity))
    .filter(Boolean);
  if (moqFailures.length) {
    const err = new Error(moqFailures.join(' '));
    err.statusCode = 400;
    throw err;
  }

  const creator = creatorStamp(req, onBehalf);

  if (reviewed) {
    assertSelectionMatchesReview(reservations, reviewed);
    const short = [];
    reservations.forEach((r, i) => {
      const available = Math.min(r.quantity, Math.max(0, products[i].availableForSale));
      const line = reviewed.get(String(r._id));
      if (available < line.bookable) short.push({ skuCode: r.skuCode, reviewed: line.bookable, available });
    });
    if (short.length) throw stockConflict(short);
  }
  const shortAtDeduction = [];

  const year = new Date().getFullYear();
  // Drawn OUTSIDE the transaction (no session). Every booking increments the
  // same counter document, so inside a transaction any two bookings at the same
  // moment — whatever they were for — conflicted on it, and a burst of them
  // retried until one gave up. A booking that rolls back now leaves a gap in
  // the numbering; numbers only ever needed to be unique.
  const orderSeq = await nextSequence(`order-${year}`);
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
  const audits = [];
  const dateNow = new Date();
  // Every line booked from stock is due to dispatch 3 days after booking
  // (utils/dispatchDate.js). Indent-only lines get no date: nothing is in hand.
  const dispatchDate = defaultDispatchDate(dateNow);

  // `entries()` rather than a bare for..of so each line keeps the position it
  // held in the customer's request. See the note on `lineSeq` in models/Order.js.
  for (const [lineSeq, resItem] of reservations.entries()) {
    const product = products[lineSeq];
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

    // Another booking took the stock between the check above and this
    // deduction. Inside a transaction, throwing after the loop rolls it back.
    const reviewedBookable = reviewed?.get(String(resItem._id))?.bookable ?? 0;
    if (confirmedQty < reviewedBookable) {
      shortAtDeduction.push({ skuCode: resItem.skuCode, reviewed: reviewedBookable, available: confirmedQty });
    }

    if (confirmedQty > 0) {
      ordersToCreate.push({
        lineSeq,
        orderId: orderNumber,
        brand: brandFromModel(product),
        // The CUSTOMER's booking, whoever placed it. Their identity is
        // snapshotted below; the staff member who placed it (if any) is in
        // `creator`, which is null for the customer's own booking.
        user: customer._id,
        ...creator,
        status: 'PO Received',
        orderTimestamp: dateNow,
        company: customer.company || 'Shraddha Impex',
        role: customer.role || 'user',
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
        emailId: customer.email || null,
        phoneNumber: customer.phone || null,
        // ── Customer identity, snapshotted at creation ──────────────────
        // Copied onto the row rather than looked up when the picklist is drawn,
        // so a customer who later moves or re-registers does not rewrite the
        // address on a booking that has already been picked. Same reasoning as
        // `unitPrice` — see models/Order.js.
        shippingAddress: customer.shippingAddress || null,
        billingAddress: customer.billingAddress || null,
        shopNumber: customer.shopNumber || null,
        gstCode: customer.gstNumber || null,
        // The delivery location chosen at checkout, falling back to the
        // customer's profile location. Stamped so the pick list can carry the
        // location and its phone number without a second lookup.
        location: req.body.deliveryLocation || customer.location || null,
        // The default dispatch date, on the per-line field the Sales Desk edits
        // and the delivery schedule email reads. scheduledBy stays null: the
        // system set it, not a person.
        scheduledDate: dispatchDate,
        scheduledAt: dateNow,
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

    audits.push({
      user: req.user?._id || null,
      action: 'Reservation Confirmed',
      method: req.method || 'SYSTEM',
      endpoint: req.originalUrl || 'N/A',
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers?.['user-agent'] || 'ERP SYSTEM',
      remarks: `Reservation ${resItem.reservationId}: confirmed ${confirmedQty}, pending ${pendingQty} (requested ${requestedQty})`
        + (onBehalf ? ` — placed by ${actorName(req.user)} for ${customerLabel(customer)}` : ''),
    });

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

  if (shortAtDeduction.length) throw stockConflict(shortAtDeduction);

  const createdOrders = ordersToCreate.length
    ? await Order.insertMany(ordersToCreate, session ? { session } : {})
    : [];

  // One write for every line's audit entry, inside the transaction, so the
  // trail and the booking commit or roll back together. These were written one
  // at a time, each swallowing its own failure — and a swallowed failure
  // inside a transaction leaves it aborted for whatever runs next.
  if (audits.length) await AuditLog.insertMany(audits, session ? { session } : {});

  const totalConfirmed = summary.reduce((sum, s) => sum + s.confirmedQty, 0);
  const totalPending = summary.reduce((sum, s) => sum + s.pendingQty, 0);

  return {
    orderNumber, poNumber, indentId, createdOrders, summary,
    totalConfirmed, totalPending,
    // The moment the confirmation happened — the indent date the customer is
    // told, read from the same value the reservations were stamped with rather
    // than from a second `new Date()` in the mail builder.
    confirmedAt: dateNow,
    // The default dispatch date stamped on the booked lines, for the mail.
    dispatchDate,
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
  const tag = items ? 'createDirectBooking' : 'confirmBooking';
  try {
    // Who the booking is for. Decided BEFORE the transaction so a refused
    // customer (not the desk, not a customer account, suspended) costs nothing.
    const { customer, onBehalf } = await resolveBookingCustomer(req, req.body?.customerId);

    // One ACID transaction for the whole confirmation — every line, its stock
    // and its booking row, or none of them. A write conflict with another
    // booking of the same SKU is retried; ledger postings wait for the commit.
    // See utils/transaction.js.
    const result = await runInTransaction(
      (session) => runConfirmBooking(req, session, { items, customer, onBehalf }),
      { label: tag },
    );

    const {
      orderNumber, poNumber, indentId, createdOrders, summary,
      totalConfirmed, totalPending, confirmedAt, dispatchDate,
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
    // The CUSTOMER's notification — it is their booking, and it lands in their
    // portal exactly as one they placed themselves would.
    sendNotification(
      customer._id,
      isStandaloneIndent ? 'Indent Raised' : 'Booking Confirmed',
      notifMessage,
      'order',
    );
    // And the desk's own, when they placed it, so the person who pressed
    // Confirm sees the outcome in their notifications too.
    if (onBehalf) {
      sendNotification(
        req.user._id,
        isStandaloneIndent ? 'Indent Raised' : 'Booking Confirmed',
        `For ${customerLabel(customer)}: ${notifMessage}`,
        'order',
      );
    }

    const who = onBehalf
      ? `${actorName(req.user)} (for ${customerLabel(customer)})`
      : (req.user.company || req.user.user || req.user.email);
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
    //
    // TO the customer, whoever placed it. A booking the desk placed copies the
    // staff member (`extraCc`) and names them in the body — the customer is
    // never replaced as the recipient of mail about their own booking.
    const creator = creatorStamp(req, onBehalf);
    const mailArgs = {
      customer,
      indentDate: confirmedAt,
      poNumber,
      extraCc: creatorEmails([creator]),
      placedBy: onBehalf ? { name: creator.createdByName, role: creator.createdByRole } : null,
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
          // Only when something was booked from stock; an all-indent booking has
          // nothing to dispatch yet.
          dispatchDate: createdOrders.length ? dispatchDate : null,
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
      io.emit('indent-raised', { indentId, customerId: String(customer._id) });
    }

    res.status(201).json({
      success: true,
      data: {
        orderId: orderNumber,
        poNumber,
        indentId,
        // Whose booking it is, and who placed it (null when the customer did).
        customer: {
          id: String(customer._id),
          name: customerLabel(customer),
          company: customer.company || null,
          email: customer.email || null,
        },
        createdBy: onBehalf
          ? { id: String(req.user._id), name: creator.createdByName, role: creator.createdByRole }
          : null,
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

      // MOQ applies to non-MSIL customers only; MSIL customers are exempt.
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
