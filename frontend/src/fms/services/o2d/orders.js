import { o2dClient } from "./client";
import {
  STAGE_STATUS,
  ORDER_STATUS,
  HOLD_REASONS,
  O2D_DOCUMENT_TYPES,
} from "@shared/constants/o2d.js";

/**
 * The O2D API, plus the label maps and formatters that go with it.
 *
 * Kept in one file the way every HRMS service is: a screen that renders a stage
 * status needs the word for it, and separating the two guarantees one is
 * updated without the other.
 *
 * The CONSTANTS are imported from `@shared/constants/o2d.js` — the same file the
 * server reads — rather than retyped. A status the backend can emit and the
 * frontend has never heard of renders as a raw enum string, which is ugly but
 * honest; a retyped copy would render the wrong word confidently.
 */

export const o2dApi = {
  // ── Tasks ───────────────────────────────────────────────────────────────
  myTasks: (params = {}) => o2dClient.get("/tasks", params),
  taskCounts: () => o2dClient.get("/tasks/counts"),

  /** The twelve stages, as configured. Owners can be changed by an admin. */
  stages: () => o2dClient.get("/stages"),

  /**
   * Live orders per stage, with the late count — the stage board (§27).
   *
   * Distinct from `stages()`: that one is the CONFIGURATION (names, owners,
   * SLAs) and this one is the CURRENT LOAD. They are fetched together by the
   * stage view, but a screen that only needs the names should not pay for the
   * aggregation.
   */
  stageBoard: () => o2dClient.get("/stages/board"),

  // ── Orders ──────────────────────────────────────────────────────────────
  list: (params = {}) => o2dClient.get("/orders", params),
  get: (id) => o2dClient.get(`/orders/${id}`),
  create: (dto) => o2dClient.post("/orders", dto),
  update: (id, dto) => o2dClient.patch(`/orders/${id}`, dto),
  /** The audit trail: what PEOPLE did to this order. Not the stage timeline. */
  activity: (id) => o2dClient.get(`/orders/${id}/activity`),

  /** The live duplicate check the intake form runs while the user types. */
  checkDuplicate: (poNumber, customerName) =>
    o2dClient.get("/orders/check-duplicate", { poNumber, customerName }),

  // ── Customer Portal bookings (§3) ───────────────────────────────────────
  //
  // A booking is addressed by its human-readable id (`BO-`/`SO-YYYY-######`),
  // not a Mongo id: one booking is several `Order` rows sharing that string, so
  // no single ObjectId names it. Encoded on the way out — the id is user data,
  // and a "/" in one would otherwise silently address a different route.
  bookings: (params = {}) => o2dClient.get("/bookings", params),
  booking: (bookingId) => o2dClient.get(`/bookings/${encodeURIComponent(bookingId)}`),

  // ── Lines ───────────────────────────────────────────────────────────────
  items: (id) => o2dClient.get(`/orders/${id}/items`),
  replaceItems: (id, items) => o2dClient.put(`/orders/${id}/items`, { items }),

  // ── Transitions ─────────────────────────────────────────────────────────
  completeStage: (id, stageNumber, dto = {}) =>
    o2dClient.post(`/orders/${id}/stages/${stageNumber}/complete`, dto),
  skipStage: (id, stageNumber, dto) =>
    o2dClient.post(`/orders/${id}/stages/${stageNumber}/skip`, dto),
  reopenStage: (id, stageNumber, dto) =>
    o2dClient.post(`/orders/${id}/stages/${stageNumber}/reopen`, dto),
  advanceDecision: (id, dto) => o2dClient.post(`/orders/${id}/advance-decision`, dto),

  /**
   * Hand a stage to one named person — the same person's Work Queue picks it
   * up automatically as a real Delegation task, kept in sync from both sides.
   * See `o2dDelegationSync.service.js` on the backend.
   */
  assignStage: (id, stageNumber, userId) =>
    o2dClient.post(`/orders/${id}/stages/${stageNumber}/assign`, { userId }),
  unassignStage: (id, stageNumber) =>
    o2dClient.delete(`/orders/${id}/stages/${stageNumber}/assign`),

  hold: (id, dto) => o2dClient.post(`/orders/${id}/hold`, dto),
  resume: (id, dto = {}) => o2dClient.post(`/orders/${id}/resume`, dto),

  // ── Leaving the workflow ────────────────────────────────────────────────
  cancel: (id, dto) => o2dClient.post(`/orders/${id}/cancel`, dto),
  void: (id, dto) => o2dClient.post(`/orders/${id}/void`, dto),
  revive: (id, dto) => o2dClient.post(`/orders/${id}/revive`, dto),
  exitRegister: (params = {}) => o2dClient.get("/exit-register", params),
  exitsByStage: (params = {}) => o2dClient.get("/exit-register/by-stage", params),

  // ── Invoicing ───────────────────────────────────────────────────────────
  /** Raise the Zoho invoice for an order. Idempotent server-side. */
  createInvoice: (orderId) => o2dClient.post(`/orders/${orderId}/invoice`, {}),

  // ── Analytics ───────────────────────────────────────────────────────────
  analytics: (params = {}) => o2dClient.get("/analytics", params),
  slaCompliance: (params = {}) => o2dClient.get("/analytics/sla", params),
  delays: (params = {}) => o2dClient.get("/analytics/delays", params),
  people: (params = {}) => o2dClient.get("/analytics/people", params),
  customers: (params = {}) => o2dClient.get("/analytics/customers", params),
  /** Returns a Blob — see `download` in client.js for why not a plain link. */
  exportDataset: (dataset, params = {}) =>
    o2dClient.download(`/analytics/export/${dataset}`, params),

  /** Every status change for an order, or for one stage. Oldest first. */
  stageHistory: (orderId, stageNumber = null) =>
    o2dClient.get(`/orders/${orderId}/history${stageNumber ? `/${stageNumber}` : ""}`),

  // ── Notifications ───────────────────────────────────────────────────────
  notifications: (params = {}) => o2dClient.get("/notifications", params),
  /** No ids = mark everything unread as read. Scoped to the caller server-side. */
  markNotificationsRead: (ids = []) => o2dClient.post("/notifications/read", { ids }),

  // ── Documents ───────────────────────────────────────────────────────────
  documents: (id) => o2dClient.get(`/orders/${id}/documents`),
  uploadDocument: (id, formData) => o2dClient.upload(`/orders/${id}/documents`, formData),
  documentUrl: (documentId) => o2dClient.get(`/documents/${documentId}/url`),
  deleteDocument: (documentId) => o2dClient.delete(`/documents/${documentId}`),
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * The RAW status names. Kept, because the history view shows the real
 * transitions and "In Progress -> In Progress" would describe nothing.
 */
export const STAGE_STATUS_LABELS = Object.freeze({
  [STAGE_STATUS.LOCKED]: "Locked",
  [STAGE_STATUS.PENDING]: "Active",
  [STAGE_STATUS.DUE_SOON]: "Due soon",
  [STAGE_STATUS.OVERDUE]: "Overdue",
  [STAGE_STATUS.DONE_ON_TIME]: "Done on time",
  [STAGE_STATUS.DONE_LATE]: "Done late",
  [STAGE_STATUS.SKIPPED]: "Skipped",
  [STAGE_STATUS.ON_HOLD]: "On hold",
});

/**
 * What a stage is CALLED on a task list: two working states, not eight.
 *
 * Mirrors `displayStatusFor` in the server's shared constants. A person reading
 * their tasks wants one thing - is this still mine, or is it finished - and
 * "Done on time" / "Done late" read as a verdict on the person rather than a
 * state of the work.
 *
 * NOT_STARTED exists because calling stage 12 "In Progress" on the day the PO
 * arrives would be false, and a task list that does that is not worth reading.
 *
 * 🔴 The STORED status is untouched. Folding the stored values into two would
 * destroy the on-time percentage, the skip exclusion from the KPI, and the
 * escalation trigger. This renames; it does not collapse. The facts the name
 * drops come back as `stageFlags` below, so a screen can show "In Progress" AND
 * a red overdue marker - the combination the old vocabulary could not express,
 * because a stage could only be one thing.
 */
export const STAGE_DISPLAY = Object.freeze({
  NOT_STARTED: "Locked",
  IN_PROGRESS: "Active",
  DONE: "Completed",
});

const TERMINAL = [STAGE_STATUS.DONE_ON_TIME, STAGE_STATUS.DONE_LATE, STAGE_STATUS.SKIPPED];

export const displayStatus = (status) => {
  if (TERMINAL.includes(status)) return STAGE_DISPLAY.DONE;
  if (status === STAGE_STATUS.LOCKED) return STAGE_DISPLAY.NOT_STARTED;
  return STAGE_DISPLAY.IN_PROGRESS;
};

/** The timing facts the two-state name deliberately drops. */
export const stageFlags = (stage = {}) => ({
  late: stage.status === STAGE_STATUS.DONE_LATE,
  overdue: stage.status === STAGE_STATUS.OVERDUE,
  dueSoon: stage.status === STAGE_STATUS.DUE_SOON,
  held: stage.status === STAGE_STATUS.ON_HOLD,
  skipped: stage.status === STAGE_STATUS.SKIPPED,
  delayMinutes: stage.delayMinutes ?? null,
});

/** Green when finished, amber while owed, grey before it starts. */
export const displayTone = (status) => {
  const shown = displayStatus(status);
  if (shown === STAGE_DISPLAY.DONE) return "success";
  if (shown === STAGE_DISPLAY.NOT_STARTED) return "neutral";
  return "primary";
};

export const ORDER_STATUS_LABELS = Object.freeze({
  [ORDER_STATUS.OPEN]: "Open",
  [ORDER_STATUS.ON_HOLD]: "On hold",
  // Stored as CLOSED; the business calls a finished order Completed.
  [ORDER_STATUS.CLOSED]: "Completed",
  [ORDER_STATUS.CANCELLED]: "Cancelled",
  [ORDER_STATUS.VOID]: "Void",
});

/** The enum values are shouted; a person reading a screen should not be. */
export const HOLD_REASON_LABELS = Object.freeze({
  CUSTOMER_REQUEST: "Customer request",
  STOCK_UNAVAILABLE: "Stock unavailable",
  PAYMENT_PENDING: "Payment pending",
  DOCUMENTATION: "Documentation",
  OTHER: "Other",
});

export const DOCUMENT_TYPE_LABELS = Object.freeze({
  PO: "Customer PO",
  SOR: "Sales Order Report",
  PI: "Proforma Invoice",
  PAYMENT_PROOF: "Payment proof",
  INVOICE: "Tax invoice",
  AWB: "AWB",
  LR: "LR / Docket",
  DELIVERY_PROOF: "Delivery proof",
  OTHER: "Other",
});

export const HOLD_REASON_OPTIONS = HOLD_REASONS.map((value) => ({
  value,
  label: HOLD_REASON_LABELS[value] ?? value,
}));

export const DOCUMENT_TYPE_OPTIONS = O2D_DOCUMENT_TYPES.map((value) => ({
  value,
  label: DOCUMENT_TYPE_LABELS[value] ?? value,
}));

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * The tone for a stage chip.
 *
 * DONE_LATE is amber rather than green: the work IS finished, so red would
 * overstate it, but colouring it the same as on-time would erase the one fact
 * the SLA engine exists to record.
 */
export const stageTone = (status) => {
  switch (status) {
    case STAGE_STATUS.DONE_ON_TIME:
      return "success";
    case STAGE_STATUS.DONE_LATE:
      return "warning";
    case STAGE_STATUS.OVERDUE:
      return "danger";
    case STAGE_STATUS.DUE_SOON:
      return "warning";
    case STAGE_STATUS.SKIPPED:
      return "neutral";
    case STAGE_STATUS.ON_HOLD:
      return "neutral";
    case STAGE_STATUS.PENDING:
      // "primary", not "info": Badge implements primary | success | warning |
      // danger | neutral, and an unknown name renders a COLOURLESS pill rather
      // than throwing - see the note in HrmsStatusBadge.
      return "primary";
    default:
      return "neutral";
  }
};

export const bucketTone = (bucket) =>
  ({ overdue: "danger", due_soon: "warning", on_track: "primary" }[bucket] ?? "neutral");

export const BUCKET_LABELS = Object.freeze({
  overdue: "Overdue",
  due_soon: "Due soon",
  on_track: "On track",
});

/**
 * A duration in working minutes, as a person would say it.
 *
 * Says "working" because that is what the number means — 12 working hours is
 * not half a day of wall-clock, and a screen that drops the word invites
 * somebody to compare it against a timestamp difference and file a bug.
 */
export function formatWorkingMinutes(minutes) {
  if (minutes == null) return "—";
  const m = Math.abs(Math.round(minutes));
  if (m === 0) return "on time";
  if (m < 60) return `${m} working min`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hours} working hr ${rest} min` : `${hours} working hr`;
}

/** "3 working hr late" / "on time" — the delay as the tracker shows it. */
export const formatDelay = (delayMinutes) =>
  !delayMinutes || delayMinutes <= 0 ? "On time" : `${formatWorkingMinutes(delayMinutes)} late`;

const DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
  // Pinned, not left to the browser. The whole business runs on IST, and an
  // employee travelling must not see a different deadline from their colleague.
  timeZone: "Asia/Kolkata",
});

const DATE_ONLY = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

export const formatDateTime = (value) => (value ? DATE_TIME.format(new Date(value)) : "—");
export const formatDate = (value) => (value ? DATE_ONLY.format(new Date(value)) : "—");

/**
 * "2 days late" / "in 3 hours" — how a promise date reads at a glance.
 *
 * Calendar time, deliberately, unlike the SLA figures above: a promise date is
 * what the customer was told, and the customer does not observe our working
 * hours.
 */
export function formatRelative(value, now = new Date()) {
  if (!value) return "—";
  const diffMs = new Date(value).getTime() - now.getTime();
  const past = diffMs < 0;
  const mins = Math.round(Math.abs(diffMs) / 60000);

  let text;
  if (mins < 60) text = `${mins} min`;
  else if (mins < 1440) text = `${Math.round(mins / 60)} hr`;
  else text = `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? "" : "s"}`;

  return past ? `${text} ago` : `in ${text}`;
}

export default {
  o2dApi,
  STAGE_STATUS_LABELS,
  STAGE_DISPLAY,
  displayStatus,
  displayTone,
  stageFlags,
  ORDER_STATUS_LABELS,
  HOLD_REASON_LABELS,
  HOLD_REASON_OPTIONS,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPE_OPTIONS,
  BUCKET_LABELS,
  stageTone,
  bucketTone,
  formatWorkingMinutes,
  formatDelay,
  formatDateTime,
  formatDate,
  formatRelative,
};
