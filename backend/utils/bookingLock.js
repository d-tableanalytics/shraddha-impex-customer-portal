import { PERMISSIONS, hasPermission } from '../middlewares/rbac.js';

/**
 * Booking lock rules.
 *
 * A booking is a set of Order rows sharing one `orderId`. Once its PO is raised
 * the booking is locked: quantities, SKUs and line composition are frozen.
 *
 * Two ways a booking reads as "PO generated":
 *   1. `poGeneratedAt` is set — written by raisePo() from now on.
 *   2. `poNumber` holds a real value — the pre-existing convention. Bookings are
 *      created with poNumber '-' (see runConfirmBooking), and the admin drawer
 *      has always shown "Raise PO" until that changes. Rows created before
 *      poGeneratedAt existed are still correctly detected by this branch.
 */

/**
 * How long a confirmed booking may sit without a PO before it is auto-cancelled
 * and its reserved stock returned. Lives here so the settlement job, the API and
 * the UI countdown all read one number.
 */
export const PO_DEADLINE_DAYS = 7;

/** When the PO must be raised by, given the booking date. */
export const poDueAt = (bookingDate) => {
  if (!bookingDate) return null;
  const t = new Date(bookingDate).getTime();
  return Number.isNaN(t) ? null : new Date(t + PO_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
};

/** A poNumber that means "not raised yet": null, blank, or the '-' placeholder. */
export const isPlaceholderPo = (po) => {
  const v = String(po ?? '').trim();
  return v === '' || v === '-';
};

/** True when this Order row's PO has been generated. */
export const isPoGenerated = (order) =>
  Boolean(order?.poGeneratedAt) || !isPlaceholderPo(order?.poNumber);

/**
 * True when ANY row of the booking shows a generated PO. Checking every row
 * matters: a partial write must still read as locked rather than half-editable.
 */
export const isBookingLocked = (orders = []) => orders.some(isPoGenerated);

/** Admin-only. Sales deliberately cannot clear the lock it created. */
export const canOverrideLock = (user) =>
  hasPermission(user, PERMISSIONS.OVERRIDE_PO_LOCK);

/**
 * Who may amend the ITEMS of a booking whose PO is already out.
 *
 * Two keys, two different authorities:
 *   OVERRIDE_PO_LOCK       Admin. Reopens the whole booking — details, PO
 *                          number, customer, and the items with them.
 *   AMEND_BOOKING_POST_PO  Sales. Reopens the ITEMS only. Raising a second PO,
 *                          rewriting the submitted details and rearranging the
 *                          lines all keep asking canOverrideLock() and so stay
 *                          shut to it.
 *
 * Deliberately NOT folded into canOverrideLock(): every existing caller of that
 * function means the wider thing, and widening it in place is exactly how the
 * separation of duties recorded in config/permissions.js would be lost by
 * accident rather than by decision.
 */
export const canAmendLockedItems = (user) =>
  canOverrideLock(user) || hasPermission(user, PERMISSIONS.AMEND_BOOKING_POST_PO);

/**
 * ── WHICH STATUSES PERMIT AN AMENDMENT ──────────────────────────────────────
 *
 * The PO lock answers "has this booking been committed". It does not answer
 * "have the goods gone", and until now nothing did: a booking that had been
 * dispatched, delivered or cancelled was as editable as one raised an hour ago,
 * for anyone holding the override. Adding a line to a delivered booking would
 * have taken stock out of inventory for goods that are never going to be picked.
 *
 * So amendment stops at the warehouse door. A booking may be amended while it
 * is still being prepared — the lifecycle's first two stages — and not after:
 *
 *   PO Received / Booked   yes, being prepared ('Booked' is the legacy spelling)
 *   Ready for Dispatch     yes, picked but still here
 *   Dispatched             no, the goods have left
 *   Delivered              no, the order is complete
 *   Cancelled              no, the stock has already gone back
 *
 * This bound applies to EVERY caller including the wildcard. It is not a
 * permission that someone senior can be given more of; it is a statement about
 * where the goods are. A delivered order that genuinely needs changing is a
 * return or a credit note, which is a workflow of its own and not this one.
 */
export const AMENDABLE_STATUSES = ['PO Received', 'Booked', 'Ready for Dispatch'];

/** 'Cancelled' lines have already had their stock settled back. */
const isCancelled = (order) => order?.status === 'Cancelled';

/**
 * Why this booking may not be amended, or null when it may be.
 *
 * Read from the LIVE lines — a booking with one cancelled line and three open
 * ones is still an open booking. Every line cancelled means the booking is.
 */
export const amendmentBlockedBecause = (orders = []) => {
  const live = orders.filter((o) => !isCancelled(o));
  if (live.length === 0) {
    return 'This booking has been cancelled, so its items can no longer be changed.';
  }
  const stopped = live.find((o) => !AMENDABLE_STATUSES.includes(o.status));
  if (stopped) {
    return `This booking is ${String(stopped.status).toLowerCase()}, so its items can no longer be changed. `
      + 'Amendments are only possible while the booking is still being prepared.';
  }
  return null;
};

/**
 * Throws when the booking may not be modified by this user.
 * The thrown error carries `status` so the route can map it to 423 Locked.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.itemsOnly]  The caller is amending the booking's ITEMS
 *        (quantities, lines), which AMEND_BOOKING_POST_PO also unlocks. Left
 *        false — the default, and what every pre-existing caller gets — only
 *        OVERRIDE_PO_LOCK clears the lock, exactly as before.
 * @param {boolean} [opts.checkStatus]  Also apply the status bound above.
 *        Default false so that no existing caller changes behaviour; the item
 *        amendment path passes true.
 */
export const assertBookingEditable = (orders, user, { itemsOnly = false, checkStatus = false } = {}) => {
  if (!orders || orders.length === 0) {
    const err = new Error('Booking not found.');
    err.status = 404;
    throw err;
  }
  const mayUnlock = itemsOnly ? canAmendLockedItems(user) : canOverrideLock(user);
  if (isBookingLocked(orders) && !mayUnlock) {
    const err = new Error('Booking is locked because the PO has already been generated.');
    err.status = 423; // 423 Locked — distinguishable from a plain 403
    throw err;
  }
  if (checkStatus) {
    const blocked = amendmentBlockedBecause(orders);
    if (blocked) {
      // 409, not 423: the booking is not locked against this person, it has
      // moved past the point where the change makes sense for anybody.
      const err = new Error(blocked);
      err.status = 409;
      throw err;
    }
  }
};

/** Compact lock state for API responses and UI badges. */
export const lockState = (orders = []) => {
  const locked = isBookingLocked(orders);
  const withPo = orders.find(isPoGenerated);
  /**
   * Whether the booking has moved past the point where its items may change,
   * and why. Sent to the client so the drawer can explain a disabled Add
   * Product button instead of just greying it out — the server still decides,
   * on every request (see assertBookingEditable).
   */
  const blocked = amendmentBlockedBecause(orders);
  return {
    locked,
    status: locked ? 'PO Generated' : 'PO Pending',
    poNumber: locked ? (withPo?.poNumber ?? null) : null,
    poGeneratedAt: withPo?.poGeneratedAt ?? null,
    poGeneratedBy: withPo?.poGeneratedBy ?? null,
    amendable: blocked === null,
    amendBlockedReason: blocked,
  };
};

export default {
  PO_DEADLINE_DAYS,
  poDueAt,
  isPlaceholderPo,
  isPoGenerated,
  isBookingLocked,
  canOverrideLock,
  canAmendLockedItems,
  AMENDABLE_STATUSES,
  amendmentBlockedBecause,
  assertBookingEditable,
  lockState,
};
