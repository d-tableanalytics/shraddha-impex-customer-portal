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
  MANAGE_CUSTOMER_USERS: "manage_customer_users",
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
  MANAGE_BOX_NUMBER: "manage_box_number",
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
    PERMISSIONS.MANAGE_CUSTOMER_USERS,
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
  /**
   * Import Team - maintains the catalogue and touches nothing else.
   *
   * Holds no ordering or booking permission at all, which is what makes the
   * sales and booking menus disappear for this role rather than merely being
   * refused after a click. Mirrors backend/middlewares/rbac.js, where the
   * reasoning for each inclusion and omission is written out.
   */
  "Import Team": [
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.MANAGE_INVENTORY_MASTER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.POST_STOCK_IN,
  ],

  Customer: [PERMISSIONS.CREATE_ORDER],
};

/** Roles that work the business's own stock rather than their own orders. */
export const INVENTORY_ROLES = ["Inventory Manager", "Warehouse User", "Management", "Import Team"];

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
 * Whether this user works ORDERS at all — bookings, the selection list, bulk
 * upload, booking and indent history.
 *
 * True for customers (who order for themselves), for Sales and Admin (who order
 * on a customer's behalf), and false for every internal stock role, which holds
 * no ordering permission and never has.
 *
 * The sidebar has always used this idea to decide which menu items to build;
 * naming it means the ROUTES can use the same answer, so an ordering screen a
 * user cannot see is also an ordering screen they cannot reach by typing its
 * URL. That is the difference between hidden and blocked, and the requirement
 * asks for both.
 *
 * Not the enforcement point: every booking write path re-checks server-side.
 */
export const canUseOrdering = (user) =>
  hasPermission(user, PERMISSIONS.CREATE_ORDER)
  || hasPermission(user, PERMISSIONS.VIEW_ALL_BOOKINGS);

/**
 * Where a role's portal starts.
 *
 * The main dashboard is a BOOKING dashboard — bookings in process, the
 * conversion funnel, demand against fulfilment, recent bookings. Import Team
 * holds no ordering permission, so those panels are hidden for them and what
 * remains is a single stock tile. Landing them there means every session opens
 * on an empty page and one more click.
 *
 * So their home is the INVENTORY dashboard, which is the screen their work
 * actually starts from. Stated once, as a path, because three places need the
 * same answer — the router, the sidebar's first menu item, and where a guard
 * sends someone it turns away — and three copies would drift.
 *
 * Deliberately keyed by ROLE rather than derived from permissions. "Which
 * screen should this person open on" is a judgement about their job, not a
 * consequence of what they may click; the other internal roles keep the main
 * dashboard because that is what they are used to, and moving them is a
 * decision for whoever owns those roles, not a side effect of this map.
 */
export const HOME_PATH_BY_ROLE = {
  "Import Team": "/inventory/dashboard",
};

export const homePathFor = (user) => HOME_PATH_BY_ROLE[user?.role] || "/";

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
 * for the adjustment. This briefly allowed the customer to revise their own
 * booking; that is no longer the rule.
 *
 * Identical to canEditBooking, and kept as its own name because the screens
 * that gate a quantity field read better asking that question, and because the
 * server enforces the quantity rule on a route of its own.
 *
 * Once the PO is raised the quantities are committed and only an Admin may
 * move them, which is what canEditBooking already encodes.
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
    ? ["Admin", "Sales", "Inventory Manager", "Warehouse User", "Management", "Import Team", "Customer"]
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
 * specifically the desk that acts on the booking. Widening this to match the
 * inventory rule would put a picking location in front of the customer who
 * placed the order.
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
