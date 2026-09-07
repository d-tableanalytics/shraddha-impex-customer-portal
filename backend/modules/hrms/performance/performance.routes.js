/**
 * Performance routes, mounted at /api/v1/hrms/performance.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * Permissions are the reference's, decorator for decorator:
 *
 *   goals: list          ANY-OF view:org | view:self | approve:team
 *   goals: create        submit:self          (service: self, or org for others)
 *   goals: update/delete ANY-OF view:self | approve:org  (service: owner or HR)
 *   cycles: list         ANY-OF view:org | view:self
 *   cycles: write        approve:org
 *   cycles: calibration  approve:org
 *   reviews: mine        ANY-OF view:self | approve:team
 *   reviews: by cycle    view:org
 *   reviews: create      ANY-OF submit:self | approve:team | approve:org
 *   reviews: submit      submit:self          (service: the assigned reviewer only)
 *   feedback: all        view:self / submit:self
 *   1:1s: list/update    view:self            (service: participants only)
 *   1:1s: schedule       approve:team         (service: own direct reports only)
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
  createGoalSchema,
  updateGoalSchema,
  goalListQuerySchema,
  createCycleSchema,
  advancePhaseSchema,
  cycleListQuerySchema,
  createReviewSchema,
  submitReviewSchema,
  reviewListQuerySchema,
  giveFeedbackSchema,
  feedbackListQuerySchema,
  createOneOnOneSchema,
  updateOneOnOneSchema,
  oneOnOneListQuerySchema,
} from '../../../shared/schemas/performance.js';
import * as controller from './performance.controller.js';

const router = express.Router();

/** Anyone who can see their own performance. Wider scopes satisfy it by ranking. */
const canViewSelf = requirePermission(
  { module: M.PERFORMANCE, action: A.VIEW, scope: S.ORG },
  { module: M.PERFORMANCE, action: A.VIEW, scope: S.TEAM },
  { module: M.PERFORMANCE, action: A.VIEW, scope: S.SELF },
);

/** Reading across the organisation, as opposed to one's own or one's team. */
const canViewOrg = requirePermission({ module: M.PERFORMANCE, action: A.VIEW, scope: S.ORG });

/** HR's own surface: cycles, phases and calibration. */
const canAdminister = requirePermission({
  module: M.PERFORMANCE,
  action: A.APPROVE,
  scope: S.ORG,
});

/** Filing one's own work — a goal, a review, a note of feedback. */
const canSubmit = requirePermission(
  { module: M.PERFORMANCE, action: A.SUBMIT, scope: S.SELF },
  { module: M.PERFORMANCE, action: A.APPROVE, scope: S.ORG },
);

/**
 * Acting on something of one's own.
 *
 * Deliberately permissive at the route, because the SERVICE is the authority:
 * updating a goal requires being its owner or HR, submitting a review requires
 * being the assigned reviewer, and editing a 1:1 requires being a participant.
 */
const canActOnOwn = requirePermission(
  { module: M.PERFORMANCE, action: A.APPROVE, scope: S.ORG },
  { module: M.PERFORMANCE, action: A.VIEW, scope: S.SELF },
);

/** Opening a review for somebody else — a manager's or HR's act. */
const canAssignReview = requirePermission(
  { module: M.PERFORMANCE, action: A.SUBMIT, scope: S.SELF },
  { module: M.PERFORMANCE, action: A.APPROVE, scope: S.TEAM },
  { module: M.PERFORMANCE, action: A.APPROVE, scope: S.ORG },
);

/** Scheduling a 1:1 — a manager's act, narrowed to direct reports by the service. */
const canScheduleOneOnOne = requirePermission(
  { module: M.PERFORMANCE, action: A.APPROVE, scope: S.TEAM },
  { module: M.PERFORMANCE, action: A.APPROVE, scope: S.ORG },
);

// ---------------------------------------------------------------------------
// Session-scoped reads — no id on the wire
// ---------------------------------------------------------------------------
//
// Declared BEFORE the parameterised routes below, so `/reviews/mine` is not
// swallowed by `/reviews/:id`.

router.get(
  '/reviews/mine',
  canActOnOwn,
  validate({ query: reviewListQuerySchema }),
  controller.listMyReviews,
);

router.get(
  '/reviews/about-me',
  canActOnOwn,
  validate({ query: reviewListQuerySchema }),
  controller.listReviewsAboutMe,
);

router.get(
  '/feedback/received',
  canActOnOwn,
  validate({ query: feedbackListQuerySchema }),
  controller.listReceivedFeedback,
);

router.get(
  '/feedback/given',
  canActOnOwn,
  validate({ query: feedbackListQuerySchema }),
  controller.listGivenFeedback,
);

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

router.get('/goals', canViewSelf, validate({ query: goalListQuerySchema }), controller.listGoals);

router.get('/goals/:id', canViewSelf, controller.getGoal);

router.post('/goals', canSubmit, validate({ body: createGoalSchema }), controller.createGoal);

/** Owner or HR — the service decides which, and refuses everyone else. */
router.patch(
  '/goals/:id',
  canActOnOwn,
  validate({ body: updateGoalSchema }),
  controller.updateGoal,
);

router.delete('/goals/:id', canActOnOwn, controller.deleteGoal);

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

router.get(
  '/cycles',
  canViewSelf,
  validate({ query: cycleListQuerySchema }),
  controller.listCycles,
);

router.get('/cycles/:id', canViewSelf, controller.getCycle);

router.post('/cycles', canAdminister, validate({ body: createCycleSchema }), controller.createCycle);

router.post(
  '/cycles/:id/phase',
  canAdminister,
  validate({ body: advancePhaseSchema }),
  controller.advancePhase,
);

router.get('/cycles/:id/calibration', canAdminister, controller.calibration);

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

router.get(
  '/reviews',
  canViewOrg,
  validate({ query: reviewListQuerySchema }),
  controller.listCycleReviews,
);

router.get('/reviews/:id', canActOnOwn, controller.getReview);

router.post(
  '/reviews',
  canAssignReview,
  validate({ body: createReviewSchema }),
  controller.createReview,
);

/** The assigned reviewer only. The service refuses anyone else. */
router.post(
  '/reviews/:id/submit',
  canActOnOwn,
  validate({ body: submitReviewSchema }),
  controller.submitReview,
);

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

router.post(
  '/feedback',
  canSubmit,
  validate({ body: giveFeedbackSchema }),
  controller.giveFeedback,
);

// ---------------------------------------------------------------------------
// 1:1s
// ---------------------------------------------------------------------------

router.get(
  '/one-on-ones',
  canActOnOwn,
  validate({ query: oneOnOneListQuerySchema }),
  controller.listMyOneOnOnes,
);

router.post(
  '/one-on-ones',
  canScheduleOneOnOne,
  validate({ body: createOneOnOneSchema }),
  controller.scheduleOneOnOne,
);

/** Either participant. The service decides what each side may change. */
router.patch(
  '/one-on-ones/:id',
  canActOnOwn,
  validate({ body: updateOneOnOneSchema }),
  controller.updateOneOnOne,
);

export default router;
