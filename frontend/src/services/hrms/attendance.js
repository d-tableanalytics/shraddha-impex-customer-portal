import { api } from "../api";
import { hrmsClient } from "./client";

/**
 * Attendance API.
 *
 * A thin wrapper over `hrmsClient`, which already unwraps the
 * `{ success, data }` envelope and normalises errors into `HrmsApiError` —
 * so a screen branches on `err.code`, never on a message.
 *
 * Added in the same commit as the screens that consume it, per the convention
 * in ./index.js.
 */

export const attendanceApi = {
  /**
   * Today's record, or null when the day has not started.
   *
   * Null is a real answer with a 200 behind it — the clock card renders
   * "Ready to clock in" from it — so it must not be treated as a failure.
   */
  today: () => hrmsClient.get("/attendance/today"),

  /**
   * Record a punch.
   *
   * The body carries NO timestamp and NO employee id. The server takes the
   * time from its own clock and the employee from the session; a client that
   * supplied either would be supplying a pay claim.
   *
   * `geo` and `selfieKey` are both optional. A punch with neither is a
   * complete punch — consent is free, so declining capture cannot stop
   * someone clocking in (AD-15).
   */
  clockIn: (dto = {}) => hrmsClient.post("/attendance/clock-in", dto),
  clockOut: (dto = {}) => hrmsClient.post("/attendance/clock-out", dto),

  /** Paginated history. Returns `{ data, total, page, pageSize, range }`. */
  list: (params = {}) => hrmsClient.get("/attendance", params),

  /** One row per report with today's summary. Managers and HR only. */
  teamGrid: () => hrmsClient.get("/attendance/team-grid"),

  /**
   * A short-lived presigned URL for one punch's selfie.
   *
   * Fetched ON DEMAND, when a thumbnail actually needs to render — never
   * eagerly for a whole page. Every issued URL is audited as a photograph
   * view, so prefetching a table's worth would file dozens of views nobody
   * performed, and would mint dozens of bearer-capable URLs to go with them.
   */
  selfieUrl: (recordId, punch) =>
    hrmsClient.get(`/attendance/records/${recordId}/selfie/${punch}`),
};

/**
 * Upload a selfie and get back an opaque storage key.
 *
 * Not on `hrmsClient` because that serialises JSON; this posts multipart and
 * must let the browser set its own boundary. It still goes through the shared
 * axios instance, so the Bearer header and the 401 refresh are unchanged.
 *
 * The key is meaningless to the browser and is only ever handed straight back
 * to a punch, which re-checks that it belongs to the caller.
 */
export async function uploadSelfie(blob) {
  const form = new FormData();
  form.append("selfie", blob, "selfie.jpg");

  const res = await api.request({
    method: "post",
    url: "/hrms/attendance/selfie",
    data: form,
  });
  return res.data?.data?.key ?? null;
}

export const attendanceConsentApi = {
  /** The caller's own consent state, with the notice text for each purpose. */
  get: () => hrmsClient.get("/attendance/consent"),
  /**
   * Grant or withdraw one purpose.
   *
   * Withdrawal erases what was already captured for that purpose, so the
   * caller must refresh anything showing selfies or locations afterwards.
   */
  set: (purpose, granted) =>
    hrmsClient.post("/attendance/consent", { purpose, granted }),
};

export const attendanceCorrectionsApi = {
  list: (params = {}) => hrmsClient.get("/attendance/corrections", params),
  submit: (dto) => hrmsClient.post("/attendance/corrections", dto),
  decide: (id, decision, comment) =>
    hrmsClient.post(`/attendance/corrections/${id}/decide`, { decision, comment }),
};

export default { attendanceApi, attendanceConsentApi, attendanceCorrectionsApi, uploadSelfie };
