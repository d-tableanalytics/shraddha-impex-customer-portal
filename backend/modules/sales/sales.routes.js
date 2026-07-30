import express from 'express';
import { getBookings, getBookingDetail, updateBookingItems, raisePo } from './sales.controller.js';
import { protect } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';
import { PERMISSIONS } from '../../middlewares/rbac.js';

const router = express.Router();

// Every route is authenticated AND permission-checked. Admin satisfies these
// via the '*' wildcard; Customers hold none of them and are rejected.
router.use(protect);

router.get('/bookings', authorize(PERMISSIONS.VIEW_ALL_BOOKINGS), getBookings);
router.get('/bookings/:orderId', authorize(PERMISSIONS.VIEW_ALL_BOOKINGS), getBookingDetail);

router.put(
  '/bookings/:orderId/items',
  authorize(PERMISSIONS.EDIT_BOOKING_PRE_PO),
  updateBookingItems,
);

router.post('/bookings/:orderId/po', authorize(PERMISSIONS.RAISE_PO), raisePo);

export default router;
