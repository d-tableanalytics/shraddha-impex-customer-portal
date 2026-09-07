import { hrmsClient } from "./client";

/**
 * Onboarding API.
 *
 * A thin wrapper over `hrmsClient`, which already unwraps the
 * `{ success, data }` envelope and normalises errors into `HrmsApiError` — so a
 * screen branches on `err.code`, never on a message.
 */

export const onboardingTemplatesApi = {
  list: (params = {}) => hrmsClient.get("/onboarding/templates", params),
  get: (id) => hrmsClient.get(`/onboarding/templates/${id}`),
  create: (dto) => hrmsClient.post("/onboarding/templates", dto),
  update: (id, dto) => hrmsClient.patch(`/onboarding/templates/${id}`, dto),
  /** Refused server-side once the template has been used to start an onboarding. */
  remove: (id) => hrmsClient.delete(`/onboarding/templates/${id}`),
};

export const onboardingChecklistsApi = {
  list: (params = {}) => hrmsClient.get("/onboarding/checklists", params),
  get: (id) => hrmsClient.get(`/onboarding/checklists/${id}`),
  /** The caller's own. No id is sent — the server takes it from the session. */
  mine: () => hrmsClient.get("/onboarding/checklists/mine"),
  start: (dto) => hrmsClient.post("/onboarding/checklists", dto),
  cancel: (id, reason) => hrmsClient.post(`/onboarding/checklists/${id}/cancel`, { reason }),
  /** Assignee or HR; the server decides which and refuses everyone else. */
  updateTask: (checklistId, taskId, dto) =>
    hrmsClient.patch(`/onboarding/checklists/${checklistId}/tasks/${taskId}`, dto),
};

export const onboardingTasksApi = {
  /** Every onboarding task assigned to the caller, across checklists. */
  mine: (params = {}) => hrmsClient.get("/onboarding/tasks/mine", params),
};

export const offerLettersApi = {
  list: (params = {}) => hrmsClient.get("/onboarding/offers", params),
  /** The caller's own offers. No id on the wire. */
  mine: () => hrmsClient.get("/onboarding/offers/mine"),
  forEmployee: (employeeId) => hrmsClient.get(`/onboarding/offers/employee/${employeeId}`),
  create: (dto) => hrmsClient.post("/onboarding/offers", dto),
  send: (id) => hrmsClient.post(`/onboarding/offers/${id}/send`, {}),
  /** The subject only. Records the typed name, the time and the address. */
  sign: (id, signatureName) =>
    hrmsClient.post(`/onboarding/offers/${id}/sign`, { signatureName }),
  reject: (id, reason) =>
    hrmsClient.post(`/onboarding/offers/${id}/reject`, reason ? { reason } : {}),
  /**
   * A short-lived presigned URL for the generated letter.
   *
   * Fetched ON DEMAND, when somebody actually opens one — never eagerly for a
   * whole list. Every issued URL is audited as an offer-letter view, so
   * prefetching a page would file reads nobody performed.
   */
  documentUrl: (id) => hrmsClient.get(`/onboarding/offers/${id}/document-url`),
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const CHECKLIST_STATUS_TONES = Object.freeze({
  active: "primary",
  completed: "success",
  cancelled: "neutral",
});

export const TASK_STATUS_TONES = Object.freeze({
  pending: "neutral",
  in_progress: "primary",
  completed: "success",
  skipped: "warning",
});

export const OFFER_LETTER_STATE_TONES = Object.freeze({
  draft: "neutral",
  sent: "primary",
  accepted: "success",
  rejected: "danger",
});

/** Indian-format money, for display only. */
export const formatCtcAmount = (value) =>
  value === null || value === undefined
    ? "—"
    : `₹ ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `YYYY-MM-DD` to "01 Sep 2026", without a locale.
 *
 * Node and browser ICU builds disagree on whether September abbreviates to
 * "Sep" or "Sept", which has broken a date assertion in this codebase before.
 * A fixed table renders the same everywhere.
 */
export const formatDay = (value) => {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return "—";
  const [, y, mo, d] = m;
  return `${d} ${MONTHS[Number(mo) - 1]} ${y}`;
};

/** An ISO instant as "01 Sep 2026, 14:30". */
export const formatInstant = (iso) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const day = formatDay(date.toISOString().slice(0, 10));
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${day}, ${hh}:${mm}`;
};

/** Percentage complete, guarding the empty checklist. */
export const progressPercent = (progress) =>
  !progress || progress.total === 0
    ? 0
    : Math.round((progress.completed / progress.total) * 100);

export default {
  onboardingTemplatesApi,
  onboardingChecklistsApi,
  onboardingTasksApi,
  offerLettersApi,
};
