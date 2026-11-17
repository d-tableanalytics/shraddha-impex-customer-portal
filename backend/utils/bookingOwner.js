import Reservation from '../models/Reservation.js';
import BookingStatusEvent from '../models/BookingStatusEvent.js';

/**
 * The records OUTSIDE the Order rows that say whose booking it is.
 *
 * A booking's `user` is on every Order row, but two other collections carry
 * the same fact and must move with it when a booking changes customer, or the
 * new customer would see the booking without its open indent and timeline,
 * and the old one would keep both:
 *
 *   - Reservation   the booking's indent lines (`PI-<number>`) and any indent
 *                   line that has since auto-booked into it. `reservedBy` is
 *                   left alone: it records who staged the line, which is what
 *                   carries the SI Team onto a later auto-booking.
 *   - BookingStatusEvent  the status timeline the customer's Booking History
 *                   reads.
 *
 * Shared by the Edit Details customer change (modules/sales/bookingEdit.service)
 * and the one-off reassignment script (scripts/reassign-booking-customer.js),
 * so the two cannot move different sets of records.
 */

/** The booking's indent lines owned by `ownerId`. */
export const indentFilterFor = (orderId, ownerId) => ({
  customerId: ownerId,
  $or: [
    { indentNumber: `PI-${String(orderId).replace(/^[A-Z]+-/, '')}` },
    { autoBookedOrderId: orderId },
  ],
});

/** How many indent lines and status events a move would touch. */
export const countOwnedRecords = async (orderId, ownerId) => ({
  indents: await Reservation.countDocuments(indentFilterFor(orderId, ownerId)),
  statusEvents: await BookingStatusEvent.countDocuments({ orderId, user: ownerId }),
});

/** Move them from one account to another. `session` is optional. */
export const moveOwnedRecords = async ({ orderId, fromUserId, toUserId, session = null }) => {
  const opts = session ? { session } : {};
  const indents = await Reservation.updateMany(
    indentFilterFor(orderId, fromUserId), { $set: { customerId: toUserId } }, opts,
  );
  const events = await BookingStatusEvent.updateMany(
    { orderId, user: fromUserId }, { $set: { user: toUserId } }, opts,
  );
  return { indents: indents.modifiedCount, statusEvents: events.modifiedCount };
};

export default { indentFilterFor, countOwnedRecords, moveOwnedRecords };
