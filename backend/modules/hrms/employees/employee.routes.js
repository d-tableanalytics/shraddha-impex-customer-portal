/**
 * Employee Master routes, mounted at /api/v1/hrms/employees.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. What each route adds is its own permission, at its own scope.
 *
 * Two things are deliberate about the ordering below:
 *
 *   1. `/custom-fields` is declared BEFORE `/:id`. Express matches in order, so
 *      the reverse would make "custom-fields" look like an employee id.
 *   2. Read routes list several specs. `requirePermission` is ANY-OF, so one
 *      route serves an employee reading their own record, a manager reading a
 *      report, and HR reading anyone - which is how the reference does it.
 *      `resourceParam` is what makes the narrow scopes evaluate against the
 *      actual row rather than waving through.
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
  createEmployeeSchema,
  updateEmployeeSchema,
  employeeListQuerySchema,
  assignRolesSchema,
  revealSensitiveSchema,
  createCustomFieldSchema,
  updateCustomFieldSchema,
} from '../../../shared/schemas/employee.js';
import * as controller from './employee.controller.js';

const router = express.Router();

const canRead = requirePermission(
  { module: M.EMPLOYEES, action: A.VIEW, scope: S.ORG },
  { module: M.EMPLOYEES, action: A.VIEW, scope: S.TEAM, resourceParam: 'id' },
  { module: M.EMPLOYEES, action: A.VIEW, scope: S.SELF, resourceParam: 'id' },
);

const canEdit = requirePermission(
  { module: M.EMPLOYEES, action: A.EDIT, scope: S.ORG },
  { module: M.EMPLOYEES, action: A.EDIT, scope: S.SELF, resourceParam: 'id' },
);

const canEditOrg = requirePermission({ module: M.EMPLOYEES, action: A.EDIT, scope: S.ORG });

// ---------------------------------------------------------------------------
// Custom field definitions - before /:id, see the note above
// ---------------------------------------------------------------------------

router.get(
  '/custom-fields',
  requirePermission(
    { module: M.EMPLOYEES, action: A.VIEW, scope: S.ORG },
    { module: M.EMPLOYEES, action: A.VIEW, scope: S.TEAM },
    // An employee filling in their own profile still needs the definitions to
    // render the form.
    { module: M.EMPLOYEES, action: A.VIEW, scope: S.SELF },
  ),
  controller.listCustomFields,
);

router.post(
  '/custom-fields',
  canEditOrg,
  validate({ body: createCustomFieldSchema }),
  controller.createCustomField,
);

router.patch(
  '/custom-fields/:id',
  canEditOrg,
  validate({ body: updateCustomFieldSchema }),
  controller.updateCustomField,
);

router.delete('/custom-fields/:id', canEditOrg, controller.deleteCustomField);

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

router.get(
  '/',
  // No resourceParam: this is a collection read, and the SERVICE narrows the
  // query by scope. Checking a resource here would be meaningless, and
  // filtering after the fetch would make the pagination total wrong.
  requirePermission(
    { module: M.EMPLOYEES, action: A.VIEW, scope: S.ORG },
    { module: M.EMPLOYEES, action: A.VIEW, scope: S.TEAM },
    { module: M.EMPLOYEES, action: A.VIEW, scope: S.SELF },
  ),
  validate({ query: employeeListQuerySchema }),
  controller.listEmployees,
);

router.post(
  '/',
  requirePermission({ module: M.EMPLOYEES, action: A.CREATE, scope: S.ORG }),
  validate({ body: createEmployeeSchema }),
  controller.createEmployee,
);

// ---------------------------------------------------------------------------
// One employee
// ---------------------------------------------------------------------------

router.get('/:id', canRead, controller.getEmployee);

router.patch('/:id', canEdit, validate({ body: updateEmployeeSchema }), controller.updateEmployee);

/**
 * Soft delete. `employees:delete:org` is held by super_admin alone in the
 * matrix, which matches the reference: deactivating someone is not an ordinary
 * HR edit.
 */
router.delete(
  '/:id',
  requirePermission({ module: M.EMPLOYEES, action: A.DELETE, scope: S.ORG }),
  controller.deactivateEmployee,
);

/**
 * Reveal one sensitive value.
 *
 * Gated on compensation access, not employee access: someone who may edit a
 * profile has no business reading its bank account. The service re-checks.
 */
router.post(
  '/:id/reveal',
  requirePermission({ module: M.EMPLOYEES_COMPENSATION, action: A.VIEW, scope: S.ORG }),
  validate({ body: revealSensitiveSchema }),
  controller.revealSensitiveField,
);

router.get('/:id/roles', canEditOrg, controller.getEmployeeRoles);

router.patch(
  '/:id/roles',
  canEditOrg,
  validate({ body: assignRolesSchema }),
  controller.assignEmployeeRoles,
);

/** Super admin only; the service enforces that, not this gate. */
router.post('/:id/reset-password', canEditOrg, controller.resetEmployeePassword);

export default router;
