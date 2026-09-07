/**
 * Document routes, mounted at /api/v1/hrms/documents.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * Permissions, with the reference's one correction:
 *
 *   read the library, my repo,
 *   policies, a download URL   documents:view:self  (wider satisfies it)
 *   upload / edit / delete
 *   my OWN document            documents:submit:self
 *   acknowledge a policy       documents:submit:self
 *   folders, library uploads,
 *   publishing, ack status     documents:edit:org
 *
 * The reference gates every one of those writes on `documents:view:org` — a
 * read grant authorising a write. Neither `submit:self` nor `edit:org` existed
 * for this module before; both are added to the matrix additively.
 *
 * Collection reads carry no resource check: the SERVICE narrows the query by
 * scope, and a read of ONE document goes through the same filter as the list.
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
  createFolderSchema,
  updateFolderSchema,
  updateDocumentSchema,
  publishPolicySchema,
  acknowledgeDocumentSchema,
} from '../../../shared/schemas/document.js';
import * as controller from './document.controller.js';
import { uploadDocumentFile, handleDocumentUploadErrors } from './documentUpload.js';

const router = express.Router();

/** Anyone with the self-service baseline. */
const canView = requirePermission({ module: M.DOCUMENTS, action: A.VIEW, scope: S.SELF });

/** Uploading to one's own repository, and acknowledging policies. */
const canSubmit = requirePermission({ module: M.DOCUMENTS, action: A.SUBMIT, scope: S.SELF });

/** HR: folders, the library, publishing, and the acknowledgment register. */
const canAdminister = requirePermission({ module: M.DOCUMENTS, action: A.EDIT, scope: S.ORG });

// ---------------------------------------------------------------------------
// Folders. Declared before `/:id` so `folders` is not read as a document id.
// ---------------------------------------------------------------------------

router.get('/folders', canView, controller.listFolders);
router.post(
  '/folders',
  canAdminister,
  validate({ body: createFolderSchema }),
  controller.createFolder,
);
router.patch(
  '/folders/:id',
  canAdminister,
  validate({ body: updateFolderSchema }),
  controller.updateFolder,
);
router.delete('/folders/:id', canAdminister, controller.deleteFolder);

// ---------------------------------------------------------------------------
// Fixed paths, before the `/:id` family.
// ---------------------------------------------------------------------------

router.get('/me', canView, controller.myDocuments);
router.get('/policies/pending', canView, controller.myPendingPolicies);
router.get('/', canView, controller.listDocuments);

/**
 * Upload. The permission gate is the SELF one; the service decides whether this
 * actor may write to the library or only to their own repository — an
 * administrator needs `edit:org` for a company document, and the service
 * enforces it.
 */
router.post(
  '/',
  canSubmit,
  uploadDocumentFile,
  handleDocumentUploadErrors,
  controller.uploadDocument,
);

// ---------------------------------------------------------------------------
// One document. Nested paths before the bare `/:id`.
// ---------------------------------------------------------------------------

/** A presigned URL, not the bytes — and never the storage key. */
router.get('/:id/url', canView, controller.documentUrl);

router.post(
  '/:id/policy',
  canAdminister,
  validate({ body: publishPolicySchema }),
  controller.publishPolicy,
);
router.post(
  '/:id/acknowledge',
  canSubmit,
  validate({ body: acknowledgeDocumentSchema }),
  controller.acknowledgePolicy,
);
router.get('/:id/acknowledgments', canAdminister, controller.acknowledgmentStatus);

router.patch(
  '/:id',
  canSubmit,
  validate({ body: updateDocumentSchema }),
  controller.updateDocument,
);
router.delete('/:id', canSubmit, controller.deleteDocument);
router.get('/:id', canView, controller.getDocument);

export default router;
