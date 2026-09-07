/**
 * Onboarding validation schemas (AD-6).
 *
 * Ported from `packages/shared-types/src/onboarding.ts` and used by both the
 * Express validator and the React forms, so a rule cannot drift between them.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections to the reference
 * ---------------------------------------------------------------------------
 * 1. MONEY IS A STRING ON THE WIRE. The reference types `ctc` as `z.number()`.
 *    AD-2 forbids it: the precision is already gone by the time a float is
 *    parsed, and the value is bound for a Decimal128.
 *
 * 2. THE SIGNATURE IMAGE IS GONE. `signOfferSchema` accepts a base64 PNG of up
 *    to 500,000 characters, which the reference then stores inside the offer
 *    row. Acceptance here is a typed legal name; the timestamp, IP and user
 *    agent are recorded beside it, which is the evidence that actually matters.
 *
 * 3. A TEMPLATE MUST HAVE AT LEAST ONE TASK. The reference defaults `tasks` to
 *    `[]`, so an empty template can be created and then instantiated into a
 *    checklist with nothing in it — which immediately auto-closes as
 *    "completed" because no task is outstanding.
 *
 * 4. TASK TITLES WITHIN A TEMPLATE MUST BE DISTINCT. Two identically named
 *    tasks are indistinguishable in the assignee's list.
 */

import { z } from 'zod';

import { objectId, isoDay, money, paginationQuery } from '../validation/common.js';
import {
  ASSIGN_TO,
  CHECKLIST_STATUSES,
  TASK_STATUSES,
  DUE_DAYS_MIN,
  DUE_DAYS_MAX,
} from '../constants/onboarding.js';

/** Present-but-empty and absent both mean "not supplied". */
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .optional()
    .nullable();

// ---------------------------------------------------------------------------
// Task template
// ---------------------------------------------------------------------------

export const taskTemplateSchema = z
  .object({
    title: z.string().trim().min(1, 'A task title is required.').max(200),
    description: optionalText(2000),
    dueDays: z
      .number()
      .int()
      .min(DUE_DAYS_MIN, 'A task cannot be due before onboarding starts.')
      .max(DUE_DAYS_MAX)
      .default(3),
    assignTo: z.enum(ASSIGN_TO),
    order: z.number().int().min(0).max(999).default(0),
  })
  .strict();

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export const createTemplateSchema = z
  .object({
    name: z.string().trim().min(1, 'A name is required.').max(160),
    /**
     * Advisory labels only.
     *
     * The reference stores both and never reads either — there is no logic that
     * picks a template from a new hire's role or department. Kept for parity and
     * documented as advisory rather than dropped, so the data a migration would
     * carry across is not silently lost.
     */
    appliesToRoleKey: optionalText(60),
    appliesToDepartmentId: objectId.optional().nullable(),
    active: z.boolean().default(true),
    tasks: z
      .array(taskTemplateSchema)
      .min(1, 'A template needs at least one task.')
      .max(100, 'A template cannot hold more than 100 tasks.'),
  })
  .strict()
  .refine(
    (v) => {
      const titles = v.tasks.map((t) => t.title.toLowerCase());
      return new Set(titles).size === titles.length;
    },
    { message: 'Two tasks in a template cannot share a title.', path: ['tasks'] },
  );

/**
 * Written out rather than `.partial()`.
 *
 * Zod refuses `.partial()` on a refined object, and the refinement above is the
 * duplicate-title rule — which still has to hold when `tasks` is supplied.
 */
export const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    appliesToRoleKey: optionalText(60),
    appliesToDepartmentId: objectId.optional().nullable(),
    active: z.boolean().optional(),
    tasks: z.array(taskTemplateSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (v) => {
      if (!v.tasks) return true;
      const titles = v.tasks.map((t) => t.title.toLowerCase());
      return new Set(titles).size === titles.length;
    },
    { message: 'Two tasks in a template cannot share a title.', path: ['tasks'] },
  );

export const templateListQuerySchema = paginationQuery
  .extend({
    active: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => v === true || v === 'true')
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export const startChecklistSchema = z
  .object({ employeeId: objectId, templateId: objectId })
  .strict();

export const checklistListQuerySchema = paginationQuery
  .extend({
    status: z.enum(CHECKLIST_STATUSES).optional(),
    employeeId: objectId.optional(),
  })
  .strict();

export const cancelChecklistSchema = z
  .object({
    /** Required, so a cancelled checklist records why. The reference has no cancel at all. */
    reason: z.string().trim().min(1, 'Say why onboarding is being cancelled.').max(500),
  })
  .strict();

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const updateTaskSchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    notes: optionalText(2000),
    /**
     * Reassignment. The service checks that the id is a real, non-deleted
     * employee — the reference accepts any UUID and writes it straight in.
     */
    assigneeEmployeeId: objectId.optional().nullable(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.notes !== undefined || v.assigneeEmployeeId !== undefined, {
    message: 'Nothing to update.',
  });

/** The panellist-style "what is assigned to me" query. */
export const myTaskListQuerySchema = paginationQuery
  .extend({ status: z.enum(TASK_STATUSES).optional() })
  .strict();

// ---------------------------------------------------------------------------
// Offer letter
// ---------------------------------------------------------------------------

export const createOfferLetterSchema = z
  .object({
    employeeId: objectId,
    /** A string on the wire, bound for Decimal128 (AD-2). */
    ctc: money(),
    joiningDate: isoDay,
    designation: z.string().trim().min(1, 'A designation is required.').max(120),
  })
  .strict();

export const offerLetterListQuerySchema = paginationQuery
  .extend({ employeeId: objectId.optional() })
  .strict();

/**
 * Accepting an offer.
 *
 * A typed legal name — see note 2 in the header. `signatureImage` is
 * deliberately absent, and `.strict()` means sending one is an error rather than
 * something silently ignored.
 */
export const signOfferLetterSchema = z
  .object({
    signatureName: z.string().trim().min(1, 'Type your full name to sign.').max(120),
  })
  .strict();

export const rejectOfferLetterSchema = z
  .object({ reason: optionalText(500) })
  .strict();

export default {
  taskTemplateSchema,
  createTemplateSchema,
  updateTemplateSchema,
  templateListQuerySchema,
  startChecklistSchema,
  checklistListQuerySchema,
  cancelChecklistSchema,
  updateTaskSchema,
  myTaskListQuerySchema,
  createOfferLetterSchema,
  offerLetterListQuerySchema,
  signOfferLetterSchema,
  rejectOfferLetterSchema,
};
