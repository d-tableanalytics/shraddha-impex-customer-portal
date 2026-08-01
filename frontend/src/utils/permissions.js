/**
 * Frontend mirror of backend/middlewares/rbac.js — keep the two in step.
 *
 * This governs what the UI *offers*. It is never the enforcement point: every
 * sales and inventory endpoint re-checks permissions and the PO lock
 * server-side, so hiding a button here is a convenience, not a control.
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

  // Inventory Management System. The full set is mirrored so the map does not
  // need reopening for each module; only the M1 four are used by any screen yet.
  VIEW_INVENTORY: "view_inventory",
  MANAGE_INVENTORY_MASTER: "manage_inventory_master",
  CONFIGURE_INVENTORY: "configure_inventory",
  EXPORT_INVENTORY: "export_inventory",
  VIEW_STOCK_LEDGER: "view_stock_ledger",
  POST_STOCK_IN: "post_stock_in",
  POST_STOCK_OUT: "post_stock_out",
  ADJUST_STOCK: "adjust_stock",
  APPROVE_ADJUSTMENT: "approve_adjustment",
  PERFORM_COUNT: "perform_count",
  APPROVE_COUNT: "approve_count",
  TRANSFER_STOCK: "transfer_stock",
};

const ROLE_PERMISSIONS = {
  Admin: ["*"],
  Sales: [
    PERMISSIONS.VIEW_ALL_BOOKINGS,
    PERMISSIONS.EDIT_BOOKING_PRE_PO,
    PERMISSIONS.RAISE_PO,
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.VIEW_INVENTORY,
  ],
  "Inventory Manager": [
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.MANAGE_INVENTORY_MASTER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.POST_STOCK_IN,
    PERMISSIONS.POST_STOCK_OUT,
    PERMISSIONS.ADJUST_STOCK,
    PERMISSIONS.PERFORM_COUNT,
    PERMISSIONS.APPROVE_COUNT,
    PERMISSIONS.TRANSFER_STOCK,
    PERMISSIONS.VIEW_REPORTS,
  ],
  "Warehouse User": [
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.POST_STOCK_IN,
    PERMISSIONS.PERFORM_COUNT,
    PERMISSIONS.TRANSFER_STOCK,
  ],
  Management: [
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.APPROVE_ADJUSTMENT,
    PERMISSIONS.APPROVE_COUNT,
    PERMISSIONS.VIEW_REPORTS,
  ],
  Customer: [PERMISSIONS.CREATE_ORDER],
};

/** Roles that work the business's own stock rather than their own orders. */
export const INVENTORY_ROLES = ["Inventory Manager", "Warehouse User", "Management"];

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

/**
 * Whether to offer the IMS master screens. Customers hold no inventory
 * permission at any level, so they never see them. Sales can read availability
 * through the ordering flow and does not need the master list.
 */
export const canUseInventoryMaster = (user) =>
  isAdmin(user) || INVENTORY_ROLES.includes(user?.role);

export const canEditPlanning = (user) =>
  hasPermission(user, PERMISSIONS.MANAGE_INVENTORY_MASTER);

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
  canRaisePo,
  canUseInventoryMaster,
  canEditPlanning,
  canConfigureInventory,
  canAdjustStock,
};
