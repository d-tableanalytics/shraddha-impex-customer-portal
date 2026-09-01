/**
 * Portal permissions for the UI.
 *
 * This governs what the UI *offers*. It is never the enforcement point: every
 * sales and inventory endpoint re-checks permissions and the PO lock
 * server-side, so hiding a button here is a convenience, not a control.
 *
 * ---------------------------------------------------------------------------
 * No longer a hand-maintained mirror
 * ---------------------------------------------------------------------------
 * `PERMISSIONS`, the role map and the evaluator used to be copied here from
 * `backend/middlewares/rbac.js`, with a comment asking whoever changed one to
 * remember the other. They now come from `@shared/permissions/legacy.js` - one
 * definition, imported by both halves - so the two cannot drift.
 *
 * The named predicates below stay here: they are UI affordances built on top of
 * the shared model, and several encode rules that are deliberately narrower
 * than any single permission.
 *
 * HRMS authorization is a different model entirely (module x action x scope).
 * It lives in `../hooks/usePermissions.js` over `@shared/permissions`.
 */

import {
  PERMISSIONS,
  INVENTORY_ROLES,
  permissionsFor,
  hasLegacyPermission,
} from '@shared/permissions/legacy.js';

export { PERMISSIONS, INVENTORY_ROLES, permissionsFor };

/** True when the user holds the permission (or the Admin wildcard). */
export const hasPermission = hasLegacyPermission;

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

/**
 * Who may amend the QUANTITIES on this booking right now.
 *
 * ADMIN AND SALES ONLY. Once a booking has been placed the customer cannot
 * change its quantities — they ask the desk, and the desk is emailed-of-record
 * for the adjustment.
 *
 * Identical to canEditBooking, and kept as its own name because the screens
 * that gate a quantity field read better asking that question, and because the
 * server enforces the quantity rule on a route of its own.
 */
export const canEditBookingQuantity = (user, booking) => canEditBooking(user, booking);

export const canRaisePo = (user, booking) =>
  Boolean(booking) && !booking.locked && hasPermission(user, PERMISSIONS.RAISE_PO);

/**
 * Whether to offer the IMS master screens. Customers hold no inventory
 * permission at any level, so they never see them. Sales can read availability
 * through the ordering flow and does not need the master list.
 */
export const canUseInventoryMaster = (user) =>
  isAdmin(user) || INVENTORY_ROLES.includes(user?.role);

/**
 * Whether to offer user management at all.
 *
 * Two permissions lead here: Admin manages every account, Sales manages
 * CUSTOMER accounts only. The screen is the same; what it shows and offers is
 * decided per account by canManageAccount() below.
 */
export const canOpenUserManagement = (user) =>
  hasPermission(user, PERMISSIONS.MANAGE_USERS)
  || hasPermission(user, PERMISSIONS.MANAGE_CUSTOMER_USERS);

/** Admin: every account, any role. */
export const canManageAllUsers = (user) => hasPermission(user, PERMISSIONS.MANAGE_USERS);

/**
 * Whether THIS actor may act on THIS account.
 *
 * Mirrors denyIfOutOfScope() in backend/modules/users/user.controller.js. The
 * server is the authority — it re-checks every read and write — and this exists
 * so a salesperson is not shown an Edit button that will 403.
 */
export const canManageAccount = (user, account) =>
  canManageAllUsers(user) || (account?.role || "Customer") === "Customer";

/** Roles this actor may assign when creating an account. */
export const assignableRolesFor = (user) =>
  (canManageAllUsers(user)
    ? ["Admin", "Sales", "Inventory Manager", "Warehouse User", "Management", "Customer"]
    : ["Customer"]);


export const canEditPlanning = (user) =>
  hasPermission(user, PERMISSIONS.MANAGE_INVENTORY_MASTER);

/**
 * Who may add or change the SKU → box number mapping. Admin only.
 *
 * Deliberately narrower than canEditPlanning: an Inventory Manager maintains
 * planning inputs but must not move a SKU's box, because the box number is
 * quoted on every PO and read off by the warehouse. Sales cannot reach the
 * inventory master at all and so never sees the field as editable.
 */
export const canEditBoxNo = (user) =>
  hasPermission(user, PERMISSIONS.MANAGE_BOX_NUMBER);

/**
 * Who sees the box number ON THE INVENTORY SCREENS — the master list, the
 * catalogue and their exports. Everyone who works the business's own stock:
 * Admin, Sales, and the inventory roles who pick and count against it.
 * Customers are excluded; it is an internal picking location.
 */
export const canViewBoxNo = (user) =>
  isAdmin(user) || isSales(user) || INVENTORY_ROLES.includes(user?.role);

/**
 * Who sees the box number ON A BOOKING'S LINE ITEMS — the sales desk, the order
 * drawer, the SKU picker that feeds them. SALES AND ADMIN ONLY, which is
 * narrower than canViewBoxNo above.
 *
 * The two rules are separate on purpose. A line item belongs to a customer's
 * booking, and the order drawer that renders it is the customer's own order
 * history screen — so the audience there is not "internal staff" but
 * specifically the desk that acts on the booking.
 */
export const canViewLineItemBoxNo = (user) => isAdmin(user) || isSales(user);

export const canConfigureInventory = (user) =>
  hasPermission(user, PERMISSIONS.CONFIGURE_INVENTORY);

// Posting a hand adjustment is the same act as posting a counted variance —
// correcting recorded stock to reality — so it reuses that permission rather
// than introducing a second one that would inevitably drift out of step.
export const canAdjustStock = (user) =>
  hasPermission(user, PERMISSIONS.ADJUST_STOCK);

export default {
  PERMISSIONS,
  INVENTORY_ROLES,
  hasPermission,
  permissionsFor,
  isAdmin,
  isSales,
  canUseSalesDesk,
  canEditBooking,
  canEditBookingQuantity,
  canRaisePo,
  canUseInventoryMaster,
  canOpenUserManagement,
  canManageAllUsers,
  canManageAccount,
  assignableRolesFor,
  canEditPlanning,
  canEditBoxNo,
  canViewBoxNo,
  canViewLineItemBoxNo,
  canConfigureInventory,
  canAdjustStock,
};
