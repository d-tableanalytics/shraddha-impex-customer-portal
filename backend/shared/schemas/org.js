/**
 * Org Structure validation schemas (AD-6).
 *
 * Ported from the reference's `packages/shared-types/src/org.ts`. Imported by
 * the Express validator AND by the React forms, so a rule cannot drift between
 * them.
 *
 * Three deliberate corrections to the reference, each covered by a test:
 *
 *   1. The uppercase code pattern is enforced HERE, on the server. The
 *      reference has it only as an Ant Design form rule, so any non-browser
 *      client - curl, the CSV import, a script - stores whatever it likes.
 *
 *   2. A location's address, city and country are `.optional().nullable()`.
 *      The reference derives its create schema with
 *      `locationSchema.omit({ id: true })`, which leaves them `.nullable()` but
 *      NOT `.optional()` - so an omitted City is a 400. Its department schema
 *      explicitly `.extend()`s the same fix for its own two optional fields;
 *      the location schema was simply missed.
 *
 *   3. `timezone` is validated against what the runtime can actually resolve,
 *      not a hardcoded list of seven. See ../constants/timezones.js.
 *
 * `parentId` and `headEmployeeId` are absent by decision (O-1, O-2): the
 * reference carries both in its DTO but exposes neither in its UI, so accepting
 * them here would build a write path for a feature that has no product. See the
 * note on Department.parentId in the model.
 */

import { z } from 'zod';

import {
  ORG_CODE_PATTERN,
  ORG_CODE_MAX_LENGTH,
  ORG_NAME_MAX_LENGTH,
  LOCATION_ADDRESS_MAX_LENGTH,
  LOCATION_CITY_MAX_LENGTH,
  LOCATION_COUNTRY_MAX_LENGTH,
} from '../constants/hrms.js';
import {
  DEFAULT_TIME_ZONE,
  TIME_ZONE_MAX_LENGTH,
  isValidTimeZone,
} from '../constants/timezones.js';

/**
 * A catalogue code: `ENG`, `HR`, `BLR-01`.
 *
 * Upper-cased before the pattern runs, so `eng` is accepted and normalised
 * rather than rejected on a technicality the user cannot see. `eng dept` is
 * still refused - a space is a mistake, not a case difference.
 */
const orgCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'Code is required.')
  .max(ORG_CODE_MAX_LENGTH)
  .regex(ORG_CODE_PATTERN, 'Use uppercase letters, numbers, hyphen or underscore only.');

const orgName = z.string().trim().min(1, 'Name is required.').max(ORG_NAME_MAX_LENGTH);

/** Present-but-empty and absent both mean "not supplied". */
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .optional()
    .nullable();

export const timeZone = z
  .string()
  .trim()
  .max(TIME_ZONE_MAX_LENGTH)
  .refine(isValidTimeZone, { message: 'Not a recognised IANA time zone.' });

// ---------------------------------------------------------------------------
// Department
// ---------------------------------------------------------------------------

export const createDepartmentSchema = z
  .object({
    code: orgCode,
    name: orgName,
  })
  .strict();

/**
 * `.partial().strict()` - every field optional, no unknown key accepted.
 *
 * `code` stays editable, as in the reference. It is the natural key for the
 * import, but unlike an employee code it is not stamped on other records: an
 * employee stores `departmentId`, never the code.
 */
export const updateDepartmentSchema = createDepartmentSchema.partial().strict();

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

export const createLocationSchema = z
  .object({
    code: orgCode,
    name: orgName,
    address: optionalText(LOCATION_ADDRESS_MAX_LENGTH),
    city: optionalText(LOCATION_CITY_MAX_LENGTH),
    country: optionalText(LOCATION_COUNTRY_MAX_LENGTH),
    timezone: timeZone.default(DEFAULT_TIME_ZONE),
  })
  .strict();

export const updateLocationSchema = createLocationSchema.partial().strict();

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Both list endpoints in the reference return the whole table ordered by name,
 * with no paging, filtering or search. These are catalogues of tens of rows, so
 * that is the right shape and is kept.
 *
 * `includeDeleted` is the one addition, and it is why soft delete is safe: an
 * employee that still references a retired department has to be able to resolve
 * its name, or the profile would render a blank where a value used to be.
 */
export const orgListQuerySchema = z
  .object({
    includeDeleted: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => v === true || v === 'true')
      .optional()
      .default(false),
  })
  .strict();

export default {
  createDepartmentSchema,
  updateDepartmentSchema,
  createLocationSchema,
  updateLocationSchema,
  orgListQuerySchema,
};
