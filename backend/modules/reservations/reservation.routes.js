import express from 'express';
import {
  getReservations,
  getPendingReservations,
  getCancelledCount,
  restoreBackorder,
  scheduleIndent,
  createReservation,
  updateReservationQuantity,
  cancelReservation,
  confirmBooking,
  createDirectBooking,
  validateBulk
} from './reservation.controller.js';
import { protect } from '../../middlewares/auth.js';
import { authorize, PERMISSIONS } from '../../middlewares/rbac.js';

const router = express.Router();

router.use(protect);

/**
 * Who may put something into the booking pipeline.
 *
 * A CUSTOMER books for themselves (create_order); the SALES DESK books on a
 * customer's behalf (view_all_bookings); ADMIN satisfies both through the
 * wildcard. Nobody else has any business creating demand.
 *
 * These routes were behind `protect` alone, which meant any signed-in account
 * could create, confirm or amend a reservation — including the internal stock
 * roles, for whom the UI has never offered the ordering flow at all. That gap
 * did not matter while every internal role was trusted staff with a menu that
 * simply lacked the buttons; it matters now, because the Import Team role is
 * defined by what it CANNOT reach, and a hidden menu is not a control.
 *
 * READS are deliberately left open: they are already scoped to the caller's own
 * records for anyone but Admin, and the dashboard and cart read them on every
 * page load.
 */
const MAY_BOOK = [PERMISSIONS.CREATE_ORDER, PERMISSIONS.VIEW_ALL_BOOKINGS];

router.route('/')
  .get(getReservations)
  .post(authorize(...MAY_BOOK), createReservation);

// Static paths must precede the '/:id' routes below, or Express matches them as an id.
router.get('/pending', getPendingReservations);
router.get('/cancelled-count', getCancelledCount);
// Scheduling takes a LIST, so it is not under /:id — an admin sets dates for
// several SKUs of one indent in a single save.
router.post('/schedule', scheduleIndent);
router.post('/:id/restore', restoreBackorder);

router.route('/:id')
  .put(authorize(...MAY_BOOK), updateReservationQuantity)
  .delete(authorize(...MAY_BOOK), cancelReservation);

router.post('/confirm', authorize(...MAY_BOOK), confirmBooking);
// Books a set of lines outright, skipping the Selection List. Used by the bulk
// upload's "Continue to Booking".
router.post('/direct-booking', authorize(...MAY_BOOK), createDirectBooking);
// Checking a pasted list against the catalogue writes nothing, but it is a step
// of the booking flow and there is no reason for a non-booking role to run it.
router.post('/validate-bulk', authorize(...MAY_BOOK), validateBulk);

export default router;
