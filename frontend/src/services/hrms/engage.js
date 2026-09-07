import { hrmsClient } from "./client";

/**
 * Engage API.
 *
 * A thin wrapper over `hrmsClient`, which already unwraps the
 * `{ success, data }` envelope and normalises errors into `HrmsApiError` — so a
 * screen branches on `err.code`, never on a message.
 */

export const announcementsApi = {
  /** Targeting is applied server-side, inside the query. */
  list: (params = {}) => hrmsClient.get("/engage/announcements", params),
  get: (id) => hrmsClient.get(`/engage/announcements/${id}`),
  create: (dto) => hrmsClient.post("/engage/announcements", dto),
  publish: (id) => hrmsClient.post(`/engage/announcements/${id}/publish`, {}),
  remove: (id) => hrmsClient.delete(`/engage/announcements/${id}`),
};

export const pollsApi = {
  list: (params = {}) => hrmsClient.get("/engage/polls", params),
  get: (id) => hrmsClient.get(`/engage/polls/${id}`),
  create: (dto) => hrmsClient.post("/engage/polls", dto),
  /** The launch step the reference has no endpoint for. */
  launch: (id) => hrmsClient.post(`/engage/polls/${id}/launch`, {}),
  /** One answer per person; the server refuses a second. */
  respond: (id, answer) => hrmsClient.post(`/engage/polls/${id}/respond`, answer),
  /** HR only. No respondent is named for any poll. */
  results: (id) => hrmsClient.get(`/engage/polls/${id}/results`),
};

export const recognitionApi = {
  wall: (params = {}) => hrmsClient.get("/engage/recognitions/wall", params),
  received: (params = {}) => hrmsClient.get("/engage/recognitions/received", params),
  given: (params = {}) => hrmsClient.get("/engage/recognitions/given", params),
  give: (dto) => hrmsClient.post("/engage/recognitions", dto),
  listBadges: () => hrmsClient.get("/engage/badges"),
  createBadge: (dto) => hrmsClient.post("/engage/badges", dto),
};

export const enpsApi = {
  list: (params = {}) => hrmsClient.get("/engage/enps", params),
  create: (dto) => hrmsClient.post("/engage/enps", dto),
  /**
   * Answer the pulse.
   *
   * Recorded against the caller so a second answer can be refused, and audited
   * WITHOUT them — the survey is anonymous and the audit trail agrees.
   */
  respond: (id, dto) => hrmsClient.post(`/engage/enps/${id}/respond`, dto),
  results: (id) => hrmsClient.get(`/engage/enps/${id}/results`),
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const ANNOUNCEMENT_STATE_TONES = Object.freeze({
  draft: "warning",
  published: "success",
  expired: "neutral",
});

export const POLL_KIND_TONES = Object.freeze({
  single: "primary",
  multi: "primary",
  scale: "warning",
  open_ended: "neutral",
});

export const ENPS_BAND_TONES = Object.freeze({
  promoters: "success",
  passives: "warning",
  detractors: "danger",
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * An ISO instant as "01 Sep 2026".
 *
 * Browser and Node ICU builds disagree on whether September abbreviates to
 * "Sep" or "Sept", which has broken a date assertion in this codebase before.
 * A fixed table renders the same everywhere.
 */
export const formatEngageDay = (value) => {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return "—";
  const [, y, mo, d] = m;
  return `${d} ${MONTHS[Number(mo) - 1]} ${y}`;
};

/** An ISO instant as "01 Sep 2026, 14:30". */
export const formatEngageInstant = (iso) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const day = formatEngageDay(date.toISOString().slice(0, 10));
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${day}, ${hh}:${mm}`;
};

/**
 * An eNPS score renders with its sign — it runs −100 to +100, and a bare "12"
 * reads like a count rather than a net score.
 */
export const formatEnpsScore = (score) =>
  score === null || score === undefined ? "—" : score > 0 ? `+${score}` : String(score);

/** Who an announcement went to, in words. */
export const audienceOf = (announcement) => {
  if (announcement.orgWide) return "Everyone";
  const parts = [];
  if (announcement.targetRoleKeys?.length) {
    parts.push(
      `${announcement.targetRoleKeys.length} role${announcement.targetRoleKeys.length === 1 ? "" : "s"}`,
    );
  }
  if (announcement.targetDepartmentNames?.length) {
    parts.push(announcement.targetDepartmentNames.join(", "));
  } else if (announcement.targetDepartmentIds?.length) {
    parts.push(
      `${announcement.targetDepartmentIds.length} department${announcement.targetDepartmentIds.length === 1 ? "" : "s"}`,
    );
  }
  return parts.join(" · ") || "Everyone";
};

export default { announcementsApi, pollsApi, recognitionApi, enpsApi };
