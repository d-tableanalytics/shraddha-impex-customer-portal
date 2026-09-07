/**
 * Document HTTP handlers.
 *
 * Every response is `{ success: true, data }` — the envelope every HRMS
 * controller uses and a test enforces across all of them. The reference returns
 * bare objects and arrays.
 */

import * as documents from './document.service.js';
import { issueReadUrl } from '../storage/storage.service.js';

const context = (req) => ({ user: req.user, req });

// ---- folders --------------------------------------------------------------

/** GET /api/v1/hrms/documents/folders */
export const listFolders = async (req, res, next) => {
  try {
    const data = await documents.listFolders(req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/documents/folders */
export const createFolder = async (req, res, next) => {
  try {
    const data = await documents.createFolder(req.body, req.hrmsActor, context(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/documents/folders/:id */
export const updateFolder = async (req, res, next) => {
  try {
    const data = await documents.updateFolder(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/v1/hrms/documents/folders/:id — soft. */
export const deleteFolder = async (req, res, next) => {
  try {
    const data = await documents.deleteFolder(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---- documents ------------------------------------------------------------

/** GET /api/v1/hrms/documents */
export const listDocuments = async (req, res, next) => {
  try {
    const data = await documents.listDocuments(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/documents/me — the caller's own repository. */
export const myDocuments = async (req, res, next) => {
  try {
    const data = await documents.listDocuments(req.hrmsActor, {
      ...req.query,
      scope: 'employee',
      employeeId: req.hrmsActor?.employeeId
        ? String(req.hrmsActor.employeeId)
        : undefined,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/documents/policies/pending — what I still owe. */
export const myPendingPolicies = async (req, res, next) => {
  try {
    const data = await documents.myPendingPolicies(req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/documents/:id */
export const getDocument = async (req, res, next) => {
  try {
    const data = await documents.getDocument(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/documents — multipart. */
export const uploadDocument = async (req, res, next) => {
  try {
    const data = await documents.uploadDocument(
      req.file,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/documents/:id */
export const updateDocument = async (req, res, next) => {
  try {
    const data = await documents.updateDocument(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/v1/hrms/documents/:id */
export const deleteDocument = async (req, res, next) => {
  try {
    const data = await documents.deleteDocument(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/hrms/documents/:id/url
 *
 * A short-lived URL, not the bytes and not the key.
 *
 * The reference streams the file through the API with the client-declared
 * content type and `Content-Disposition: inline`, which turns an uploaded HTML
 * file into script execution on the API origin. Nothing is served from this
 * origin here, and the object has no publicly addressable form.
 *
 * Authorised twice on purpose: once against the document, and once by the
 * storage rule against the object itself.
 */
export const documentUrl = async (req, res, next) => {
  try {
    const { key, category, name } = await documents.documentStorageKey(
      req.params.id,
      req.hrmsActor,
    );
    const link = await issueReadUrl({
      category,
      key,
      actor: req.hrmsActor,
      req,
    });
    res.status(200).json({ success: true, data: { ...link, name } });
  } catch (error) {
    next(error);
  }
};

// ---- policies -------------------------------------------------------------

/** POST /api/v1/hrms/documents/:id/policy */
export const publishPolicy = async (req, res, next) => {
  try {
    const data = await documents.publishPolicy(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/documents/:id/acknowledge */
export const acknowledgePolicy = async (req, res, next) => {
  try {
    const data = await documents.acknowledgePolicy(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/documents/:id/acknowledgments */
export const acknowledgmentStatus = async (req, res, next) => {
  try {
    const data = await documents.acknowledgmentStatus(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export default {
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  listDocuments,
  myDocuments,
  myPendingPolicies,
  getDocument,
  uploadDocument,
  updateDocument,
  deleteDocument,
  documentUrl,
  publishPolicy,
  acknowledgePolicy,
  acknowledgmentStatus,
};
