/**
 * Performance validation schemas (AD-6).
 *
 * Ported from `packages/shared-types/src/performance.ts` and used by both the
 * Express validator and the React forms, so a rule cannot drift between them.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections to the reference
 * ---------------------------------------------------------------------------
 * 1. MEASURES ARE STRINGS ON THE WIRE. The reference types `targetValue` and
 *    `currentValue` as `z.number()`. They are `Decimal(14,2)` at rest, and
 *    AD-2 forbids letting a float carry them — a goal measured in rupees or in
 *    two-decimal percentages loses precision before it is ever stored.
 *
 * 2. PEER AND SKIP-LEVEL REVIEWS TAKE AN EXPLICIT REVIEWER. The reference's
 *    `createReviewResponseSchema` has no reviewer field at all, and its service
 *    hardcodes `reviewerUserId = actor.userId` with an inline `// stub`
 *    comment — so HR assigning a peer review assigns it to themselves and two
 *    of the four review kinds are unusable.
 *
 * 3. RATINGS ARE BOUNDED AND NON-EMPTY, AND KEYS ARE CONSTRAINED.
 *    `z.record(z.number().min(1).max(5))` accepts `{}` — a submitted review
 *    that rates nothing — and any key string at all.
 *
 * 4. COMPETENCY KEYS MUST BE DISTINCT within a cycle. The reference collects a
 *    free list; two competencies sharing a key silently collapse into one
 *    rating, because `ratings` is keyed on it.
 */

import { z } from 'zod';

import { objectId, isoDay, isoDateTime, money, paginationQuery } from '../validation/common.js';
import {
  GOAL_STATUSES,
  GOAL_WEIGHT_MIN,
  GOAL_WEIGHT_MAX,
  REVIEW_PHASES,
  REVIEW_KINDS,
  RATING_MIN,
  RATING_MAX,
  FEEDBACK_KINDS,
  FEEDBACK_VISIBILITIES,
  ONE_ON_ONE_STATUSES,
  ONE_ON_ONE_MIN_MINUTES,
  ONE_ON_ONE_MAX_MINUTES,
} from '../constants/performance.js';

/** Present-but-empty and absent both mean "not supplied". */
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .optional()
    .nullable();

/** A measure — target or current. Decimal at rest, string on the wire (note 1). */
const measure = () => money({ allowNegative: true });

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export const createGoalSchema = z
  .object({
    /** Absent means "for myself"; the service refuses anyone else's without org scope. */
    employeeId: objectId.optional().nullable(),
    parentGoalId: objectId.optional().nullable(),
    cycleId: objectId.optional().nullable(),
    title: z.string().trim().min(1, 'A title is required.').max(200),
    description: optionalText(4000),
    targetValue: measure().optional().nullable(),
    unit: optionalText(40),
    weight: z.number().int().min(GOAL_WEIGHT_MIN).max(GOAL_WEIGHT_MAX).default(1),
    dueDate: isoDay.optional().nullable(),
  })
  .strict()
  .refine((v) => !v.unit || v.targetValue, {
    message: 'A unit only means something with a target value.',
    path: ['unit'],
  });

export const updateGoalSchema = z
  .object({
    currentValue: measure().optional(),
    status: z.enum(GOAL_STATUSES).optional(),
    /** Reopening or closing out deserves a note; optional, as the reference has none. */
    note: optionalText(500),
  })
  .strict()
  .refine((v) => v.currentValue !== undefined || v.status !== undefined, {
    message: 'Nothing to update.',
  });

export const goalListQuerySchema = paginationQuery
  .extend({
    status: z.enum(GOAL_STATUSES).optional(),
    cycleId: objectId.optional(),
    employeeId: objectId.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Review cycle
// ---------------------------------------------------------------------------

export const competencySchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(60)
      // `ratings` is keyed on this, so it has to be a safe object key rather
      // than arbitrary text.
      .regex(/^[a-z0-9_]+$/, 'Use lower-case letters, digits and underscores.'),
    label: z.string().trim().min(1).max(120),
    weight: z.number().int().min(1).max(10).default(1),
  })
  .strict();

export const createCycleSchema = z
  .object({
    name: z.string().trim().min(1, 'A name is required.').max(160),
    startDate: isoDay,
    endDate: isoDay,
    competencies: z
      .array(competencySchema)
      .min(1, 'A cycle needs at least one competency.')
      .max(20),
  })
  .strict()
  .refine((v) => v.startDate < v.endDate, {
    message: 'The start date must be before the end date.',
    path: ['endDate'],
  })
  .refine(
    (v) => {
      const keys = v.competencies.map((c) => c.key);
      return new Set(keys).size === keys.length;
    },
    { message: 'Two competencies cannot share a key.', path: ['competencies'] },
  );

export const advancePhaseSchema = z.object({ phase: z.enum(REVIEW_PHASES) }).strict();

export const cycleListQuerySchema = paginationQuery
  .extend({ phase: z.enum(REVIEW_PHASES).optional() })
  .strict();

// ---------------------------------------------------------------------------
// Review response
// ---------------------------------------------------------------------------

export const createReviewSchema = z
  .object({
    cycleId: objectId,
    employeeId: objectId,
    kind: z.enum(REVIEW_KINDS),
    /**
     * Who writes it — required for `peer` and `skip_level`, derived for `self`
     * and `manager`. See note 2: the reference has no such field and assigns
     * peer reviews to whoever clicked the button.
     */
    reviewerEmployeeId: objectId.optional().nullable(),
  })
  .strict()
  .refine((v) => !['peer', 'skip_level'].includes(v.kind) || Boolean(v.reviewerEmployeeId), {
    message: 'Choose who should write this review.',
    path: ['reviewerEmployeeId'],
  })
  .refine((v) => ['peer', 'skip_level'].includes(v.kind) || !v.reviewerEmployeeId, {
    message: 'A self or manager review takes its reviewer from the employee record.',
    path: ['reviewerEmployeeId'],
  });

export const submitReviewSchema = z
  .object({
    ratings: z
      .record(
        z.string().trim().min(1).max(60),
        z.number().int().min(RATING_MIN).max(RATING_MAX),
      )
      .refine((v) => Object.keys(v).length > 0, { message: 'Rate at least one competency.' }),
    overallRating: z.number().int().min(RATING_MIN).max(RATING_MAX),
    comments: optionalText(4000),
  })
  .strict();

export const reviewListQuerySchema = paginationQuery
  .extend({
    cycleId: objectId.optional(),
    employeeId: objectId.optional(),
    kind: z.enum(REVIEW_KINDS).optional(),
    submitted: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => v === true || v === 'true')
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export const giveFeedbackSchema = z
  .object({
    /** An EMPLOYEE, not a user account — see the model's note. */
    toEmployeeId: objectId,
    kind: z.enum(FEEDBACK_KINDS),
    message: z.string().trim().min(1, 'Write something.').max(2000),
    visibility: z.enum(FEEDBACK_VISIBILITIES).default('visible'),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  })
  .strict();

export const feedbackListQuerySchema = paginationQuery
  .extend({ kind: z.enum(FEEDBACK_KINDS).optional() })
  .strict();

// ---------------------------------------------------------------------------
// 1:1
// ---------------------------------------------------------------------------

export const oneOnOneItemSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
    done: z.boolean().default(false),
  })
  .strict();

export const createOneOnOneSchema = z
  .object({
    reportEmployeeId: objectId,
    scheduledAt: isoDateTime,
    durationMinutes: z
      .number()
      .int()
      .min(ONE_ON_ONE_MIN_MINUTES)
      .max(ONE_ON_ONE_MAX_MINUTES)
      .default(30),
    agenda: z.array(oneOnOneItemSchema).max(50).default([]),
  })
  .strict();

export const updateOneOnOneSchema = z
  .object({
    scheduledAt: isoDateTime.optional(),
    durationMinutes: z
      .number()
      .int()
      .min(ONE_ON_ONE_MIN_MINUTES)
      .max(ONE_ON_ONE_MAX_MINUTES)
      .optional(),
    agenda: z.array(oneOnOneItemSchema).max(50).optional(),
    notes: z.array(oneOnOneItemSchema).max(100).optional(),
    actionItems: z.array(oneOnOneItemSchema).max(50).optional(),
    status: z.enum(ONE_ON_ONE_STATUSES).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

export const oneOnOneListQuerySchema = paginationQuery
  .extend({ status: z.enum(ONE_ON_ONE_STATUSES).optional() })
  .strict();

export default {
  createGoalSchema,
  updateGoalSchema,
  goalListQuerySchema,
  competencySchema,
  createCycleSchema,
  advancePhaseSchema,
  cycleListQuerySchema,
  createReviewSchema,
  submitReviewSchema,
  reviewListQuerySchema,
  giveFeedbackSchema,
  feedbackListQuerySchema,
  oneOnOneItemSchema,
  createOneOnOneSchema,
  updateOneOnOneSchema,
  oneOnOneListQuerySchema,
};
