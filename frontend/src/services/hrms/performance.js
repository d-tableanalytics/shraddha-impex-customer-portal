import { hrmsClient } from "./client";

/**
 * Performance API.
 *
 * A thin wrapper over `hrmsClient`, which already unwraps the
 * `{ success, data }` envelope and normalises errors into `HrmsApiError` — so a
 * screen branches on `err.code`, never on a message.
 */

export const goalsApi = {
  list: (params = {}) => hrmsClient.get("/performance/goals", params),
  get: (id) => hrmsClient.get(`/performance/goals/${id}`),
  create: (dto) => hrmsClient.post("/performance/goals", dto),
  /** Owner or HR; the server refuses everyone else, a manager included. */
  update: (id, dto) => hrmsClient.patch(`/performance/goals/${id}`, dto),
  /** Refused server-side while any goal cascades from this one. */
  remove: (id) => hrmsClient.delete(`/performance/goals/${id}`),
};

export const cyclesApi = {
  list: (params = {}) => hrmsClient.get("/performance/cycles", params),
  get: (id) => hrmsClient.get(`/performance/cycles/${id}`),
  create: (dto) => hrmsClient.post("/performance/cycles", dto),
  /** Forward by one, or one step back — the server re-checks the phase table. */
  advancePhase: (id, phase) => hrmsClient.post(`/performance/cycles/${id}/phase`, { phase }),
  calibration: (id) => hrmsClient.get(`/performance/cycles/${id}/calibration`),
};

export const reviewsApi = {
  /** The caller's own queue. No id is sent — the server takes it from the session. */
  mine: (params = {}) => hrmsClient.get("/performance/reviews/mine", params),
  /**
   * Reviews written ABOUT the caller.
   *
   * Submitted responses only, and only once the cycle reaches calibration —
   * an employee cannot watch their manager's assessment take shape mid-cycle.
   */
  aboutMe: (params = {}) => hrmsClient.get("/performance/reviews/about-me", params),
  /** Every response in a cycle. HR's view. */
  list: (params = {}) => hrmsClient.get("/performance/reviews", params),
  get: (id) => hrmsClient.get(`/performance/reviews/${id}`),
  create: (dto) => hrmsClient.post("/performance/reviews", dto),
  /** The assigned reviewer only, once. */
  submit: (id, dto) => hrmsClient.post(`/performance/reviews/${id}/submit`, dto),
};

export const feedbackApi = {
  received: (params = {}) => hrmsClient.get("/performance/feedback/received", params),
  given: (params = {}) => hrmsClient.get("/performance/feedback/given", params),
  give: (dto) => hrmsClient.post("/performance/feedback", dto),
};

export const oneOnOnesApi = {
  /** Both sides come from the session; no id on the wire. */
  mine: (params = {}) => hrmsClient.get("/performance/one-on-ones", params),
  schedule: (dto) => hrmsClient.post("/performance/one-on-ones", dto),
  update: (id, dto) => hrmsClient.patch(`/performance/one-on-ones/${id}`, dto),
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const GOAL_STATUS_TONES = Object.freeze({
  open: "neutral",
  in_progress: "primary",
  at_risk: "warning",
  achieved: "success",
  missed: "danger",
  cancelled: "neutral",
});

export const PHASE_TONES = Object.freeze({
  goal_setting: "neutral",
  self_review: "primary",
  manager_review: "warning",
  calibration: "primary",
  closed: "success",
});

export const FEEDBACK_KIND_TONES = Object.freeze({
  praise: "success",
  constructive: "warning",
});

export const ONE_ON_ONE_STATUS_TONES = Object.freeze({
  scheduled: "primary",
  completed: "success",
  cancelled: "neutral",
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `YYYY-MM-DD` to "01 Sep 2026", without a locale.
 *
 * Browser and Node ICU builds disagree on whether September abbreviates to
 * "Sep" or "Sept", which has broken a date assertion in this codebase before.
 * A fixed table renders the same everywhere.
 */
export const formatPerfDay = (value) => {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return "—";
  const [, y, mo, d] = m;
  return `${d} ${MONTHS[Number(mo) - 1]} ${y}`;
};

/** An ISO instant as "01 Sep 2026, 14:30". */
export const formatPerfInstant = (iso) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const day = formatPerfDay(date.toISOString().slice(0, 10));
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${day}, ${hh}:${mm}`;
};

/** A 1–5 rating, or an em dash. */
export const formatRating = (value) =>
  value === null || value === undefined ? "—" : `${value}/5`;

/** A measure with its unit, for the Current / Target column. */
export const formatMeasure = (value, unit) =>
  value === null || value === undefined
    ? "—"
    : `${Number(value).toLocaleString("en-IN")}${unit ? ` ${unit}` : ""}`;

export default { goalsApi, cyclesApi, reviewsApi, feedbackApi, oneOnOnesApi };
