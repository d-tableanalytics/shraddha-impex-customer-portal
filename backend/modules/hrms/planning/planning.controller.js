/**
 * Planning HTTP layer.
 *
 * Thin, as every other HRMS controller is: validation in the `validate`
 * middleware, authorization in `requirePermission`, business rules and audit in
 * the services.
 *
 * One controller over two services, mirroring the reference's single
 * `PlanningController` — the two halves share one screen and one pair of
 * permissions and differ only in what they plan.
 *
 * Every payload goes UNDER `data`, never spread beside it.
 */

import * as headcount from './headcountPlan.service.js';
import * as hiring from './hiringPlan.service.js';

/**
 * The actor is taken from the SESSION, never from the body or the path.
 *
 * Planning writes record who planned what; none of them accepts an identity
 * from the client.
 */
const contextOf = (req) => ({
  user: req.user,
  req,
  actor: req.hrmsActor,
});

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const query = (req) => req.validated?.query ?? req.query;
const body = (req) => req.validated?.body ?? req.body;

// ---------------------------------------------------------------------------
// Headcount plans
// ---------------------------------------------------------------------------

export const listHeadcountPlans = handler(async (req, res) =>
  ok(res, await headcount.listHeadcountPlans(query(req))),
);

export const headcountSummary = handler(async (req, res) =>
  ok(res, await headcount.headcountSummary(query(req))),
);

export const financialYears = handler(async (req, res) =>
  ok(res, await headcount.financialYears()),
);

export const getHeadcountPlan = handler(async (req, res) =>
  ok(res, await headcount.getHeadcountPlan(req.params.id)),
);

export const createHeadcountPlan = handler(async (req, res) =>
  ok(res, await headcount.createHeadcountPlan(body(req), contextOf(req)), 201),
);

export const updateHeadcountPlan = handler(async (req, res) =>
  ok(res, await headcount.updateHeadcountPlan(req.params.id, body(req), contextOf(req))),
);

// ---------------------------------------------------------------------------
// Hiring plans
// ---------------------------------------------------------------------------

export const listHiringPlans = handler(async (req, res) =>
  ok(res, await hiring.listHiringPlans(query(req))),
);

export const hiringPlanSummary = handler(async (req, res) =>
  ok(res, await hiring.hiringPlanSummary()),
);

export const getHiringPlan = handler(async (req, res) =>
  ok(res, await hiring.getHiringPlan(req.params.id)),
);

export const createHiringPlan = handler(async (req, res) =>
  ok(res, await hiring.createHiringPlan(body(req), contextOf(req)), 201),
);

export const updateHiringPlan = handler(async (req, res) =>
  ok(res, await hiring.updateHiringPlan(req.params.id, body(req), contextOf(req))),
);

export const changeHiringPlanStatus = handler(async (req, res) =>
  ok(res, await hiring.changeHiringPlanStatus(req.params.id, body(req), contextOf(req))),
);
