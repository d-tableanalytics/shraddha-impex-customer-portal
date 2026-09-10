/**
 * What the UI offers the signed-in user.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SERVER IS NOW THE SOURCE; THIS IS THE FALLBACK
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This file used to be a hand-maintained MIRROR of the backend's role map, with
 * a comment asking whoever touched one to remember the other. That works until
 * roles become editable at runtime, which is the entire point of the new model:
 * a Super Admin can now invent a role this file has never heard of, and a
 * mirror cannot mirror something that did not exist when it was written.
 *
 * So /auth/me returns the user's resolved permissions, and permissionsFor()
 * reads them. The map below is kept only as a FALLBACK, for the window between
 * the app booting and the profile arriving, and for an older server that does
 * not send the field yet. It is deliberately still accurate for the seven
 * built-in roles, so that window shows the right menu rather than an empty one.
 *
 * NEVER THE ENFORCEMENT POINT. Every sales and inventory endpoint re-checks
 * permissions and the PO lock server-side, so hiding a button here is a
 * convenience, not a control.
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
  // See the four tier prices and choose which one a customer is offered.
  // MIRRORS backend/config/permissions.js — the server refuses the pricing
  // routes without it, so this only decides what the screen offers.
  VIEW_PRICING: "view_pricing",

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
  // Admin-only. Its own permission because deleting a catalogue entry is
  // not master-data maintenance - see the note in rbac.js.
  DELETE_SKU: "delete_sku",

  // Customer Portal. These name access that used to be decided by the sidebar
  // with no permission behind it - see config/permissions.js on the server.
  VIEW_DASHBOARD: "view_dashboard",
  VIEW_ORDERS: "view_orders",
  VIEW_CATALOGUE: "view_catalogue",
  VIEW_PROFILE: "view_profile",
  EDIT_PROFILE: "edit_profile",
  VIEW_HELP: "view_help",

  // HRMS entry tiers. MIRRORS backend/config/permissions.js.
  //
  // These decide which HRMS ROLES an account holds, not what it may do once it
  // holds them - that lives with HRMS, in the Employee Portal,
  // which useHrmsPermissions reads from the actor the server resolved. So no
  // HRMS screen should ever ask about a key below; ask `can(module, action,
  // scope)` instead. They are here so the permission matrix and the role
  // fallback can name them.
  ACCESS_HRMS: "access_hrms",
  MANAGE_HRMS_TEAM: "manage_hrms_team",
  MANAGE_HRMS_PEOPLE: "manage_hrms_people",
  MANAGE_HRMS_PAYROLL: "manage_hrms_payroll",
  MANAGE_HRMS_HIRING: "manage_hrms_hiring",
  MANAGE_HRMS_ASSETS: "manage_hrms_assets",
  AUDIT_HRMS: "audit_hrms",
  ADMINISTER_HRMS: "administer_hrms",
};

/** Open to any signed-in account. Mirrors PORTAL_BASICS on the server. */
const PORTAL_BASICS = [
  PERMISSIONS.VIEW_DASHBOARD,
  PERMISSIONS.VIEW_CATALOGUE,
  PERMISSIONS.VIEW_PROFILE,
  PERMISSIONS.EDIT_PROFILE,
  PERMISSIONS.VIEW_HELP,
];

/**
 * Fallback only. See the note at the top of the file: this answers for the
 * built-in roles while the profile is in flight, and the server answers for
 * everyone once it arrives.
 */
const FALLBACK_ROLE_PERMISSIONS = {
  "Super Admin": ["*"],
  Admin: ["*"],
  /**
   * HR - the whole of HRMS, and the ordinary portal screens.
   *
   * ADMINISTER_HRMS is the only non-basic key: the HRMS nav and every HRMS
   * screen are driven by the HRMS actor, not by this list, so mirroring the
   * eight tiers here would add nothing the sidebar can use. Mirrors
   * backend/config/permissions.js, where the reasoning is written out.
   */
  HR: [...PORTAL_BASICS, PERMISSIONS.ADMINISTER_HRMS],
  Sales: [
    ...PORTAL_BASICS,
    PERMISSIONS.VIEW_ORDERS,
    PERMISSIONS.VIEW_ALL_BOOKINGS,
    PERMISSIONS.MANAGE_CUSTOMER_USERS,
    PERMISSIONS.EDIT_BOOKING_PRE_PO,
    PERMISSIONS.RAISE_PO,
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.VIEW_INVENTORY,
  ],
  "Inventory Manager": [
    ...PORTAL_BASICS,
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
    ...PORTAL_BASICS,
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.POST_STOCK_IN,
    PERMISSIONS.PERFORM_COUNT,
    PERMISSIONS.TRANSFER_STOCK,
  ],
  Management: [
    ...PORTAL_BASICS,
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
   * refused after a click. Mirrors backend/config/permissions.js, where the
   * reasoning for each inclusion and omission is written out.
   */
  "Import Team": [
    ...PORTAL_BASICS,
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.MANAGE_INVENTORY_MASTER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.POST_STOCK_IN,
  ],

  Customer: [...PORTAL_BASICS, PERMISSIONS.CREATE_ORDER, PERMISSIONS.VIEW_ORDERS],
};

/** Roles that work the business's own stock rather than their own orders. */
export const INVENTORY_ROLES = ["Inventory Manager", "Warehouse User", "Management", "Import Team"];

/** The roles the code itself knows by name. Anything else is a custom role. */
export const SYSTEM_ROLE_NAMES = Object.keys(FALLBACK_ROLE_PERMISSIONS);

/** A role a Super Admin invented, which this bundle knows nothing about. */
export const isCustomRole = (user) =>
  Boolean(user?.role) && !SYSTEM_ROLE_NAMES.includes(user.role);

/**
 * The user's permissions.
 *
 * Prefers what the SERVER resolved. That is the only answer that accounts for
 * database roles, per-user grants and roles invented after this bundle was
 * built - and it is the same computation the API will run when the request
 * actually arrives, so the button and the endpoint agree by construction.
 */
export const permissionsFor = (user) => {
  if (Array.isArray(user?.permissions)) return user.permissions;
  return FALLBACK_ROLE_PERMISSIONS[user?.role] || [];
};

export const hasPermission = (user, permission) => {
  const perms = permissionsFor(user);
  return perms.includes("*") || perms.includes(permission);
};

/**
 * Matrix-shaped question: may this user take `action` on this sub-module?
 *
 * Answered from the `grants` the server sends alongside the permission list, so
 * a screen can ask about a cell without shipping its own copy of the module
 * registry. Returns false when grants have not arrived - the safe direction for
 * a check that decides whether to render a Delete button.
 */
export const canAction = (user, moduleKey, submoduleKey, action) => {
  if (hasPermission(user, "*")) return true;
  const grants = user?.grants;
  if (!Array.isArray(grants)) return false;
  return grants.some(
    (g) => g.module === moduleKey && g.submodule === submoduleKey && g.actions?.includes(action),
  );
};

/** Full access to the entire ERP. */
export const isSuperAdmin = (user) =>
  user?.role === "Super Admin" || user?.role === "Admin" || hasPermission(user, "*");

/**
 * Kept as the name 20-odd screens already import. 'Super Admin' is the same
 * authority under the name the client asked for, so it answers true here too -
 * otherwise every existing isAdmin() check would quietly exclude the very role
 * that is supposed to be able to do everything.
 */
export const isAdmin = (user) => user?.role === "Admin" || user?.role === "Super Admin";
export const isSales = (user) => user?.role === "Sales";
/** Anyone who works the sales desk - Sales, plus Super Admin via the wildcard. */
export const canUseSalesDesk = (user) => hasPermission(user, PERMISSIONS.VIEW_ALL_BOOKINGS);

/**
 * Whether this user works ORDERS at all - bookings, the selection list, bulk
 * upload, booking and indent history.
 *
 * True for customers (who order for themselves), for Sales and Super Admin (who
 * order on a customer's behalf), and false for every internal stock role, which
 * holds no ordering permission and never has.
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
  || hasPermission(user, PERMISSIONS.VIEW_ALL_BOOKINGS)
  || hasPermission(user, PERMISSIONS.VIEW_ORDERS);

/**
 * Where a role's portal starts.
 *
 * The main dashboard is a BOOKING dashboard - bookings in process, the
 * conversion funnel, demand against fulfilment, recent bookings. Import Team
 * holds no ordering permission, so those panels are hidden for them and what
 * remains is a single stock tile. Landing them there means every session opens
 * on an empty page and one more click.
 *
 * So their home is the INVENTORY dashboard, which is the screen their work
 * actually starts from. Stated once, as a path, because three places need the
 * same answer - the router, the sidebar's first menu item, and where a guard
 * sends someone it turns away - and three copies would drift.
 *
 * Deliberately keyed by ROLE rather than derived from permissions. "Which
 * screen should this person open on" is a judgement about their job, not a
 * consequence of what they may click; the other internal roles keep the main
 * dashboard because that is what they are used to, and moving them is a
 * decision for whoever owns those roles, not a side effect of this map.
 *
 * A CUSTOM role gets a computed home instead: the first destination its menu
 * offers. A role invented after this file was written cannot appear in a map
 * written before it existed, and landing such a user on a dashboard they hold
 * no permission for would bounce them straight back out.
 */
export const HOME_PATH_BY_ROLE = {
  "Import Team": "/inventory/dashboard",
};

export const homePathFor = (user) => {
  const mapped = HOME_PATH_BY_ROLE[user?.role];
  if (mapped) return mapped;

  // Built-in roles all start at the main dashboard, as they always have.
  if (!isCustomRole(user)) return "/";

  // A custom role starts wherever it can actually go.
  if (hasPermission(user, PERMISSIONS.VIEW_DASHBOARD)) return "/";
  const firstItem = user?.menu?.[0]?.items?.[0]?.path;
  return firstItem || "/settings";
};

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
 * change its quantities - they ask the desk, and the desk is emailed-of-record
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
 * Who may see what we charge, and pick the rate a customer is quoted.
 *
 * Admin and Sales by baseline; anyone else only if a Super Admin ticks
 * Sales Desk > Customer Pricing in the permission matrix. The four tier prices
 * appear on exactly one screen (the PO dialog) and in exactly one response
 * (GET /sales/bookings/:id/pricing), and both are behind this.
 *
 * NOT the same question as "may this customer see their own price". That is
 * decided on the server, which strips the rate from anyone who is not the owner
 * of a booking whose PO has been raised - see utils/pricingVisibility.js.
 */
export const canViewPricing = (user) => hasPermission(user, PERMISSIONS.VIEW_PRICING);

/**
 * Whether to offer the IMS master screens. Customers hold no inventory
 * permission at any level, so they never see them. Sales can read availability
 * through the ordering flow and does not need the master list.
 *
 * Kept as a ROLE question for the seven built-in roles, because that is exactly
 * what it has always been and re-deriving it from permissions would change who
 * sees these screens - Sales holds VIEW_INVENTORY for availability, and would
 * be pulled in by any permission-shaped version of this rule.
 *
 * A CUSTOM role is asked the matrix instead. There is no list to consult for a
 * role invented last week, and its Super Admin has already answered the
 * question by ticking (or not ticking) Inventory Master.
 */
export const canUseInventoryMaster = (user) =>
  isAdmin(user)
  || INVENTORY_ROLES.includes(user?.role)
  || (isCustomRole(user) && canAction(user, "inventory", "master", "view"));

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

/** Whether to offer the role and permission screens. */
export const canManageRoles = (user) => hasPermission(user, PERMISSIONS.MANAGE_ROLES);

/** Admin: every account, any role. */
export const canManageAllUsers = (user) => hasPermission(user, PERMISSIONS.MANAGE_USERS);

/**
 * Whether THIS actor may act on THIS account.
 *
 * Mirrors denyIfOutOfScope() in backend/modules/users/user.controller.js. The
 * server is the authority - it re-checks every read and write - and this exists
 * so a salesperson is not shown an Edit button that will 403.
 */
export const canManageAccount = (user, account) =>
  canManageAllUsers(user) || (account?.role || "Customer") === "Customer";

/**
 * Roles this actor may assign when creating an account.
 *
 * The built-in list is the User schema enum. `extraRoles` carries the custom
 * roles the Super Admin has created since - passed in by the caller, which has
 * them from the roles API, rather than fetched here, so this stays a pure
 * function the way its 20-odd callers expect.
 */
export const assignableRolesFor = (user, extraRoles = []) => {
  if (!canManageAllUsers(user)) return ["Customer"];
  return [
    "Super Admin",
    "Admin",
    "Sales",
    "Inventory Manager",
    "Warehouse User",
    "Management",
    "Import Team",
    "Customer",
    ...extraRoles.filter((r) => !SYSTEM_ROLE_NAMES.includes(r)),
  ];
};

export const canEditPlanning = (user) =>
  hasPermission(user, PERMISSIONS.MANAGE_INVENTORY_MASTER);

/**
 * Who may add or change the SKU -> box number mapping. Admin only.
 *
 * Deliberately narrower than canEditPlanning: an Inventory Manager maintains
 * planning inputs but must not move a SKU's box, because the box number is
 * quoted on every PO and read off by the warehouse. Sales cannot reach the
 * inventory master at all and so never sees the field as editable.
 */
export const canEditBoxNo = (user) =>
  hasPermission(user, PERMISSIONS.MANAGE_BOX_NUMBER);

/**
 * Who sees the box number ON THE INVENTORY SCREENS - the master list, the
 * catalogue and their exports. Everyone who works the business's own stock:
 * Admin, Sales, and the inventory roles who pick and count against it.
 * Customers are excluded; it is an internal picking location.
 */
export const canViewBoxNo = (user) =>
  isAdmin(user)
  || isSales(user)
  || INVENTORY_ROLES.includes(user?.role)
  || (isCustomRole(user) && canAction(user, "inventory", "master", "view"));

/**
 * Who sees the box number ON A BOOKING'S LINE ITEMS - the sales desk, the order
 * drawer, the SKU picker that feeds them. SALES AND ADMIN ONLY, which is
 * narrower than canViewBoxNo above.
 *
 * The two rules are separate on purpose. A line item belongs to a customer's
 * booking, and the order drawer that renders it is the customer's own order
 * history screen - so the audience there is not "internal staff" but
 * specifically the desk that acts on the booking. Widening this to match the
 * inventory rule would put a picking location in front of the customer who
 * placed the order.
 */
export const canViewLineItemBoxNo = (user) =>
  isAdmin(user) || isSales(user) || (isCustomRole(user) && canUseSalesDesk(user));

export const canConfigureInventory = (user) =>
  hasPermission(user, PERMISSIONS.CONFIGURE_INVENTORY);

// Posting a hand adjustment is the same act as posting a counted variance -
// correcting recorded stock to reality - so it reuses that permission rather
// than introducing a second one that would inevitably drift out of step.
export const canAdjustStock = (user) =>
  hasPermission(user, PERMISSIONS.ADJUST_STOCK);

export default {
  PERMISSIONS,
  INVENTORY_ROLES,
  SYSTEM_ROLE_NAMES,
  isCustomRole,
  hasPermission,
  permissionsFor,
  canAction,
  isAdmin,
  isSuperAdmin,
  isSales,
  canUseSalesDesk,
  canUseOrdering,
  homePathFor,
  canEditBooking,
  canEditBookingQuantity,
  canRaisePo,
  canViewPricing,
  canUseInventoryMaster,
  canOpenUserManagement,
  canManageRoles,
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
