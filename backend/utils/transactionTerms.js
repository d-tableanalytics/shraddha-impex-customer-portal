import { isPlaceholderPo } from './bookingLock.js';

/**
 * Booking or Purchase Order — what should we be calling this?
 *
 * A transaction starts life as a BOOKING. The moment a PO is raised against it
 * the customer stops thinking of it as a booking: they have a purchase order
 * number, that is the reference they quote, and mail that keeps saying "your
 * booking" reads as being about something else entirely.
 *
 * The wording was previously hard-coded in each template, so a booking that had
 * become a PO was still told its "booking" had been dispatched, and every mail
 * signed off as the "Booking Portal" regardless of stage. Deriving it here
 * means one rule decides the subject line, the body, the headline box and the
 * in-app notification together, and they cannot drift apart.
 *
 * The test is the PO NUMBER, not the lifecycle status. A booking is converted
 * the instant a PO exists — which is exactly what isPlaceholderPo() already
 * decides for the lock, so the two can never disagree about whether a PO has
 * been raised.
 */

/**
 * The portal's name in customer-facing copy.
 *
 * "Shraddha Impex Portal", never "Booking Portal": the same portal carries
 * bookings, purchase orders and indents, and naming it after one of them makes
 * the other two look like they belong somewhere else.
 */
export const PORTAL_NAME = 'Shraddha Impex Portal';

/** True once a real PO number has been raised against the transaction. */
export const isPurchaseOrder = (poNumber) => !isPlaceholderPo(poNumber);

/**
 * Every piece of stage-dependent wording, derived once.
 *
 * @param {object} tx
 * @param {string} tx.orderId   the booking id (BO-/SO-YYYY-######)
 * @param {string} [tx.poNumber] the PO number, or '-'/null before one is raised
 */
export const termsFor = ({ orderId, poNumber } = {}) => {
  const isPo = isPurchaseOrder(poNumber);

  return {
    isPo,

    // "Purchase Order" / "Booking" — for subjects and headings.
    noun: isPo ? 'Purchase Order' : 'Booking',
    // Mid-sentence: "an update on your purchase order".
    nounLower: isPo ? 'purchase order' : 'booking',

    // The reference the customer should quote. Once a PO exists that is the PO
    // number; the booking id becomes internal history.
    reference: isPo ? poNumber : orderId,
    // Label above that reference in the headline box.
    referenceLabel: isPo ? 'Purchase Order No.' : 'Booking ID',

    // The booking id, kept available for the one email that legitimately spans
    // both — the conversion itself, where the customer needs to see which
    // booking became which PO.
    orderId,
    poNumber: isPo ? poNumber : null,

    // Where to go and look. Both live on the same screen; only the wording of
    // the sentence changes.
    historyScreen: isPo ? 'Order History' : 'Booking History',
    portal: PORTAL_NAME,

    // "Purchase Order schedule" vs "Booking schedule" — the phrase the schedule
    // update mail has to get right.
    scheduleNoun: isPo ? 'Purchase Order schedule' : 'Booking schedule',
    progressHeading: isPo ? 'Purchase Order progress' : 'Booking progress',
  };
};

export default { PORTAL_NAME, isPurchaseOrder, termsFor };
