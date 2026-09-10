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
import { authorize, PERMISSIONS } from '../../middlewares/rbac.js';
import { auditLogger } from '../../middlewares/auditLogger.js';
import { requirePortalModule } from '../../middlewares/portalGuard.js';

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
 * TWO GATES, and they answer different questions:
 *
 *   requirePortalModule  is this DOMAIN allowed to offer the role matrix at
 *                        all? The matrix grants access across both portals'
 *                        modules, and both repositories write the same `roles`
 *                        collection — so two editors mean one can strip cells
 *                        the other wrote (see SHARED-CONTRACT.md). The single
 *                        editor lives in the employee domain; here these routes
 *                        404 as though they were never written.
 *
 *   authorize            does this USER hold manage_roles? Unchanged.
 *
 * The portal gate is FIRST and is not a permission check, deliberately: a Super
 * Admin holds the wildcard and satisfies every permission ever written, so a
 * domain fence built out of permissions would fail on exactly the accounts it
 * most needs to contain.
 *
 * `/my-access` above stays open to every signed-in account in both domains — it
 * reports what the caller may do, which is how any sidebar gets drawn.
 */
router.use(requirePortalModule('administration', 'roles'));
router.use(authorize(PERMISSIONS.MANAGE_ROLES));

router.get('/', getRoles);

// Static path, declared before any ':id' route would shadow it.
router.get('/registry', getRegistry);

router.post('/', auditLogger('Create Role'), createRole);
router.patch('/:id', auditLogger('Update Role'), updateRole);
router.delete('/:id', auditLogger('Delete Role'), deleteRole);

// Legacy flat-permission endpoint. Still served - see the note on the handler.
router.put('/:id/permissions', auditLogger('Update Role Permissions'), updateRolePermissions);

export default router;
