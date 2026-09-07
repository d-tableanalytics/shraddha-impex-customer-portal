/**
 * Asset routes, mounted at /api/v1/hrms/assets.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * Permissions follow the reference, with one correction:
 *
 *   read the catalogue        assets:view:self  (wider satisfies it)
 *   my assets, my requests    assets:view:self
 *   raise / cancel a request  assets:submit:self   <- the reference gates this
 *                             on `view:self`, a READ grant authorising a WRITE
 *   inventory reads           assets:view:org
 *   everything administrative assets:assign:org
 *
 * Collection reads carry no resource check: the SERVICE narrows by scope — the
 * request list returns only the caller's own rows unless they administer
 * assets, and an assignment read for somebody else requires org scope.
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
  createAssetCategorySchema,
  updateAssetCategorySchema,
  createAssetItemSchema,
  updateAssetItemSchema,
  setAssetStatusSchema,
  assignAssetSchema,
  returnAssetSchema,
  createAssetRequestSchema,
  decideAssetRequestSchema,
  fulfillAssetRequestSchema,
} from '../../../shared/schemas/asset.js';
import * as controller from './asset.controller.js';

const router = express.Router();

/** Anyone with the self-service baseline. Wider scopes satisfy it by ranking. */
const canView = requirePermission({ module: M.ASSETS, action: A.VIEW, scope: S.SELF });

/** Raising and withdrawing one's own request. */
const canRequest = requirePermission({ module: M.ASSETS, action: A.SUBMIT, scope: S.SELF });

/** Seeing the estate, rather than one's own kit. */
const canViewInventory = requirePermission({ module: M.ASSETS, action: A.VIEW, scope: S.ORG });

/** IT and HR: the catalogue, the inventory, assignment and the request queue. */
const canAdminister = requirePermission({ module: M.ASSETS, action: A.ASSIGN, scope: S.ORG });

// ---------------------------------------------------------------------------
// Categories — everyone reads them (a requester picks one), IT writes them.
// ---------------------------------------------------------------------------

router.get('/categories', canView, controller.listCategories);
router.post(
  '/categories',
  canAdminister,
  validate({ body: createAssetCategorySchema }),
  controller.createCategory,
);
router.patch(
  '/categories/:id',
  canAdminister,
  validate({ body: updateAssetCategorySchema }),
  controller.updateCategory,
);
router.delete('/categories/:id', canAdminister, controller.deleteCategory);

// ---------------------------------------------------------------------------
// Assignments. Declared before `/items/:id` so `/items/assign` is not read as
// an id, and `/assignments/me` before `/assignments/employee/:id`.
// ---------------------------------------------------------------------------

router.get('/assignments/me', canView, controller.myAssignments);
router.get(
  '/assignments/employee/:employeeId',
  canView,
  controller.employeeAssignments,
);

router.post(
  '/items/assign',
  canAdminister,
  validate({ body: assignAssetSchema }),
  controller.assignItem,
);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

router.get('/requests', canView, controller.listRequests);
router.post(
  '/requests',
  canRequest,
  validate({ body: createAssetRequestSchema }),
  controller.createRequest,
);
router.post(
  '/requests/:id/decide',
  canAdminister,
  validate({ body: decideAssetRequestSchema }),
  controller.decideRequest,
);
router.post(
  '/requests/:id/fulfill',
  canAdminister,
  validate({ body: fulfillAssetRequestSchema }),
  controller.fulfillRequest,
);
/** The requester or an administrator; the service decides which. */
router.post('/requests/:id/cancel', canRequest, controller.cancelRequest);

// ---------------------------------------------------------------------------
// Inventory. `/items/:id` last, so it cannot shadow the nested routes above.
// ---------------------------------------------------------------------------

router.get('/items', canViewInventory, controller.listItems);
router.post(
  '/items',
  canAdminister,
  validate({ body: createAssetItemSchema }),
  controller.createItem,
);
router.post(
  '/items/:id/status',
  canAdminister,
  validate({ body: setAssetStatusSchema }),
  controller.setItemStatus,
);
router.post(
  '/items/:id/return',
  canAdminister,
  validate({ body: returnAssetSchema }),
  controller.returnItem,
);
router.patch(
  '/items/:id',
  canAdminister,
  validate({ body: updateAssetItemSchema }),
  controller.updateItem,
);
router.get('/items/:id', canViewInventory, controller.getItem);

export default router;
