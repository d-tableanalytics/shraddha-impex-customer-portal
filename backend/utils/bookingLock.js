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
 * Throws when the booking may not be modified by this user.
 * The thrown error carries `status` so the route can map it to 423 Locked.
 */
export const assertBookingEditable = (orders, user) => {
  if (!orders || orders.length === 0) {
    const err = new Error('Booking not found.');
    err.status = 404;
    throw err;
  }
  if (isBookingLocked(orders) && !canOverrideLock(user)) {
    const err = new Error('Booking is locked because the PO has already been generated.');
    err.status = 423; // 423 Locked — distinguishable from a plain 403
    throw err;
  }
};

/** Compact lock state for API responses and UI badges. */
export const lockState = (orders = []) => {
  const locked = isBookingLocked(orders);
  const withPo = orders.find(isPoGenerated);
  return {
    locked,
    status: locked ? 'PO Generated' : 'PO Pending',
    poNumber: locked ? (withPo?.poNumber ?? null) : null,
    poGeneratedAt: withPo?.poGeneratedAt ?? null,
    poGeneratedBy: withPo?.poGeneratedBy ?? null,
  };
};

export default {
  isPlaceholderPo,
  isPoGenerated,
  isBookingLocked,
  canOverrideLock,
  assertBookingEditable,
  lockState,
};
