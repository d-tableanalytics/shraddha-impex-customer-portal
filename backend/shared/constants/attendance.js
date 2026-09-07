/**
 * Attendance vocabulary and business thresholds.
 *
 * A file of its own rather than more entries in `./hrms.js`, for the reason
 * that file states about itself: it carries "Phase 0 scope only ... module
 * specific enums arrive with their modules". This is that module's enums.
 *
 * Dependency-free, like every other file under `shared/constants/`. In
 * particular it reads NO environment: `shared/` is bundled into the browser as
 * well as run in Node (see `shared/README.md` rule 1), so a `process.env` here
 * is a runtime crash in the SPA rather than a configuration option.
 *
 * ---------------------------------------------------------------------------
 * Ported from the reference
 * ---------------------------------------------------------------------------
 * `attendanceSourceSchema` and `attendanceStatusSchema`
 * (`packages/shared-types/src/attendance.ts`) give the two enums verbatim. The
 * hour thresholds are the reference's own product rule, stated in
 * `apps/web/src/pages/attendance/attendance-status.tsx`:
 *
 *     FULL_DAY_HOURS = 7.75   // 7h 45m
 *     HALF_DAY_HOURS = 3.75   // 3h 45m
 *
 * They live here rather than in the browser because the reference computes the
 * derived status client-side only, which means a report, an export or an API
 * consumer would each have to restate the rule and could each get it wrong.
 */

import { DEFAULT_TIME_ZONE } from './timezones.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** How a punch reached the system. */
export const ATTENDANCE_SOURCES = Object.freeze([
  'web',
  'mobile',
  'biometric',
  'manual',
]);

/** Sources an employee may claim for their own punch. */
export const SELF_PUNCH_SOURCES = Object.freeze(['web', 'mobile']);

/**
 * The stored status of an attendance day.
 *
 * `present` is what a punch writes. The richer full-day / half-day / partial
 * distinction is DERIVED from the hours worked (see ../attendance/status.js) and
 * deliberately not stored: it changes the moment the thresholds change, and a
 * stored copy would then disagree with every recomputation.
 *
 * The remaining values exist because the reference declares them and later
 * modules will write them - `on_leave` and `holiday` belong to Leave and
 * Holidays, which this module does not own.
 */
export const ATTENDANCE_STATUSES = Object.freeze([
  'present',
  'absent',
  'half_day',
  'on_leave',
  'holiday',
  'weekly_off',
  'pending_regularization',
]);

export const PUNCH_TYPES = Object.freeze(['in', 'out']);

export const CORRECTION_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

// ---------------------------------------------------------------------------
// Derived-status thresholds
// ---------------------------------------------------------------------------

/** Hours that count as a full day. The reference's 7h 45m. */
export const FULL_DAY_HOURS = 7.75;

/** Hours that count as a half day. The reference's 3h 45m. */
export const HALF_DAY_HOURS = 3.75;

export const DERIVED_ATTENDANCE_KINDS = Object.freeze([
  'absent',
  'present_partial',
  'half_day',
  'full_day',
  'in_progress',
]);

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Image types accepted for a selfie.
 *
 * The reference allows the same three. Each is checked against the file's own
 * magic bytes as well as its declared type - a declared MIME is client-supplied
 * text and proves nothing.
 */
export const SELFIE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/** First bytes that must be present for each accepted type. */
export const SELFIE_MAGIC_BYTES = Object.freeze({
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // RIFF....WEBP - the four bytes at offset 8 are checked separately.
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
});

/**
 * GPS accuracy ceiling, in metres.
 *
 * Not a geofence (AD-15 rules those out): a reading this coarse is not a
 * location at all, and storing it would imply a precision that does not exist.
 * A punch carrying one is accepted WITHOUT coordinates rather than refused -
 * consent rules mean a punch never depends on capture succeeding.
 */
export const MAX_GPS_ACCURACY_METRES = 10_000;

/**
 * The time zone the attendance CALENDAR DAY is computed in.
 *
 * The reference uses the server's UTC day (`attendance.service.ts#todayString`).
 * For an India-based company that puts the day boundary at 05:30 local, so an
 * early shift clocking in at 05:00 IST would be filed against the previous day
 * and a 06:00 clock-out against the next one - the record would be split in
 * two and neither half would show hours.
 *
 * ---------------------------------------------------------------------------
 * A CONSTANT, deliberately - not an environment variable
 * ---------------------------------------------------------------------------
 * This read `process.env.HRMS_ATTENDANCE_TIME_ZONE` until it was found to break
 * the browser. `shared/README.md` rule 1 forbids `process.env` here precisely
 * because this directory "must run unchanged in Node and in a browser bundle",
 * and three Attendance screens import this file - so Vite bundled a `process`
 * reference into the SPA and `/hrms/attendance` died on load. The Node test
 * environment hid it, because `process` exists there.
 *
 * It is not restored as `import.meta.env` on one side and `process.env` on the
 * other, because both halves must agree on this value or they disagree about
 * which DAY a punch belongs to: the browser converts a wall-clock correction
 * time to an instant with it, and the server files that instant against a
 * calendar day with it. Two independently-configured variables can drift; one
 * constant cannot.
 *
 * AD-1 makes that safe - single tenant, one company, one business day. To
 * change it, change this line: both halves import it, so they move together.
 * `DEFAULT_TIME_ZONE` is reused rather than restated so the company has one
 * default time zone rather than two that can disagree.
 */
export const ATTENDANCE_TIME_ZONE = DEFAULT_TIME_ZONE;

// ---------------------------------------------------------------------------
// Biometric ingestion
// ---------------------------------------------------------------------------

/** Punches accepted in one webhook call. The reference's own ceiling. */
export const MAX_BIOMETRIC_PUNCHES = 500;

/**
 * How far back a device may report.
 *
 * A device that has been offline replays its buffer, so a window is needed; an
 * unbounded one lets a replayed payload rewrite a closed month.
 */
export const BIOMETRIC_MAX_BACKDATE_DAYS = 30;

/** Clock skew tolerated on a device's own timestamp. */
export const BIOMETRIC_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export default {
  ATTENDANCE_SOURCES,
  SELF_PUNCH_SOURCES,
  ATTENDANCE_STATUSES,
  PUNCH_TYPES,
  CORRECTION_STATUSES,
  FULL_DAY_HOURS,
  HALF_DAY_HOURS,
  DERIVED_ATTENDANCE_KINDS,
  SELFIE_MIME_TYPES,
  SELFIE_MAGIC_BYTES,
  MAX_GPS_ACCURACY_METRES,
  ATTENDANCE_TIME_ZONE,
  MAX_BIOMETRIC_PUNCHES,
  BIOMETRIC_MAX_BACKDATE_DAYS,
  BIOMETRIC_MAX_FUTURE_SKEW_MS,
};
