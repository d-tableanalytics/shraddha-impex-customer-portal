/**
 * Hiring collections.
 *
 * Ported from the reference's Prisma models, adapted to Mongoose and the
 * accepted decisions:
 *
 *   AD-1   single tenant, so no organizationId
 *   AD-2   ObjectId keys, no foreign keys — the services check references,
 *          and money is Decimal128
 *   AD-7   résumés and offer letters live in object storage, never on the
 *          instance's disk
 *   AD-13  every list is server-paginated, so the indexes below matter
 *
 * Grouped in one file because these seven collections are one aggregate: an
 * application is meaningless without its requisition and candidate, and
 * feedback without its interview. Attendance's three models earned separate
 * files because each is independently useful; these are not.
 */

import mongoose from 'mongoose';

import {
  REQUISITION_STATUSES,
  CANDIDATE_SOURCES,
  APPLICATION_STAGES,
  INTERVIEW_STATUSES,
  INTERVIEW_DECISIONS,
} from '../../shared/constants/hiring.js';

const { Schema } = mongoose;

/** A monetary field. Always Decimal128; never `Number` (AD-2). */
const money = (extra = {}) => ({ type: Schema.Types.Decimal128, default: null, ...extra });

const isoDay = { type: String, match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'] };

// ---------------------------------------------------------------------------
// JobRequisition
// ---------------------------------------------------------------------------

const jobRequisitionSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },

    /**
     * Optional references to Org Structure.
     *
     * AD-2 removed foreign keys, so a dangling id would not be caught by the
     * database — the service validates them through the reference provider,
     * exactly as Employee Master does for the same two fields.
     */
    departmentId: { type: Schema.Types.ObjectId, default: null, index: true },
    locationId: { type: Schema.Types.ObjectId, default: null },

    headcount: { type: Number, required: true, min: 1, max: 100, default: 1 },

    budgetMin: money(),
    budgetMax: money(),

    status: {
      type: String,
      enum: REQUISITION_STATUSES,
      required: true,
      default: 'draft',
      index: true,
    },
    businessJustification: { type: String, default: null, maxlength: 2000 },

    /** Why it was cancelled. The reference records nothing. */
    cancellationReason: { type: String, default: null, maxlength: 500 },

    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, collection: 'hrms_job_requisitions' },
);

/** The list's default ordering: open work first, newest first. */
jobRequisitionSchema.index({ deletedAt: 1, status: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// JobPosting
// ---------------------------------------------------------------------------

const jobPostingSchema = new Schema(
  {
    requisitionId: { type: Schema.Types.ObjectId, required: true, index: true },

    /**
     * The public URL segment.
     *
     * Server-generated from the title plus random suffix, never accepted from a
     * caller: a client-chosen slug is a way to squat a path or to probe which
     * requisitions exist.
     */
    publicSlug: { type: String, required: true, trim: true, maxlength: 160 },

    description: { type: String, required: true, maxlength: 10_000 },
    requirements: { type: String, required: true, maxlength: 5_000 },

    /**
     * Job-board names. Stored for parity and never acted on — the reference
     * writes this array and no code path reads it. Documented rather than
     * dropped, so the field is not silently lost on a future migration.
     */
    boardIntegrations: { type: [String], default: [] },

    publishedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, collection: 'hrms_job_postings' },
);

jobPostingSchema.index(
  { publicSlug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** The careers page: everything published and not yet closed. */
jobPostingSchema.index({ publishedAt: 1, closedAt: 1 });

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

const candidateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, default: null, trim: true, maxlength: 30 },

    /**
     * Object key for the résumé, NOT a URL or a path.
     *
     * The reference streams the file from local disk through its API. AD-7
     * requires the storage abstraction and a short-lived presigned read; a key
     * means there is no address to leak.
     */
    resumeKey: { type: String, default: null, maxlength: 300 },
    resumeFilename: { type: String, default: null, maxlength: 200 },
    resumeContentType: { type: String, default: null, maxlength: 120 },

    source: { type: String, enum: CANDIDATE_SOURCES, default: 'manual' },
    currentEmployer: { type: String, default: null, trim: true, maxlength: 120 },

    /** Decimal128, per AD-2 — this is a salary figure. */
    expectedSalary: money(),
    noticePeriodDays: { type: Number, default: null, min: 0, max: 365 },

    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, collection: 'hrms_candidates' },
);

/**
 * One candidate per email.
 *
 * The reference's `@@unique([organizationId, email])` becomes a plain unique
 * index (AD-1), partial over live rows so a deleted candidate's address can be
 * reused. It is also what makes the public apply flow's upsert safe under two
 * simultaneous applications from the same person.
 */
candidateSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
candidateSchema.index({ deletedAt: 1, createdAt: -1 });
candidateSchema.index({ name: 'text', email: 'text' }, { name: 'candidate_search' });

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

const stageEventSchema = new Schema(
  {
    stage: { type: String, enum: APPLICATION_STAGES, required: true },
    at: { type: Date, required: true, default: Date.now },
    byUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: null, maxlength: 500 },
  },
  { _id: false },
);

const applicationSchema = new Schema(
  {
    candidateId: { type: Schema.Types.ObjectId, required: true, index: true },
    requisitionId: { type: Schema.Types.ObjectId, required: true, index: true },

    stage: {
      type: String,
      enum: APPLICATION_STAGES,
      required: true,
      default: 'applied',
      index: true,
    },

    appliedAt: { type: Date, default: Date.now },
    currentStageAt: { type: Date, default: Date.now },
    rejectionReason: { type: String, default: null, maxlength: 500 },

    /**
     * Every stage this application has passed through.
     *
     * The reference keeps only the current stage and its timestamp, so
     * "how long did screening take" is unanswerable and a mis-click that
     * advanced someone leaves no trace. An append-only trail costs one small
     * array and answers both.
     */
    stageHistory: { type: [stageEventSchema], default: () => [] },

    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'hrms_applications' },
);

/** One application per candidate per requisition. */
applicationSchema.index({ candidateId: 1, requisitionId: 1 }, { unique: true });
/** The Kanban: one requisition's board, newest movement first. */
applicationSchema.index({ requisitionId: 1, stage: 1, currentStageAt: -1 });

// ---------------------------------------------------------------------------
// Interview
// ---------------------------------------------------------------------------

const panelMemberSchema = new Schema(
  {
    /**
     * The panellist's EMPLOYEE id, with their user id alongside.
     *
     * The reference stores only `userId` and reads `User.displayName`. Here the
     * canonical person is the Employee (AD-4), and the user id is kept because
     * feedback is submitted by whoever is signed in — so both halves of the
     * identity are on the row and neither needs a join to check.
     */
    employeeId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, default: null },
    name: { type: String, required: true, maxlength: 200 },
  },
  { _id: false },
);

const interviewSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, required: true, index: true },
    round: { type: Number, required: true, min: 1, max: 10, default: 1 },
    panel: { type: [panelMemberSchema], default: [] },

    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, required: true, min: 15, max: 300, default: 45 },
    meetingLink: { type: String, default: null, maxlength: 500 },

    status: {
      type: String,
      enum: INTERVIEW_STATUSES,
      required: true,
      default: 'scheduled',
      index: true,
    },

    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'hrms_interviews' },
);

interviewSchema.index({ applicationId: 1, round: 1 });
/** "My interviews": the panellist lookup, which must not scan the collection. */
interviewSchema.index({ 'panel.employeeId': 1, scheduledAt: -1 });
interviewSchema.index({ scheduledAt: -1 });

// ---------------------------------------------------------------------------
// InterviewFeedback
// ---------------------------------------------------------------------------

const interviewFeedbackSchema = new Schema(
  {
    interviewId: { type: Schema.Types.ObjectId, required: true, index: true },
    /** Resolved from the AUTHENTICATED actor, never from the request body. */
    interviewerEmployeeId: { type: Schema.Types.ObjectId, required: true },
    interviewerUserId: { type: Schema.Types.ObjectId, default: null },

    /** criterion -> 1..5. Mixed because the criteria are free-form. */
    ratings: { type: Schema.Types.Mixed, required: true },
    comments: { type: String, default: null, maxlength: 4000 },
    decision: { type: String, enum: INTERVIEW_DECISIONS, required: true },

    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'hrms_interview_feedback' },
);

/**
 * One review per interviewer per interview.
 *
 * The index is the real guarantee: two rapid submissions both read "no
 * feedback" and only one insert survives, so a panellist cannot double-vote.
 */
interviewFeedbackSchema.index(
  { interviewId: 1, interviewerEmployeeId: 1 },
  { unique: true },
);

// ---------------------------------------------------------------------------
// HiringOffer
// ---------------------------------------------------------------------------

const signatureSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    ipAddress: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 300 },
    signedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const hiringOfferSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, required: true, index: true },

    /** Annual cost to company. Decimal128 (AD-2). */
    ctc: { type: Schema.Types.Decimal128, required: true },
    joiningDate: { ...isoDay, required: true },
    designation: { type: String, required: true, trim: true, maxlength: 120 },
    negotiationNotes: { type: String, default: null, maxlength: 2000 },

    /**
     * 🔴 THE ACCESS TOKEN IS WHAT AUTHORISES THE PUBLIC ROUTES.
     *
     * The reference's careers endpoints take the offer's own id, so anyone
     * holding or guessing one can read a candidate's salary, download the
     * signed letter, or accept the offer on their behalf. There is no
     * credential anywhere in that flow.
     *
     * A 256-bit random token, delivered with the offer, is the credential. It
     * is stored HASHED — a leaked database dump must not yield working links —
     * and compared in constant time. `select: false` keeps it out of every
     * ordinary read.
     */
    accessTokenHash: { type: String, default: null, select: false },
    accessTokenExpiresAt: { type: Date, default: null },

    /** Object key for the letter. Null until one is generated. */
    letterKey: { type: String, default: null, maxlength: 300 },

    sentAt: { type: Date, default: null },
    sentByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    acceptedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, maxlength: 500 },

    /** Evidence of the acceptance: who typed what, from where, when. */
    signature: { type: signatureSchema, default: null },

    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'hrms_hiring_offers' },
);

hiringOfferSchema.index({ applicationId: 1, createdAt: -1 });
/** The public lookup is BY TOKEN HASH, never by id. */
hiringOfferSchema.index({ accessTokenHash: 1 }, { sparse: true });

// ---------------------------------------------------------------------------

export const JobRequisition =
  mongoose.models.JobRequisition || mongoose.model('JobRequisition', jobRequisitionSchema);
export const JobPosting =
  mongoose.models.JobPosting || mongoose.model('JobPosting', jobPostingSchema);
export const Candidate =
  mongoose.models.Candidate || mongoose.model('Candidate', candidateSchema);
export const Application =
  mongoose.models.Application || mongoose.model('Application', applicationSchema);
export const Interview =
  mongoose.models.Interview || mongoose.model('Interview', interviewSchema);
export const InterviewFeedback =
  mongoose.models.InterviewFeedback ||
  mongoose.model('InterviewFeedback', interviewFeedbackSchema);
export const HiringOffer =
  mongoose.models.HiringOffer || mongoose.model('HiringOffer', hiringOfferSchema);

export default {
  JobRequisition,
  JobPosting,
  Candidate,
  Application,
  Interview,
  InterviewFeedback,
  HiringOffer,
};
