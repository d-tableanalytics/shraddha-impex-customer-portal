/**
 * Dashboard HTTP layer.
 *
 * Thin, as every other HRMS controller is. The actor comes from the SESSION and
 * nothing else — no endpoint here accepts an employee id, so a caller cannot
 * ask for somebody else's dashboard.
 *
 * Every payload goes UNDER `data`.
 */

import * as dashboard from './dashboard.service.js';

const ok = (res, data) => res.status(200).json({ success: true, data });

const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const query = (req) => req.validated?.query ?? req.query;

export const widgets = handler(async (req, res) =>
  ok(res, await dashboard.dashboardWidgets(req.hrmsActor)),
);

export const summary = handler(async (req, res) =>
  ok(res, await dashboard.dashboardSummary(req.hrmsActor, query(req))),
);

export const loginTrend = handler(async (req, res) =>
  ok(res, await dashboard.loginTrend(req.hrmsActor, query(req).range)),
);
