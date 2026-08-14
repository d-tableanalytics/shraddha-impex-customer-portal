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
} from './order.controller.js';
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
