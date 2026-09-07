/**
 * Reports DTOs (AD-6).
 *
 * The reference accepts `@Query() params: Record<string, string>` on all three
 * endpoints and then **ignores it in every generator** — each one is declared
 * `async (_actor)`, so the params argument is not even named. The API advertises
 * a filterable surface it does not have: `?departmentId=x` returns the whole
 * organisation and no error.
 *
 * Here each report declares its own params schema, the service validates
 * against it, and an unknown or malformed filter is a 400 rather than silence.
 *
 * Two bounds exist that the reference has neither of:
 *
 *   - a page size ceiling (AD-13) — the reference's `run` returns `any[]` with
 *     no `take` and no cursor, so `leave_balances` is employees x leave types
 *     rows in a single response;
 *   - a date range ceiling — the reference's "current month" filter is
 *     `date: { gte: startOfMonth }` with NO upper bound, so it includes every
 *     future-dated record forever.
 */

import { z } from 'zod';

import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants/hrms.js';
import { objectId, isoDay } from '../validation/common.js';

// ---------------------------------------------------------------------------
// Keys and bounds
// ---------------------------------------------------------------------------

/**
 * The reference's three built-in report keys, verbatim.
 *
 * The reference's registry is an extension point — `register()` is exported so
 * other modules can add reports — but nothing in the repository calls it. A
 * whole-repo search for `.register(` finds three hits, all inside
 * `registerBuiltins()`. So three is the complete inventory, not a starting set.
 */
export const REPORT_KEYS = Object.freeze([
  'employees_directory',
  'attendance_monthly',
  'leave_balances',
]);

export const reportKey = z.enum(REPORT_KEYS);

/**
 * The widest window any date-ranged report will scan.
 *
 * A year plus a day, so "the whole of last year" and "the trailing twelve
 * months" both fit and nothing wider does.
 */
export const REPORT_MAX_RANGE_DAYS = 366;

/**
 * The row ceiling on a CSV export.
 *
 * The reference concatenates the entire result set into one string in memory
 * with no cap at all. At AD-13's 50-200 headcount the real exports are well
 * under this; the ceiling is what stops an unexpected collection size from
 * turning an export into an outage.
 */
export const REPORT_EXPORT_MAX_ROWS = 5000;

/** Oldest year a report will accept. Before this there is no HRMS data. */
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/**
 * Paging, on every report.
 *
 * `sortDir` only — the sort FIELD is not caller-supplied. Letting a caller name
 * a sort key would let them sort by a column the report does not project, and
 * on a collection this size an unindexed sort is the cheapest denial of service
 * available. Each report declares its own ordering instead.
 */
const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
};

/**
 * A closed date window: both ends optional, but ordered and bounded if given.
 *
 * Applied as refinements ON the report's own object rather than intersected
 * with it. `A.and(B)` would produce a ZodIntersection, and an intersection is
 * not strict even when both halves are — so an unknown filter would be
 * silently dropped, which is precisely the reference behaviour (D8) this
 * schema exists to stop.
 */
const dateWindowFields = {
  from: isoDay.optional(),
  to: isoDay.optional(),
};

const withDateWindow = (schema) =>
  schema
    .refine((v) => !(v.from && v.to) || v.from <= v.to, {
      message: '`from` must not be after `to`',
      path: ['from'],
    })
    .refine(
      (v) => {
        if (!v.from || !v.to) return true;
        const days =
          (Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86_400_000 + 1;
        return days <= REPORT_MAX_RANGE_DAYS;
      },
      {
        message: `date range must not exceed ${REPORT_MAX_RANGE_DAYS} days`,
        path: ['to'],
      },
    );

// ---------------------------------------------------------------------------
// Per-report params
// ---------------------------------------------------------------------------

/**
 * Employee Directory.
 *
 * The reference hardcodes `where: { status: 'active' }` and offers no filter.
 * `status` is exposed here because the report is otherwise unable to answer
 * "who is on notice", and the reference's own screen has no other way to ask.
 *
 * `.strict()` on every one of these: an unrecognised filter is a 400. The
 * reference silently ignores it and returns the whole organisation, which reads
 * to the caller like a filter that matched everything.
 */
export const employeesDirectoryParams = z
  .object({
    ...paging,
    departmentId: objectId.optional(),
    status: z.enum(['active', 'probation', 'notice', 'invited', 'exited', 'suspended', 'inactive'])
      .default('active'),
    search: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

/**
 * Monthly Attendance Summary.
 *
 * The window defaults to the current calendar month in the SERVER's timezone in
 * the reference (`new Date(); setDate(1); setHours(0,0,0,0)`), and has no upper
 * bound. Here the default is the current calendar month in UTC with both ends
 * closed — attendance dates are stored as UTC midnights, so the comparison is
 * against the same clock the data was written on.
 */
export const attendanceMonthlyParams = withDateWindow(
  z
    .object({
      ...paging,
      ...dateWindowFields,
      departmentId: objectId.optional(),
    })
    .strict(),
);

/**
 * Leave Balances.
 *
 * The reference filters on `new Date().getFullYear()` and nothing else.
 */
export const leaveBalancesParams = z
  .object({
    ...paging,
    year: z.coerce.number().int().min(YEAR_MIN).max(YEAR_MAX).optional(),
    leaveTypeId: objectId.optional(),
    departmentId: objectId.optional(),
  })
  .strict();

/** Keyed the same way the registry is, so a report can look its own schema up. */
export const REPORT_PARAM_SCHEMAS = Object.freeze({
  employees_directory: employeesDirectoryParams,
  attendance_monthly: attendanceMonthlyParams,
  leave_balances: leaveBalancesParams,
});

/**
 * The export endpoint takes the same params as `run`, minus paging.
 *
 * Paging is meaningless on an export and accepting it would invite
 * `?pageSize=1000000`. The service strips page/pageSize before validating and
 * applies `REPORT_EXPORT_MAX_ROWS` itself.
 */
export const EXPORT_STRIPPED_KEYS = Object.freeze(['page', 'pageSize']);

export default {
  REPORT_KEYS,
  reportKey,
  REPORT_MAX_RANGE_DAYS,
  REPORT_EXPORT_MAX_ROWS,
  REPORT_PARAM_SCHEMAS,
  EXPORT_STRIPPED_KEYS,
  employeesDirectoryParams,
  attendanceMonthlyParams,
  leaveBalancesParams,
};
