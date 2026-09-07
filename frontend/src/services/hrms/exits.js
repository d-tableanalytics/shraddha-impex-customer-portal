import { hrmsClient } from "./client";

/**
 * Exits API.
 *
 * Mirrors the reference's `api/exit.ts`, with three differences worth knowing
 * at the call site:
 *
 *   1. THE LIST IS SCOPED AND PAGED BY THE SERVER. The reference fetches every
 *      exit request the viewer can see and then filters in the browser —
 *      `requests.filter(r => r.employeeId === me.employee.id)` for "my exit",
 *      and a nested loop over every request's clearances for the queue. Here
 *      the server decides, and the response is a page object.
 *
 *   2. `/exits/me` EXISTS. The reference has no such endpoint, which is why its
 *      My Exit tab has to download the whole list to find one row.
 *
 *   3. THE RELIEVING LETTER IS A SHORT-LIVED URL, not a link to a streaming
 *      path. The reference points an anchor at
 *      `/api/v1/exits/:id/relieving-letter/pdf`.
 */

export const exitsApi = {
  /** `{ data, total, page, pageSize }` — scoped by the server. */
  list: (params = {}) => hrmsClient.get("/exits", params),

  /** The signed-in employee's own latest exit, or null. */
  mine: () => hrmsClient.get("/exits/me"),

  get: (id) => hrmsClient.get(`/exits/${id}`),

  /**
   * File an exit. `employeeId` is omitted for a self-service resignation —
   * the server resolves it from the signed-in actor.
   */
  initiate: (dto) => hrmsClient.post("/exits", dto),

  managerApprove: (id) => hrmsClient.post(`/exits/${id}/manager-approve`),
  hrApprove: (id) => hrmsClient.post(`/exits/${id}/hr-approve`),
  openClearances: (id) => hrmsClient.post(`/exits/${id}/open-clearances`),
  cancel: (id) => hrmsClient.post(`/exits/${id}/cancel`),

  updateClearance: (id, clearanceId, dto) =>
    hrmsClient.patch(`/exits/${id}/clearances/${clearanceId}`, dto),

  /** Handover: replacement, transfer notes, actual last day. */
  update: (id, dto) => hrmsClient.patch(`/exits/${id}`, dto),

  /** Reads only — safe to call whenever the drawer is open. */
  previewSettlement: (id) => hrmsClient.get(`/exits/${id}/fnf/preview`),
  createSettlement: (id) => hrmsClient.post(`/exits/${id}/fnf`),
  disburseSettlement: (id) => hrmsClient.post(`/exits/${id}/fnf/disburse`),

  generateRelievingLetter: (id) => hrmsClient.post(`/exits/${id}/relieving-letter`),
  /** `{ url, expiresInSeconds }`. The URL expires; do not cache it. */
  relievingLetterUrl: (id) => hrmsClient.get(`/exits/${id}/relieving-letter/url`),
};

/**
 * The exit states, in the order they occur, with the label each is shown as.
 *
 * Eight, not the reference's nine: its `hr_approved` is unreachable — its
 * `hrApprove()` writes `in_notice` — and carrying the dead value is what makes
 * its own progress bar skip a step on every exit.
 */
export const EXIT_STEPS = [
  { key: "initiated", label: "Initiated" },
  { key: "manager_approved", label: "Manager approved" },
  { key: "in_notice", label: "In notice" },
  { key: "clearance_pending", label: "Clearances" },
  { key: "cleared", label: "Cleared" },
  { key: "f_and_f_pending", label: "Settlement" },
  { key: "closed", label: "Closed" },
];

export const EXIT_STATUS_LABELS = {
  ...Object.fromEntries(EXIT_STEPS.map((s) => [s.key, s.label])),
  cancelled: "Cancelled",
};

export const CLEARANCE_STATUS_LABELS = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  waived: "Waived",
};

export const CLEARANCE_AREA_LABELS = {
  it: "IT",
  finance: "Finance",
  admin: "Admin",
  hr: "HR",
  manager: "Manager",
};

export const EXIT_REASON_LABELS = {
  resignation: "Resignation",
  termination: "Termination",
  retirement: "Retirement",
  other: "Other",
};

export default {
  exitsApi,
  EXIT_STEPS,
  EXIT_STATUS_LABELS,
  CLEARANCE_STATUS_LABELS,
  CLEARANCE_AREA_LABELS,
  EXIT_REASON_LABELS,
};
