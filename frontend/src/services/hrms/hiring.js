import { api } from "../api";
import { hrmsClient } from "./client";

/**
 * Hiring API.
 *
 * A thin wrapper over `hrmsClient`, which already unwraps the
 * `{ success, data }` envelope and normalises errors into `HrmsApiError` — so a
 * screen branches on `err.code`, never on a message.
 */

export const requisitionsApi = {
  list: (params = {}) => hrmsClient.get("/hiring/requisitions", params),
  get: (id) => hrmsClient.get(`/hiring/requisitions/${id}`),
  create: (dto) => hrmsClient.post("/hiring/requisitions", dto),
  update: (id, dto) => hrmsClient.patch(`/hiring/requisitions/${id}`, dto),
  /** Refused server-side when the caller raised the requisition themselves. */
  approve: (id) => hrmsClient.post(`/hiring/requisitions/${id}/approve`, {}),
  setStatus: (id, status, reason) =>
    hrmsClient.post(`/hiring/requisitions/${id}/status`, { status, reason }),
  /** The Kanban board. Not paginated — a board that shows page one is not one. */
  pipeline: (id) => hrmsClient.get(`/hiring/requisitions/${id}/pipeline`),
};

export const postingsApi = {
  list: (params = {}) => hrmsClient.get("/hiring/postings", params),
  create: (dto) => hrmsClient.post("/hiring/postings", dto),
  publish: (id) => hrmsClient.post(`/hiring/postings/${id}/publish`, {}),
  close: (id) => hrmsClient.post(`/hiring/postings/${id}/close`, {}),
};

export const candidatesApi = {
  list: (params = {}) => hrmsClient.get("/hiring/candidates", params),
  get: (id) => hrmsClient.get(`/hiring/candidates/${id}`),
  create: (dto) => hrmsClient.post("/hiring/candidates", dto),
  update: (id, dto) => hrmsClient.patch(`/hiring/candidates/${id}`, dto),
  /**
   * A short-lived presigned URL for the CV.
   *
   * Fetched ON DEMAND, when somebody actually opens one — never eagerly for a
   * whole list. Every issued URL is audited as a résumé view, so prefetching a
   * page would file reads nobody performed.
   */
  resumeUrl: (id) => hrmsClient.get(`/hiring/candidates/${id}/resume-url`),
};

/**
 * Upload a résumé.
 *
 * Not on `hrmsClient` because that serialises JSON; this posts multipart and
 * must let the browser set its own boundary. It still goes through the shared
 * axios instance, so the Bearer header and the 401 refresh are unchanged.
 */
export async function uploadResume(candidateId, file) {
  const form = new FormData();
  form.append("resume", file, file.name);
  const res = await api.request({
    method: "post",
    url: `/hrms/hiring/candidates/${candidateId}/resume`,
    data: form,
  });
  return res.data?.data;
}

export const applicationsApi = {
  list: (params = {}) => hrmsClient.get("/hiring/applications", params),
  get: (id) => hrmsClient.get(`/hiring/applications/${id}`),
  create: (dto) => hrmsClient.post("/hiring/applications", dto),
  /** Forward by one, or reject. The server re-checks the transition table. */
  move: (id, stage, rejectionReason) =>
    hrmsClient.post(`/hiring/applications/${id}/move`, { stage, rejectionReason }),
};

export const interviewsApi = {
  list: (params = {}) => hrmsClient.get("/hiring/interviews", params),
  /** The caller's own panels. No id is sent — the server takes it from the session. */
  mine: (params = {}) => hrmsClient.get("/hiring/interviews/mine", params),
  schedule: (dto) => hrmsClient.post("/hiring/interviews", dto),
  setStatus: (id, status) => hrmsClient.post(`/hiring/interviews/${id}/status`, { status }),
  feedback: (id) => hrmsClient.get(`/hiring/interviews/${id}/feedback`),
  /** Panelists only; the server refuses anyone who was not in the room. */
  submitFeedback: (id, dto) => hrmsClient.post(`/hiring/interviews/${id}/feedback`, dto),
};

export const offersApi = {
  list: (params = {}) => hrmsClient.get("/hiring/offers", params),
  create: (dto) => hrmsClient.post("/hiring/offers", dto),
  /**
   * Send an offer.
   *
   * The response carries the candidate's access token ONCE — it is stored only
   * as a hash and is never returned again. The recruiter delivers the link.
   */
  send: (id) => hrmsClient.post(`/hiring/offers/${id}/send`, {}),
};

/** A drafting aid. A template, not a model — see the service. */
export const jdApi = {
  draft: (dto) => hrmsClient.post("/hiring/jd/draft", dto),
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const REQUISITION_STATUS_TONES = Object.freeze({
  draft: "neutral",
  approved: "primary",
  open: "success",
  filled: "neutral",
  cancelled: "danger",
});

export const STAGE_LABELS = Object.freeze({
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
});

export const STAGE_TONES = Object.freeze({
  applied: "neutral",
  screening: "primary",
  interview: "primary",
  offer: "warning",
  hired: "success",
  rejected: "danger",
});

export const DECISION_LABELS = Object.freeze({
  strong_hire: "Strong hire",
  hire: "Hire",
  no_hire: "No hire",
  strong_no_hire: "Strong no hire",
});

export const OFFER_STATE_TONES = Object.freeze({
  draft: "neutral",
  sent: "primary",
  accepted: "success",
  rejected: "danger",
  expired: "warning",
});

/** Indian-format money, for display only. */
export const formatCtc = (value) =>
  value === null || value === undefined
    ? "—"
    : `₹ ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export default {
  requisitionsApi,
  postingsApi,
  candidatesApi,
  applicationsApi,
  interviewsApi,
  offersApi,
  jdApi,
  uploadResume,
};
