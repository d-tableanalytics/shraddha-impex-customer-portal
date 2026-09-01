/**
 * Role-based access control for the customer portal.
 *
 * Permissions are derived from `user.role`. Admin holds the '*' wildcard and so
 * satisfies every check; other roles carry an explicit list.
 *
 * ---------------------------------------------------------------------------
 * The definitions moved; the exports did not
 * ---------------------------------------------------------------------------
 * `PERMISSIONS`, the role map, `INVENTORY_ROLES` and the evaluator now live in
 * `../shared/permissions/legacy.js`, so the backend and the frontend read one
 * copy instead of two hand-maintained mirrors. This file re-exports them under
 * their original names: every existing consumer keeps working unchanged.
 *
 * Adding a capability still means adding it in one place - now
 * `shared/permissions/legacy.js` - and never inline in a controller.
 *
 * ---------------------------------------------------------------------------
 * HRMS authorization is somewhere else
 * ---------------------------------------------------------------------------
 * HRMS uses a module x action x scope model, not flat strings. It lives in
 * `./hrmsAuth.js` and `../shared/permissions/`. The two never merge (AD-3), and
 * a portal role grants no HRMS permission (AD-4).
 */

import {
  PERMISSIONS,
  INVENTORY_ROLES,
  permissionsFor,
  hasLegacyPermission,
} from '../shared/permissions/legacy.js';

export { PERMISSIONS, INVENTORY_ROLES, permissionsFor };

/**
 * True when the user holds the permission (or the Admin wildcard).
 *
 * Kept under its original name for the existing call sites. The canonical
 * implementation is `hasLegacyPermission` - the rename exists so this can never
 * be confused with the HRMS evaluator, which takes an actor and a
 * module/action/scope triple.
 */
export const hasPermission = hasLegacyPermission;

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
