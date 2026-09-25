import express from 'express';
import {
  getRoles,
  getRegistry,
  createRole,
  updateRole,
  updateRolePermissions,
  deleteRole,
  getMyAccess,
} from './role.controller.js';
import { protect } from '../../middlewares/auth.js';
import { authorize, authorizeModule, PERMISSIONS } from '../../middlewares/rbac.js';
import { auditLogger } from '../../middlewares/auditLogger.js';

const router = express.Router();

router.use(protect);

/**
 * "What may I do?" is not an administrative question.
 *
 * Declared BEFORE the manage_roles gate below, because every signed-in account
 * needs its own permission list to render its own sidebar - including the
 * customers, who by definition hold no administrative permission at all.
 * Putting it after the gate would mean the only people who could find out what
 * they are allowed to do are the people allowed to do everything.
 */
router.get('/my-access', getMyAccess);

/*
 * Everything past this point administers OTHER people's access.
 *
 * THIS PORTAL HAS ITS OWN EDITOR NOW, SCOPED TO ITS OWN MODULES.
 *
 * These routes used to sit behind requirePortalModule('administration','roles')
 * and 404 here, because both repositories write the same `roles` collection and
 * a second editor could strip cells the first one wrote. That risk is closed on
 * the server rather than by keeping the screen out: every save here goes
 * through mergeServedGrants (utils/portalGrants.js), so this portal can change
 * only the Customer Portal's cells and keeps every Employee Portal cell exactly
 * as stored. `/registry` offers only this portal's modules.
 *
 * WHO GETS IN. `manage_roles` and its per-action keys are reachable only through
 * `administration.roles`, which the shared registry tags as the Employee
 * Portal's. So this portal's domain fence removes them from every non-wildcard
 * account, and only Super Admin / Admin pass. Widening that needs a registry
 * change, which is a shared-contract change in both repositories.
 *
 * `/my-access` above stays open to every signed-in account — it reports what
 * the caller may do, which is how any sidebar gets drawn.
 */
router.use(authorize(PERMISSIONS.MANAGE_ROLES));

// One key per write, as in the Employee Portal: reading the matrix and
// rewriting it are different authorities.
const canCreate = authorizeModule('administration', 'roles', 'create');
const canEdit = authorizeModule('administration', 'roles', 'edit');
const canDelete = authorizeModule('administration', 'roles', 'delete');

router.get('/', getRoles);

// Static path, declared before any ':id' route would shadow it.
router.get('/registry', getRegistry);

router.post('/', canCreate, auditLogger('Create Role'), createRole);
router.patch('/:id', canEdit, auditLogger('Update Role'), updateRole);
router.delete('/:id', canDelete, auditLogger('Delete Role'), deleteRole);

// Legacy flat-permission endpoint. Still served - see the note on the handler.
router.put('/:id/permissions', canEdit, auditLogger('Update Role Permissions'), updateRolePermissions);

export default router;
