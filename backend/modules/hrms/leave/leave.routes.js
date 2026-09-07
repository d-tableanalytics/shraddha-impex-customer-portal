/**
 * Leave routes, mounted at /api/v1/hrms/leave.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * Permissions are the reference's, decorator for decorator:
 *
 *   types / balances / requests / calendar   leave:view:self (ANY-OF wider)
 *   submit / cancel                          leave:submit:self
 *   decide                                   ANY-OF leave:approve:org | :team
 *   leave types (write)                      leave:edit:org
 *
 * Collection reads carry no `resourceParam`: the SERVICE narrows the query by
 * scope, and checking one resource at the gate would be meaningless while
 * filtering after the fetch would make any count a lie. Reads of a NAMED
 * employee are re-checked against that employee inside the service.
 */

import express from 'express';

import { requirePermission } from '../../../middlewares/hrmsAuth.js';
import { validate } from '../../../middlewares/validate.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
  createLeaveRequestSchema,
  leaveDecisionSchema,
  leaveListQuerySchema,
  leaveCalendarQuerySchema,
  createLeaveTypeSchema,
} from '../../../shared/schemas/leave.js';
import * as controller from './leave.controller.js';

const router = express.Router();

/** Anyone who can see their own leave. Wider scopes satisfy it by ranking. */
const canView = requirePermission({ module: M.LEAVE, action: A.VIEW, scope: S.SELF });

/** Reads that may name another employee; the service checks which one. */
const canViewSomeone = requirePermission(
  { module: M.LEAVE, action: A.VIEW, scope: S.ORG },
  { module: M.LEAVE, action: A.VIEW, scope: S.TEAM },
  { module: M.LEAVE, action: A.VIEW, scope: S.SELF },
);

/** Filing and withdrawing one's own leave. */
const canSubmit = requirePermission({ module: M.LEAVE, action: A.SUBMIT, scope: S.SELF });

/**
 * Deciding. The gate admits any approver; the service then requires the actor
 * to be THIS employee's direct manager, or to hold the org-wide override.
 */
const canDecide = requirePermission(
  { module: M.LEAVE, action: A.APPROVE, scope: S.ORG },
  { module: M.LEAVE, action: A.APPROVE, scope: S.TEAM },
);

/** Administering the leave catalogue — the same grant that manages holidays. */
const canAdminister = requirePermission({ module: M.LEAVE, action: A.EDIT, scope: S.ORG });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

router.get('/types', canView, controller.listLeaveTypes);

router.post(
  '/types',
  canAdminister,
  validate({ body: createLeaveTypeSchema }),
  controller.createLeaveType,
);

// ---------------------------------------------------------------------------
// Balances — `/me` before `/:employeeId`, or "me" reads as an id
// ---------------------------------------------------------------------------

router.get('/balances/me', canView, controller.myBalances);
router.get('/balances/:employeeId', canViewSomeone, controller.employeeBalances);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

router.get(
  '/requests',
  canViewSomeone,
  validate({ query: leaveListQuerySchema }),
  controller.listRequests,
);

router.post(
  '/requests',
  canSubmit,
  validate({ body: createLeaveRequestSchema }),
  controller.createRequest,
);

router.post(
  '/requests/:id/decide',
  canDecide,
  validate({ body: leaveDecisionSchema }),
  controller.decideRequest,
);

/** Cancelling is a self-service act; the service enforces that it is your own. */
router.post('/requests/:id/cancel', canSubmit, controller.cancelRequest);

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

router.get(
  '/calendar',
  canViewSomeone,
  validate({ query: leaveCalendarQuerySchema }),
  controller.calendar,
);

export default router;
