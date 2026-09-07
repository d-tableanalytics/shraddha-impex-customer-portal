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

// Everything past this point administers OTHER people's access.
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
