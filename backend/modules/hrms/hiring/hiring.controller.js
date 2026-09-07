/**
 * Hiring HTTP layer.
 *
 * Thin, as every other HRMS controller is: validation in the `validate`
 * middleware, authorization in `requirePermission` and re-checked in the
 * services, business rules and audit in the services.
 *
 * Every payload goes UNDER `data`, never spread beside it — the envelope bug
 * that once killed the employee directory.
 */

import * as requisitions from './requisition.service.js';
import * as candidates from './candidate.service.js';
import * as applications from './application.service.js';
import * as interviews from './interview.service.js';
import * as offers from './offer.service.js';
import * as careers from './careers.service.js';
import { generateJobDescription } from './aiJd.service.js';
import { FileAccessError } from '../storage/storage.service.js';

const contextOf = (req) => ({
  user: req.user,
  req,
  actorEmployeeId: req.hrmsActor?.employeeId ?? null,
});

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof FileAccessError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/** Where a public caller came from, for the audit trail on refusals. */
const publicMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

export const listRequisitions = handler(async (req, res) =>
  ok(res, await requisitions.listRequisitions(req.query)),
);
export const getRequisition = handler(async (req, res) =>
  ok(res, await requisitions.getRequisition(req.params.id)),
);
export const createRequisition = handler(async (req, res) =>
  ok(res, await requisitions.createRequisition(req.body, contextOf(req)), 201),
);
export const updateRequisition = handler(async (req, res) =>
  ok(res, await requisitions.updateRequisition(req.params.id, req.body, contextOf(req))),
);
export const approveRequisition = handler(async (req, res) =>
  ok(res, await requisitions.approveRequisition(req.params.id, req.hrmsActor, contextOf(req))),
);
export const setRequisitionStatus = handler(async (req, res) =>
  ok(res, await requisitions.setRequisitionStatus(req.params.id, req.body, contextOf(req))),
);

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

export const listPostings = handler(async (req, res) =>
  ok(res, await requisitions.listPostings(req.query)),
);
export const createPosting = handler(async (req, res) =>
  ok(res, await requisitions.createPosting(req.body, contextOf(req)), 201),
);
export const publishPosting = handler(async (req, res) =>
  ok(res, await requisitions.publishPosting(req.params.id, contextOf(req))),
);
export const closePosting = handler(async (req, res) =>
  ok(res, await requisitions.closePosting(req.params.id, contextOf(req))),
);

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export const listCandidates = handler(async (req, res) =>
  ok(res, await candidates.listCandidates(req.query)),
);
export const getCandidate = handler(async (req, res) =>
  ok(res, await candidates.getCandidate(req.params.id)),
);
export const createCandidate = handler(async (req, res) =>
  ok(res, await candidates.createCandidate(req.body, contextOf(req)), 201),
);
export const updateCandidate = handler(async (req, res) =>
  ok(res, await candidates.updateCandidate(req.params.id, req.body, contextOf(req))),
);

export const uploadResume = handler(async (req, res) =>
  ok(
    res,
    await candidates.uploadResume(
      req.params.id,
      {
        buffer: req.file?.buffer,
        mimeType: req.file?.mimetype,
        filename: req.file?.originalname,
      },
      contextOf(req),
    ),
    201,
  ),
);

/**
 * A short-lived presigned URL for a résumé.
 *
 * The bytes travel browser ↔ S3 and never pass through this process, and the
 * storage service writes the audit entry — issuing the URL is the auditable
 * act, because a presigned link is usable for its whole lifetime.
 */
export const getResumeUrl = handler(async (req, res) =>
  ok(res, await candidates.issueResumeUrl(req.params.id, req.hrmsActor, req)),
);

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export const listApplications = handler(async (req, res) =>
  ok(res, await applications.listApplications(req.query)),
);
export const getApplication = handler(async (req, res) =>
  ok(res, await applications.getApplication(req.params.id)),
);
export const createApplication = handler(async (req, res) =>
  ok(res, await applications.createApplication(req.body, contextOf(req)), 201),
);
export const moveApplicationStage = handler(async (req, res) =>
  ok(res, await applications.moveStage(req.params.id, req.body, contextOf(req))),
);

/** The Kanban board for one requisition. Not paginated — see the service. */
export const pipelineBoard = handler(async (req, res) =>
  ok(res, await applications.pipelineBoard(req.params.requisitionId)),
);

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

export const listInterviews = handler(async (req, res) =>
  ok(res, await interviews.listInterviews(req.query, req.hrmsActor?.employeeId)),
);

/**
 * "My interviews".
 *
 * The employee comes from the actor, so there is no id to tamper with — which
 * is why this route needs no permission beyond holding an employee record.
 */
export const listMyInterviews = handler(async (req, res) =>
  ok(res, await interviews.listMyInterviews(req.hrmsActor?.employeeId, req.query)),
);

export const scheduleInterview = handler(async (req, res) =>
  ok(res, await interviews.scheduleInterview(req.body, contextOf(req)), 201),
);
export const setInterviewStatus = handler(async (req, res) =>
  ok(res, await interviews.setInterviewStatus(req.params.id, req.body, contextOf(req))),
);
export const listFeedback = handler(async (req, res) =>
  ok(res, await interviews.listFeedback(req.params.id)),
);
export const submitFeedback = handler(async (req, res) =>
  ok(
    res,
    await interviews.submitFeedback(
      req.params.id,
      req.body,
      req.hrmsActor?.employeeId,
      contextOf(req),
    ),
    201,
  ),
);

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export const listOffers = handler(async (req, res) =>
  ok(res, await offers.listOffers(req.query)),
);
export const createOffer = handler(async (req, res) =>
  ok(res, await offers.createOffer(req.body, contextOf(req)), 201),
);

/**
 * Send an offer.
 *
 * The response carries the candidate's access token ONCE. It is never stored in
 * plaintext, never audited and never returned again — the recruiter delivers
 * the link.
 */
export const sendOffer = handler(async (req, res) =>
  ok(res, await offers.sendOffer(req.params.id, contextOf(req))),
);

// ---------------------------------------------------------------------------
// AI job description
// ---------------------------------------------------------------------------

export const generateJd = handler(async (req, res) => ok(res, generateJobDescription(req.body)));

// ---------------------------------------------------------------------------
// Public careers — no authentication
// ---------------------------------------------------------------------------

export const publicListRoles = handler(async (req, res) =>
  ok(res, await careers.listOpenRoles()),
);
export const publicGetRole = handler(async (req, res) =>
  ok(res, await careers.getOpenRole(req.params.slug)),
);
export const publicApply = handler(async (req, res) =>
  ok(res, await careers.applyToRole(req.params.slug, req.body, publicMeta(req)), 201),
);

/** All three of these are authorised by the TOKEN in the path, never by an id. */
export const publicViewOffer = handler(async (req, res) =>
  ok(res, await offers.publicViewOffer(req.params.token, publicMeta(req))),
);
export const publicAcceptOffer = handler(async (req, res) =>
  ok(res, await offers.acceptOffer(req.params.token, req.body, publicMeta(req))),
);
export const publicRejectOffer = handler(async (req, res) =>
  ok(res, await offers.rejectOffer(req.params.token, req.body, publicMeta(req))),
);

export default {
  listRequisitions,
  getRequisition,
  createRequisition,
  updateRequisition,
  approveRequisition,
  setRequisitionStatus,
  listPostings,
  createPosting,
  publishPosting,
  closePosting,
  listCandidates,
  getCandidate,
  createCandidate,
  updateCandidate,
  uploadResume,
  getResumeUrl,
  listApplications,
  getApplication,
  createApplication,
  moveApplicationStage,
  pipelineBoard,
  listInterviews,
  listMyInterviews,
  scheduleInterview,
  setInterviewStatus,
  listFeedback,
  submitFeedback,
  listOffers,
  createOffer,
  sendOffer,
  generateJd,
  publicListRoles,
  publicGetRole,
  publicApply,
  publicViewOffer,
  publicAcceptOffer,
  publicRejectOffer,
};
