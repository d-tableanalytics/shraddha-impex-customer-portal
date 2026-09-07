/**
 * Hiring validation schemas (AD-6).
 *
 * Ported from `packages/shared-types/src/hiring.ts` and used by both the
 * Express validator and the React forms, so a rule cannot drift between them.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections to the reference
 * ---------------------------------------------------------------------------
 * 1. MONEY IS A STRING ON THE WIRE. The reference types `budgetMin`,
 *    `budgetMax`, `expectedSalary` and `ctc` as `z.number()`. AD-2 forbids it:
 *    the precision is already gone by the time a float is parsed, and the value
 *    is bound for a Decimal128.
 *
 * 2. THE BUDGET RANGE IS CHECKED AT THE BOUNDARY. The reference checks
 *    `budgetMin > budgetMax` inside the service, so the same rule is absent
 *    from every other caller and from the form.
 *
 * 3. A REJECTION REASON IS REQUIRED BY THE SCHEMA, not by a service branch —
 *    `moveStageSchema` makes it optional and the service then throws.
 *
 * 4. FEEDBACK RATINGS ARE BOUNDED AND NON-EMPTY. `z.record(z.number())` on the
 *    response type accepts `{}` and any magnitude; an empty ratings map is a
 *    submitted review that scores nothing.
 */

import { z } from 'zod';

import { objectId, isoDay, isoDateTime, money, moneyString, paginationQuery } from '../validation/common.js';
import {
  REQUISITION_STATUSES,
  CANDIDATE_SOURCES,
  APPLICATION_STAGES,
  INTERVIEW_STATUSES,
  INTERVIEW_DECISIONS,
  FEEDBACK_RATING_MIN,
  FEEDBACK_RATING_MAX,
  AI_JD_SENIORITIES,
} from '../constants/hiring.js';

/** Present-but-empty and absent both mean "not supplied". */
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .optional()
    .nullable();

const optionalMoney = money().optional().nullable();

// ---------------------------------------------------------------------------
// Requisition
// ---------------------------------------------------------------------------

export const createRequisitionSchema = z
  .object({
    title: z.string().trim().min(1, 'A title is required.').max(200),
    departmentId: objectId.optional().nullable(),
    locationId: objectId.optional().nullable(),
    headcount: z.number().int().min(1).max(100).default(1),
    budgetMin: optionalMoney,
    budgetMax: optionalMoney,
    businessJustification: optionalText(2000),
  })
  .strict()
  .refine(
    (v) => !v.budgetMin || !v.budgetMax || Number(v.budgetMin) <= Number(v.budgetMax),
    { message: 'The minimum budget cannot exceed the maximum.', path: ['budgetMin'] },
  );

export const updateRequisitionSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    departmentId: objectId.optional().nullable(),
    locationId: objectId.optional().nullable(),
    headcount: z.number().int().min(1).max(100).optional(),
    budgetMin: optionalMoney,
    budgetMax: optionalMoney,
    businessJustification: optionalText(2000),
  })
  .strict();

export const requisitionStatusSchema = z
  .object({
    status: z.enum(REQUISITION_STATUSES),
    /** Required when cancelling, so a closed requisition records why. */
    reason: optionalText(500),
  })
  .strict()
  .refine((v) => v.status !== 'cancelled' || Boolean(v.reason), {
    message: 'Say why the requisition is being cancelled.',
    path: ['reason'],
  });

export const requisitionListQuerySchema = paginationQuery
  .extend({
    status: z.enum(REQUISITION_STATUSES).optional(),
    departmentId: objectId.optional(),
    locationId: objectId.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export const createPostingSchema = z
  .object({
    requisitionId: objectId,
    description: z.string().trim().min(1, 'A description is required.').max(10_000),
    requirements: z.string().trim().min(1, 'Requirements are required.').max(5_000),
    /**
     * Job-board names. The reference stores this and never reads it; kept for
     * parity so the field is not lost, and documented as inert.
     */
    boardIntegrations: z.array(z.string().trim().max(60)).max(20).default([]),
  })
  .strict();

export const updatePostingSchema = createPostingSchema.omit({ requisitionId: true }).partial().strict();

export const postingListQuerySchema = paginationQuery
  .extend({
    requisitionId: objectId.optional(),
    published: z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true').optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

export const createCandidateSchema = z
  .object({
    name: z.string().trim().min(1, 'A name is required.').max(160),
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200),
    phone: optionalText(30),
    source: z.enum(CANDIDATE_SOURCES).default('manual'),
    currentEmployer: optionalText(120),
    expectedSalary: optionalMoney,
    noticePeriodDays: z.number().int().min(0).max(365).optional().nullable(),
  })
  .strict();

export const updateCandidateSchema = createCandidateSchema.partial().strict();

export const candidateListQuerySchema = paginationQuery
  .extend({ source: z.enum(CANDIDATE_SOURCES).optional() })
  .strict();

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export const createApplicationSchema = z
  .object({ candidateId: objectId, requisitionId: objectId })
  .strict();

export const moveStageSchema = z
  .object({
    stage: z.enum(APPLICATION_STAGES),
    rejectionReason: optionalText(500),
  })
  .strict()
  /**
   * The reference makes this optional and throws from the service. Enforced
   * here so the form, the API and any script share one rule — and so a
   * rejection can never be recorded without a reason the candidate could be
   * told.
   */
  .refine((v) => v.stage !== 'rejected' || Boolean(v.rejectionReason), {
    message: 'Give a reason for the rejection.',
    path: ['rejectionReason'],
  });

export const applicationListQuerySchema = paginationQuery
  .extend({
    requisitionId: objectId.optional(),
    candidateId: objectId.optional(),
    stage: z.enum(APPLICATION_STAGES).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Interview
// ---------------------------------------------------------------------------

export const scheduleInterviewSchema = z
  .object({
    applicationId: objectId,
    round: z.number().int().min(1).max(10).default(1),
    /** Employee ids, not user ids — see the model's note. */
    panelEmployeeIds: z.array(objectId).min(1, 'Add at least one panellist.').max(10),
    scheduledAt: isoDateTime,
    durationMinutes: z.number().int().min(15).max(300).default(45),
    meetingLink: z.string().trim().url('Enter a valid URL.').max(500).optional().nullable(),
  })
  .strict();

export const interviewStatusSchema = z
  .object({ status: z.enum(INTERVIEW_STATUSES) })
  .strict();

export const submitFeedbackSchema = z
  .object({
    /**
     * A non-empty map of criterion -> 1..5.
     *
     * The reference's response type is `z.record(z.number())` with no bounds
     * and no minimum, so `{}` is a submitted review that scores nothing and a
     * rating of 99 is accepted.
     */
    ratings: z
      .record(
        z.string().trim().min(1).max(60),
        z.number().int().min(FEEDBACK_RATING_MIN).max(FEEDBACK_RATING_MAX),
      )
      .refine((v) => Object.keys(v).length > 0, { message: 'Rate at least one criterion.' }),
    comments: optionalText(4000),
    decision: z.enum(INTERVIEW_DECISIONS),
  })
  .strict();

export const interviewListQuerySchema = paginationQuery
  .extend({
    applicationId: objectId.optional(),
    status: z.enum(INTERVIEW_STATUSES).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Offer
// ---------------------------------------------------------------------------

export const createOfferSchema = z
  .object({
    applicationId: objectId,
    ctc: moneyString,
    joiningDate: isoDay,
    designation: z.string().trim().min(1, 'A designation is required.').max(120),
    negotiationNotes: optionalText(2000),
  })
  .strict();

export const offerListQuerySchema = paginationQuery
  .extend({ applicationId: objectId.optional() })
  .strict();

// ---------------------------------------------------------------------------
// Public careers
// ---------------------------------------------------------------------------

/**
 * A public application.
 *
 * Deliberately NOT `createCandidateSchema`: an anonymous caller must not be
 * able to set `source` (which would let them claim to be a referral) and must
 * not reach any field the recruiter-facing form owns.
 */
export const publicApplySchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    email: z.string().trim().toLowerCase().email().max(200),
    phone: optionalText(30),
    currentEmployer: optionalText(120),
    expectedSalary: optionalMoney,
    noticePeriodDays: z.number().int().min(0).max(365).optional().nullable(),
  })
  .strict();

/**
 * Accepting an offer.
 *
 * The token is the ONLY thing that authorises this, so it is validated as
 * strictly as any other credential: hex, exact length, nothing else.
 */
export const acceptOfferSchema = z
  .object({
    signatureName: z.string().trim().min(1, 'Type your full name to sign.').max(120),
  })
  .strict();

export const rejectOfferSchema = z
  .object({ reason: optionalText(500) })
  .strict();

export const offerTokenSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/, 'That link is not valid.');

// ---------------------------------------------------------------------------
// AI JD
// ---------------------------------------------------------------------------

export const generateJdSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    skills: z.array(z.string().trim().min(1).max(80)).min(1, 'List at least one skill.').max(30),
    seniority: z.enum(AI_JD_SENIORITIES).default('mid'),
  })
  .strict();

export default {
  createRequisitionSchema,
  updateRequisitionSchema,
  requisitionStatusSchema,
  requisitionListQuerySchema,
  createPostingSchema,
  updatePostingSchema,
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
  publicApplySchema,
  acceptOfferSchema,
  rejectOfferSchema,
  offerTokenSchema,
  generateJdSchema,
};
