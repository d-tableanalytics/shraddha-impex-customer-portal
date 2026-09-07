/**
 * Role-based access control.
 *
 * Permissions are derived from the user's role. A Super Admin holds the '*'
 * wildcard and so satisfies every check; other roles carry an explicit list
 * assembled from a compiled-in baseline plus whatever the Super Admin has
 * granted them in the permission matrix.
 *
 * Adding a capability means adding it to config/permissions.js and giving it a
 * cell in config/moduleRegistry.js - never inline in a controller - so the
 * authoritative answer to "who may do this" lives in one place.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This file used to OWN a hardcoded role -> permission map. It now owns the
 * route guards and nothing else; the vocabulary moved to config/permissions.js
 * and the resolution moved to utils/roleResolver.js, so that permissions can
 * come from the database without every consumer having to know that.
 *
 * The public surface is unchanged on purpose. `PERMISSIONS`, `INVENTORY_ROLES`,
 * `permissionsFor`, `hasPermission` and `authorize` all keep their exact
 * previous names, signatures and semantics, and the first two are re-exported
 * from here so the ~145 existing import sites did not have to move. If you are
 * reading a route file that says
 *
 *     import { authorize, PERMISSIONS } from '../../middlewares/rbac.js';
 *
 * it means today what it meant before: the same check, against a set that a
 * Super Admin can now widen.
 */

import {
  PERMISSIONS,
  INVENTORY_ROLES,
  BASELINE_ROLE_PERMISSIONS,
  SYSTEM_ROLE_NAMES,
  SUPER_ADMIN_ROLES,
  isSuperAdminRoleName,
} from '../config/permissions.js';
import {
  resolveUserPermissions,
  setHas,
  can,
  menuFor,
  grantsForUser,
} from '../utils/roleResolver.js';

// Re-exported so existing imports keep resolving from this module.
export {
  PERMISSIONS,
  INVENTORY_ROLES,
  BASELINE_ROLE_PERMISSIONS,
  SYSTEM_ROLE_NAMES,
  SUPER_ADMIN_ROLES,
  isSuperAdminRoleName,
};
export { can, menuFor, grantsForUser };

/**
 * Permission list for a user. Unknown/absent role -> no permissions.
 *
 * Synchronous, as it has always been - see the note at the top of
 * utils/roleResolver.js for why the database lookup behind it is a cache read.
 */
export const permissionsFor = (user) => resolveUserPermissions(user);

/** True when the user holds the permission (or the Super Admin wildcard). */
export const hasPermission = (user, permission) =>
  setHas(permissionsFor(user), permission);

/**
 * Is this user unrestricted?
 *
 * The question ~15 call sites used to ask as `user.role === 'Admin'`. That
 * string comparison was correct while 'Admin' was the only unrestricted role;
 * it silently stopped being correct the moment 'Super Admin' existed, and would
 * stop being correct again for any role a Super Admin marks as full-access.
 *
 * Asking the permission set instead means all three answer true, and a fourth
 * would too. It is the same wildcard authorize() has always honoured.
 */
export const isSuperAdmin = (user) => hasPermission(user, '*');

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

/**
 * Route guard in matrix terms.
 *
 *   router.delete('/items/:sku', authorizeModule('inventory', 'master', 'delete'), handler)
 *
 * Identical in effect to authorize() with that cell's keys spelled out, and
 * preferable for NEW modules: it reads as the thing the Super Admin ticked, and
 * it cannot drift out of step with the matrix, because it asks the registry
 * rather than repeating its answer.
 *
 * Existing routes were left on authorize() rather than mechanically rewritten.
 * Both are the same check, and a 145-file diff that changes no behaviour buries
 * the ones that do.
 */
export const authorizeModule = (moduleKey, submoduleKey, action) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({ success: false, message: 'Forbidden. No role assigned.' });
    }

    if (!can(req.user, moduleKey, submoduleKey, action)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. Insufficient permissions.',
      });
    }

    next();
  };
};

export default {
  authorize,
  authorizeModule,
  hasPermission,
  isSuperAdmin,
  permissionsFor,
  can,
  menuFor,
  grantsForUser,
  PERMISSIONS,
  INVENTORY_ROLES,
};
