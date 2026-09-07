import { hrmsClient } from "./client";

/**
 * Planning API.
 *
 * A thin wrapper over `hrmsClient`, which already unwraps the
 * `{ success, data }` envelope and normalises errors into `HrmsApiError` — so a
 * screen branches on `err.code`, never on a message.
 */

export const headcountPlansApi = {
  list: (params = {}) => hrmsClient.get("/planning/headcount", params),
  /**
   * The three summary tiles, summed over the WHOLE year in the database.
   *
   * The reference sums these in the browser over the rows it happened to fetch,
   * which stops being the year's total the moment the list is paginated.
   */
  summary: (params = {}) => hrmsClient.get("/planning/headcount/summary", params),
  /** The years that actually have plans — the reference offers a free text box. */
  years: () => hrmsClient.get("/planning/headcount/years"),
  get: (id) => hrmsClient.get(`/planning/headcount/${id}`),
  create: (dto) => hrmsClient.post("/planning/headcount", dto),
  /** No equivalent in the reference: a plan there is created and then frozen. */
  update: (id, dto) => hrmsClient.patch(`/planning/headcount/${id}`, dto),
};

export const hiringPlansApi = {
  list: (params = {}) => hrmsClient.get("/planning/hiring", params),
  summary: () => hrmsClient.get("/planning/hiring/summary"),
  get: (id) => hrmsClient.get(`/planning/hiring/${id}`),
  create: (dto) => hrmsClient.post("/planning/hiring", dto),
  update: (id, dto) => hrmsClient.patch(`/planning/hiring/${id}`, dto),
  /**
   * Move a plan along.
   *
   * The reference has no endpoint here at all, which is why four of its five
   * statuses are unreachable. Legality is decided by the SERVER against the
   * transition table; the row carries `allowedTransitions` so the UI offers
   * exactly the moves that will be accepted.
   */
  changeStatus: (id, dto) => hrmsClient.patch(`/planning/hiring/${id}/status`, dto),
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const HIRING_PLAN_STATUS_TONES = Object.freeze({
  planned: "neutral",
  in_progress: "primary",
  completed: "success",
  delayed: "warning",
  cancelled: "neutral",
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A `YYYY-MM-DD` day as "01 Sep 2026".
 *
 * Parsed by SPLITTING the string, never with `new Date(day)` — that parses a
 * bare date as UTC midnight and then renders it in local time, which shows the
 * previous day for anyone west of Greenwich. The value is a day; it has no
 * instant to convert.
 */
export function formatPlanDay(day) {
  if (!day) return "—";
  const [y, m, d] = String(day).split("-").map(Number);
  if (!y || !m || !d) return "—";
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Money, as the reference renders it: `₹12,34,567`.
 *
 * Indian grouping, and no decimals — a headcount budget is quoted in whole
 * rupees. The exact paise live in Decimal128 on the server; this is display.
 */
export function formatPlanMoney(amount) {
  if (amount === null || amount === undefined) return "—";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** Planned vs actual, as a whole-number percentage. Guards the zero plan. */
export function utilizationPercent(actual, planned) {
  if (!planned) return 0;
  return Math.round((Number(actual) / Number(planned)) * 100);
}
