/**
 * Onboarding vocabulary.
 *
 * A file of its own, as Attendance, Leave, Payroll and Hiring each have — the
 * Phase 0 `hrms.js` carries the foundation values and says so; module enums
 * arrive with their module.
 *
 * Dependency-free and environment-free: this is bundled into the browser as
 * well as run in Node, so a `process.env` here would be a runtime crash in the
 * SPA (`shared/README.md` rule 1, enforced by the guard in shared-foundation).
 *
 * Every enum is `packages/shared-types/src/onboarding.ts` verbatim. Nothing is
 * invented — a status the reference does not have does not appear here.
 */

// ---------------------------------------------------------------------------
// Task assignment
// ---------------------------------------------------------------------------

/**
 * Who a template task lands on when a checklist is instantiated.
 *
 * These are ROLES IN THE PROCESS, not permission keys. `hr` and `it` resolve to
 * a person holding the corresponding HRMS role; `manager` and `new_hire` are
 * resolved from the employee record; `buddy` is left unassigned for HR to fill
 * in, which is what the reference does too.
 */
export const ASSIGN_TO = Object.freeze(['hr', 'buddy', 'manager', 'new_hire', 'it']);

export const ASSIGN_TO_LABELS = Object.freeze({
  hr: 'HR',
  buddy: 'Buddy',
  manager: 'Manager',
  new_hire: 'New hire',
  it: 'IT',
});

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export const CHECKLIST_STATUSES = Object.freeze(['active', 'completed', 'cancelled']);

/**
 * The legal moves for a checklist, declared as DATA.
 *
 * 🔴 The reference has `cancelled` in its enum and NO way to reach it — there is
 * no cancel endpoint and no transition that sets it. A status nothing can write
 * is a status that lies about what the system can express, so the move is
 * declared here and given an endpoint.
 *
 * `completed` is not terminal on purpose: reopening a task must reopen its
 * checklist, or a checklist that auto-closed stays closed while work is
 * outstanding (the reference's defect 3). `closeIfSettled` recomputes the
 * status from the tasks on every update rather than latching it.
 */
export const CHECKLIST_TRANSITIONS = Object.freeze({
  active: Object.freeze(['completed', 'cancelled']),
  completed: Object.freeze(['active', 'cancelled']),
  // Terminal. A new checklist is the way to onboard again.
  cancelled: Object.freeze([]),
});

export const TERMINAL_CHECKLIST_STATUSES = Object.freeze(['cancelled']);

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'skipped']);

/**
 * A task moves forward, and a closed one can be reopened to `pending`.
 *
 * 🔴 The reference enforces nothing: `updateTask` writes whatever status it is
 * given. Reopening is genuinely useful — a task marked done by mistake has to be
 * undoable — but it must go back to `pending` rather than sideways into
 * `in_progress`, and the checklist has to follow it back out of `completed`.
 */
export const TASK_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['in_progress', 'completed', 'skipped']),
  in_progress: Object.freeze(['completed', 'skipped', 'pending']),
  completed: Object.freeze(['pending']),
  skipped: Object.freeze(['pending']),
});

/** Statuses that count as settled — for progress, and for auto-closing. */
export const CLOSED_TASK_STATUSES = Object.freeze(['completed', 'skipped']);

/** Statuses that still need somebody to act. */
export const OPEN_TASK_STATUSES = Object.freeze(['pending', 'in_progress']);

export const TASK_STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  skipped: 'Skipped',
});

// ---------------------------------------------------------------------------
// Offer letter
// ---------------------------------------------------------------------------

/**
 * The offer's state is DERIVED from its timestamps, never stored.
 *
 * The reference does the same, in a `statusOf()` helper on the client. Deriving
 * it server-side instead means one definition rather than one per screen, and
 * no column that can disagree with the timestamps beside it.
 */
export const OFFER_LETTER_STATES = Object.freeze(['draft', 'sent', 'accepted', 'rejected']);

export const OFFER_LETTER_STATE_LABELS = Object.freeze({
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
});

/** Bounds on the task-template due offset, in days after the checklist starts. */
export const DUE_DAYS_MIN = 0;
export const DUE_DAYS_MAX = 365;

export default {
  ASSIGN_TO,
  ASSIGN_TO_LABELS,
  CHECKLIST_STATUSES,
  CHECKLIST_TRANSITIONS,
  TERMINAL_CHECKLIST_STATUSES,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  CLOSED_TASK_STATUSES,
  OPEN_TASK_STATUSES,
  TASK_STATUS_LABELS,
  OFFER_LETTER_STATES,
  OFFER_LETTER_STATE_LABELS,
  DUE_DAYS_MIN,
  DUE_DAYS_MAX,
};
