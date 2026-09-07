/**
 * Performance HTTP layer.
 *
 * Thin, as every other HRMS controller is: validation in the `validate`
 * middleware, authorization in `requirePermission` and re-checked in the
 * services, business rules and audit in the services.
 *
 * Every payload goes UNDER `data`, never spread beside it — the envelope bug
 * that once killed the employee directory.
 */

import * as goals from './goal.service.js';
import * as cycles from './cycle.service.js';
import * as reviews from './review.service.js';
import * as feedback from './feedback.service.js';
import * as oneOnOnes from './oneOnOne.service.js';

/**
 * The actor is taken from the SESSION, never from the body or the path.
 *
 * `actor` carries the resolved permission set and the caller's own employee id;
 * every scope decision in the services reads it from here.
 */
const contextOf = (req) => ({
  user: req.user,
  req,
  actor: req.hrmsActor,
  actorEmployeeId: req.hrmsActor?.employeeId ?? null,
});

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export const listGoals = handler(async (req, res) =>
  ok(res, await goals.listGoals(req.validated?.query ?? req.query, req.hrmsActor)),
);

export const getGoal = handler(async (req, res) =>
  ok(res, await goals.getGoal(req.params.id, req.hrmsActor)),
);

export const createGoal = handler(async (req, res) =>
  ok(res, await goals.createGoal(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const updateGoal = handler(async (req, res) =>
  ok(res, await goals.updateGoal(req.params.id, req.validated?.body ?? req.body, contextOf(req))),
);

export const deleteGoal = handler(async (req, res) => {
  await goals.deleteGoal(req.params.id, contextOf(req));
  // 204, as the reference returns. There is nothing meaningful to hand back.
  return res.status(204).send();
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

export const listCycles = handler(async (req, res) =>
  ok(res, await cycles.listCycles(req.validated?.query ?? req.query)),
);

export const getCycle = handler(async (req, res) => ok(res, await cycles.getCycle(req.params.id)));

export const createCycle = handler(async (req, res) =>
  ok(res, await cycles.createCycle(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const advancePhase = handler(async (req, res) =>
  ok(res, await cycles.advancePhase(req.params.id, req.validated?.body ?? req.body, contextOf(req))),
);

export const calibration = handler(async (req, res) =>
  ok(res, await cycles.calibrationSnapshot(req.params.id)),
);

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/** The caller's own queue. No id is accepted — it comes from the session. */
export const listMyReviews = handler(async (req, res) =>
  ok(res, await reviews.listMyReviews(req.hrmsActor, req.validated?.query ?? req.query)),
);

/** Submitted reviews written ABOUT the caller — the endpoint the reference lacks. */
export const listReviewsAboutMe = handler(async (req, res) =>
  ok(res, await reviews.listReviewsAboutMe(req.hrmsActor, req.validated?.query ?? req.query)),
);

export const listCycleReviews = handler(async (req, res) =>
  ok(res, await reviews.listCycleReviews(req.validated?.query ?? req.query)),
);

export const getReview = handler(async (req, res) =>
  ok(res, await reviews.getReview(req.params.id, req.hrmsActor)),
);

export const createReview = handler(async (req, res) =>
  ok(res, await reviews.createReview(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const submitReview = handler(async (req, res) =>
  ok(res, await reviews.submitReview(req.params.id, req.validated?.body ?? req.body, contextOf(req))),
);

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export const listReceivedFeedback = handler(async (req, res) =>
  ok(res, await feedback.listReceivedFeedback(req.hrmsActor, req.validated?.query ?? req.query)),
);

export const listGivenFeedback = handler(async (req, res) =>
  ok(res, await feedback.listGivenFeedback(req.hrmsActor, req.validated?.query ?? req.query)),
);

export const giveFeedback = handler(async (req, res) =>
  ok(res, await feedback.giveFeedback(req.validated?.body ?? req.body, contextOf(req)), 201),
);

// ---------------------------------------------------------------------------
// 1:1s
// ---------------------------------------------------------------------------

export const listMyOneOnOnes = handler(async (req, res) =>
  ok(res, await oneOnOnes.listMyOneOnOnes(req.hrmsActor, req.validated?.query ?? req.query)),
);

export const scheduleOneOnOne = handler(async (req, res) =>
  ok(res, await oneOnOnes.scheduleOneOnOne(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const updateOneOnOne = handler(async (req, res) =>
  ok(
    res,
    await oneOnOnes.updateOneOnOne(req.params.id, req.validated?.body ?? req.body, contextOf(req)),
  ),
);

export default {
  listGoals,
  getGoal,
  createGoal,
  updateGoal,
  deleteGoal,
  listCycles,
  getCycle,
  createCycle,
  advancePhase,
  calibration,
  listMyReviews,
  listReviewsAboutMe,
  listCycleReviews,
  getReview,
  createReview,
  submitReview,
  listReceivedFeedback,
  listGivenFeedback,
  giveFeedback,
  listMyOneOnOnes,
  scheduleOneOnOne,
  updateOneOnOne,
};
