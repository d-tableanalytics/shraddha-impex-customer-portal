/**
 * Exit HTTP handlers.
 *
 * Every response is `{ success: true, data }` — the envelope every HRMS
 * controller uses and a test enforces across all of them. The reference returns
 * bare objects and arrays.
 */

import * as exits from './exit.service.js';
import { issueReadUrl } from '../storage/storage.service.js';
import { STORAGE_CATEGORIES, AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';

const context = (req) => ({ user: req.user, req });

/** GET /api/v1/hrms/exits */
export const listExits = async (req, res, next) => {
  try {
    const data = await exits.listExits(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/exits/me — the caller's own exit, or null. */
export const myExit = async (req, res, next) => {
  try {
    const data = await exits.myExit(req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/exits/:id */
export const getExit = async (req, res, next) => {
  try {
    const data = await exits.getExit(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/exits */
export const initiateExit = async (req, res, next) => {
  try {
    const data = await exits.initiateExit(req.body, req.hrmsActor, context(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/exits/:id/manager-approve */
export const managerApprove = async (req, res, next) => {
  try {
    const data = await exits.managerApprove(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/exits/:id/hr-approve */
export const hrApprove = async (req, res, next) => {
  try {
    const data = await exits.hrApprove(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/exits/:id/open-clearances */
export const openClearances = async (req, res, next) => {
  try {
    const data = await exits.openClearances(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/exits/:id/clearances/:clearanceId */
export const updateClearance = async (req, res, next) => {
  try {
    const data = await exits.updateClearance(
      req.params.id,
      req.params.clearanceId,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/exits/:id */
export const updateExit = async (req, res, next) => {
  try {
    const data = await exits.updateExit(req.params.id, req.body, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/exits/:id/cancel */
export const cancelExit = async (req, res, next) => {
  try {
    const data = await exits.cancelExit(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/hrms/exits/:id/fnf/preview
 *
 * A GET that only reads. The reference's equivalent shares its computation with
 * the create path and zeroes loan balances as a side effect.
 */
export const previewSettlement = async (req, res, next) => {
  try {
    const data = await exits.previewSettlement(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/exits/:id/fnf */
export const createSettlement = async (req, res, next) => {
  try {
    const data = await exits.createSettlement(req.params.id, req.hrmsActor, context(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/exits/:id/fnf/disburse */
export const disburseSettlement = async (req, res, next) => {
  try {
    const data = await exits.disburseSettlement(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/exits/:id/relieving-letter */
export const generateRelievingLetter = async (req, res, next) => {
  try {
    const data = await exits.generateRelievingLetter(
      req.params.id,
      req.hrmsActor,
      context(req),
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/hrms/exits/:id/relieving-letter/url
 *
 * A short-lived URL, not the bytes and not a stable path. The reference streams
 * the file from instance disk through the API.
 *
 * Authorised twice on purpose: once against the exit request here, and once by
 * the storage rule against the object itself.
 */
export const relievingLetterUrl = async (req, res, next) => {
  try {
    const key = await exits.relievingLetterKey(req.params.id, req.hrmsActor);
    const data = await issueReadUrl({
      category: STORAGE_CATEGORIES.LETTER,
      key,
      actor: req.hrmsActor,
      req,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export default {
  listExits,
  myExit,
  getExit,
  initiateExit,
  managerApprove,
  hrApprove,
  openClearances,
  updateClearance,
  updateExit,
  cancelExit,
  previewSettlement,
  createSettlement,
  disburseSettlement,
  generateRelievingLetter,
  relievingLetterUrl,
};

// Re-exported so the routes file can name the audit action for the letter read
// without importing the constants module twice.
export const LETTER_VIEW_AUDIT = AUDIT_ACTIONS.EXIT_LETTER_VIEWED;
