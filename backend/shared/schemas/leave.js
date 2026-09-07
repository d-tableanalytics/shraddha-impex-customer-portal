/**
 * Leave and Holiday validation schemas (AD-6).
 *
 * Ported from the reference's `packages/shared-types/src/leave.ts`. Imported by
 * the Express validator AND by the React forms, so a rule cannot drift between
 * them.
 *
 * Deviations from the reference, each deliberate:
 *   - `uuid` becomes `objectId` (AD-2)
 *   - `organizationId` is gone (AD-1)
 *   - hourly leave carries `hoursPerDay`, and the SERVER converts it to a day
 *     fraction. The reference writes raw hours into a days-denominated
 *     `durationValue`, so a two-hour absence spends two days of entitlement.
 */

import { z } from 'zod';

import { objectId, isoDay as isoDayShape } from '../validation/common.js';
import {
  LEAVE_DURATION_UNITS,
  HALF_DAY_PERIODS,
  DAY_BREAKDOWN_KINDS,
  inclusiveDayCount,
  eachDay,
  dayToUtcMs,
} from '../leave/dates.js';

/**
 * A date that is both well-SHAPED and real.
 *
 * The shared `isoDay` is a regex, so `2026-02-31` passes it — and every date
 * helper downstream then throws, turning a bad request into a 500. Leave is the
 * first module to feed user-supplied dates straight into arithmetic, so the
 * realness check lives here rather than in the shared helper, which Employee
 * Master and Org Structure also use and which is not mine to change.
 */
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

export const LEAVE_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'cancelled']);
export const HOLIDAY_TYPES = Object.freeze([
  'public',
  'national',
  'state',
  'festival',
  'optional',
  'restricted',
]);

/** HH:MM, 24-hour. */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)');

export const durationUnit = z.enum(LEAVE_DURATION_UNITS);
export const halfDayPeriod = z.enum(HALF_DAY_PERIODS);

export const halfDaySlotSchema = z.object({ date: isoDay, period: halfDayPeriod }).strict();
export const dayBreakdownEntrySchema = z
  .object({ date: isoDay, kind: z.enum(DAY_BREAKDOWN_KINDS) })
  .strict();

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

/**
 * The reference hardcodes which types a person may use: `CL` for everyone,
 * `AL` only for admins or an employee whose DESIGNATION STRING is "EA". That is
 * a customer-specific rule wired into the service, and matching on a free-text
 * job title is not something to reproduce.
 *
 * `adminOnly` is the same product behaviour expressed as data: a type flagged
 * that way is offered only to someone who can administer leave. The EA
 * exemption is deliberately not ported.
 */
export const createLeaveTypeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(20)
      .regex(/^[A-Z0-9_-]+$/, 'Use uppercase letters, numbers, hyphen or underscore only.'),
    name: z.string().trim().min(1).max(80),
    paid: z.boolean().default(true),
    allowsHalfDay: z.boolean().default(true),
    requiresProof: z.boolean().default(false),
    adminOnly: z.boolean().default(false),
    color: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #rrggbb colour')
      .default('#1E5FB8'),
  })
  .strict();

export const updateLeaveTypeSchema = createLeaveTypeSchema.partial().strict();

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

const rangeCovers = (value, list) => {
  const days = eachDay(value.startDate, value.endDate);
  if (list.length !== days.length) return false;
  const wanted = new Set(days);
  return list.every((entry) => wanted.has(entry.date));
};

export const createLeaveRequestSchema = z
  .object({
    leaveTypeId: objectId,
    startDate: isoDay,
    endDate: isoDay,
    durationUnit: durationUnit.default('full_day'),
    /** Hours taken on each day of an hourly request. */
    hoursPerDay: z.number().positive().max(24).optional(),
    /** One period for the whole request; the usual single-day case. */
    halfDayPeriod: halfDayPeriod.optional(),
    /** Per-day periods, required once a half-day request spans more than a day. */
    halfDaySlots: z.array(halfDaySlotSchema).optional(),
    /** Per-day full/half breakdown, for `mixed`. */
    dayBreakdown: z.array(dayBreakdownEntrySchema).optional(),
    hourFrom: hhmm.optional(),
    hourTo: hhmm.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((v) => v.endDate >= v.startDate, {
    message: 'The end date must be on or after the start date.',
    path: ['endDate'],
  })
  .refine((v) => v.durationUnit !== 'half_day' || v.halfDayPeriod || v.halfDaySlots?.length, {
    message: 'Choose first or second half.',
    path: ['halfDayPeriod'],
  })
  .refine(
    (v) =>
      v.durationUnit !== 'half_day' ||
      inclusiveDayCount(v.startDate, v.endDate) <= 1 ||
      (v.halfDaySlots?.length ? rangeCovers(v, v.halfDaySlots) : false),
    {
      message: 'Choose first or second half for every date in the range.',
      path: ['halfDaySlots'],
    },
  )
  .refine(
    (v) =>
      v.durationUnit !== 'mixed' ||
      (inclusiveDayCount(v.startDate, v.endDate) >= 2 &&
        Boolean(v.dayBreakdown?.length) &&
        rangeCovers(v, v.dayBreakdown)),
    {
      message: 'A mixed request needs a full or half entry for every date, over at least two days.',
      path: ['dayBreakdown'],
    },
  )
  .refine((v) => v.durationUnit !== 'hour' || (v.hourFrom && v.hourTo && v.hoursPerDay), {
    message: 'An hourly request needs a start time, an end time and a number of hours.',
    path: ['hourFrom'],
  })
  .refine((v) => v.durationUnit !== 'hour' || inclusiveDayCount(v.startDate, v.endDate) === 1, {
    message: 'An hourly request covers a single day.',
    path: ['endDate'],
  })
  .refine((v) => v.durationUnit !== 'hour' || !v.hourTo || v.hourTo > v.hourFrom, {
    message: 'The end time must be after the start time.',
    path: ['hourTo'],
  });

export const leaveDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

export const leaveListQuerySchema = z
  .object({
    status: z.enum(LEAVE_STATUSES).optional(),
    employeeId: objectId.optional(),
  })
  .strict();

export const leaveCalendarQuerySchema = z
  .object({ from: isoDay, to: isoDay })
  .strict()
  .refine((v) => v.to >= v.from, { message: '`to` must be on or after `from`.', path: ['to'] })
  // 400 rather than a 20,000-row scan: the calendar is a month at a time.
  .refine((v) => inclusiveDayCount(v.from, v.to) <= 366, {
    message: 'A calendar window cannot exceed one year.',
    path: ['to'],
  });

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export const upsertHolidaySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    date: isoDay,
    type: z.enum(HOLIDAY_TYPES).default('public'),
    /** Free text in the reference; kept as such. Null means org-wide. */
    region: z.string().trim().max(20).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    isOptional: z.boolean().default(false),
  })
  .strict();

export const bulkImportHolidaysSchema = z
  .object({
    year: z.number().int().min(2000).max(2100),
    region: z.string().trim().max(20).optional().nullable(),
    /** Replace the year rather than merge into it. */
    overwrite: z.boolean().default(false),
    holidays: z.array(upsertHolidaySchema).min(1).max(100),
  })
  .strict();

export const holidayListQuerySchema = z
  .object({ year: z.coerce.number().int().min(2000).max(2100).optional() })
  .strict();

export default {
  createLeaveTypeSchema,
  updateLeaveTypeSchema,
  createLeaveRequestSchema,
  leaveDecisionSchema,
  leaveListQuerySchema,
  leaveCalendarQuerySchema,
  upsertHolidaySchema,
  bulkImportHolidaysSchema,
  holidayListQuerySchema,
};
