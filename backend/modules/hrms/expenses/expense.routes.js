/**
 * Expenses routes, mounted at /api/v1/hrms/expenses.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * Permissions are the reference's, decorator for decorator:
 *
 *   read claims / categories       expenses:view:self (wider satisfies it)
 *   file, edit, submit, receipts   expenses:submit:self
 *   decide, reimburse              ANY-OF expenses:approve:org | :team
 *   categories and policies        expenses:approve:org
 *
 * The reference administers categories with `expenses:approve:org` too — there
 * is no separate configuration grant, and none is invented.
 *
 * Collection reads carry no `resourceParam`: the SERVICE narrows the query by
 * scope. Reads of ONE claim are re-checked against that claim inside the
 * service, which is where the claimant's managerChain is known.
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
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  upsertExpensePolicySchema,
  createClaimSchema,
  updateClaimSchema,
  claimDecisionSchema,
  claimListQuerySchema,
} from '../../../shared/schemas/expense.js';
import * as controller from './expense.controller.js';
import { uploadReceiptFile, handleReceiptUploadErrors } from './receiptUpload.js';

const router = express.Router();

/** Anyone who can see their own expenses. Wider scopes satisfy it by ranking. */
const canView = requirePermission({ module: M.EXPENSES, action: A.VIEW, scope: S.SELF });

/** Filing, editing, submitting and attaching receipts to one's own claim. */
const canSubmit = requirePermission({ module: M.EXPENSES, action: A.SUBMIT, scope: S.SELF });

/**
 * Deciding. The gate admits any approver; the service then requires the actor
 * to be the assigned manager for a manager step, or to hold org scope for a
 * finance step — and refuses self-approval at either level.
 */
const canDecide = requirePermission(
  { module: M.EXPENSES, action: A.APPROVE, scope: S.ORG },
  { module: M.EXPENSES, action: A.APPROVE, scope: S.TEAM },
);

/** Administering the catalogue, and recording a payment. */
const canAdminister = requirePermission({ module: M.EXPENSES, action: A.APPROVE, scope: S.ORG });

// ---------------------------------------------------------------------------
// Categories and policies — before /claims, and before any /:id
// ---------------------------------------------------------------------------

router.get('/categories', canView, controller.listCategories);
router.post(
  '/categories',
  canAdminister,
  validate({ body: createExpenseCategorySchema }),
  controller.createCategory,
);
router.get('/categories/:id', canView, controller.getCategory);
router.patch(
  '/categories/:id',
  canAdminister,
  validate({ body: updateExpenseCategorySchema }),
  controller.updateCategory,
);
router.delete('/categories/:id', canAdminister, controller.deleteCategory);

router.post(
  '/policies',
  canAdminister,
  validate({ body: upsertExpensePolicySchema }),
  controller.upsertPolicy,
);

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

router.get('/claims', canView, validate({ query: claimListQuerySchema }), controller.listClaims);

router.post('/claims', canSubmit, validate({ body: createClaimSchema }), controller.createClaim);

router.get('/claims/:id', canView, controller.getClaim);

/** A draft only, and only its owner's — both enforced in the service. */
router.patch(
  '/claims/:id',
  canSubmit,
  validate({ body: updateClaimSchema }),
  controller.updateClaim,
);

router.post('/claims/:id/submit', canSubmit, controller.submitClaim);

router.post(
  '/claims/:id/decide',
  canDecide,
  validate({ body: claimDecisionSchema }),
  controller.decideClaim,
);

/** Recording that a finance-approved claim has been paid. */
router.post('/claims/:id/reimburse', canAdminister, controller.reimburseClaim);

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * Gated on SUBMIT, not VIEW: attaching a receipt is part of making a claim.
 * `handleReceiptUploadErrors` sits directly after multer so a rejected file is
 * a 400 about the file rather than an unhandled MulterError.
 */
router.post(
  '/claims/:id/lines/:lineId/receipt',
  canSubmit,
  uploadReceiptFile,
  handleReceiptUploadErrors,
  controller.uploadReceipt,
);

/** A short-lived presigned URL. Authorised twice and audited once. */
router.get('/claims/:id/lines/:lineId/receipt', canView, controller.getReceiptUrl);

export default router;
