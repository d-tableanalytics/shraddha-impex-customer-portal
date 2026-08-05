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
router.post('/validate-bulk', validateBulk);

export default router;
