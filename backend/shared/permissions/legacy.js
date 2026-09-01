/**
 * The existing customer-portal permission model.
 *
 * Moved here verbatim from `backend/middlewares/rbac.js` so that the backend and
 * the frontend read ONE copy instead of two hand-maintained mirrors. Behaviour is
 * unchanged: `backend/middlewares/rbac.js` and `frontend/src/utils/permissions.js`
 * both re-export from this file under their original names, so all 22 backend and
 * 18 frontend consumers keep working untouched.
 *
 * ---------------------------------------------------------------------------
 * This model is SEPARATE from the HRMS model, on purpose
 * ---------------------------------------------------------------------------
 * Legacy: a flat capability string, answered by `hasLegacyPermission(user, perm)`.
 * HRMS:   a module x action x scope tuple, answered by `hasHrmsPermission(actor, ...)`.
 *
 * They are different shapes with different semantics, so they stay separate
 * rather than being forced into one function (AD-3). The names differ too - the
 * evaluator here is `hasLegacyPermission`, not `hasPermission` - so the two can
 * never be confused at a call site. `middlewares/rbac.js` still exports it as
 * `hasPermission` for backward compatibility with existing callers.
 *
 * A legacy role grants NO HRMS permission. See `matrix.js` for why the portal's
 * `Admin: ['*']` wildcard deliberately does not reach HRMS.
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
 * stay stable and change only when the packing actually changes.
 */
export const LEGACY_ROLE_PERMISSIONS = {
  Admin: ['*'],
  Sales: [
    PERMISSIONS.VIEW_ALL_BOOKINGS,
    // Sales onboards its own customers. Deliberately NOT MANAGE_USERS: that
    // would also let a salesperson create an Admin or promote themselves.
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
  Customer: [PERMISSIONS.CREATE_ORDER],
};

/**
 * Internal staff roles. They act on the business's own inventory rather than
 * their own orders, so they see every brand — the per-user brandAccess flags
 * exist to scope CUSTOMERS. Sales is deliberately excluded: its brand
 * visibility is already decided separately by the sales-desk rules.
 */
export const INVENTORY_ROLES = ['Inventory Manager', 'Warehouse User', 'Management'];

/** Every portal role name. Used to tell portal keys from HRMS keys. */
export const LEGACY_ROLE_LIST = Object.keys(LEGACY_ROLE_PERMISSIONS);

/** Permission list for a user. Unknown/absent role → no permissions. */
export const permissionsFor = (user) => LEGACY_ROLE_PERMISSIONS[user?.role] || [];

/** True when the user holds the permission (or the Admin wildcard). */
export const hasLegacyPermission = (user, permission) => {
  const perms = permissionsFor(user);
  return perms.includes('*') || perms.includes(permission);
};
