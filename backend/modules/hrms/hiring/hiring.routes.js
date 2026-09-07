/**
 * Hiring routes, mounted at /api/v1/hrms/hiring.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * ---------------------------------------------------------------------------
 * Permissions, taken from the reference's decorators
 * ---------------------------------------------------------------------------
 *   list / get everything     ANY-OF hiring:view:org | hiring:view:team
 *   every write               hiring:edit:org
 *   résumé download           hiring:view:org   (candidate.controller.ts:75)
 *   my interviews             any employee — scoped to the actor
 *
 * No permission is invented. Both keys already exist in the matrix:
 * `hiring:view:org` on hr_admin, recruiter, super_admin and the auditor,
 * `hiring:view:team` on the manager ("interviewer view", matrix.js:186), and
 * `hiring:edit:org` on hr_admin, recruiter and super_admin.
 *
 * ---------------------------------------------------------------------------
 * The résumé is a `view:org` read, not `view:team`
 * ---------------------------------------------------------------------------
 * The reference draws this line and it is the right one. A manager on an
 * interview panel needs to see that a candidate exists and to file feedback;
 * a CV carries a home address, a full employment history and a phone number,
 * and it is not part of sitting on a panel.
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
  createRequisitionSchema,
  updateRequisitionSchema,
  requisitionStatusSchema,
  requisitionListQuerySchema,
  createPostingSchema,
  postingListQuerySchema,
  createCandidateSchema,
  updateCandidateSchema,
  candidateListQuerySchema,
  createApplicationSchema,
  moveStageSchema,
  applicationListQuerySchema,
  scheduleInterviewSchema,
  interviewStatusSchema,
  submitFeedbackSchema,
  interviewListQuerySchema,
  createOfferSchema,
  offerListQuerySchema,
  generateJdSchema,
} from '../../../shared/schemas/hiring.js';
import { uploadResumeFile, handleResumeUploadErrors } from './resumeUpload.js';
import * as controller from './hiring.controller.js';

const router = express.Router();

/** Seeing the pipeline. A panel member holds the team-scoped grant. */
const canView = requirePermission(
  { module: M.HIRING, action: A.VIEW, scope: S.ORG },
  { module: M.HIRING, action: A.VIEW, scope: S.TEAM },
);

/** Recruiting: raising requisitions, moving candidates, making offers. */
const canEdit = requirePermission({ module: M.HIRING, action: A.EDIT, scope: S.ORG });

/** Reading a CV. Org-wide only — see the header. */
const canViewOrg = requirePermission({ module: M.HIRING, action: A.VIEW, scope: S.ORG });

// ---------------------------------------------------------------------------
// My interviews — before /interviews/:id, so `mine` is never read as an id
// ---------------------------------------------------------------------------

/**
 * The caller's own panel.
 *
 * `view:self` is not a hiring scope in the matrix, so the gate is the
 * team-scoped view every interviewer holds — and the SERVICE pins the query to
 * the actor's own employee id, so there is nothing to tamper with.
 */
router.get(
  '/interviews/mine',
  canView,
  validate({ query: interviewListQuerySchema }),
  controller.listMyInterviews,
);

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

router.get('/requisitions', canView, validate({ query: requisitionListQuerySchema }), controller.listRequisitions);
router.post('/requisitions', canEdit, validate({ body: createRequisitionSchema }), controller.createRequisition);
router.get('/requisitions/:id', canView, controller.getRequisition);
router.patch('/requisitions/:id', canEdit, validate({ body: updateRequisitionSchema }), controller.updateRequisition);

/**
 * Approve. The gate says "may this person approve anything"; the SERVICE
 * refuses an approver who raised the requisition themselves.
 */
router.post('/requisitions/:id/approve', canEdit, controller.approveRequisition);
router.post(
  '/requisitions/:id/status',
  canEdit,
  validate({ body: requisitionStatusSchema }),
  controller.setRequisitionStatus,
);

/** The Kanban board for one requisition. */
router.get('/requisitions/:requisitionId/pipeline', canView, controller.pipelineBoard);

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

router.get('/postings', canView, validate({ query: postingListQuerySchema }), controller.listPostings);
router.post('/postings', canEdit, validate({ body: createPostingSchema }), controller.createPosting);
router.post('/postings/:id/publish', canEdit, controller.publishPosting);
router.post('/postings/:id/close', canEdit, controller.closePosting);

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

router.get('/candidates', canView, validate({ query: candidateListQuerySchema }), controller.listCandidates);
router.post('/candidates', canEdit, validate({ body: createCandidateSchema }), controller.createCandidate);
router.get('/candidates/:id', canView, controller.getCandidate);
router.patch('/candidates/:id', canEdit, validate({ body: updateCandidateSchema }), controller.updateCandidate);

/**
 * Résumé upload. `handleResumeUploadErrors` sits directly after multer so an
 * oversized or wrong-typed file is a 400/413 rather than escaping as a 500.
 */
router.post(
  '/candidates/:id/resume',
  canEdit,
  uploadResumeFile,
  handleResumeUploadErrors,
  controller.uploadResume,
);
router.get('/candidates/:id/resume-url', canViewOrg, controller.getResumeUrl);

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

router.get('/applications', canView, validate({ query: applicationListQuerySchema }), controller.listApplications);
router.post('/applications', canEdit, validate({ body: createApplicationSchema }), controller.createApplication);
router.get('/applications/:id', canView, controller.getApplication);
router.post('/applications/:id/move', canEdit, validate({ body: moveStageSchema }), controller.moveApplicationStage);

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

router.get('/interviews', canView, validate({ query: interviewListQuerySchema }), controller.listInterviews);
router.post('/interviews', canEdit, validate({ body: scheduleInterviewSchema }), controller.scheduleInterview);
router.post('/interviews/:id/status', canEdit, validate({ body: interviewStatusSchema }), controller.setInterviewStatus);
router.get('/interviews/:id/feedback', canView, controller.listFeedback);

/**
 * Submit feedback.
 *
 * `canView` is the outer gate only — a panellist holds the team-scoped view and
 * usually nothing more. The SERVICE requires the actor to be ON the panel, so
 * a recruiter with `edit:org` cannot file a review for a room they were not in.
 */
router.post(
  '/interviews/:id/feedback',
  canView,
  validate({ body: submitFeedbackSchema }),
  controller.submitFeedback,
);

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

router.get('/offers', canView, validate({ query: offerListQuerySchema }), controller.listOffers);
router.post('/offers', canEdit, validate({ body: createOfferSchema }), controller.createOffer);
router.post('/offers/:id/send', canEdit, controller.sendOffer);

// ---------------------------------------------------------------------------
// Drafting aid
// ---------------------------------------------------------------------------

router.post('/jd/draft', canEdit, validate({ body: generateJdSchema }), controller.generateJd);

export default router;
