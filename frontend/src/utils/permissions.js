/**
 * Frontend mirror of backend/middlewares/rbac.js — keep the two in step.
 *
 * This governs what the UI *offers*. It is never the enforcement point: every
 * sales endpoint re-checks permissions and the PO lock server-side, so hiding a
 * button here is a convenience, not a control.
 */

export const PERMISSIONS = {
  CREATE_ORDER: "create_order",
  MANAGE_ORDERS: "manage_orders",
  MANAGE_INVENTORY: "manage_inventory",
  MANAGE_USERS: "manage_users",
  MANAGE_ROLES: "manage_roles",
  VIEW_REPORTS: "view_reports",
  VIEW_ALL_BOOKINGS: "view_all_bookings",
  EDIT_BOOKING_PRE_PO: "edit_booking_pre_po",
  RAISE_PO: "raise_po",
  OVERRIDE_PO_LOCK: "override_po_lock",
};

const ROLE_PERMISSIONS = {
  Admin: ["*"],
  Sales: [
    PERMISSIONS.VIEW_ALL_BOOKINGS,
    PERMISSIONS.EDIT_BOOKING_PRE_PO,
    PERMISSIONS.RAISE_PO,
    PERMISSIONS.VIEW_REPORTS,
  ],
  Customer: [PERMISSIONS.CREATE_ORDER],
};

export const permissionsFor = (user) => ROLE_PERMISSIONS[user?.role] || [];

export const hasPermission = (user, permission) => {
  const perms = permissionsFor(user);
  return perms.includes("*") || perms.includes(permission);
};

export const isAdmin = (user) => user?.role === "Admin";
export const isSales = (user) => user?.role === "Sales";
/** Anyone who works the sales desk — Sales, plus Admin via the wildcard. */
export const canUseSalesDesk = (user) => hasPermission(user, PERMISSIONS.VIEW_ALL_BOOKINGS);

/**
 * Whether THIS booking may be edited by THIS user right now.
 * Mirrors assertBookingEditable() on the server.
 */
export const canEditBooking = (user, booking) => {
  if (!booking) return false;
  if (booking.locked) return hasPermission(user, PERMISSIONS.OVERRIDE_PO_LOCK);
  return hasPermission(user, PERMISSIONS.EDIT_BOOKING_PRE_PO);
};

export const canRaisePo = (user, booking) =>
  Boolean(booking) && !booking.locked && hasPermission(user, PERMISSIONS.RAISE_PO);

export default { PERMISSIONS, hasPermission, permissionsFor, isAdmin, isSales, canUseSalesDesk, canEditBooking, canRaisePo };
