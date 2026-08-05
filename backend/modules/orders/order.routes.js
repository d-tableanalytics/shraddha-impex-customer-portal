import express from 'express';
import { createOrder, getOrders, getOrderById, updateOrderStatus, updateOrderPO, cancelBooking } from './order.controller.js';
import { protect } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';
import { auditLogger } from '../../middlewares/auditLogger.js';

const router = express.Router();

router.route('/')
  .get(protect, getOrders)
  .post(protect, authorize('create_order'), auditLogger('Create Order'), createOrder);

router.get('/:id', protect, getOrderById);

// Cancellation is NOT behind manage_orders: a customer cancelling their own
// booking is the main case. The handler checks ownership itself and lets
// manage_orders holders act for someone else.
router.post('/:orderId/cancel', protect, auditLogger('Cancel Booking'), cancelBooking);

router.put('/:id/status', protect, authorize('manage_orders'), updateOrderStatus);
router.put('/:orderId/po', protect, authorize('manage_orders'), updateOrderPO);

export default router;
