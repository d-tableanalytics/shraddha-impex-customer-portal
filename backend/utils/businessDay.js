/**
 * Calendar days in the business's own time zone — India (Asia/Kolkata).
 *
 * A date the desk types ("25 Oct") is a day in India, whatever time zone the
 * server happens to run in. Building it with `new Date(y, m, d)` makes it a
 * day in the SERVER's zone instead: on a server in Sydney, 25 Oct is stored as
 * 24 Oct 13:00 UTC, shows as the 24th in an Indian browser, and its end-of-day
 * cut-off falls at 18:29 IST. Everything that turns a business date into an
 * instant, or an instant back into a business date, goes through here.
 *
 * India has no daylight saving, so the offset is a constant and the arithmetic
 * is exact — no time-zone database is needed.
 */

export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant an IST calendar day starts, for the IST day containing `date`. */
export const istDayStart = (date) => {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST_OFFSET_MS);
};

/** The last millisecond of the IST calendar day containing `date`. */
export const istDayEnd = (date) => new Date(istDayStart(date).getTime() + DAY_MS - 1);

/** 'YYYY-MM-DD' of the IST calendar day containing `date`. */
export const istYmd = (date) => {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
};

/**
 * 'YYYY-MM-DD' (what a date input sends) -> the instant that IST day starts,
 * or null for anything that is not a real calendar date ('2026-02-30').
 */
export const parseIstDay = (raw) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  return new Date(utc.getTime() - IST_OFFSET_MS);
};

/** '25 Oct 2026', in IST. */
export const formatIstDate = (date) => new Date(date).toLocaleDateString('en-IN', {
  timeZone: BUSINESS_TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric',
});

export default { BUSINESS_TIME_ZONE, istDayStart, istDayEnd, istYmd, parseIstDay, formatIstDate };
