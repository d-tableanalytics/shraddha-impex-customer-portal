/**
 * Conversions between the "YYYY-MM-DD" strings the portal stores and the Date
 * objects the calendar works in.
 *
 * BOTH DIRECTIONS STAY IN LOCAL TIME. `new Date("2026-08-05")` is parsed as UTC
 * midnight, which is still the 4th for anyone west of Greenwich — so a user
 * picking the 5th would file a booking dated the 4th. These build and read the
 * date field by field and never touch the string parser, so the machine's
 * timezone cannot shift the result.
 *
 * They live here rather than beside the component so the component file exports
 * only a component, which is what React Fast Refresh needs to work.
 */

/** Date -> "YYYY-MM-DD" in LOCAL time. Empty string when there is no date. */
export const toYmd = (date) => {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "YYYY-MM-DD" -> Date at LOCAL midnight. undefined when unset or malformed. */
export const fromYmd = (value) => {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** Today as "YYYY-MM-DD", for min/max bounds. */
export const todayYmd = () => toYmd(new Date());

/** How a date is written throughout the portal: "05 Aug 2026". */
export const formatDisplayDate = (date) =>
  date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export default { toYmd, fromYmd, todayYmd, formatDisplayDate };
