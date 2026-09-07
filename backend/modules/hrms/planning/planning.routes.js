/**
 * Planning routes, mounted at /api/v1/hrms/planning.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission.
 *
 * Planning has exactly TWO permission specs, and the reference uses no others —
 * every one of its four endpoints carries one of these:
 *
 *   planning:view:org   read headcount plans and hiring plans
 *   planning:edit:org   create and change them
 *
 * There is no self scope and no team scope anywhere in this module, in either
 * codebase. Company-wide headcount and budget is an HR planning tool; the
 * baseline matrix already grants both specs to HR Admin and Super Admin only,
 * and NOTHING in this module changes that — see the analysis, §7.
 *
 * Reads carry no resource check because there is no owner to check against: a
 * headcount plan belongs to a department, not to a person, and anyone who can
 * read one can read all of them by definition of the scope.
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
  createHeadcountPlanSchema,
  updateHeadcountPlanSchema,
  listHeadcountPlansQuery,
  createHiringPlanSchema,
  updateHiringPlanSchema,
  hiringPlanStatusSchema,
  listHiringPlansQuery,
} from '../../../shared/schemas/planning.js';
import * as controller from './planning.controller.js';

const router = express.Router();

/**
 * `edit:org` outranks `view:org` by action, so a planner satisfies the read
 * check too without a second spec being listed on every route.
 */
const canView = requirePermission(
  { module: M.PLANNING, action: A.EDIT, scope: S.ORG },
  { module: M.PLANNING, action: A.VIEW, scope: S.ORG },
);

const canEdit = requirePermission({ module: M.PLANNING, action: A.EDIT, scope: S.ORG });

// ---------------------------------------------------------------------------
// Headcount plans
// ---------------------------------------------------------------------------

router.get(
  '/headcount',
  canView,
  validate({ query: listHeadcountPlansQuery }),
  controller.listHeadcountPlans,
);

/**
 * The three summary tiles, summed over the WHOLE year in the database.
 *
 * The reference sums them in the browser across the rows it happened to fetch,
 * which stops being the year's total the moment the list is paginated.
 * Registered before `/headcount/:id` so "summary" is never read as an id.
 */
router.get(
  '/headcount/summary',
  canView,
  validate({ query: listHeadcountPlansQuery }),
  controller.headcountSummary,
);

/** The years that actually have plans — the reference offers a free text box. */
router.get('/headcount/years', canView, controller.financialYears);

router.get('/headcount/:id', canView, controller.getHeadcountPlan);

router.post(
  '/headcount',
  canEdit,
  validate({ body: createHeadcountPlanSchema }),
  controller.createHeadcountPlan,
);

/** No equivalent in the reference: a plan there is created and then frozen. */
router.patch(
  '/headcount/:id',
  canEdit,
  validate({ body: updateHeadcountPlanSchema }),
  controller.updateHeadcountPlan,
);

// ---------------------------------------------------------------------------
// Hiring plans
// ---------------------------------------------------------------------------

router.get(
  '/hiring',
  canView,
  validate({ query: listHiringPlansQuery }),
  controller.listHiringPlans,
);

router.get('/hiring/summary', canView, controller.hiringPlanSummary);

router.get('/hiring/:id', canView, controller.getHiringPlan);

router.post(
  '/hiring',
  canEdit,
  validate({ body: createHiringPlanSchema }),
  controller.createHiringPlan,
);

router.patch(
  '/hiring/:id',
  canEdit,
  validate({ body: updateHiringPlanSchema }),
  controller.updateHiringPlan,
);

/**
 * The transition endpoint.
 *
 * Separate from the general patch because a status change is a different act:
 * it has its own legality check against the transition table, its own audit
 * action, and it is the only thing that may stamp `actualByDate`. Folding it
 * into `PATCH /hiring/:id` is how a state machine stops being one.
 *
 * 🔴 The reference has no endpoint here at all, which is why four of its five
 * statuses are unreachable — see the service header.
 */
router.patch(
  '/hiring/:id/status',
  canEdit,
  validate({ body: hiringPlanStatusSchema }),
  controller.changeHiringPlanStatus,
);

export default router;
