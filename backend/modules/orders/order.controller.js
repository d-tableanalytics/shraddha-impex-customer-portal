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
import { findProductBySku, consumeStock } from '../../utils/stockLedger.js';
import { recordAudit } from '../../utils/auditLog.js';
import { recordStockMovement } from '../../utils/dualWrite.js';

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
    res.status(200).json({ success: true, data: orders });
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
    res.status(200).json({ success: true, data: order });
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

export const updateOrderStatus = async (req, res, next) => {
  try {
    const { status, remarks } = req.body;

    const allowed = Order.schema.path('status').enumValues;
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${allowed.join(', ')}` });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // The Order schema is a flat record (no auditLogs/comments/timeline arrays),
    // so only update fields that actually exist on it.
    order.status = status;
    order.statusTimestamp = new Date();
    if (remarks) order.remarks = remarks;

    await order.save();

    io.emit('order-updated', { orderId: order._id, status });

    // Tell the order's owner their status changed.
    if (order.user) {
      notifyUser(order.user, {
        title: 'Booking Update',
        message: `Your booking ${order.orderId} is now "${status}".`,
        type: 'order',
      });
    }

    res.status(200).json({ success: true, data: order });
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
