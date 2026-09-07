/**
 * Expenses HTTP layer.
 *
 * Thin, as every other HRMS controller is: validation in the `validate`
 * middleware and the service, authorization in `requirePermission` plus the
 * service's own resource check, business rules and audit in the service.
 *
 * Every payload goes UNDER `data`, never spread beside it.
 */

import * as claims from './claim.service.js';
import * as categories from './category.service.js';
import { STORAGE_CATEGORIES } from '../../../shared/constants/hrms.js';
import { issueReadUrl, FileAccessError } from '../storage/storage.service.js';
import { HrmsValidationError } from '../hrms.errors.js';

const contextOf = (req) => ({ user: req.user, req });

// ---------------------------------------------------------------------------
// Categories and policies
// ---------------------------------------------------------------------------

/** GET /api/v1/hrms/expenses/categories */
export const listCategories = async (req, res, next) => {
  try {
    // Only an administrator has a reason to see retired categories; a claimant
    // picking one would only be offered something they cannot use.
    const data = await categories.listCategories({
      // A query-string value is always a string; `=== true` never matches.
      includeInactive: req.query.includeInactive === 'true',
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getCategory = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await categories.getCategory(req.params.id) });
  } catch (error) {
    next(error);
  }
};

export const createCategory = async (req, res, next) => {
  try {
    const data = await categories.createCategory(req.body, contextOf(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateCategory = async (req, res, next) => {
  try {
    const data = await categories.updateCategory(req.params.id, req.body, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** Soft delete, refused while claims still book to it. */
export const deleteCategory = async (req, res, next) => {
  try {
    const data = await categories.deleteCategory(req.params.id, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/expenses/policies — create or replace, keyed on category. */
export const upsertPolicy = async (req, res, next) => {
  try {
    const data = await categories.upsertPolicy(req.body, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** GET /api/v1/hrms/expenses/claims */
export const listClaims = async (req, res, next) => {
  try {
    const data = await claims.listClaims(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getClaim = async (req, res, next) => {
  try {
    const data = await claims.getClaim(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/hrms/expenses/claims
 *
 * Always filed for the ACTOR. No employeeId is read from the payload.
 */
export const createClaim = async (req, res, next) => {
  try {
    const data = await claims.createClaim(req.body, req.hrmsActor, contextOf(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateClaim = async (req, res, next) => {
  try {
    const data = await claims.updateClaim(req.params.id, req.body, req.hrmsActor, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const submitClaim = async (req, res, next) => {
  try {
    const data = await claims.submitClaim(req.params.id, req.hrmsActor, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const decideClaim = async (req, res, next) => {
  try {
    const data = await claims.decideClaim(req.params.id, req.body, req.hrmsActor, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const reimburseClaim = async (req, res, next) => {
  try {
    const data = await claims.reimburseClaim(req.params.id, req.hrmsActor, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** POST /api/v1/hrms/expenses/claims/:id/lines/:lineId/receipt */
export const uploadReceipt = async (req, res, next) => {
  try {
    if (!req.file?.buffer) {
      throw new HrmsValidationError('No receipt file was uploaded.');
    }
    const data = await claims.uploadReceipt(
      req.params.id,
      req.params.lineId,
      req.file,
      req.hrmsActor,
      contextOf(req),
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/hrms/expenses/claims/:id/lines/:lineId/receipt
 *
 * Returns a short-lived presigned URL rather than the bytes. The reference
 * streams the file from local disk; a presigned URL keeps the object private,
 * expires on its own, and is the point at which the read is audited.
 */
export const getReceiptUrl = async (req, res, next) => {
  try {
    // Ownership is checked here, against the claim, before the key is known.
    const { key } = await claims.receiptKeyFor(req.params.id, req.params.lineId, req.hrmsActor);

    // And again by the storage layer's own rule, which also writes the audit
    // entry. Two checks over one decision, because a presigned URL outlives the
    // request that minted it.
    const data = await issueReadUrl({
      category: STORAGE_CATEGORIES.EXPENSE_RECEIPT,
      key,
      actor: req.hrmsActor,
      req,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error instanceof FileAccessError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
};
