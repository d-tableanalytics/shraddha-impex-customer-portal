import express from 'express';
import {
  getBookings, getBookingDetail, updateBookingItems, raisePo,
  getBookingPricing, setBookingPricing,
} from './sales.controller.js';
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

/**
 * Customer pricing. VIEW_PRICING and nothing else — not RAISE_PO, not
 * VIEW_ALL_BOOKINGS.
 *
 * The GET is the only response anywhere in the application that carries more
 * than one price for a SKU, so its guard is the fence around the whole price
 * schedule. The PUT is behind the same key because seeing the tiers and
 * choosing between them are one job at the desk.
 *
 * No ordering subtlety with '/bookings/:orderId' above: that pattern is one
 * path segment, these are two, and Express matches segment by segment.
 */
router.get('/bookings/:orderId/pricing', authorize(PERMISSIONS.VIEW_PRICING), getBookingPricing);
router.put('/bookings/:orderId/pricing', authorize(PERMISSIONS.VIEW_PRICING), setBookingPricing);

export default router;
