/**
 * Public surface of the shared permissions module.
 *
 * Two models live side by side and never merge (AD-3):
 *
 *   Legacy portal   flat capability string   hasLegacyPermission(user, 'raise_po')
 *   HRMS            module x action x scope  hasHrmsPermission(actor, 'leave', 'approve', 'team', res)
 *
 * A legacy role grants no HRMS permission, and vice versa. See ./matrix.js.
 */

export {
  HRMS_MODULES,
  HRMS_MODULE_LIST,
  HRMS_ACTIONS,
  HRMS_ACTION_LIST,
  SCOPES,
  SCOPE_LIST,
  SCOPE_RANK,
  HRMS_ROLES,
  HRMS_ROLE_LIST,
  HRMS_ROLE_LABELS,
  isHrmsRoleKey,
  permission,
  isValidModule,
  isValidAction,
  isValidScope,
} from './constants.js';

export {
  HRMS_PERMISSION_MATRIX,
  SELF_BASELINE,
  permissionsForHrmsRoles,
  modulesForHrmsRoles,
} from './matrix.js';

export {
  ANONYMOUS_HRMS_ACTOR,
  buildHrmsActor,
  hasHrmsPermission,
  hasAnyHrmsPermission,
  canAccessHrmsModule,
  hasAnyHrmsAccess,
} from './has-permission.js';

export {
  PERMISSIONS,
  LEGACY_ROLE_PERMISSIONS,
  LEGACY_ROLE_LIST,
  INVENTORY_ROLES,
  permissionsFor,
  hasLegacyPermission,
} from './legacy.js';
