import mongoose from 'mongoose';
import Order from '../../models/Order.js';
import Reservation from '../../models/Reservation.js';
import { ProductKoken, ProductBIX, ProductIMADA } from '../../models/Product.js';
import AuditLog from '../../models/AuditLog.js';
import { nextSequence } from '../../models/Counter.js';
import { io } from '../../server.js';
import { notifyUser, notifyAdmins } from '../../utils/notify.js';
import { allowedBrandModels, canAccessBrand, brandFilter } from '../../utils/brandAccess.js';
import { isBookingLocked, canOverrideLock } from '../../utils/bookingLock.js';
import { hasPermission, PERMISSIONS } from '../../middlewares/rbac.js';
import { withBoxNoVisibility } from '../../utils/boxNoVisibility.js';
import { findProductBySku, consumeStock, releaseStock } from '../../utils/stockLedger.js';
import { processAvailableIndents } from '../inventory/indentAvailability.service.js';
import { recordAudit } from '../../utils/auditLog.js';
import { recordStockMovement } from '../../utils/dualWrite.js';
import {
  applyBookingStatus,
  recordExternalStatusChange,
  getBookingTimeline,
  resendStatusMail,
} from './bookingStatus.service.js';
import { bookingStatusOf, stageLabel } from '../../utils/bookingLifecycle.js';

// Product is stored one-collection-per-brand; brand is implied by the collection.
const BRAND_MODELS = [
  [ProductKoken, 'Koken'],
  [ProductBIX, 'BIX'],
  [ProductIMADA, 'IMADA'],
];

// Pass `user` to restrict the lookup to that user's permitted brands, so a
// product they cannot access resolves to null instead of being orderable by id.
const findProductById = async (productId, session = null, user = null) => {
  const opts = session ? { session } : {};
  const models = user ? allowedBrandModels(user) : BRAND_MODELS;
  for (const [Model, brand] of models) {
    const p = await Model.findById(productId, null, opts);
    if (p) return { product: p, brand };
  }
  return { product: null, brand: null };
};

// Atomically deduct up to wantQty from live stock without overselling.
// Returns the quantity actually taken and updates product.availableForSale.
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
  }
  return 0;
};

// Audit writing lives in utils/auditLog.js — see recordAudit().

export const getOrders = async (req, res, next) => {
  try {
    // Customers see only their own orders, and only in brands they still have
    // access to — revoking a brand hides its past bookings too.
    // Roles holding VIEW_ALL_BOOKINGS (Admin, Sales) see every customer and
    // every brand, since the sales desk has to process the whole queue.
    const seesEverything = hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS);
    const query = seesEverything ? {} : { ...brandFilter(req.user), user: req.user._id };
    const orders = await Order.find(query).sort({ createdAt: -1 });
    // The box number rides on every order row. It is shown on the line items to
    // Sales and Admin only, so it is removed from the payload here rather than
    // merely hidden by the client — this endpoint serves a customer their own
    // bookings, and a hidden column is still in the response.
    res.status(200).json({ success: true, data: withBoxNoVisibility(orders, req.user) });
  } catch (error) {
    next(error);
  }
};

export const getOrderById = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    // Owner + brand check. Both answer 404 rather than 403 so this endpoint
    // cannot be used to probe which order ids or brands exist.
    const seesEverything = hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS);
    if (!seesEverything) {
      const isOwner = String(order.user) === String(req.user._id);
      if (!isOwner || !canAccessBrand(req.user, order.brand)) {
        return res.status(404).json({ success: false, message: 'Order not found' });
      }
    }
    res.status(200).json({ success: true, data: withBoxNoVisibility(order, req.user) });
  } catch (error) {
    next(error);
  }
};

// Direct order creation (a booking placed without going through the reservation
// selection list). Mirrors confirmBooking: over-booking is allowed — any
// quantity beyond live stock becomes a Pending backorder remainder. Each line
// item becomes one flat Order row sharing a single order number.
export const createOrder = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { poNumber, deliveryLocation, remarks, items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('At least one order item is required.');
    }

    const year = new Date().getFullYear();
    const orderSeq = await nextSequence(`order-${year}`, session);
    const orderNumber = `SO-${year}-${String(orderSeq).padStart(6, '0')}`;
    const now = new Date();

    const ordersToCreate = [];
    const summary = [];

    for (const item of items) {
      const requestedQty = Number(item.quantity) || 0;
      if (requestedQty <= 0) {
        throw new Error('Item quantity must be greater than zero.');
      }

      const { product, brand } = await findProductById(item.productId, session, req.user);
      if (!product) {
        throw new Error(`Product ${item.productId} not found`);
      }

      const confirmedQty = await deductStockAtomic(product, requestedQty, session, {
        workflow: 'order-create',
        referenceType: 'order',
        referenceId: orderNumber,
        actor: req.user,
        req,
      });
      const pendingQty = requestedQty - confirmedQty;

      if (confirmedQty > 0) {
        ordersToCreate.push({
          orderId: orderNumber,
          brand: brand || 'Koken',
          user: req.user._id,
          status: 'PO Received',
          orderTimestamp: now,
          company: req.user.company || null,
          role: req.user.role || 'Customer',
          date: now,
          skuCode: product.skuCode,
          category: Array.isArray(product.category) ? product.category.join(', ') : (product.category || null),
          requestedQty: confirmedQty,
          bookedQty: requestedQty,
          confirmedQty,
          pendingQty,
          poNumber: poNumber || "-",
          location: deliveryLocation || null,
          remarks: pendingQty > 0
            ? `Partially confirmed (${confirmedQty}/${requestedQty}). ${pendingQty} pending. ${remarks || ''}`.trim()
            : (remarks || 'Direct order booking.'),
          msilCode: product.msilCode || null,
          boxNo: product.boxNo || null,
          emailId: req.user.email || null,
        });
      }

      summary.push({
        skuCode: product.skuCode,
        requestedQty,
        confirmedQty,
        pendingQty,
        availableStockAfter: product.availableForSale,
      });
    }

    const createdOrders = ordersToCreate.length
      ? await Order.insertMany(ordersToCreate, { session })
      : [];

    await recordAudit(req.user, 'Booking Created', `Booking ${orderNumber} created with ${items.length} line item(s).`, req, { session });

    await session.commitTransaction();

    if (createdOrders.length) {
      io.emit('order-created', { orderId: createdOrders[0]._id, orderNumber });

      const totalPending = summary.reduce((s, i) => s + (i.pendingQty || 0), 0);
      notifyUser(req.user._id, {
        title: 'Booking Placed',
        message: totalPending > 0
          ? `Your booking ${orderNumber} is placed. ${totalPending} units could not be fulfilled and are on indent.`
          : `Your booking ${orderNumber} has been placed successfully.`,
        type: 'order',
      });
      const who = req.user.company || req.user.user || req.user.email;
      notifyAdmins({
        title: 'New Booking Placed',
        message: `${who} placed booking ${orderNumber} (${summary.length} line item${summary.length === 1 ? '' : 's'})${totalPending > 0 ? ` — ${totalPending} units on indent` : ''}.`,
        type: 'order',
      });
    }

    res.status(201).json({
      success: true,
      data: createdOrders[0] || null,
      orders: createdOrders,
      orderId: orderNumber,
      summary,
    });
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
};

/**
 * PUT /api/v1/orders/:id/status — advance a booking by one of its line items.
 *
 * Kept because clients hold line-item ids, but it no longer acts on the single
 * row. A status is a property of the BOOKING, and updating one of five lines
 * left a booking that was half dispatched and a customer told it was dispatched
 * outright. It now delegates to the booking-level service, which moves every
 * line together, writes one timeline entry and sends one email — so a caller
 * that loops over five line items produces one notification, not five.
 */
export const updateOrderStatus = async (req, res, next) => {
  try {
    const { status, remarks } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const result = await applyBookingStatus({
      orderId: order.orderId,
      status,
      remarks,
      actor: req.user,
      req,
    });
    if (!result.ok) {
      return res.status(result.code).json({ success: false, message: result.message });
    }

    // Re-read so the caller gets the row as it now stands rather than the copy
    // fetched before the update.
    const updated = await Order.findById(req.params.id);
    res.status(200).json({
      success: true,
      data: updated,
      changed: result.changed,
      notified: result.notification || null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/orders/booking/:orderId/status — the admin panel's status update.
 *
 * The route to prefer: one request per booking, whatever it contains.
 */
export const updateBookingStatus = async (req, res, next) => {
  try {
    const { status, remarks } = req.body;
    const result = await applyBookingStatus({
      orderId: req.params.orderId,
      status,
      remarks,
      actor: req.user,
      req,
    });

    if (!result.ok) {
      return res.status(result.code).json({ success: false, message: result.message });
    }

    res.status(200).json({
      success: true,
      // Whether anything moved. A false here is the "no email for a status that
      // did not actually change" rule being applied, not a failure.
      changed: result.changed,
      message: result.changed
        ? `Booking ${req.params.orderId} moved to "${stageLabel(status)}".`
        : result.message || 'The booking was already at this status.',
      data: {
        orderId: req.params.orderId,
        status: result.status,
        previousStatus: result.previousStatus,
        changedAt: result.changedAt || null,
        lineItemsUpdated: result.lineItemsUpdated || 0,
      },
      notified: result.notification || null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/orders/booking/:orderId/timeline
 *
 * The booking's lifecycle history. The customer who owns it sees the stages and
 * their timestamps; staff who can see every booking additionally get the
 * notification log — whether each email was sent, skipped or failed, and why.
 * The log is withheld from customers deliberately: their own address and a
 * bounce reason are operational detail they cannot act on.
 */
export const getBookingStatusTimeline = async (req, res, next) => {
  try {
    const orderId = req.params.orderId;
    const rows = await Order.find({ orderId });
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    // Same ownership rule as getOrderById, and the same 404 for a booking that
    // is not the caller's — so this cannot be used to probe which ids exist.
    const seesEverything = hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS);
    if (!seesEverything) {
      const isOwner = String(rows[0].user) === String(req.user._id);
      if (!isOwner || !canAccessBrand(req.user, rows[0].brand)) {
        return res.status(404).json({ success: false, message: 'Booking not found.' });
      }
    }

    const events = await getBookingTimeline(orderId, rows);
    const timeline = events.map((e) => ({
      id: String(e._id),
      status: e.status,
      previousStatus: e.previousStatus,
      changedAt: e.changedAt,
      changedByName: seesEverything ? e.changedByName : undefined,
      remarks: e.remarks,
      // Flagged so the client does not offer a resend against an id that
      // belongs to no stored document.
      ...(e.derived ? { derived: true } : {}),
      ...(seesEverything ? { notification: e.notification } : {}),
    }));

    res.status(200).json({
      success: true,
      data: {
        orderId,
        currentStatus: bookingStatusOf(rows),
        timeline,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/orders/booking/status-events/:eventId/resend
 *
 * Retry a status email the customer never received. Staff only — this is the
 * action side of the notification log.
 */
export const resendBookingStatusEmail = async (req, res, next) => {
  try {
    const result = await resendStatusMail({
      eventId: req.params.eventId,
      actor: req.user,
      req,
    });
    if (!result.ok) {
      return res.status(result.code).json({ success: false, message: result.message });
    }

    res.status(200).json({
      success: result.sent,
      message: result.sent
        ? 'The notification was sent.'
        : `The notification could not be sent — ${result.notification?.error || result.notification?.reason}`,
      notified: result.notification,
    });
  } catch (error) {
    next(error);
  }
};

export const updateOrderPO = async (req, res, next) => {
  try {
    const { poNumber } = req.body;
    const orderNumber = req.params.orderId; 
    
    if (!orderNumber || !poNumber) {
      return res.status(400).json({ success: false, message: 'orderNumber and poNumber required' });
    }

    const rows = await Order.find({ orderId: orderNumber });
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    // Raising a PO here locks the booking exactly as the sales-desk route does,
    // so the two paths cannot disagree about whether a booking is editable.
    if (isBookingLocked(rows) && !canOverrideLock(req.user)) {
      return res.status(423).json({
        success: false,
        message: 'Booking is locked because the PO has already been generated.',
      });
    }

    const now = new Date();
    await Order.updateMany(
      { orderId: orderNumber },
      { $set: { poNumber, poGeneratedAt: now, poGeneratedBy: req.user._id } },
    );

    // Same as the sales-desk route: raising the PO commits the goods, so the
    // reserved units leave inventory permanently. stockState makes it idempotent.
    for (const row of rows) {
      if ((row.stockState ?? 'reserved') !== 'reserved') continue;
      const product = await findProductBySku(row.skuCode);
      if (product) {
        await consumeStock(product, row.confirmedQty || 0, null, {
          workflow: 'po-raise',
          referenceType: 'booking',
          referenceId: orderNumber,
          actor: req.user,
          req,
        });
      }
      await Order.updateOne(
        { _id: row._id },
        { $set: { stockState: 'consumed', stockSettledAt: now } },
      );
    }

    const indentNumber = orderNumber.replace(/^SO-|^BO-/, 'PI-');
    await Reservation.updateMany({ indentNumber }, { poNumber });

    await recordAudit(
      req.user,
      'PO Generated',
      `PO ${poNumber} raised for booking ${orderNumber}. Booking is now locked.`,
      req,
    );

    res.status(200).json({ success: true, poNumber });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/orders/:orderId/cancel
 *
 * Cancel a booking whose stock is still reserved, and hand the units back.
 *
 * This is the customer's own escape hatch for a booking they no longer want —
 * including one the system raised for them automatically when their indent came
 * back in stock. Without it, an auto-booking could only be undone by waiting out
 * the 7-day PO deadline, which leaves stock sitting reserved against a customer
 * who has already said they do not want it.
 *
 * The release is deliberately identical to what the settlement job does when
 * the deadline expires — `releaseStock`, then `stockState: 'released'`. Two
 * different ways of returning stock would eventually disagree, and `stockState`
 * is what makes both idempotent: a line already consumed or released is skipped,
 * so this can never double-release.
 *
 * A booking whose PO has been raised is NOT cancellable here. Those units are
 * already consumed — gone from inventory against a commitment the customer
 * made — and "cancelling" would have to un-issue goods that may have shipped.
 */
export const cancelBooking = async (req, res, next) => {
  try {
    const orderNumber = req.params.orderId;
    const rows = await Order.find({ orderId: orderNumber });
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    // A customer may cancel only their own booking. Admins and anyone holding
    // manage_orders may cancel on a customer's behalf, which is how a phone
    // request gets actioned.
    const owner = String(rows[0].user);
    const isOwner = owner === String(req.user._id);
    const canActForOthers = req.user.role === 'Admin'
      || hasPermission(req.user, PERMISSIONS.MANAGE_ORDERS);
    if (!isOwner && !canActForOthers) {
      return res.status(403).json({ success: false, message: 'This booking belongs to another customer.' });
    }

    if (rows.every((r) => r.status === 'Cancelled')) {
      return res.status(409).json({
        success: false,
        message: `Booking ${orderNumber} is already cancelled.`,
      });
    }

    // Locked means the PO exists and the stock has left inventory.
    if (isBookingLocked(rows)) {
      return res.status(423).json({
        success: false,
        message: 'This booking cannot be cancelled because its PO has already been raised. '
          + 'Please contact us to arrange a return or amendment.',
      });
    }

    const releasable = rows.filter((r) => (r.stockState ?? 'reserved') === 'reserved');
    if (releasable.length === 0) {
      return res.status(409).json({
        success: false,
        message: 'This booking holds no reserved stock, so there is nothing to cancel.',
      });
    }

    const now = new Date();
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    const byName = isOwner ? 'the customer' : `${req.user.name || req.user.email || 'staff'}`;
    // Captured before the rows are rewritten below — afterwards every line reads
    // 'Cancelled' and the stage it was cancelled FROM is unrecoverable.
    const statusBeforeCancel = bookingStatusOf(rows);

    const released = [];
    const releasedSkus = new Set();

    for (const row of releasable) {
      const product = await findProductBySku(row.skuCode);
      if (product) {
        await releaseStock(product, row.confirmedQty || 0, null, {
          workflow: 'booking-cancel',
          referenceType: 'booking',
          referenceId: orderNumber,
          reasonCode: 'REVERSAL',
          actor: req.user,
          req,
        });
        releasedSkus.add(row.skuCode);
      }
      row.stockState = 'released';
      row.stockSettledAt = now;
      row.status = 'Cancelled';
      row.remarks = `Cancelled by ${byName}${reason ? ` — ${reason}` : ''}. ${row.remarks || ''}`.trim();
      await row.save();
      released.push({ skuCode: row.skuCode, quantity: row.confirmedQty || 0, msilCode: row.msilCode });
    }

    const units = released.reduce((n, l) => n + l.quantity, 0);

    await recordAudit(
      req.user,
      'Booking Cancelled',
      `Booking ${orderNumber} cancelled by ${byName}. ${units} unit(s) released back to stock.`
        + (reason ? ` Reason: ${reason}` : ''),
      req,
      { meta: { orderId: orderNumber, units, lines: released } },
    );

    // Put the cancellation on the lifecycle timeline. No status email goes with
    // it — the stage descriptions and next-step wording are written for the four
    // forward stages, and the customer is already told about a cancellation by
    // the notification below. A timeline that simply stops at the last stage
    // reached, though, reads as a booking still in progress.
    await recordExternalStatusChange({
      orderId: orderNumber,
      status: 'Cancelled',
      previousStatus: statusBeforeCancel,
      rows,
      actor: req.user,
      remarks: `Cancelled by ${byName}${reason ? ` — ${reason}` : ''}`,
      changedAt: now,
    });

    notifyUser(rows[0].user, {
      title: 'Booking cancelled',
      message: `Booking ${orderNumber} has been cancelled and ${units} unit(s) returned to stock.`,
      type: 'order',
    });
    notifyAdmins({
      title: 'Booking Cancelled',
      message: `${orderNumber} (${rows[0].company || 'customer'}) cancelled by ${byName} — ${units} unit(s) released.`,
      type: 'order',
    });

    io.emit('booking-cancelled', { orderId: orderNumber });

    // The units are back on the shelf, so anyone still waiting on them may now
    // be bookable. This cannot re-raise the booking just cancelled: the indent
    // behind it was closed when that booking was created and is not reopened
    // here, so only indents still waiting are considered.
    let autoBooked = null;
    if (releasedSkus.size) {
      autoBooked = await processAvailableIndents([...releasedSkus]);
    }

    res.status(200).json({
      success: true,
      message: `Booking ${orderNumber} cancelled. ${units} unit(s) released back to stock.`,
      data: { orderId: orderNumber, units, lines: released, autoBooked },
    });
  } catch (error) {
    next(error);
  }
};
