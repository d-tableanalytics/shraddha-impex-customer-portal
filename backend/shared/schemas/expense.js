/**
 * Expense validation schemas (AD-6).
 *
 * Ported from the reference's `packages/shared-types/src/expense.ts`. Imported
 * by the Express validator AND by the React forms, so a rule cannot drift.
 *
 * Deviations from the reference, each deliberate:
 *   - `uuid` becomes `objectId` (AD-2), `organizationId` is gone (AD-1)
 *   - money is a STRING at the boundary, so a float never reaches Decimal128
 *     (AD-2). The reference accepts `z.number()` and sums with `+`.
 *   - `receiptKey` is NOT accepted from a client. See the note on it below.
 */

import { z } from 'zod';

import { objectId, isoDay as isoDayShape, money } from '../validation/common.js';
// Calendar-day primitives. They live under `shared/leave/` because Leave needed
// them first, but they are generic — a date is a date. Importing them beats a
// second implementation that could disagree about what 2026-02-31 means.
import { dayToUtcMs, isNotFutureDay } from '../leave/dates.js';

/** Well-shaped AND real: the bare regex accepts 2026-02-31. */
const isoDay = isoDayShape.refine(
  (value) => {
    try {
      dayToUtcMs(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'That is not a real calendar date.' },
);

/** An expense cannot be incurred in the future. */
// 🔴 Was `value <= utcMsToDay(Date.now())`, which rejected the claim drawer's
// OWN default — it dates each line to the viewer's local today — for the five
// and a half hours a night when IST is a day ahead of UTC. See `isNotFutureDay`.
const pastOrToday = isoDay.refine(isNotFutureDay, {
  message: 'An expense date cannot be in the future.',
});

export const CLAIM_STATUSES = Object.freeze([
  'draft',
  'submitted',
  'manager_approved',
  'finance_approved',
  'reimbursed',
  'rejected',
]);

/** The reference has no `cancelled` state, and none is invented here. */
export const APPROVAL_ROLES = Object.freeze(['manager', 'finance']);

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const createExpenseCategorySchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(30)
      .regex(/^[A-Z0-9_-]+$/, 'Use uppercase letters, numbers, hyphen or underscore only.'),
    name: z.string().trim().min(1).max(120),
    /** Accounting codes, free text in the reference. */
    glCode: z.string().trim().max(30).optional().nullable(),
    tallyLedger: z.string().trim().max(160).optional().nullable(),
    active: z.boolean().default(true),
  })
  .strict();

export const updateExpenseCategorySchema = createExpenseCategorySchema.partial().strict();

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/**
 * One optional policy per category.
 *
 * IMPORTANT: the reference stores these and never reads them. `dailyLimit`,
 * `monthlyLimit`, `requiresReceipt` and `autoApproveBelow` have no consumer in
 * its claim service — only a comment describing an auto-approval that is not
 * implemented. They are configuration and guidance here too; a claim is never
 * silently refused for breaching a limit the reference does not enforce.
 */
export const upsertExpensePolicySchema = z
  .object({
    categoryId: objectId,
    dailyLimit: money().optional().nullable(),
    monthlyLimit: money().optional().nullable(),
    requiresReceipt: z.boolean().default(true),
    requiresApproval: z.boolean().default(true),
    autoApproveBelow: money().optional().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * A line item as SUBMITTED.
 *
 * `receiptKey` is deliberately absent. The reference accepts it on create and
 * later does `path.resolve(uploadsRoot, receiptKey)` to read the file back —
 * so a claim created with `receiptKey: "../../.env"` reads whatever the server
 * process can. Receipts here are attached only through the upload endpoint,
 * which mints its own key through the storage layer.
 */
export const createLineItemSchema = z
  .object({
    categoryId: objectId,
    date: pastOrToday,
    amount: money({ allowNegative: false }),
    description: z.string().trim().min(1).max(500),
  })
  .strict();

export const createClaimSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    lineItems: z.array(createLineItemSchema).min(1).max(50),
  })
  .strict();

/** A draft may be edited wholesale; nothing else may be edited at all. */
export const updateClaimSchema = createClaimSchema.partial().strict();

export const claimDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

export const claimListQuerySchema = z
  .object({
    status: z.enum(CLAIM_STATUSES).optional(),
    employeeId: objectId.optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

export default {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  upsertExpensePolicySchema,
  createLineItemSchema,
  createClaimSchema,
  updateClaimSchema,
  claimDecisionSchema,
  claimListQuerySchema,
  CLAIM_STATUSES,
  APPROVAL_ROLES,
};
