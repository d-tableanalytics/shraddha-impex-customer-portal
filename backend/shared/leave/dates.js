/**
 * Leave day arithmetic — the sandwich rule.
 *
 * Ported from the reference's `LeaveService.computeDuration`
 * (`leave.service.ts:536-626`). Pure on purpose: this decides how many days
 * come off someone's balance, so it is the one piece that has to be provable
 * without a database, a request or a clock.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 * Working days inside the range count by their portion — a full day is 1, a
 * half day is 0.5. A weekend or holiday inside the range normally costs
 * nothing, EXCEPT when it is sandwiched between two FULL leave days, in which
 * case it counts as a full day. A half day, an hourly day or a `half_*` day in
 * a mixed request on either side breaks the sandwich, and the non-working day
 * is free again. Hourly leave never drags in a surrounding non-working day at
 * all.
 *
 * That is the reference's behaviour exactly, and it is the behaviour employees
 * will already be used to.
 *
 * ---------------------------------------------------------------------------
 * Dates are handled as calendar days, never as instants
 * ---------------------------------------------------------------------------
 * Every date here is a `YYYY-MM-DD` string and every conversion goes through
 * `Date.UTC`. The reference uses `new Date(iso)` and `Date.parse(iso)`, which
 * are UTC-midnight for a bare date but local-midnight for other formats - the
 * classic source of an off-by-one where a leave that starts on the 1st is
 * stored as the 30th for anyone west of Greenwich. Leave is a calendar
 * concept: the 3rd is the 3rd wherever the server happens to run.
 */

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` -> UTC epoch ms at midnight. Rejects anything else. */
export function dayToUtcMs(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new TypeError(`Expected a YYYY-MM-DD date, got ${JSON.stringify(iso)}`);
  }
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day);

  // Date.UTC rolls 2026-02-31 into March rather than failing. A date that does
  // not survive the round trip was never a real date.
  const back = new Date(ms).toISOString().slice(0, 10);
  if (back !== iso) throw new TypeError(`${iso} is not a real calendar date`);
  return ms;
}

/** UTC epoch ms -> `YYYY-MM-DD`. */
export const utcMsToDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * 🔴 "Today" is not one day. Comparing a user's day against UTC's day is a bug.
 *
 * These schemas run in the BROWSER as well as on the server (AD-6), and a form
 * that defaults a field to "today" uses the viewer's own calendar — which is
 * what a person means by today, and what every date picker shows them.
 *
 * UTC is a different day for part of every day. In IST (UTC+5:30) the local
 * date runs AHEAD of UTC from 00:00 to 05:30; west of Greenwich it runs BEHIND
 * in the evening. So a bound written as `value <= utcMsToDay(Date.now())`
 * rejects the user's own today as "in the future" for five and a half hours
 * every single night — and the same rule on the server rejects it again, so a
 * corrected client would not help.
 *
 * That is not hypothetical: it made expense claims and attendance corrections
 * unfileable between midnight and 05:30 IST, every day, on both halves of the
 * app.
 *
 * One day of tolerance is the whole timezone envelope — no real calendar is
 * more than 24 hours from UTC — so these accept any day that is "today"
 * somewhere, and still refuse a date that is genuinely next week. Where a
 * tighter rule matters, the SERVICE applies it against the company's own
 * timezone, which the schema cannot know.
 */
const ONE_DAY_MS = 86_400_000;

/** True when `iso` is not in the future for any viewer on Earth. */
export const isNotFutureDay = (iso) => iso <= utcMsToDay(Date.now() + ONE_DAY_MS);

/** True when `iso` is not in the past for any viewer on Earth. */
export const isNotPastDay = (iso) => iso >= utcMsToDay(Date.now() - ONE_DAY_MS);

/** Every calendar day from `start` to `end` inclusive. */
export function eachDay(startIso, endIso) {
  const start = dayToUtcMs(startIso);
  const end = dayToUtcMs(endIso);
  if (end < start) return [];

  const days = [];
  for (let ms = start; ms <= end; ms += MS_PER_DAY) days.push(utcMsToDay(ms));
  return days;
}

/** Inclusive day count. `2026-01-01`..`2026-01-01` is 1, not 0. */
export const inclusiveDayCount = (startIso, endIso) => {
  const start = dayToUtcMs(startIso);
  const end = dayToUtcMs(endIso);
  return end < start ? 0 : Math.floor((end - start) / MS_PER_DAY) + 1;
};

/** Saturday or Sunday, read in UTC so it cannot drift with the server. */
export const isWeekend = (iso) => {
  const dow = new Date(dayToUtcMs(iso)).getUTCDay();
  return dow === 0 || dow === 6;
};

export const LEAVE_DURATION_UNITS = Object.freeze(['full_day', 'half_day', 'hour', 'mixed']);
export const HALF_DAY_PERIODS = Object.freeze(['first', 'second']);
export const DAY_BREAKDOWN_KINDS = Object.freeze(['full', 'half_first', 'half_second']);

/**
 * How many days a request costs.
 *
 * @param {object}      request
 * @param {string}      request.startDate      YYYY-MM-DD
 * @param {string}      request.endDate        YYYY-MM-DD
 * @param {string}      request.durationUnit   full_day | half_day | hour | mixed
 * @param {number}     [request.hoursPerDay]   hours taken, when unit is `hour`
 * @param {object[]}   [request.dayBreakdown]  [{ date, kind }], when unit is `mixed`
 * @param {Set<string>} holidayDates           YYYY-MM-DD strings
 * @param {number}     [workdayHours]          hours in a standard working day
 * @returns {number} days, to two decimals
 */
export function computeLeaveDays(
  { startDate, endDate, durationUnit = 'full_day', hoursPerDay, dayBreakdown = null },
  holidayDates = new Set(),
  workdayHours = 8,
) {
  const dates = eachDay(startDate, endDate);
  if (dates.length === 0) return 0;

  const isNonWorking = (iso) => isWeekend(iso) || holidayDates.has(iso);

  const breakdownFor = (iso) => dayBreakdown?.find((entry) => entry.date === iso) ?? null;

  /**
   * What one working day of this request costs, IN DAYS.
   *
   * The reference returns `hoursPerDay` here — raw hours — and then subtracts
   * that number from a balance denominated in days, so a two-hour absence
   * spends two days of someone's entitlement. Hours are converted to a day
   * fraction instead; `workdayHours` is configuration, not a constant baked
   * into this file.
   */
  const portionOf = (iso) => {
    switch (durationUnit) {
      case 'full_day':
        return 1;
      case 'half_day':
        return 0.5;
      case 'hour':
        return Math.min(1, (hoursPerDay ?? workdayHours) / workdayHours);
      case 'mixed': {
        const entry = breakdownFor(iso);
        return !entry || entry.kind === 'full' ? 1 : 0.5;
      }
      default:
        return 0;
    }
  };

  /** Only a whole working day of leave can hold up one side of a sandwich. */
  const isFullLeaveDay = (iso) => {
    if (isNonWorking(iso)) return false;
    switch (durationUnit) {
      case 'full_day':
        return true;
      case 'half_day':
      case 'hour':
        return false;
      case 'mixed': {
        const entry = breakdownFor(iso);
        return !entry || entry.kind === 'full';
      }
      default:
        return false;
    }
  };

  /** The nearest working day before/after `index`, or null. */
  const neighbour = (index, step) => {
    for (let i = index + step; i >= 0 && i < dates.length; i += step) {
      if (!isNonWorking(dates[i])) return dates[i];
    }
    return null;
  };

  let total = 0;

  for (let i = 0; i < dates.length; i += 1) {
    const iso = dates[i];

    if (!isNonWorking(iso)) {
      total += portionOf(iso);
      continue;
    }

    // An hourly absence is a few hours on one day; it never reaches across a
    // weekend to charge for it.
    if (durationUnit === 'hour') continue;

    const before = neighbour(i, -1);
    const after = neighbour(i, +1);
    if (before && after && isFullLeaveDay(before) && isFullLeaveDay(after)) total += 1;
  }

  // Two decimals: halves and hour fractions are the only values that occur,
  // and float addition of 0.5 repeatedly is otherwise happy to produce
  // 2.9999999999999996.
  return Math.round(total * 100) / 100;
}

export default {
  dayToUtcMs,
  utcMsToDay,
  eachDay,
  inclusiveDayCount,
  isWeekend,
  computeLeaveDays,
};
