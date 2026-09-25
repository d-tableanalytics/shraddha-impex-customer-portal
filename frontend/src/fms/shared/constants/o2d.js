/**
 * O2D / FMS — the vocabulary.
 *
 * Order-to-Dispatch replaces a Google Form → Google Sheet → email → paperwork
 * chain with a twelve-stage workflow whose every stage has an owner, a deadline
 * computed from working time, and an actual completion recorded by the person
 * who did the work.
 *
 * Everything nameable lives here, in `shared/`, for the same reason the HRMS
 * permission matrix does: the backend enforces these values and the frontend
 * renders them, and a stage number or status string that means one thing on one
 * side and another on the other is the bug this file exists to prevent.
 *
 * Dependency-free on purpose — no Mongoose, no Zod, no Express — so either half
 * can import it without pulling the other's runtime in.
 */

// ---------------------------------------------------------------------------
// The twelve stages
// ---------------------------------------------------------------------------

/**
 * Stage numbers are the stable identity, not the labels.
 *
 * Named constants rather than bare integers at the call sites, because
 * `STAGES.INVOICE` says what a rule is about and `8` does not — and because a
 * business that later inserts a stage should have exactly one file to argue
 * with.
 */
export const STAGES = Object.freeze({
  RECEIVE_ORDER: 1,
  SUBMIT_PO_TO_BILLING: 2,
  SEND_SOR_PI: 3,
  ADVANCE_DECISION: 4,
  RECEIVE_ADVANCE: 5,
  CREATE_ORDER_LIST: 6,
  WAREHOUSE_PICKING: 7,
  SCAN_AND_INVOICE: 8,
  PACK_AND_DISPATCH: 9,
  MARK_SENT_IN_ZOHO: 10,
  SEND_DISPATCH_DETAILS: 11,
  UPLOAD_AWB_AND_CLOSE: 12,
});

export const STAGE_NUMBERS = Object.freeze(Object.values(STAGES));
export const FIRST_STAGE = STAGES.RECEIVE_ORDER;
export const LAST_STAGE = STAGES.UPLOAD_AWB_AND_CLOSE;

/**
 * The stage whose actual completion is the dispatch moment.
 *
 * Named because it is the denominator of the headline KPI — Order-to-Dispatch
 * TAT is `PO date → stage 9 actual` — and a KPI that quietly starts measuring a
 * different stage is worse than no KPI.
 */
export const DISPATCH_STAGE = STAGES.PACK_AND_DISPATCH;

// ---------------------------------------------------------------------------
// Stage status
// ---------------------------------------------------------------------------

/**
 * Where a stage stands.
 *
 * Three of these are worth reading twice, because the KPI rules depend on the
 * distinction:
 *
 *   SKIPPED     the stage was not REQUIRED — stage 5 on a non-advance order.
 *               It is not a success and not a failure; it is excluded from
 *               on-time percentage entirely. Counting it either way would let a
 *               department improve its score by having fewer advance orders.
 *   DONE_LATE   completed, after the deadline. Counts, and counts against.
 *   ON_HOLD     the clock is PAUSED. Held time is not the owner's delay, so it
 *               is subtracted before any deadline is judged.
 */
export const STAGE_STATUS = Object.freeze({
  LOCKED: 'LOCKED',
  PENDING: 'PENDING',
  DUE_SOON: 'DUE_SOON',
  OVERDUE: 'OVERDUE',
  DONE_ON_TIME: 'DONE_ON_TIME',
  DONE_LATE: 'DONE_LATE',
  SKIPPED: 'SKIPPED',
  ON_HOLD: 'ON_HOLD',
});

export const STAGE_STATUS_LIST = Object.freeze(Object.values(STAGE_STATUS));

/** Statuses that mean the stage is finished and will not be worked again. */
export const TERMINAL_STAGE_STATUSES = Object.freeze([
  STAGE_STATUS.DONE_ON_TIME,
  STAGE_STATUS.DONE_LATE,
  STAGE_STATUS.SKIPPED,
]);

/**
 * Statuses that count toward on-time percentage.
 *
 * SKIPPED is deliberately absent — see the note above. A stage still open
 * counts toward nothing either: it has not been completed, so it has no
 * completion to judge.
 */
export const KPI_COUNTED_STATUSES = Object.freeze([
  STAGE_STATUS.DONE_ON_TIME,
  STAGE_STATUS.DONE_LATE,
]);

/**
 * What a stage's status is CALLED on screen.
 *
 * ---------------------------------------------------------------------------
 * TWO WORKING STATES, NOT EIGHT
 * ---------------------------------------------------------------------------
 *
 * A person reading a task list wants to know one thing: is this still mine to
 * do, or is it finished. Eight stored statuses answered that question eight
 * ways, and DONE_ON_TIME / DONE_LATE in particular read as a verdict on the
 * person rather than a state of the work.
 *
 * So the STATUS shown is one of two - In Progress or Done - with NOT_STARTED for
 * a stage the order has not reached yet, because calling stage 12 "In Progress"
 * on the day the PO arrives would be false.
 *
 * ---------------------------------------------------------------------------
 * 🔴 THE STORED STATUS IS NOT COLLAPSED, AND MUST NOT BE
 * ---------------------------------------------------------------------------
 *
 * This is a naming layer over `STAGE_STATUS`, not a replacement for it. Folding
 * the stored values into two would destroy, in this order:
 *
 *   DONE_ON_TIME vs DONE_LATE   the entire on-time percentage, the delay
 *                               analysis and every per-team figure (§39-41).
 *                               There is no way to recompute it afterwards -
 *                               the deadline comparison happens once, at
 *                               completion, against a frozen SLA.
 *   SKIPPED                     the KPI EXCLUSION. A skipped stage is neither a
 *                               success nor a failure; counting it as "Done"
 *                               would let a team improve its score by having
 *                               fewer advance orders.
 *   DUE_SOON / OVERDUE          the escalation sweep's entire trigger.
 *   ON_HOLD                     the SLA freeze.
 *
 * The timing facts therefore stay available beside the status - as `late`,
 * `overdue` and `held` flags - so the desk can still see that something needs
 * attention. What changed is that lateness is no longer the NAME of the state.
 */
export const STAGE_DISPLAY_STATUS = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
});

export const STAGE_DISPLAY_LABELS = Object.freeze({
  NOT_STARTED: 'Locked',
  IN_PROGRESS: 'Active',
  DONE: 'Completed',
});

/**
 * Stored status -> the two-state name.
 *
 * SKIPPED maps to DONE deliberately: the stage is finished and will not be
 * worked again, which is exactly what "Done" tells the reader. That it was
 * skipped rather than performed is carried alongside as `skipped`, and the KPI
 * still excludes it - the label does not change the arithmetic.
 */
export const displayStatusFor = (status) => {
  if (TERMINAL_STAGE_STATUSES.includes(status)) return STAGE_DISPLAY_STATUS.DONE;
  if (status === STAGE_STATUS.LOCKED) return STAGE_DISPLAY_STATUS.NOT_STARTED;
  // PENDING, DUE_SOON, OVERDUE, ON_HOLD - all of them mean somebody still owes
  // this work, however the clock is running.
  return STAGE_DISPLAY_STATUS.IN_PROGRESS;
};

/**
 * The facts the two-state label deliberately drops, kept beside it.
 *
 * Returned as flags rather than folded into the status so a screen can show
 * "In Progress" AND a red overdue marker - which is the combination the old
 * vocabulary could not express, because a stage could only be one thing.
 */
export const stageFlagsFor = (stage = {}) => ({
  late: stage.status === STAGE_STATUS.DONE_LATE,
  overdue: stage.status === STAGE_STATUS.OVERDUE,
  dueSoon: stage.status === STAGE_STATUS.DUE_SOON,
  held: stage.status === STAGE_STATUS.ON_HOLD,
  skipped: stage.status === STAGE_STATUS.SKIPPED,
  delayMinutes: stage.delayMinutes ?? null,
});

/** How close to the deadline a stage must be before it is DUE_SOON. */
export const DUE_SOON_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Order status and exit
// ---------------------------------------------------------------------------

export const ORDER_STATUS = Object.freeze({
  OPEN: 'OPEN',
  ON_HOLD: 'ON_HOLD',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
  VOID: 'VOID',
});

export const ORDER_STATUS_LIST = Object.freeze(Object.values(ORDER_STATUS));

/** Orders that have left the workflow without being completed. */
export const EXIT_TYPES = Object.freeze(['ON_HOLD', 'CANCELLED', 'VOID']);

/**
 * Why an order is on hold.
 *
 * Stock and customer holds are counted separately on purpose: one is the
 * business's own supply problem and the other is the customer's instruction,
 * and a dashboard that merges them cannot answer "are we slow, or are they?".
 */
export const HOLD_REASONS = Object.freeze([
  'CUSTOMER_REQUEST',
  'STOCK_UNAVAILABLE',
  'PAYMENT_PENDING',
  'DOCUMENTATION',
  'OTHER',
]);

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

/**
 * How a stage's deadline is computed from its start.
 *
 * The distinction that matters is WORKING versus CALENDAR. §17 of the brief is
 * explicit: 12 working hours from Monday 5:00 PM is NOT Tuesday 5:00 AM. The
 * first four types below consume only time inside the working window; the last
 * two land on a clock time rather than after a duration.
 *
 *   WORKING_MINUTES   "5 minutes", but only minutes the office is open
 *   WORKING_HOURS     "3 working hours", "12 working hours"
 *   WORKING_DAYS      whole open days
 *   CALENDAR_DAYS     wall-clock days, weekends and holidays included — used
 *                     for the 7-day advance-payment window, because a customer's
 *                     bank does not care about our office hours
 *   SAME_DAY_BY       a clock time today: "same day by 5:00 PM"
 *   NEXT_WORKING_DAY_BY  a clock time on the next open day: "by 11:45 AM"
 */
export const SLA_TYPES = Object.freeze({
  WORKING_MINUTES: 'WORKING_MINUTES',
  WORKING_HOURS: 'WORKING_HOURS',
  WORKING_DAYS: 'WORKING_DAYS',
  CALENDAR_DAYS: 'CALENDAR_DAYS',
  SAME_DAY_BY: 'SAME_DAY_BY',
  NEXT_WORKING_DAY_BY: 'NEXT_WORKING_DAY_BY',
});

export const SLA_TYPE_LIST = Object.freeze(Object.values(SLA_TYPES));

/** SLA types measured in working time, and therefore paused by a hold. */
export const WORKING_SLA_TYPES = Object.freeze([
  SLA_TYPES.WORKING_MINUTES,
  SLA_TYPES.WORKING_HOURS,
  SLA_TYPES.WORKING_DAYS,
]);

// ---------------------------------------------------------------------------
// The working calendar
// ---------------------------------------------------------------------------

/**
 * The office window, as defaults.
 *
 * DEFAULTS, not constants: §37 requires an administrator to change an SLA or a
 * working day without a code change, so these seed the configuration rather
 * than being read directly by the engine.
 *
 * Minutes from midnight, in the configured timezone. 10:30 → 630, 18:30 → 1110.
 */
export const DEFAULT_WORKDAY_START_MINUTE = 10 * 60 + 30;
export const DEFAULT_WORKDAY_END_MINUTE = 18 * 60 + 30;

/**
 * Monday–Saturday, using JavaScript's `getDay()` numbering where Sunday is 0.
 *
 * Sunday alone is closed. Note this differs from HRMS's `isWeekend` in
 * shared/leave/dates.js, which treats Saturday as a weekend too — that is a
 * LEAVE rule about when staff are entitled not to work, and this is a DISPATCH
 * rule about when the warehouse is open. They are genuinely different facts and
 * must not be collapsed into one helper.
 */
export const DEFAULT_WORKING_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6]);

/** Minutes in one working day, derived so the two cannot disagree. */
export const DEFAULT_WORKING_MINUTES_PER_DAY =
  DEFAULT_WORKDAY_END_MINUTE - DEFAULT_WORKDAY_START_MINUTE;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const O2D_API_PREFIX = "/api/v1/o2d";

/**
 * Where O2D's screens live in the Employee Portal — `FMS → O2D` (§1).
 *
 * ⚠ NOT the same string as `O2D_API_PREFIX`, and they must not be derived from
 * one another. §1 renames a NAVIGATION section; it says nothing about the API,
 * whose paths are quoted in the route file, the frontend client, and any
 * integration already pointed at this deployment. Moving the API to match the
 * menu would be a breaking change made for cosmetic reasons.
 *
 * One constant rather than the literal in each page, for exactly the reason
 * `HRMS_ROUTE_PREFIX` exists: the next rename should be one edit, not a sweep
 * across every file that happens to call `navigate()`.
 */
export const O2D_ROUTE_PREFIX = "/fms/o2d";

/** `o2dRoute('orders')` → `/fms/o2d/orders`. */
export const o2dRoute = (...segments) =>
  [O2D_ROUTE_PREFIX, ...segments.filter(Boolean)].join('/');

export const O2D_DOCUMENT_TYPES = Object.freeze([
  'PO',
  'SOR',
  'PI',
  'PAYMENT_PROOF',
  'INVOICE',
  'AWB',
  'LR',
  'DELIVERY_PROOF',
  'OTHER',
]);

// ---------------------------------------------------------------------------
// Communication
// ---------------------------------------------------------------------------

export const COMMUNICATION_CHANNELS = Object.freeze(['EMAIL', 'WHATSAPP', 'IN_APP']);

export const COMMUNICATION_STATUS = Object.freeze([
  'PENDING',
  'SENT',
  'FAILED',
  'SKIPPED',
]);

// ---------------------------------------------------------------------------
// Events the notification layer listens for
// ---------------------------------------------------------------------------

/**
 * Named events rather than direct sends.
 *
 * §42: a stage controller must not know whether a notification goes by email,
 * WhatsApp or the in-app inbox. It announces what happened; the notification
 * layer decides who hears about it and how.
 */
export const O2D_EVENTS = Object.freeze({
  ORDER_CREATED: 'o2d.order.created',
  STAGE_UNLOCKED: 'o2d.stage.unlocked',
  STAGE_DUE_SOON: 'o2d.stage.due_soon',
  STAGE_OVERDUE: 'o2d.stage.overdue',
  STAGE_ESCALATED: 'o2d.stage.escalated',
  STAGE_COMPLETED: 'o2d.stage.completed',
  STAGE_SKIPPED: 'o2d.stage.skipped',
  STAGE_REOPENED: 'o2d.stage.reopened',
  ADVANCE_PENDING: 'o2d.advance.pending',
  INVOICE_CREATED: 'o2d.invoice.created',
  DISPATCH_COMPLETED: 'o2d.dispatch.completed',
  ORDER_HELD: 'o2d.order.held',
  ORDER_RESUMED: 'o2d.order.resumed',
  ORDER_CLOSED: 'o2d.order.closed',
  ORDER_CANCELLED: 'o2d.order.cancelled',
  DAILY_SUMMARY: 'o2d.summary.daily',
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const O2D_AUDIT_ACTIONS = Object.freeze({
  ORDER_CREATED: 'o2d.order.created',
  ORDER_UPDATED: 'o2d.order.updated',
  STAGE_COMPLETED: 'o2d.stage.completed',
  STAGE_SKIPPED: 'o2d.stage.skipped',
  STAGE_REOPENED: 'o2d.stage.reopened',
  STAGE_OVERRIDDEN: 'o2d.stage.overridden',
  STAGE_ASSIGNED: 'o2d.stage.assigned',
  STAGE_UNASSIGNED: 'o2d.stage.unassigned',
  ORDER_HELD: 'o2d.order.held',
  ORDER_RESUMED: 'o2d.order.resumed',
  ORDER_CANCELLED: 'o2d.order.cancelled',
  ORDER_VOIDED: 'o2d.order.voided',
  ORDER_REOPENED: 'o2d.order.reopened',
  DOCUMENT_UPLOADED: 'o2d.document.uploaded',
  ADVANCE_APPROVED: 'o2d.advance.proceed_anyway',
  ZOHO_SYNC: 'o2d.zoho.sync',
  TIMESTAMP_CORRECTED: 'o2d.timestamp.corrected',
});

export default {
  STAGES,
  STAGE_NUMBERS,
  FIRST_STAGE,
  LAST_STAGE,
  DISPATCH_STAGE,
  STAGE_STATUS,
  STAGE_STATUS_LIST,
  TERMINAL_STAGE_STATUSES,
  STAGE_DISPLAY_STATUS,
  STAGE_DISPLAY_LABELS,
  displayStatusFor,
  stageFlagsFor,
  KPI_COUNTED_STATUSES,
  DUE_SOON_THRESHOLD,
  ORDER_STATUS,
  ORDER_STATUS_LIST,
  EXIT_TYPES,
  HOLD_REASONS,
  SLA_TYPES,
  SLA_TYPE_LIST,
  WORKING_SLA_TYPES,
  DEFAULT_WORKDAY_START_MINUTE,
  DEFAULT_WORKDAY_END_MINUTE,
  DEFAULT_WORKING_WEEKDAYS,
  DEFAULT_WORKING_MINUTES_PER_DAY,
  O2D_DOCUMENT_TYPES,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_STATUS,
  O2D_EVENTS,
  O2D_AUDIT_ACTIONS,
};
