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
  MANAGE_INVENTORY: 'manage_inventory',
  MANAGE_USERS: 'manage_users',
  MANAGE_ROLES: 'manage_roles',
  VIEW_REPORTS: 'view_reports',
  // Sales-desk capabilities
  VIEW_ALL_BOOKINGS: 'view_all_bookings',     // see other customers' bookings
  EDIT_BOOKING_PRE_PO: 'edit_booking_pre_po', // amend lines until the PO is raised
  RAISE_PO: 'raise_po',                       // generate the PO number (locks the booking)
  OVERRIDE_PO_LOCK: 'override_po_lock',       // edit a booking after the PO exists
};

// Sales deliberately does NOT hold OVERRIDE_PO_LOCK: raising the PO locks the
// booking against the very role that raised it. Only Admin's '*' clears it.
const ROLE_PERMISSIONS = {
  Admin: ['*'],
  Sales: [
    PERMISSIONS.VIEW_ALL_BOOKINGS,
    PERMISSIONS.EDIT_BOOKING_PRE_PO,
    PERMISSIONS.RAISE_PO,
    PERMISSIONS.VIEW_REPORTS,
  ],
  Customer: [PERMISSIONS.CREATE_ORDER],
};

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

export default { authorize, hasPermission, permissionsFor, PERMISSIONS };
