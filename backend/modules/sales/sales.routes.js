import express from 'express';
import {
  getBookings, getBookingDetail, updateBookingItems, raisePo,
  reorderBookingLines, updateBookingDetails,
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
 * Rearrange the SKU lines to match the customer's actual PO.
 *
 * EDIT_BOOKING_PRE_PO, the same key that guards amending the lines - because
 * this IS an amendment to the booking, just one that changes only sequence. It
 * puts the capability in Sales' hands (who hold it) and keeps it out of a
 * Customer's (who do not), which is exactly what the requirement asks.
 *
 * Not RAISE_PO: reordering to compare against the PO is the work done BEFORE
 * deciding to raise one, and a role that may arrange the desk's paperwork need
 * not also be able to commit the booking.
 */
router.put(
  '/bookings/:orderId/line-order',
  authorize(PERMISSIONS.EDIT_BOOKING_PRE_PO),
  reorderBookingLines,
);

/**
 * Correct customer/order details after submission. Admin only.
 *
 * OVERRIDE_PO_LOCK is the existing Admin-only key meaning "may change a booking
 * after the PO exists" - see the separation-of-duties note in config/
 * permissions.js, which withholds it from Sales precisely so that raising the
 * PO locks the booking against the role that raised it. Reusing it here keeps
 * that one rule in one place; a new key would be a second thing to remember to
 * withhold, and the day someone forgets is the day Sales can quietly rewrite
 * the PO number on a booking it already committed.
 *
 * PATCH, not PUT: the body carries only the fields being corrected, and an
 * absent field means "leave it alone" rather than "clear it".
 */
router.patch(
  '/bookings/:orderId/details',
  authorize(PERMISSIONS.OVERRIDE_PO_LOCK),
  updateBookingDetails,
);

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
