/**
 * Role-based access control.
 *
 * Permissions are derived from `user.role`. Admin holds the '*' wildcard and so
 * satisfies every check; other roles carry an explicit list.
 *
 * Adding a capability means adding it here — never inline in a controller — so
 * the authoritative answer to "who may do this" lives in one place.
 */

export const PERMISSIONS = {
  CREATE_ORDER: 'create_order',
  MANAGE_ORDERS: 'manage_orders',             // admin booking lifecycle (status changes)
  MANAGE_INVENTORY: 'manage_inventory',       // legacy umbrella; superseded by the granular set below
  MANAGE_USERS: 'manage_users',                // every account, any role
  MANAGE_CUSTOMER_USERS: 'manage_customer_users', // CUSTOMER accounts only
  MANAGE_ROLES: 'manage_roles',
  VIEW_REPORTS: 'view_reports',
  // Sales-desk capabilities
  VIEW_ALL_BOOKINGS: 'view_all_bookings',     // see other customers' bookings
  EDIT_BOOKING_PRE_PO: 'edit_booking_pre_po', // amend lines until the PO is raised
  RAISE_PO: 'raise_po',                       // generate the PO number (locks the booking)
  OVERRIDE_PO_LOCK: 'override_po_lock',       // edit a booking after the PO exists

  // ── Inventory Management System ─────────────────────────────────────────
  // The full set is declared here in one pass rather than being reopened for
  // each module, so the role matrix below is complete and reviewable now. Only
  // the four marked (M1) are enforced by any route today; the rest are carried
  // by the roles that will need them when their module ships.
  VIEW_INVENTORY: 'view_inventory',                     // (M1) list, detail, health, dashboard
  MANAGE_INVENTORY_MASTER: 'manage_inventory_master',   // (M1) edit planning parameters
  MANAGE_BOX_NUMBER: 'manage_box_number',               // (M1) add/change the SKU → box number mapping
  CONFIGURE_INVENTORY: 'configure_inventory',           // (M1) thresholds, reason codes, locations
  EXPORT_INVENTORY: 'export_inventory',                 // (M1) export lists and reports
  VIEW_STOCK_LEDGER: 'view_stock_ledger',               // (M2) movement history
  POST_STOCK_IN: 'post_stock_in',                       // (M7) receipts and opening stock
  POST_STOCK_OUT: 'post_stock_out',                     // (M7) manual issues
  ADJUST_STOCK: 'adjust_stock',                         // (M7) create adjustments
  APPROVE_ADJUSTMENT: 'approve_adjustment',             // (M7) approve above threshold
  PERFORM_COUNT: 'perform_count',                       // (M7) enter counts
  APPROVE_COUNT: 'approve_count',                       // (M7) approve variances and post
  TRANSFER_STOCK: 'transfer_stock',                     // (M7) inter-location transfers
  /**
   * (M1) Remove a SKU from the catalogue entirely.
   *
   * Its own permission, and Admin-only, for the same reason MANAGE_BOX_NUMBER
   * is: an Inventory Manager maintains what a SKU says, and deleting one is not
   * maintenance — it is the removal of a business key that orders, movements
   * and counts refer to by name. The service refuses outright to delete a SKU
   * anything has ever referenced, so this permission governs only the removal
   * of catalogue entries created in error.
   */
  DELETE_SKU: 'delete_sku',
};

/**
 * Role → permission map.
 *
 * Two separation-of-duties rules are enforced structurally here, not by policy:
 *
 *  • Sales holds RAISE_PO but not OVERRIDE_PO_LOCK — raising the PO locks the
 *    booking against the very role that raised it. Only Admin's '*' clears it.
 *  • Inventory Manager holds ADJUST_STOCK but NOT APPROVE_ADJUSTMENT, and
 *    Management holds the approval without the ability to create. Nobody can
 *    both make and approve their own stock correction.
 *
 * MANAGE_CUSTOMER_USERS is the third structural rule. Sales can create and
 * maintain CUSTOMER accounts and nothing else — not an Admin, not another
 * salesperson, not itself. Privilege escalation through user management is the
 * obvious attack on a role that can create logins, so the restriction is on the
 * TARGET's role and is checked in the controller for every read and write.
 *
 * CONFIGURE_INVENTORY is Admin-only: a threshold change silently reclassifies
 * thousands of SKUs, so it sits with the role that already owns global settings.
 *
 * MANAGE_BOX_NUMBER is Admin-only for the same reason, and is deliberately NOT
 * granted to Inventory Manager despite that role holding
 * MANAGE_INVENTORY_MASTER. The box number is the physical picking location for
 * a SKU: it is quoted on every PO and read off by the warehouse, so it must
 * stay stable and change only when the packing actually changes. Splitting it
 * out of the planning permission is what stops it drifting as an ordinary
 * master-data edit. Sales holds neither permission and so cannot reach it at
 * all.
 */
const ROLE_PERMISSIONS = {
  Admin: ['*'],
  Sales: [
    PERMISSIONS.VIEW_ALL_BOOKINGS,
    // Sales onboards its own customers. Deliberately NOT MANAGE_USERS: that
    // would also let a salesperson create an Admin or promote themselves.
    // The narrower permission is enforced on the target account's role in
    // user.controller.js — a permission alone cannot express "only Customers".
    PERMISSIONS.MANAGE_CUSTOMER_USERS,
    PERMISSIONS.EDIT_BOOKING_PRE_PO,
    PERMISSIONS.RAISE_PO,
    PERMISSIONS.VIEW_REPORTS,
    // Sales needs to know what can be sold — availability only, never the
    // ledger, costs or adjustments.
    PERMISSIONS.VIEW_INVENTORY,
  ],
  'Inventory Manager': [
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
  'Warehouse User': [
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.POST_STOCK_IN,
    PERMISSIONS.PERFORM_COUNT,
    PERMISSIONS.TRANSFER_STOCK,
  ],
  // Oversight: read everything, approve, create nothing.
  Management: [
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.APPROVE_ADJUSTMENT,
    PERMISSIONS.APPROVE_COUNT,
    PERMISSIONS.VIEW_REPORTS,
  ],
  /**
   * Import Team — maintains the catalogue, and touches nothing else.
   *
   * The narrowest of the internal roles by design. It exists for the people who
   * load and correct product data in bulk: the inventory master, the product
   * content, the import wizard behind both, and the reads that make them
   * usable. It holds NO ordering or booking permission at all, which is what
   * makes "hide sales and booking from this user" a fact about the role rather
   * than a decision the UI has to remember to take.
   *
   * What it deliberately does NOT have:
   *
   *  • CREATE_ORDER / VIEW_ALL_BOOKINGS / EDIT_BOOKING_PRE_PO / RAISE_PO —
   *    every booking write path is refused, and the sales desk is invisible.
   *  • MANAGE_BOX_NUMBER — Admin-only for everyone (see the note above); a box
   *    number is a physical picking location quoted on every PO, and the import
   *    is not the way around that. An import that CREATES a SKU may still set
   *    its first box, which is a rule about new SKUs, not about this role.
   *  • ADJUST_STOCK / PERFORM_COUNT / APPROVE_* — correcting a counted balance
   *    is warehouse and management work. This role loads data; it does not
   *    decide that the shelf disagrees with the system.
   *  • CONFIGURE_INVENTORY — thresholds and reason codes reclassify the whole
   *    catalogue, and stay with the role that owns global settings.
   *
   * POST_STOCK_IN is included because the Inventory Master sheet carries a
   * Quantity column: importing one posts a receipt through the ledger, and a
   * role that may run that import must hold the permission the movement needs.
   */
  'Import Team': [
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.MANAGE_INVENTORY_MASTER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.POST_STOCK_IN,
  ],

  Customer: [PERMISSIONS.CREATE_ORDER],
};

/**
 * Internal staff roles. They act on the business's own inventory rather than
 * their own orders, so they see every brand — the per-user brandAccess flags
 * exist to scope CUSTOMERS. Sales is deliberately excluded: its brand
 * visibility is already decided separately by the sales-desk rules.
 */
export const INVENTORY_ROLES = ['Inventory Manager', 'Warehouse User', 'Management', 'Import Team'];

/** Permission list for a user. Unknown/absent role → no permissions. */
export const permissionsFor = (user) => ROLE_PERMISSIONS[user?.role] || [];

/** True when the user holds the permission (or the Admin wildcard). */
export const hasPermission = (user, permission) => {
  const perms = permissionsFor(user);
  return perms.includes('*') || perms.includes(permission);
};

/**
 * Route guard. Passes when the user holds ANY of the listed permissions.
 *
 *   router.post('/:orderId/po', protect, authorize('raise_po'), handler)
 */
export const authorize = (...requiredPermissions) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({ success: false, message: 'Forbidden. No role assigned.' });
    }

    const ok = requiredPermissions.some((p) => hasPermission(req.user, p));
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. Insufficient permissions.',
      });
    }

    next();
  };
};

export default { authorize, hasPermission, permissionsFor, PERMISSIONS, INVENTORY_ROLES };
