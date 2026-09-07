import { hrmsClient } from "./client";

/**
 * Dashboard API.
 *
 * Two reads, not fifteen. Each is one server-side aggregation that already
 * knows the caller's scope, so the browser never filters for authorization and
 * never pulls a collection to count it.
 *
 * There is no write here. The dashboard reads; the modules own the writes.
 */

export const dashboardApi = {
  /** Holidays, announcements, polls, who is out, celebrations, quick access. */
  widgets: () => hrmsClient.get("/dashboard/widgets"),
  /** Role-shaped: workforce KPIs, pending queues, new hires, exits, trend. */
  summary: (params = {}) => hrmsClient.get("/dashboard/summary", params),
  loginTrend: (range = "7d") => hrmsClient.get("/dashboard/login-trend", { range }),
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** The reference's own thresholds, and its "Working late" for both ends. */
export function greetingFor(hour = new Date().getHours()) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Working late";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * "Thursday, September 4" — the reference's `dddd, MMMM D`.
 *
 * Built from local getters, never `toISOString()`: this is the viewer's own
 * calendar, and UTC is a different day for part of every day. The final audit
 * fixed three schemas that got this wrong.
 */
export function formatHeroDate(d = new Date()) {
  return `${DAYS[d.getDay()]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}`;
}

/** "4:05 PM". */
export function formatClock(d = new Date()) {
  const h = d.getHours();
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(d.getMinutes()).padStart(2, "0")} ${suffix}`;
}

/** `YYYY-MM-DD` as "04 Sep". Split, never parsed — a day has no instant. */
export function formatShortDay(day) {
  if (!day) return "—";
  const [y, m, d] = String(day).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "—";
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]}`;
}

/** "Today", "Tomorrow", then "in n days" — how a celebration reads. */
export function formatDaysUntil(days) {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days} days`;
}
