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

// AMEND QUANTITIES ON YOUR OWN BOOKING.
//
// Deliberately the SAME handler the sales desk calls, not a second write path.
// That handler already moves the stock, honours the PO lock and writes the
// audit entry the history above and the PO mail are both built from;
// reimplementing any of it here would leave two versions to keep in step.
//
// Not behind a permission, for the same reason /cancel is not: a customer
// revising their own booking is the main case. runUpdateItems() checks
// ownership itself and confines a non-staff caller to quantity changes on
// lines that already exist.
router.put('/booking/:orderId/items', protect, updateBookingItems);

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
