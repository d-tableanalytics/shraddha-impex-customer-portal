/**
 * Exit routes, mounted at /api/v1/hrms/exits.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * Permissions are the reference's, decorator for decorator:
 *
 *   list / read            ANY-OF exits:view:org | :view:self | :approve:team
 *   initiate / cancel      ANY-OF exits:submit:self | :edit:org
 *   manager approve        ANY-OF exits:approve:team | :edit:org
 *   hr approve, clearances,
 *   handover, F&F, letter  exits:edit:org
 *   update one clearance   exits:view:self  (the service requires assignee or HR)
 *
 * Collection reads carry no resource check: the SERVICE narrows the query by
 * scope. Reads of ONE request go through the same scope filter as the list, so
 * a manager can open exactly what a manager was shown â€” the reference asks
 * those two questions in two places and leaves the second unimplemented.
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
  createExitRequestSchema,
  updateExitRequestSchema,
  updateClearanceSchema,
} from '../../../shared/schemas/exit.js';
import * as controller from './exit.controller.js';

const router = express.Router();

/** Anyone who can see their own exit. Wider scopes satisfy it by ranking. */
const canView = requirePermission(
  { module: M.EXITS, action: A.VIEW, scope: S.ORG },
  { module: M.EXITS, action: A.VIEW, scope: S.SELF },
  { module: M.EXITS, action: A.APPROVE, scope: S.TEAM },
);

/** Filing and withdrawing. The service decides whose exit it may be. */
const canSubmit = requirePermission(
  { module: M.EXITS, action: A.SUBMIT, scope: S.SELF },
  { module: M.EXITS, action: A.EDIT, scope: S.ORG },
);

/**
 * The manager gate. The gate admits any approver; the service then requires the
 * actor to be in the leaver's manager chain, or to hold org scope â€” and refuses
 * self-approval either way.
 */
const canApprove = requirePermission(
  { module: M.EXITS, action: A.APPROVE, scope: S.TEAM },
  { module: M.EXITS, action: A.EDIT, scope: S.ORG },
);

/** HR. Approval, clearances, handover, settlement and the letter. */
const canAdminister = requirePermission({ module: M.EXITS, action: A.EDIT, scope: S.ORG });

/**
 * Working a clearance.
 *
 * Deliberately wide at the route, narrow in the service: the assignee may be an
 * IT admin or a reporting manager who holds no exits grant beyond `view`, and
 * the service checks that they are the actual assignee. The reference admits
 * `assets:assign:org` here for the same reason.
 */
const canWorkClearance = requirePermission(
  { module: M.EXITS, action: A.VIEW, scope: S.SELF },
  { module: M.EXITS, action: A.EDIT, scope: S.ORG },
);

// ---------------------------------------------------------------------------
// Reads. `/me` is declared before `/:id` so it is not swallowed by it.
// ---------------------------------------------------------------------------

router.get('/me', canView, controller.myExit);
router.get('/', canView, controller.listExits);

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

router.post('/', canSubmit, validate({ body: createExitRequestSchema }), controller.initiateExit);

router.post('/:id/manager-approve', canApprove, controller.managerApprove);
router.post('/:id/hr-approve', canAdminister, controller.hrApprove);
router.post('/:id/open-clearances', canAdminister, controller.openClearances);
router.post('/:id/cancel', canSubmit, controller.cancelExit);

router.patch(
  '/:id/clearances/:clearanceId',
  canWorkClearance,
  validate({ body: updateClearanceSchema }),
  controller.updateClearance,
);

// ---------------------------------------------------------------------------
// Settlement and letter
// ---------------------------------------------------------------------------

router.get('/:id/fnf/preview', canAdminister, controller.previewSettlement);
router.post('/:id/fnf', canAdminister, controller.createSettlement);
router.post('/:id/fnf/disburse', canAdminister, controller.disburseSettlement);

router.post('/:id/relieving-letter', canAdminister, controller.generateRelievingLetter);
/** A presigned URL, not the bytes â€” and not a stable, guessable path. */
router.get('/:id/relieving-letter/url', canView, controller.relievingLetterUrl);

// ---------------------------------------------------------------------------
// Handover. Declared last so `/:id` cannot shadow the nested routes above.
// ---------------------------------------------------------------------------

router.patch('/:id', canAdminister, validate({ body: updateExitRequestSchema }), controller.updateExit);
router.get('/:id', canView, controller.getExit);

export default router;
