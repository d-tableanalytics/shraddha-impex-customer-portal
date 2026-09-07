/**
 * Payroll routes, mounted at /api/v1/hrms/payroll.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * ---------------------------------------------------------------------------
 * Permissions, taken from the reference's decorators
 * ---------------------------------------------------------------------------
 *   runs list/get           payroll:view:org       (payroll-run.controller.ts:33,40)
 *   run create/compute/
 *     lock/disburse/rollback payroll:run:org       (:46,58,66,77,89)
 *   payslips mine           payroll:view:self      (payslip.controller.ts:32)
 *   payslip get             ANY-OF view org | self (:72)
 *   pay groups / components /
 *     structures / statutory payroll:structure:*   (the reference gates its
 *                            Pay Groups, Structures and Statutory tabs on
 *                            `payroll:structure:edit:org`, PayrollPage.tsx:24)
 *
 * No permission is invented. Every key already exists in the matrix:
 * `payroll:view:self` sits in SELF_BASELINE; `payroll:view:org`,
 * `payroll:run:org`, `payroll:structure:view:org` and
 * `payroll:structure:edit:org` are held by super_admin and payroll_admin, and
 * `payroll:view:org` additionally by hr_admin and the auditor.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Compensation is gated on employees:compensation, NOT on payroll
 * ---------------------------------------------------------------------------
 * A CTC is the single most sensitive field in the HRMS. Employee Master already
 * draws this line for PAN and bank details, and payroll does not get to draw a
 * looser one: a payroll admin who may run the month is not automatically
 * entitled to browse individual salaries, and an HR admin who may edit a
 * profile is not either.
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
  createPayGroupSchema,
  updatePayGroupSchema,
  createSalaryComponentSchema,
  updateSalaryComponentSchema,
  createSalaryStructureSchema,
  updateSalaryStructureSchema,
  structurePreviewSchema,
  createCompensationSchema,
  compensationListQuerySchema,
  createStatutoryConfigSchema,
  updateStatutoryConfigSchema,
  createPayrollRunSchema,
  runListQuerySchema,
  createAdjustmentSchema,
  payslipListQuerySchema,
} from '../../../shared/schemas/payroll.js';
import * as controller from './payroll.controller.js';

const router = express.Router();

/** Designing the payroll: pay groups, components, structures, statutory rules. */
const canReadStructure = requirePermission(
  { module: M.PAYROLL_STRUCTURE, action: A.VIEW, scope: S.ORG },
  { module: M.PAYROLL_STRUCTURE, action: A.EDIT, scope: S.ORG },
);
const canEditStructure = requirePermission({
  module: M.PAYROLL_STRUCTURE,
  action: A.EDIT,
  scope: S.ORG,
});

/** Seeing the company's payroll. */
const canViewPayroll = requirePermission({ module: M.PAYROLL, action: A.VIEW, scope: S.ORG });

/** Running it. */
const canRunPayroll = requirePermission({ module: M.PAYROLL, action: A.RUN, scope: S.ORG });

/**
 * Reading or writing an individual's compensation.
 *
 * See the header — this is the employees:compensation gate, not a payroll one.
 */
const canViewCompensation = requirePermission({
  module: M.EMPLOYEES_COMPENSATION,
  action: A.VIEW,
  scope: S.ORG,
});
const canEditCompensation = requirePermission({
  module: M.EMPLOYEES_COMPENSATION,
  action: A.EDIT,
  scope: S.ORG,
});

// ---------------------------------------------------------------------------
// Payslips — before /:id-shaped routes elsewhere, and `mine` before anything
// that could match it as an id.
// ---------------------------------------------------------------------------

/**
 * The caller's own. `view:self` is the SELF_BASELINE grant every employee
 * holds; the service resolves the employee from the actor, so there is no id
 * to tamper with.
 */
router.get(
  '/payslips/mine',
  requirePermission({ module: M.PAYROLL, action: A.VIEW, scope: S.SELF }),
  validate({ query: payslipListQuerySchema }),
  controller.listMyPayslips,
);

/**
 * The filtered list. ANY-OF at the gate; the SERVICE narrows by scope, and
 * refuses a caller who names an employee they may not see.
 */
router.get(
  '/payslips',
  requirePermission(
    { module: M.PAYROLL, action: A.VIEW, scope: S.ORG },
    { module: M.PAYROLL, action: A.VIEW, scope: S.SELF },
  ),
  validate({ query: payslipListQuerySchema }),
  controller.listPayslips,
);

/**
 * One payslip.
 *
 * `resourceParam` is deliberately absent: the subject is not knowable from the
 * id without reading the row, so the SERVICE resolves it and re-checks. The
 * guard here only establishes that the caller may see payslips at all.
 */
router.get(
  '/payslips/:id',
  requirePermission(
    { module: M.PAYROLL, action: A.VIEW, scope: S.ORG },
    { module: M.PAYROLL, action: A.VIEW, scope: S.SELF },
  ),
  controller.getPayslip,
);

// ---------------------------------------------------------------------------
// Pay groups
// ---------------------------------------------------------------------------

router.get('/pay-groups', canReadStructure, controller.listPayGroups);
router.post(
  '/pay-groups',
  canEditStructure,
  validate({ body: createPayGroupSchema }),
  controller.createPayGroup,
);
router.patch(
  '/pay-groups/:id',
  canEditStructure,
  validate({ body: updatePayGroupSchema }),
  controller.updatePayGroup,
);
router.delete('/pay-groups/:id', canEditStructure, controller.deletePayGroup);

// ---------------------------------------------------------------------------
// Salary components
// ---------------------------------------------------------------------------

router.get('/components', canReadStructure, controller.listComponents);
router.post(
  '/components',
  canEditStructure,
  validate({ body: createSalaryComponentSchema }),
  controller.createComponent,
);
router.patch(
  '/components/:id',
  canEditStructure,
  validate({ body: updateSalaryComponentSchema }),
  controller.updateComponent,
);
router.delete('/components/:id', canEditStructure, controller.deleteComponent);

// ---------------------------------------------------------------------------
// Salary structures
// ---------------------------------------------------------------------------

router.get('/structures', canReadStructure, controller.listStructures);
router.post(
  '/structures',
  canEditStructure,
  validate({ body: createSalaryStructureSchema }),
  controller.createStructure,
);
/** Before `/:id`, so "preview" is never read as a structure id. */
router.post(
  '/structures/:id/preview',
  canReadStructure,
  validate({ body: structurePreviewSchema }),
  controller.previewStructure,
);
router.get('/structures/:id', canReadStructure, controller.getStructure);
router.patch(
  '/structures/:id',
  canEditStructure,
  validate({ body: updateSalaryStructureSchema }),
  controller.updateStructure,
);
router.delete('/structures/:id', canEditStructure, controller.deleteStructure);

// ---------------------------------------------------------------------------
// Statutory configuration
// ---------------------------------------------------------------------------

/** `effective` before `/:id`, for the same reason as `preview` above. */
router.get('/statutory/effective', canReadStructure, controller.getEffectiveStatutoryConfig);
router.get('/statutory', canReadStructure, controller.listStatutoryConfigs);
router.post(
  '/statutory',
  canEditStructure,
  validate({ body: createStatutoryConfigSchema }),
  controller.createStatutoryConfig,
);
router.patch(
  '/statutory/:id',
  canEditStructure,
  validate({ body: updateStatutoryConfigSchema }),
  controller.updateStatutoryConfig,
);
router.delete('/statutory/:id', canEditStructure, controller.deleteStatutoryConfig);

// ---------------------------------------------------------------------------
// Employee compensation
// ---------------------------------------------------------------------------

router.get(
  '/compensation/:employeeId',
  canViewCompensation,
  validate({ query: compensationListQuerySchema }),
  controller.listCompensation,
);
router.get('/compensation/:employeeId/current', canViewCompensation, controller.getCurrentCompensation);
router.post(
  '/compensation',
  canEditCompensation,
  validate({ body: createCompensationSchema }),
  controller.createCompensation,
);
router.delete('/compensation/entry/:id', canEditCompensation, controller.deleteCompensation);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

router.get('/runs', canViewPayroll, validate({ query: runListQuerySchema }), controller.listRuns);
router.post(
  '/runs',
  canRunPayroll,
  validate({ body: createPayrollRunSchema }),
  controller.createRun,
);
router.get('/runs/:id', canViewPayroll, controller.getRun);
router.get('/runs/:id/payslips', canViewPayroll, controller.listRunPayslips);

/** State transitions. Every one is `payroll:run:org`, and re-checked server-side. */
router.post('/runs/:id/compute', canRunPayroll, controller.computeRun);
router.post('/runs/:id/lock', canRunPayroll, controller.lockRun);
router.post('/runs/:id/disburse', canRunPayroll, controller.disburseRun);
router.post('/runs/:id/rollback', canRunPayroll, controller.rollbackRun);

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

router.get('/runs/:id/adjustments', canViewPayroll, controller.listAdjustments);
router.post(
  '/runs/:id/adjustments',
  canRunPayroll,
  validate({ body: createAdjustmentSchema }),
  controller.createAdjustment,
);
router.delete('/runs/:id/adjustments/:adjustmentId', canRunPayroll, controller.deleteAdjustment);

export default router;
