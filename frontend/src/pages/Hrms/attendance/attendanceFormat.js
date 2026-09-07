/**
 * Date, time and duration formatting for the Attendance screens.
 *
 * Every format here is matched to the reference's dayjs calls, so the columns
 * read identically:
 *
 *   table date      `DD MMM YYYY`  -> 01 Sep 2026   (AttendancePage.tsx:129)
 *   table time      `HH:mm`        -> 09:15         (:137, :156)
 *   table hours     `.toFixed(2)`  -> 9.00          (:176)
 *   card clock      `h:mm` + `A`   -> 9:15 AM       (ClockInCard.tsx:701)
 *   card date       `ddd, DD MMM`  -> Wed, 02 Sep   (:646)
 *   card elapsed    HH:mm:ss                        (:formatElapsed)
 *
 * The project does not depend on dayjs and one is not added for four formats -
 * `Intl.DateTimeFormat` does all of it and ships in every supported browser.
 *
 * ---------------------------------------------------------------------------
 * Months are spelled out here, not left to the locale
 * ---------------------------------------------------------------------------
 * `Intl` with `month: 'short'` renders September as "Sept" under `en-GB` on
 * ICU 72+ and "Sep" before it, so the column would change spelling with the
 * Node/browser build. dayjs's `MMM` is always three letters, so the reference
 * always shows "Sep". A fixed table matches it and cannot drift.
 *
 * Everything renders in the BUSINESS time zone, never the viewer's: a manager
 * travelling would otherwise see their team's punches shifted by hours, and the
 * day a row belongs to would stop matching the date beside it.
 */

import { ATTENDANCE_TIME_ZONE } from "@shared/constants/attendance.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The wall-clock parts of an instant, in the business zone.
 *
 * One formatter feeding every helper below, so a date and the time beside it
 * can never be resolved against different zones.
 */
const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: ATTENDANCE_TIME_ZONE,
  hour12: false,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function zonedParts(value) {
  const parts = partsFormatter.formatToParts(value);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    year: Number(get("year")),
    // `hour` can come back as "24" at midnight under hour12:false.
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
  };
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * A `YYYY-MM-DD` is a calendar LABEL with no time of day.
 *
 * Pinned to midday UTC before formatting so no zone offset can push it onto the
 * neighbouring date - a bug that would show a punch under the wrong day.
 */
const toInstant = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);

// ---------------------------------------------------------------------------
// Table formats
// ---------------------------------------------------------------------------

/** `09:15`, or an em dash for a punch that never happened. */
export function formatTime(iso) {
  if (!iso) return "—";
  const { hour, minute } = zonedParts(new Date(iso));
  return `${pad(hour)}:${pad(minute)}`;
}

/** `01 Sep 2026` - the reference's `DD MMM YYYY`. */
export function formatDate(value) {
  if (!value) return "—";
  const { day, month, year } = zonedParts(toInstant(value));
  return `${pad(day)} ${MONTHS[month - 1]} ${year}`;
}

/**
 * `9.00` - decimal hours to two places, exactly as the reference's Hours column.
 *
 * Not "9h 00m": that reads better in isolation but it is not what the column
 * shows, and payroll conversations quote the decimal.
 */
export function formatHoursDecimal(decimalHours) {
  if (!decimalHours || decimalHours <= 0) return "—";
  return decimalHours.toFixed(2);
}

// ---------------------------------------------------------------------------
// Clock-card formats
// ---------------------------------------------------------------------------

/**
 * `{ time: '9:15', meridiem: 'AM' }` - the reference renders the two at
 * different sizes, so they are returned separately rather than as one string.
 */
export function formatClockTime(value = new Date()) {
  const { hour, minute } = zonedParts(value instanceof Date ? value : new Date(value));
  const meridiem = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return { time: `${twelve}:${pad(minute)}`, meridiem };
}

/** `9:15 AM`, for the "Since …" line. */
export function formatClockTimeLabel(value) {
  if (!value) return "—";
  const { time, meridiem } = formatClockTime(new Date(value));
  return `${time} ${meridiem}`;
}

/** `Wed, 02 Sep` - the card's header date. */
export function formatDayLabel(date = new Date()) {
  const { weekday, day, month } = zonedParts(date);
  // `weekday: 'short'` is already three letters in en-GB, but it is normalised
  // through the same table as the months so both sides cannot disagree.
  const index = WEEKDAYS.indexOf(weekday);
  return `${index >= 0 ? WEEKDAYS[index] : weekday}, ${pad(day)} ${MONTHS[month - 1]}`;
}

/** `01:23:45` - the running counter while someone is on the clock. */
export function formatElapsed(fromIso, now = new Date()) {
  if (!fromIso) return "00:00:00";
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 1000));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map(pad)
    .join(":");
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Today, as the `YYYY-MM-DD` the API speaks. */
export function todayIsoDay() {
  const { year, month, day } = zonedParts(new Date());
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * A position, for display.
 *
 * The resolved street label when there is one, otherwise the raw coordinates -
 * never nothing. A punch that recorded a position but could not name it should
 * still show that a position was recorded.
 */
export function formatLocation(capture) {
  if (!capture) return null;
  if (capture.locationLabel) return capture.locationLabel;
  if (capture.geo) return `${capture.geo.lat.toFixed(4)}°, ${capture.geo.lng.toFixed(4)}°`;
  return null;
}

export default {
  formatTime,
  formatDate,
  formatHoursDecimal,
  formatClockTime,
  formatClockTimeLabel,
  formatDayLabel,
  formatElapsed,
  todayIsoDay,
  formatLocation,
};
