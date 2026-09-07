/**
 * Onboarding routes, mounted at /api/v1/hrms/onboarding.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * Permissions are the reference's, decorator for decorator:
 *
 *   templates: list/read      onboarding:view:org
 *   templates: write/delete   onboarding:edit:org
 *   checklists: list          ANY-OF view:org | view:team | view:self
 *   checklists: read one      ANY-OF view:org | view:team | view:self
 *   checklists: start/cancel  onboarding:edit:org
 *   task update               ANY-OF edit:org | view:self  (service: assignee or HR)
 *   offers: list              onboarding:view:org
 *   offers: for one employee  ANY-OF view:org | view:self  (service: self or org)
 *   offers: create/send       onboarding:edit:org
 *   offers: sign/reject       onboarding:view:self  (service: the subject only)
 *   offers: document URL      ANY-OF view:org | view:self  (storage rule re-checks)
 *
 * 🔴 ONE CORRECTION TO THE REFERENCE'S DECORATORS. Its `checklists/:id` allows
 * only `view:org` or `view:self`, while its LIST also serves `view:team` — so a
 * manager is shown a row and then refused when they open it. `canView` below
 * includes team, and the service reads one checklist through the same scope
 * filter the list uses, so the two can no longer disagree.
 *
 * Collection reads carry no resource check: the SERVICE narrows the query by
 * scope, which is the only way a list can be both filtered and paginated.
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
  createTemplateSchema,
  updateTemplateSchema,
  templateListQuerySchema,
  startChecklistSchema,
  checklistListQuerySchema,
  cancelChecklistSchema,
  updateTaskSchema,
  myTaskListQuerySchema,
  createOfferLetterSchema,
  offerLetterListQuerySchema,
  signOfferLetterSchema,
  rejectOfferLetterSchema,
} from '../../../shared/schemas/onboarding.js';
import * as controller from './onboarding.controller.js';

const router = express.Router();

/** Anyone who can see their own onboarding. Wider scopes satisfy it by ranking. */
const canView = requirePermission(
  { module: M.ONBOARDING, action: A.VIEW, scope: S.ORG },
  { module: M.ONBOARDING, action: A.VIEW, scope: S.TEAM },
  { module: M.ONBOARDING, action: A.VIEW, scope: S.SELF },
);

/** HR's own surface: templates, starting an onboarding, raising an offer. */
const canAdminister = requirePermission({
  module: M.ONBOARDING,
  action: A.EDIT,
  scope: S.ORG,
});

/** Reading anybody's onboarding, as opposed to one's own. */
const canViewOrg = requirePermission({ module: M.ONBOARDING, action: A.VIEW, scope: S.ORG });

/**
 * The self-service gate.
 *
 * Deliberately permissive at the route, because the SERVICE is the authority:
 * updating a task requires being its assignee or holding `edit:org`, and
 * signing requires being the person the offer is addressed to. The route only
 * establishes that the caller is an HRMS user with an onboarding grant at all.
 */
const canActOnOwn = requirePermission(
  { module: M.ONBOARDING, action: A.EDIT, scope: S.ORG },
  { module: M.ONBOARDING, action: A.VIEW, scope: S.SELF },
);

// ---------------------------------------------------------------------------
// The caller's own onboarding — no id on the wire
// ---------------------------------------------------------------------------
//
// Declared BEFORE the parameterised routes below, so `/checklists/mine` is not
// swallowed by `/checklists/:id`.

router.get('/checklists/mine', canActOnOwn, controller.myChecklist);

router.get(
  '/tasks/mine',
  canActOnOwn,
  validate({ query: myTaskListQuerySchema }),
  controller.listMyTasks,
);

router.get('/offers/mine', canActOnOwn, controller.myOfferLetters);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

router.get(
  '/templates',
  canViewOrg,
  validate({ query: templateListQuerySchema }),
  controller.listTemplates,
);

router.get('/templates/:id', canViewOrg, controller.getTemplate);

router.post(
  '/templates',
  canAdminister,
  validate({ body: createTemplateSchema }),
  controller.createTemplate,
);

router.patch(
  '/templates/:id',
  canAdminister,
  validate({ body: updateTemplateSchema }),
  controller.updateTemplate,
);

router.delete('/templates/:id', canAdminister, controller.retireTemplate);

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

router.get(
  '/checklists',
  canView,
  validate({ query: checklistListQuerySchema }),
  controller.listChecklists,
);

router.get('/checklists/:id', canView, controller.getChecklist);

router.post(
  '/checklists',
  canAdminister,
  validate({ body: startChecklistSchema }),
  controller.startChecklist,
);

router.post(
  '/checklists/:id/cancel',
  canAdminister,
  validate({ body: cancelChecklistSchema }),
  controller.cancelChecklist,
);

/** Assignee or HR — the service decides which, and refuses everyone else. */
router.patch(
  '/checklists/:id/tasks/:taskId',
  canActOnOwn,
  validate({ body: updateTaskSchema }),
  controller.updateTask,
);

// ---------------------------------------------------------------------------
// Offer letters
// ---------------------------------------------------------------------------

router.get(
  '/offers',
  canViewOrg,
  validate({ query: offerLetterListQuerySchema }),
  controller.listOfferLetters,
);

/** Self or org — the service re-checks the employee id against the session. */
router.get('/offers/employee/:employeeId', canActOnOwn, controller.listOfferLettersForEmployee);

router.post(
  '/offers',
  canAdminister,
  validate({ body: createOfferLetterSchema }),
  controller.createOfferLetter,
);

router.post('/offers/:id/send', canAdminister, controller.sendOfferLetter);

/** The subject only. The service refuses anyone the offer is not addressed to. */
router.post(
  '/offers/:id/sign',
  canActOnOwn,
  validate({ body: signOfferLetterSchema }),
  controller.signOfferLetter,
);

router.post(
  '/offers/:id/reject',
  canActOnOwn,
  validate({ body: rejectOfferLetterSchema }),
  controller.rejectOfferLetter,
);

/** The storage layer authorises and audits this one again, by design. */
router.get('/offers/:id/document-url', canActOnOwn, controller.offerLetterUrl);

export default router;
