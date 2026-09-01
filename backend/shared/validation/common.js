/**
 * Shared Zod building blocks (AD-6).
 *
 * The same schemas validate on the server (through the `validate` middleware)
 * and drive `react-hook-form` on the client, so a rule cannot drift between the
 * two. Zod 4 - the version the frontend already depends on.
 *
 * This is the ONLY directory in `shared/` permitted an external import.
 */

import { z } from 'zod';

import {
  EMPLOYMENT_TYPES,
  EMPLOYEE_STATUSES,
  INDIAN_STATE_CODES,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  RETENTION_ACTION_LIST,
} from '../constants/hrms.js';

/** A 24-character hex MongoDB ObjectId (AD-2 - not a UUID). */
export const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'expected a 24-character ObjectId');

/** Date-only wire format, `YYYY-MM-DD`. */
export const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'not a real date');

export const isoDateTime = z.string().datetime({ offset: true });

export const email = z.string().trim().toLowerCase().email().max(320);

/** Indian mobile number: exactly ten digits, matching the DTA reference rule. */
export const phone10 = z
  .string()
  .regex(/^\d{10}$/, 'phone must be exactly 10 digits');

/** State/UT subdivision code without the `IN-` prefix (AD-12). */
export const stateCode = z.enum(INDIAN_STATE_CODES);

export const employmentType = z.enum(EMPLOYMENT_TYPES);
export const employeeStatus = z.enum(EMPLOYEE_STATUSES);

/**
 * A monetary amount, on the wire.
 *
 * AD-2 requires `Decimal128` in the database and forbids JavaScript `Number`
 * for money. Accepting a plain number at the API boundary would defeat that -
 * the value has already lost precision by the time it is parsed. So the wire
 * format is a STRING, and the persistence layer hands that string straight to
 * `Decimal128.fromString`.
 *
 * A number is still accepted for ergonomics, but only when it is integral or
 * has at most `maxDp` decimal places AND round-trips exactly through
 * `Number`, so no silent precision loss can slip past.
 */
export function money({ maxDp = 2, allowNegative = false, max = 1e15 } = {}) {
  const pattern = allowNegative
    ? new RegExp(`^-?\\d+(\\.\\d{1,${maxDp}})?$`)
    : new RegExp(`^\\d+(\\.\\d{1,${maxDp}})?$`);

  return z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      const str = typeof v === 'number' ? String(v) : v.trim();

      if (typeof v === 'number' && !Number.isFinite(v)) {
        ctx.addIssue({ code: 'custom', message: 'amount must be a finite number' });
        return z.NEVER;
      }
      if (!pattern.test(str)) {
        ctx.addIssue({
          code: 'custom',
          message: allowNegative
            ? `expected a decimal with at most ${maxDp} decimal places`
            : `expected a non-negative decimal with at most ${maxDp} decimal places`,
        });
        return z.NEVER;
      }
      if (Math.abs(Number(str)) > max) {
        ctx.addIssue({ code: 'custom', message: 'amount is out of range' });
        return z.NEVER;
      }
      // Always a string, so the caller can only ever hand it to Decimal128.
      return str;
    });
}

/** Shorthand for the common non-negative two-decimal-place case. */
export const moneyString = money();

/** Server-side pagination query (AD-13 - never assume the set is small). */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  search: z.string().trim().max(200).optional(),
  sortBy: z.string().trim().max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});

/** Shape of every paginated list response. */
export const paginatedResponse = (item) =>
  z.object({
    data: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  });

/** One retention rule. `days: null` means retain indefinitely (AD-16). */
export const retentionRule = z.object({
  days: z.number().int().min(1).max(36500).nullable(),
  action: z.enum(RETENTION_ACTION_LIST),
});

/**
 * `customFieldValues` as it arrives on the wire.
 *
 * Intentionally permissive here: rejecting reserved keys at the schema level
 * would tell a caller which keys are sensitive, and would fail the request
 * rather than cleaning it. The sanitiser strips them instead, in memory, before
 * the first database write (AD-11).
 */
export const customFieldValues = z.record(z.string(), z.unknown()).default({});

/**
 * Flatten a Zod error into `[{ path, message }]` for an API response.
 * Zod 4 exposes `.issues`.
 */
export function formatZodIssues(error) {
  const issues = error?.issues ?? [];
  return issues.map((i) => ({
    path: Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? ''),
    message: i.message,
  }));
}

export { z };
