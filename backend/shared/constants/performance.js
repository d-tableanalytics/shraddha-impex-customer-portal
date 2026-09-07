/**
 * Performance vocabulary.
 *
 * A file of its own, as Attendance, Leave, Payroll, Hiring and Onboarding each
 * have — the Phase 0 `hrms.js` carries the foundation values and says so;
 * module enums arrive with their module.
 *
 * Dependency-free and environment-free: this is bundled into the browser as
 * well as run in Node, so a `process.env` here would be a runtime crash in the
 * SPA (`shared/README.md` rule 1, enforced by the guard in shared-foundation).
 *
 * Every enum is `packages/shared-types/src/performance.ts` verbatim. Nothing is
 * invented — a status the reference does not have does not appear here.
 */

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export const GOAL_STATUSES = Object.freeze([
  'open',
  'in_progress',
  'at_risk',
  'achieved',
  'missed',
  'cancelled',
]);

/**
 * The legal moves for a goal, declared as DATA.
 *
 * 🔴 The reference enforces nothing: `updateProgress` writes whatever status it
 * is given, so `achieved → open` and a revived `cancelled` goal are both
 * accepted. A goal that has been closed out is a record of what happened, and
 * reopening one has to be a deliberate move back to `in_progress` rather than a
 * sideways write.
 *
 * `at_risk` is reachable from and returns to `in_progress`, because that is
 * what "at risk" means — work still in flight that may not land.
 */
export const GOAL_TRANSITIONS = Object.freeze({
  open: Object.freeze(['in_progress', 'at_risk', 'achieved', 'missed', 'cancelled']),
  in_progress: Object.freeze(['at_risk', 'achieved', 'missed', 'cancelled']),
  at_risk: Object.freeze(['in_progress', 'achieved', 'missed', 'cancelled']),
  // Closed out, but a mistake must be undoable — back to work, not sideways.
  achieved: Object.freeze(['in_progress']),
  missed: Object.freeze(['in_progress']),
  cancelled: Object.freeze(['in_progress']),
});

/** Statuses that mean the goal is no longer being worked. */
export const CLOSED_GOAL_STATUSES = Object.freeze(['achieved', 'missed', 'cancelled']);

export const GOAL_STATUS_LABELS = Object.freeze({
  open: 'Open',
  in_progress: 'In progress',
  at_risk: 'At risk',
  achieved: 'Achieved',
  missed: 'Missed',
  cancelled: 'Cancelled',
});

/** Bounds on a goal's weight. Stored and shown; see the module's §15. */
export const GOAL_WEIGHT_MIN = 1;
export const GOAL_WEIGHT_MAX = 10;

// ---------------------------------------------------------------------------
// Review cycle
// ---------------------------------------------------------------------------

export const REVIEW_PHASES = Object.freeze([
  'goal_setting',
  'self_review',
  'manager_review',
  'calibration',
  'closed',
]);

/**
 * The phase machine, declared as DATA and actually enforced.
 *
 * 🔴 The reference's own service header says the phases "progress linearly",
 * and then `advancePhase` accepts ANY phase from any phase — the only check is
 * that the cycle is not already closed. A cycle sitting in `calibration` can be
 * shoved back to `goal_setting`, which invalidates every review written under
 * it while leaving those rows in place.
 *
 * Forward-by-one is the machine the reference describes. One backward move is
 * allowed — reopening a closed cycle is not, but stepping back one phase to fix
 * a premature advance is, and the service refuses even that once responses have
 * been submitted.
 */
export const PHASE_TRANSITIONS = Object.freeze({
  goal_setting: Object.freeze(['self_review']),
  self_review: Object.freeze(['manager_review', 'goal_setting']),
  manager_review: Object.freeze(['calibration', 'self_review']),
  calibration: Object.freeze(['closed', 'manager_review']),
  // Terminal. A new cycle is the way to review again.
  closed: Object.freeze([]),
});

/** The order phases run in, for rendering a progress rail. */
export const PHASE_ORDER = Object.freeze([
  'goal_setting',
  'self_review',
  'manager_review',
  'calibration',
  'closed',
]);

export const PHASE_LABELS = Object.freeze({
  goal_setting: 'Goal setting',
  self_review: 'Self review',
  manager_review: 'Manager review',
  calibration: 'Calibration',
  closed: 'Closed',
});

/**
 * Phases in which a review response may be created.
 *
 * The reference refuses `closed` and `goal_setting`, which is right: there is
 * nothing to review before goals are set, and nothing to add after the cycle
 * has shut.
 */
export const RESPONSE_OPEN_PHASES = Object.freeze([
  'self_review',
  'manager_review',
  'calibration',
]);

// ---------------------------------------------------------------------------
// Review response
// ---------------------------------------------------------------------------

export const REVIEW_KINDS = Object.freeze(['self', 'manager', 'peer', 'skip_level']);

export const REVIEW_KIND_LABELS = Object.freeze({
  self: 'Self',
  manager: 'Manager',
  peer: 'Peer',
  skip_level: 'Skip-level',
});

/** Kinds whose reviewer is derived from the employee rather than chosen. */
export const DERIVED_REVIEWER_KINDS = Object.freeze(['self', 'manager']);

export const RATING_MIN = 1;
export const RATING_MAX = 5;

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export const FEEDBACK_KINDS = Object.freeze(['praise', 'constructive']);
export const FEEDBACK_VISIBILITIES = Object.freeze(['visible', 'anonymous']);

export const FEEDBACK_KIND_LABELS = Object.freeze({
  praise: 'Praise',
  constructive: 'Constructive',
});

// ---------------------------------------------------------------------------
// 1:1
// ---------------------------------------------------------------------------

export const ONE_ON_ONE_STATUSES = Object.freeze(['scheduled', 'completed', 'cancelled']);

/**
 * A 1:1 is resolved once and stays resolved.
 *
 * The reference lets `update` write any status, so a completed meeting can be
 * put back to `scheduled` and its notes reattached to a session that has
 * already happened.
 */
export const ONE_ON_ONE_TRANSITIONS = Object.freeze({
  scheduled: Object.freeze(['completed', 'cancelled']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const ONE_ON_ONE_STATUS_LABELS = Object.freeze({
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
});

export const ONE_ON_ONE_MIN_MINUTES = 15;
export const ONE_ON_ONE_MAX_MINUTES = 180;

/** The competency template a new cycle is seeded with, as the reference seeds it. */
export const DEFAULT_COMPETENCIES = Object.freeze([
  Object.freeze({ key: 'execution', label: 'Execution', weight: 2 }),
  Object.freeze({ key: 'collaboration', label: 'Collaboration', weight: 1 }),
  Object.freeze({ key: 'ownership', label: 'Ownership', weight: 2 }),
]);

export default {
  GOAL_STATUSES,
  GOAL_TRANSITIONS,
  CLOSED_GOAL_STATUSES,
  GOAL_STATUS_LABELS,
  GOAL_WEIGHT_MIN,
  GOAL_WEIGHT_MAX,
  REVIEW_PHASES,
  PHASE_TRANSITIONS,
  PHASE_ORDER,
  PHASE_LABELS,
  RESPONSE_OPEN_PHASES,
  REVIEW_KINDS,
  REVIEW_KIND_LABELS,
  DERIVED_REVIEWER_KINDS,
  RATING_MIN,
  RATING_MAX,
  FEEDBACK_KINDS,
  FEEDBACK_VISIBILITIES,
  FEEDBACK_KIND_LABELS,
  ONE_ON_ONE_STATUSES,
  ONE_ON_ONE_TRANSITIONS,
  ONE_ON_ONE_STATUS_LABELS,
  ONE_ON_ONE_MIN_MINUTES,
  ONE_ON_ONE_MAX_MINUTES,
  DEFAULT_COMPETENCIES,
};
