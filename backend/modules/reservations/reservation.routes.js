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

const router = express.Router();

router.use(protect);

router.route('/')
  .get(getReservations)
  .post(createReservation);

// Static paths must precede the '/:id' routes below, or Express matches them as an id.
router.get('/pending', getPendingReservations);
router.get('/cancelled-count', getCancelledCount);
// Scheduling takes a LIST, so it is not under /:id — an admin sets dates for
// several SKUs of one indent in a single save.
router.post('/schedule', scheduleIndent);
router.post('/:id/restore', restoreBackorder);

router.route('/:id')
  .put(updateReservationQuantity)
  .delete(cancelReservation);

router.post('/confirm', confirmBooking);
// Books a set of lines outright, skipping the Selection List. Used by the bulk
// upload's "Continue to Booking".
router.post('/direct-booking', createDirectBooking);
router.post('/validate-bulk', validateBulk);

export default router;
