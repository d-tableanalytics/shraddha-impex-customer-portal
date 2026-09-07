import { hrmsClient } from "./client";

/**
 * Helpdesk API.
 *
 * Mirrors the reference's `api/helpdesk.ts`, with four differences worth
 * knowing at the call site:
 *
 *   1. THERE IS A CATEGORIES ENDPOINT. The reference has none, which is why its
 *      own Raise Ticket form posts `'hr-placeholder'` — a value its `uuid`
 *      validator rejects. Ticket creation is broken end to end there.
 *
 *   2. THE LIST IS SCOPED BY CATEGORY. The reference collapses its three
 *      per-team resolver grants into one boolean, so every resolver receives
 *      every ticket. Here the server returns the queues you actually answer for.
 *
 *   3. ASSIGNMENT AND STATUS ARE SEPARATE CALLS, because they are separate
 *      decisions with separate rules. The reference has one PATCH that writes
 *      whatever it is given.
 *
 *   4. THE KNOWLEDGE BASE CAN BE WRITTEN. The reference filters on
 *      `publishedAt` and offers no endpoint that could ever set it.
 */

export const helpdeskApi = {
  // -- Categories -----------------------------------------------------------
  categories: (params = {}) => hrmsClient.get("/helpdesk/categories", params),
  createCategory: (dto) => hrmsClient.post("/helpdesk/categories", dto),
  updateCategory: (id, dto) => hrmsClient.patch(`/helpdesk/categories/${id}`, dto),
  removeCategory: (id) => hrmsClient.delete(`/helpdesk/categories/${id}`),

  // -- Tickets --------------------------------------------------------------
  /** `{ data, total, page, pageSize }` — scoped by the server. */
  tickets: (params = {}) => hrmsClient.get("/helpdesk/tickets", params),
  myTickets: (params = {}) => hrmsClient.get("/helpdesk/tickets/me", params),
  /** One ticket, with the conversation the caller is entitled to see. */
  ticket: (id) => hrmsClient.get(`/helpdesk/tickets/${id}`),

  raise: (dto) => hrmsClient.post("/helpdesk/tickets", dto),
  update: (id, dto) => hrmsClient.patch(`/helpdesk/tickets/${id}`, dto),

  assign: (id, assigneeEmployeeId) =>
    hrmsClient.post(`/helpdesk/tickets/${id}/assign`, { assigneeEmployeeId }),
  changeStatus: (id, status, resolutionNotes) =>
    hrmsClient.post(`/helpdesk/tickets/${id}/status`, {
      status,
      resolutionNotes: resolutionNotes ?? null,
    }),
  comment: (id, body, internal = false) =>
    hrmsClient.post(`/helpdesk/tickets/${id}/comments`, { body, internal }),

  // -- Knowledge base -------------------------------------------------------
  articles: (params = {}) => hrmsClient.get("/helpdesk/kb", params),
  article: (id) => hrmsClient.get(`/helpdesk/kb/${id}`),
  createArticle: (dto) => hrmsClient.post("/helpdesk/kb", dto),
  updateArticle: (id, dto) => hrmsClient.patch(`/helpdesk/kb/${id}`, dto),
  removeArticle: (id) => hrmsClient.delete(`/helpdesk/kb/${id}`),
};

export const TICKET_STATUS_LABELS = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

export const TICKET_PRIORITY_LABELS = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/** Which team answers a category. The reference stores this and routes on nothing. */
export const RESOLVER_TEAM_LABELS = {
  "helpdesk:hr": "HR",
  "helpdesk:payroll": "Payroll",
  "helpdesk:it": "IT",
};

/**
 * `3.5` -> `3h left`; a breached ticket says so instead.
 *
 * The reference renders only a red "SLA Breached" tag and never shows how long
 * is left before that happens.
 */
export function formatSla({ slaBreached, slaHoursRemaining }) {
  if (slaBreached) return "SLA breached";
  if (slaHoursRemaining === null || slaHoursRemaining === undefined) return "—";
  if (slaHoursRemaining < 1) return `${Math.round(slaHoursRemaining * 60)}m left`;
  if (slaHoursRemaining < 24) return `${Math.round(slaHoursRemaining)}h left`;
  return `${Math.floor(slaHoursRemaining / 24)}d left`;
}

export default {
  helpdeskApi,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
  RESOLVER_TEAM_LABELS,
  formatSla,
};
