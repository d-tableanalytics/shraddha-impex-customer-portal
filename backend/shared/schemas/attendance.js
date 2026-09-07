/**
 * Attendance validation schemas (AD-6).
 *
 * Ported from the reference's `packages/shared-types/src/attendance.ts` and
 * used by BOTH the Express validator and the React forms, so a rule cannot
 * drift between them.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections to the reference
 * ---------------------------------------------------------------------------
 * 1. COORDINATES ARE PER PUNCH. The reference's record carries a single
 *    `geoLat`/`geoLng` pair but two location labels, so a clock-out silently
 *    overwrites where the clock-in happened (AD-15, defect 2). The punch body
 *    therefore carries one `geo` block and the SERVER files it under the punch
 *    being made.
 *
 * 2. A SELFIE IS A STORAGE KEY, NEVER A URL. The reference posts
 *    `selfieUrl: '/api/v1/attendance/selfie/<filename>'` and stores that string
 *    - which is also a public, guessable endpoint (AD-15, defect 1). Here the
 *    client uploads first and passes back the opaque key it was given; the
 *    service verifies that key belongs to the caller before storing it.
 *
 * 3. ACCURACY IS ACCEPTED. The reference discards it. Without it there is no
 *    way to tell a rooftop GPS fix from a cell-tower guess, and both would be
 *    displayed with identical confidence.
 *
 * 4. `employeeId` IS NEVER ACCEPTED ON A PUNCH. The reference derives it from
 *    the actor, and so does this - it is called out because a punch body that
 *    took one would let anybody clock in as anybody.
 */

import { z } from 'zod';

import { objectId, isoDay, isoDateTime, paginationQuery } from '../validation/common.js';
import {
  SELF_PUNCH_SOURCES,
  ATTENDANCE_STATUSES,
  CORRECTION_STATUSES,
  PUNCH_TYPES,
  MAX_GPS_ACCURACY_METRES,
  MAX_BIOMETRIC_PUNCHES,
} from '../constants/attendance.js';
import { CONSENT_PURPOSE_LIST, STORAGE_PREFIXES, STORAGE_CATEGORIES } from '../constants/hrms.js';
import { isNotFutureDay } from '../leave/dates.js';

// ---------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------

/**
 * A punch-time position.
 *
 * Ranges are enforced rather than assumed: a browser that reports a longitude
 * of 200 is broken, and storing it would put an employee off the map on every
 * screen that renders one.
 *
 * `accuracy` is the radius of the 95% confidence circle, in metres, exactly as
 * `GeolocationCoordinates.accuracy` defines it. Negative is impossible; the
 * upper bound is a sanity ceiling, not a geofence (AD-15 rules geofencing out).
 */
export const geoPointSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().max(MAX_GPS_ACCURACY_METRES).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Selfie keys
// ---------------------------------------------------------------------------

const SELFIE_PREFIX = STORAGE_PREFIXES[STORAGE_CATEGORIES.ATTENDANCE_SELFIE];

/**
 * An object key returned by the selfie upload endpoint.
 *
 * Shape-checked here; OWNERSHIP is checked in the service, because only the
 * service knows who is punching. Both are needed: this stops a traversal
 * attempt reaching any storage call at all, and the service stops a valid-
 * looking key that belongs to somebody else.
 */
export const selfieKeySchema = z
  .string()
  .trim()
  .max(300)
  .regex(
    new RegExp(`^${SELFIE_PREFIX}/[A-Za-z0-9_-]{1,64}/[0-9a-fA-F-]{36}\\.(jpg|jpeg|png|webp)$`),
    'not a selfie object key',
  );

// ---------------------------------------------------------------------------
// Punch
// ---------------------------------------------------------------------------

/**
 * The clock-in / clock-out body.
 *
 * EVERY capture field is optional, and that is a requirement rather than a
 * convenience: AD-15 aligns consent to the DPDP Act, under which consent must
 * be free - so a refusal to share a selfie or a location must still leave the
 * punch possible. A schema that required either would make consent a condition
 * of being paid.
 */
export const punchSchema = z
  .object({
    source: z.enum(SELF_PUNCH_SOURCES).default('web'),
    geo: geoPointSchema.optional(),
    selfieKey: selfieKeySchema.optional(),
    /**
     * A human-readable label the client already resolved.
     *
     * Accepted so a browser that has done the lookup saves the server a call,
     * but never required: the server resolves its own label asynchronously
     * after the record is written (AD-15, defect 3).
     */
    locationLabel: z.string().trim().max(300).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The history query.
 *
 * The reference caps its list at 400 rows with no paging at all
 * (`attendance.service.ts#list`), which silently truncates a year of history.
 * AD-13 requires server-side pagination regardless of how small the set looks,
 * so `paginationQuery` is extended rather than replaced.
 */
export const attendanceListQuerySchema = paginationQuery
  .extend({
    employeeId: objectId.optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    status: z.enum(ATTENDANCE_STATUSES).optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  });

/**
 * The params of `/records/:id/selfie/:punch`.
 *
 * BOTH parameters, deliberately. `validate` REPLACES `req.params` with the
 * parsed result, and a Zod object strips keys it does not declare — so a schema
 * naming only `punch` would delete `req.params.id` and the handler would look
 * up a record with `undefined`.
 */
export const selfieParamsSchema = z
  .object({
    id: objectId,
    punch: z.enum(PUNCH_TYPES),
  })
  .strict();

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/**
 * A correction request.
 *
 * The reference's fields exactly - date, requested in, requested out, reason
 * (10-500 chars) - with its "at least one of the two times" rule moved from the
 * service into the schema, so the API refuses at the boundary rather than after
 * a database round trip.
 *
 * The future-date refusal is the reference's `disabledDate` browser rule made
 * to bind every client. Its server accepts a correction for next year.
 */
export const attendanceCorrectionSchema = z
  .object({
    date: isoDay,
    requestedClockIn: isoDateTime.nullable().optional().default(null),
    requestedClockOut: isoDateTime.nullable().optional().default(null),
    reason: z.string().trim().min(10, 'Give at least 10 characters.').max(500),
  })
  .strict()
  .refine((v) => v.requestedClockIn || v.requestedClockOut, {
    message: 'Provide at least one of requestedClockIn / requestedClockOut.',
    path: ['requestedClockIn'],
  })
  // 🔴 Was `new Date().toISOString().slice(0, 10)` — UTC's day, compared
  // against a date the picker produced in the viewer's calendar. That refused
  // a correction for TODAY between midnight and 05:30 IST, every night. See
  // `isNotFutureDay`.
  .refine((v) => isNotFutureDay(v.date), {
    message: 'A correction cannot be requested for a future date.',
    path: ['date'],
  })
  .refine(
    (v) =>
      !v.requestedClockIn ||
      !v.requestedClockOut ||
      new Date(v.requestedClockIn) < new Date(v.requestedClockOut),
    { message: 'Clock-in must be before clock-out.', path: ['requestedClockOut'] },
  );

export const attendanceCorrectionDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().trim().max(500).optional(),
  })
  .strict();

export const correctionListQuerySchema = paginationQuery
  .extend({
    status: z.enum(CORRECTION_STATUSES).optional(),
    employeeId: objectId.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Consent (AD-15) - net-new; the reference has no consent model at all
// ---------------------------------------------------------------------------

export const consentPurposeSchema = z.enum(CONSENT_PURPOSE_LIST);

export const consentDecisionSchema = z
  .object({
    purpose: consentPurposeSchema,
    /**
     * An explicit boolean. No default, deliberately: DPDP consent must be
     * unambiguous and affirmative, and a field that defaults to `true` when
     * omitted is neither.
     */
    granted: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Biometric ingestion
// ---------------------------------------------------------------------------

/**
 * The vendor-agnostic canonical punch payload, as the reference defines it.
 *
 * Vendor-specific parsing is NOT ported. The reference ships three driver stubs
 * in `biometric-drivers.ts` and nothing imports them - no controller, no
 * service, no test - so there is no workflow there to reproduce, only unreached
 * code. A device or its middleware normalises to this shape and signs it.
 */
export const biometricPunchSchema = z
  .object({
    employeeCode: z.string().trim().min(1).max(40),
    timestamp: isoDateTime,
    punchType: z.enum(PUNCH_TYPES),
    deviceId: z.string().trim().min(1).max(80),
    raw: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const biometricIngestSchema = z
  .object({
    punches: z.array(biometricPunchSchema).min(1).max(MAX_BIOMETRIC_PUNCHES),
  })
  .strict();

export default {
  geoPointSchema,
  selfieKeySchema,
  punchSchema,
  attendanceListQuerySchema,
  selfieParamsSchema,
  attendanceCorrectionSchema,
  attendanceCorrectionDecisionSchema,
  correctionListQuerySchema,
  consentPurposeSchema,
  consentDecisionSchema,
  biometricPunchSchema,
  biometricIngestSchema,
};
