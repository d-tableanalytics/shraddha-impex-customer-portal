/**
 * Employee exit validation schemas (AD-6).
 *
 * Ported from the reference's `packages/shared-types/src/exit.ts`. Imported by
 * the Express validator AND by the React forms, so a rule cannot drift.
 *
 * Deviations from the reference, each deliberate:
 *   - `uuid` becomes `objectId` (AD-2), `organizationId` is gone (AD-1)
 *   - `hr_approved` is NOT a status. See the note on EXIT_STATUSES.
 *   - money is a STRING at the boundary (AD-2); the reference uses z.number()
 *     for the full-and-final figures despite a Decimal(14,2) column.
 *   - `requestedLastDay` has a real lower bound. The reference disables past
 *     dates in the DatePicker and accepts them in the API.
 */

import { z } from 'zod';

import { objectId, isoDay as isoDayShape } from '../validation/common.js';
import { dayToUtcMs, isNotPastDay } from '../leave/dates.js';

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

/** A last working day is a future commitment, not a backdated one. */
// 🔴 Was `value >= utcMsToDay(Date.now())` — the mirror of the expense bug.
// It holds in IST by luck (local runs ahead of UTC) and fails west of
// Greenwich, where a viewer's today is BEHIND UTC's. See `isNotPastDay`.
const todayOrLater = isoDay.refine(isNotPastDay, {
  message: 'The last working day cannot be in the past.',
});

/**
 * The exit states.
 *
 * The reference declares nine and can only ever reach eight: `hrApprove()`
 * writes `in_notice`, so `hr_approved` is unreachable. It is nonetheless in its
 * enum, its UI step list and its colour map, which is why its progress bar
 * jumps from step 1 to step 3 on every exit. The dead state is not reproduced —
 * this list is what the reference's own code actually does.
 */
export const EXIT_STATUSES = Object.freeze([
  'initiated',
  'manager_approved',
  'in_notice',
  'clearance_pending',
  'cleared',
  'f_and_f_pending',
  'closed',
  'cancelled',
]);

/** States from which nothing further happens. */
export const TERMINAL_EXIT_STATUSES = Object.freeze(['closed', 'cancelled']);

export const EXIT_REASON_CATEGORIES = Object.freeze([
  'resignation',
  'termination',
  'retirement',
  'other',
]);

/**
 * Categories an employee may file against themselves.
 *
 * The reference's schema accepts every category from anyone and merely hides
 * `termination` in the picker — so an employee can self-file a termination by
 * posting one. Nobody terminates themselves; that is an HR act.
 */
export const SELF_SERVICE_REASON_CATEGORIES = Object.freeze([
  'resignation',
  'retirement',
  'other',
]);

export const CLEARANCE_AREAS = Object.freeze(['it', 'finance', 'admin', 'hr', 'manager']);

export const CLEARANCE_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'completed',
  'waived',
]);

/** Clearance states that count as finished. */
export const TERMINAL_CLEARANCE_STATUSES = Object.freeze(['completed', 'waived']);

// ---------------------------------------------------------------------------
// Exit requests
// ---------------------------------------------------------------------------

export const createExitRequestSchema = z
  .object({
    /**
     * Whose exit. Optional: omitted means "mine", and the server resolves it
     * from the signed-in actor rather than trusting the browser.
     */
    employeeId: objectId.optional(),
    reason: z.string().trim().min(1).max(2000),
    reasonCategory: z.enum(EXIT_REASON_CATEGORIES).default('resignation'),
    requestedLastDay: todayOrLater,
  })
  .strict();

export const updateExitRequestSchema = z
  .object({
    actualLastDay: isoDay.optional().nullable(),
    /** Who picks up the work. The reference's own handover field. */
    replacementEmployeeId: objectId.optional().nullable(),
    transferNotes: z.string().trim().max(4000).optional().nullable(),
  })
  .strict();

export const updateClearanceSchema = z
  .object({
    status: z.enum(CLEARANCE_STATUSES).optional(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

export const exitListQuerySchema = z
  .object({
    status: z.enum(EXIT_STATUSES).optional(),
    /** `true` hides closed and cancelled rows. */
    activeOnly: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

export default {
  createExitRequestSchema,
  updateExitRequestSchema,
  updateClearanceSchema,
  exitListQuerySchema,
  EXIT_STATUSES,
  TERMINAL_EXIT_STATUSES,
  EXIT_REASON_CATEGORIES,
  SELF_SERVICE_REASON_CATEGORIES,
  CLEARANCE_AREAS,
  CLEARANCE_STATUSES,
  TERMINAL_CLEARANCE_STATUSES,
};
