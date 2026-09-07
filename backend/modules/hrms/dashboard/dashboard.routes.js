/**
 * Dashboard routes, mounted at /api/v1/hrms/dashboard.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission.
 *
 * ONE permission spec, `dashboard:view:self`, exactly as the reference has it
 * — every role holds it, because everybody lands here. What differs per role is
 * the CONTENT, which the service decides from the same evaluator the modules
 * use:
 *
 *   quick access      only tiles the actor could actually use
 *   on leave today    attendance team/org scope, and Leave's own scope filter
 *   mobile clock-ins  the same
 *   workforce KPIs    employees:view:org
 *   login activity    audit-logs:view:org  🔴 the reference exposes this to
 *                     everyone, so any employee can read company-wide sign-in
 *                     volume from the home page
 *
 * There is no write endpoint. The dashboard reads; the modules own the writes.
 */

import express from 'express';

import { requirePermission } from '../../../middlewares/hrmsAuth.js';
import { validate } from '../../../middlewares/validate.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import { dashboardRangeQuery } from '../../../shared/schemas/dashboard.js';
import * as controller from './dashboard.controller.js';

const router = express.Router();

/** Everybody who can open HRMS at all. */
const canView = requirePermission({ module: M.DASHBOARD, action: A.VIEW, scope: S.SELF });

router.get('/widgets', canView, controller.widgets);

router.get('/summary', canView, validate({ query: dashboardRangeQuery }), controller.summary);

router.get(
  '/login-trend',
  canView,
  validate({ query: dashboardRangeQuery }),
  controller.loginTrend,
);

export default router;
