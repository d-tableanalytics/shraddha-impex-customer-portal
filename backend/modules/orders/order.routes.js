import express from 'express';
import {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  updateBookingStatus,
  getBookingStatusTimeline,
  resendBookingStatusEmail,
  updateOrderPO,
  cancelBooking,
  getBookingQuantityHistory,
  scheduleBooking,
} from './order.controller.js';
import { updateBookingItems } from '../sales/sales.controller.js';
import { protect } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';
import { auditLogger } from '../../middlewares/auditLogger.js';

const router = express.Router();

router.route('/')
  .get(protect, getOrders)
  .post(protect, authorize('create_order'), auditLogger('Create Order'), createOrder);

// Booking-level routes are declared BEFORE '/:id' so 'booking' is never taken
// for an order id.
//
// Advancing the lifecycle is a booking-wide action: one request moves every
// line item, records one timeline entry and sends the customer one email.
router.put(
  '/booking/:orderId/status',
  protect,
  authorize('manage_orders'),
  auditLogger('Update Booking Status'),
  updateBookingStatus,
);

// The customer's own lifecycle timeline. Not behind manage_orders — the
// handler applies the ownership rule and gives staff the notification log.
router.get('/booking/:orderId/timeline', protect, getBookingStatusTimeline);

// Who changed the quantities, when, and to what. Same ownership rule as the
// timeline above — the handler applies it.
router.get('/booking/:orderId/quantity-history', protect, getBookingQuantityHistory);

/*
 * Set the expected availability date on a booking's SKU lines, and email the
 * customer their delivery schedule.
 *
 * `manage_orders` — the same permission that advances the booking lifecycle
 * above, because both are the desk making a commitment to the customer about
 * goods. Deliberately NOT `view_all_bookings`: seeing every booking is not the
 * same authority as promising a date on one.
 *
 * The indent equivalent (`PATCH /reservations/schedule`) is admin-only via
 * isSuperAdmin. This is a narrower, permission-based gate rather than a role
 * check, which is the direction the rest of this router already went — and
 * anyone holding the wildcard satisfies it anyway, so no existing admin loses
 * access.
 */
router.put(
  '/booking/:orderId/schedule',
  protect,
  authorize('manage_orders'),
  auditLogger('Schedule Booking'),
  scheduleBooking,
);

// AMEND QUANTITIES ON A BOOKING. ADMIN AND SALES ONLY.
//
// Deliberately the SAME handler the sales desk calls, not a second write path.
// That handler already moves the stock, honours the PO lock and writes the
// audit entry the quantity history and the PO mail are both built from;
// reimplementing any of it here would leave two versions to keep in step.
//
// Behind edit_booking_pre_po, so a CUSTOMER cannot change a quantity once the
// booking exists — only Admin and Sales can, and the customer is emailed the
// adjustment. This route was previously open so a customer could revise their
// own booking; that is no longer the rule. runUpdateItems() still applies its
// own ownership and quantity-only confinement as defence in depth.
router.put(
  '/booking/:orderId/items',
  protect,
  authorize('edit_booking_pre_po'),
  updateBookingItems,
);

// Retry a status email that never reached the customer.
router.post(
  '/booking/status-events/:eventId/resend',
  protect,
  authorize('manage_orders'),
  auditLogger('Resend Booking Status Email'),
  resendBookingStatusEmail,
);

router.get('/:id', protect, getOrderById);

// Cancellation is NOT behind manage_orders: a customer cancelling their own
// booking is the main case. The handler checks ownership itself and lets
// manage_orders holders act for someone else.
router.post('/:orderId/cancel', protect, auditLogger('Cancel Booking'), cancelBooking);

router.put('/:id/status', protect, authorize('manage_orders'), updateOrderStatus);
router.put('/:orderId/po', protect, authorize('manage_orders'), updateOrderPO);

export default router;
