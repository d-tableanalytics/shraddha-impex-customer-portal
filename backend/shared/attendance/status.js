/**
 * The attendance calendar day, and the status derived from a day's punches.
 *
 * Under `shared/` because both halves need it and they must not disagree. The
 * reference computes its derived status in the browser alone
 * (`apps/web/src/pages/attendance/attendance-status.tsx`), so the API returns a
 * bare `status: 'present'` and every non-browser consumer - a report, an
 * export, a manager's summary - would have to restate the 7h45m rule for
 * itself. One implementation, imported by the service and by the screen.
 *
 * Dependency-free apart from `../constants/attendance.js`.
 */

import {
  FULL_DAY_HOURS,
  HALF_DAY_HOURS,
  ATTENDANCE_TIME_ZONE,
} from '../constants/attendance.js';

// ---------------------------------------------------------------------------
// The calendar day
// ---------------------------------------------------------------------------

/**
 * The `YYYY-MM-DD` an instant falls on, in a given zone.
 *
 * `en-CA` is used because its short date format IS `YYYY-MM-DD`, so no manual
 * part reassembly is needed and no locale surprise can reorder it.
 *
 * @param {Date}   [at]        the instant; defaults to now
 * @param {string} [timeZone]  IANA zone; defaults to the configured one
 * @returns {string}
 */
export function attendanceDayString(at = new Date(), timeZone = ATTENDANCE_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * The stored `date` value for a calendar day.
 *
 * MIDNIGHT UTC of that day, used purely as a label. Storing the local midnight
 * instead would make the stored value shift when the configured zone changed,
 * and would make an equality lookup depend on knowing the zone that was in
 * force when the row was written.
 *
 * @param {string} day `YYYY-MM-DD`
 * @returns {Date}
 */
export function dayToDate(day) {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The inverse of {@link dayToDate}. */
export function dateToDay(date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : String(date ?? '');
}

/** Today's stored `date` value. */
export const todayDate = (at = new Date(), timeZone = ATTENDANCE_TIME_ZONE) =>
  dayToDate(attendanceDayString(at, timeZone));

/**
 * Shift a `YYYY-MM-DD` by whole days.
 *
 * Arithmetic happens on the UTC label, never on a local timestamp, so a DST
 * transition in the configured zone cannot add or drop a day.
 */
export function shiftDay(day, deltaDays) {
  const d = dayToDate(day);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return dateToDay(d);
}

// ---------------------------------------------------------------------------
// Derived status
// ---------------------------------------------------------------------------

/** Decimal hours between two instants, or 0. */
export function hoursBetween(from, to) {
  if (!from || !to) return 0;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms > 0 ? ms / 3_600_000 : 0;
}

/** `7h 45m`. */
export function formatHours(decimalHours) {
  const totalMinutes = Math.max(0, Math.round((decimalHours ?? 0) * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Derive the rich status of one attendance day.
 *
 * The reference's rules, kept exactly:
 *   - no clock-in                        -> Absent
 *   - clocked in, not out                -> On the clock, with elapsed hours
 *   - >= FULL_DAY_HOURS                  -> Full day
 *   - >= HALF_DAY_HOURS but under full   -> Half day, with a hint
 *   - under HALF_DAY_HOURS               -> Present, with a hint
 *
 * `now` is injectable so the "on the clock" branch is testable and so a server
 * rendering a historical list does not describe an old open punch as still
 * running against the wall clock.
 *
 * @returns {{ kind: string, label: string, tone: string, hint: string|null,
 *             hoursWorked: number, complete: boolean }}
 */
export function deriveAttendanceStatus(clockIn, clockOut, now = new Date()) {
  if (!clockIn) {
    return {
      kind: 'absent',
      label: 'Absent',
      tone: 'neutral',
      hint: null,
      hoursWorked: 0,
      complete: false,
    };
  }

  if (!clockOut) {
    const soFar = hoursBetween(clockIn, now);
    return {
      kind: 'in_progress',
      label: 'On the clock',
      tone: 'primary',
      hint: `Working — ${formatHours(soFar)} so far, not clocked out yet`,
      hoursWorked: soFar,
      complete: false,
    };
  }

  const hours = hoursBetween(clockIn, clockOut);

  if (hours >= FULL_DAY_HOURS) {
    return {
      kind: 'full_day',
      label: 'Full day',
      tone: 'success',
      hint: null,
      hoursWorked: hours,
      complete: true,
    };
  }

  if (hours >= HALF_DAY_HOURS) {
    return {
      kind: 'half_day',
      label: 'Half day',
      tone: 'warning',
      hint: `Full hours not yet completed (${formatHours(hours)} / ${formatHours(FULL_DAY_HOURS)})`,
      hoursWorked: hours,
      complete: true,
    };
  }

  return {
    kind: 'present_partial',
    label: 'Present',
    tone: 'primary',
    hint: `Not full hours completed (${formatHours(hours)} / ${formatHours(HALF_DAY_HOURS)} for half day)`,
    hoursWorked: hours,
    complete: true,
  };
}

export default {
  attendanceDayString,
  dayToDate,
  dateToDay,
  todayDate,
  shiftDay,
  hoursBetween,
  formatHours,
  deriveAttendanceStatus,
};
