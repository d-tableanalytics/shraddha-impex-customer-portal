import express from 'express';
import {
  getUsers, createUser, updateUser, updateUserRole, resetUserPassword, updateUserAccess,
} from './user.controller.js';
import { protect } from '../../middlewares/auth.js';
import { authorize, PERMISSIONS } from '../../middlewares/rbac.js';
import { passwordLimiter } from '../../middlewares/rateLimiters.js';
import { auditLogger } from '../../middlewares/auditLogger.js';

const router = express.Router();

router.use(protect);

/**
 * Two permissions reach this router:
 *
 *   MANAGE_USERS          (Admin) — every account, any role.
 *   MANAGE_CUSTOMER_USERS (Sales) — CUSTOMER accounts only.
 *
 * The route guard can only answer "may this actor use user management at all".
 * WHICH accounts they may see and change depends on the target's role, which
 * the route does not know, so every handler re-checks it — see
 * denyIfOutOfScope() in the controller. Guarding here alone would let a
 * salesperson POST /users with role: 'Admin'.
 */
router.use(authorize(PERMISSIONS.MANAGE_USERS, PERMISSIONS.MANAGE_CUSTOMER_USERS));

router.get('/', getUsers);
router.post('/', auditLogger('Create User'), createUser);
router.patch('/:id', auditLogger('Update User'), updateUser);
// Changing a role is Admin-only; the handler refuses anyone else outright.
router.put('/:id/roles', auditLogger('Update User Role'), updateUserRole);
// The rate limiter stays on the password route: it is the one path here that
// can be used to guess or grind, and the merge must not drop it.
router.put('/:id/password', passwordLimiter, auditLogger('Reset User Password'), resetUserPassword);
// Extra per-account access. Admin-only, and the handler refuses anyone else
// outright - handing out permissions is not part of managing customers.
router.put('/:id/access', auditLogger('Update User Access'), updateUserAccess);

export default router;
