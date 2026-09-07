/**
 * Org Structure routes, mounted at /api/v1/hrms/org.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * ---------------------------------------------------------------------------
 * Permissions, taken from the reference decorator for decorator
 * ---------------------------------------------------------------------------
 *   list / get        org-structure:view:self   (department.controller.ts:33)
 *   create/update/del org-structure:edit:org    (department.controller.ts:45)
 *   tree              ANY-OF org-structure:view:org OR employees:view:team
 *                                               (organization.controller.ts:34)
 *
 * `view:self` on the reads looks lax and is not: the module is in the SELF
 * baseline, so every HRMS role can read the catalogues, which is what makes the
 * department and location pickers work on the employee form. Departments and
 * locations are a company's org chart furniture, not personal data. Writing
 * them is `edit:org`, held only by super_admin and hr_admin.
 *
 * ---------------------------------------------------------------------------
 * The tree's ANY-OF, and who it excludes
 * ---------------------------------------------------------------------------
 * An ordinary employee holds neither grant and is refused - the reference's
 * behaviour, kept deliberately. Its own UI defaults a non-editor to the Org
 * Chart tab, so in the reference that tab always 403s for an employee; that is
 * a UI bug to resolve when the tab is built, not a reason to widen an endpoint
 * that would otherwise expose the whole company's reporting lines to everyone.
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
  createDepartmentSchema,
  updateDepartmentSchema,
  createLocationSchema,
  updateLocationSchema,
  orgListQuerySchema,
} from '../../../shared/schemas/org.js';
import * as controller from './org.controller.js';

const router = express.Router();

/** Anyone with HRMS access may read the catalogues. */
const canRead = requirePermission({ module: M.ORG_STRUCTURE, action: A.VIEW, scope: S.SELF });

/** Only super_admin and hr_admin may change them. */
const canEdit = requirePermission({ module: M.ORG_STRUCTURE, action: A.EDIT, scope: S.ORG });

/**
 * `includeDeleted` is the one query parameter, and it exists because WE soft
 * delete (O-3) where the reference hard deletes. An employee can still be
 * assigned to a retired department, so resolving its name for display has to be
 * possible. The schema is `.strict()`, so any other query parameter is a 400
 * rather than being silently ignored.
 */
const listQuery = validate({ query: orgListQuerySchema });

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

router.get('/departments', canRead, listQuery, controller.listDepartments);

router.post(
  '/departments',
  canEdit,
  validate({ body: createDepartmentSchema }),
  controller.createDepartment,
);

router.get('/departments/:id', canRead, controller.getDepartment);

router.patch(
  '/departments/:id',
  canEdit,
  validate({ body: updateDepartmentSchema }),
  controller.updateDepartment,
);

/** Soft delete. The service refuses while live employees reference it. */
router.delete('/departments/:id', canEdit, controller.deleteDepartment);

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

router.get('/locations', canRead, listQuery, controller.listLocations);

router.post(
  '/locations',
  canEdit,
  validate({ body: createLocationSchema }),
  controller.createLocation,
);

router.get('/locations/:id', canRead, controller.getLocation);

router.patch(
  '/locations/:id',
  canEdit,
  validate({ body: updateLocationSchema }),
  controller.updateLocation,
);

router.delete('/locations/:id', canEdit, controller.deleteLocation);

// ---------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------

router.get(
  '/tree',
  // ANY-OF, matching the reference. No resourceParam: this is a collection
  // read, and the SERVICE narrows it to the actor's own subtree when they do
  // not hold an org-wide grant.
  requirePermission(
    { module: M.ORG_STRUCTURE, action: A.VIEW, scope: S.ORG },
    { module: M.EMPLOYEES, action: A.VIEW, scope: S.TEAM },
  ),
  controller.getTree,
);

export default router;
