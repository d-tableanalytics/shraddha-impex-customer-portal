/**
 * Planning vocabulary.
 *
 * A file of its own, as every other module has — the Phase 0 `hrms.js` carries
 * the foundation values and says so; module enums arrive with their module.
 *
 * Dependency-free and environment-free: this is bundled into the browser as
 * well as run in Node, so a `process.env` here would be a runtime crash in the
 * SPA (`shared/README.md` rule 1, enforced by the guard in shared-foundation).
 *
 * Every enum is `packages/shared-types/src/planning.ts` verbatim. Nothing is
 * invented — a status the reference does not have does not appear here.
 */

// ---------------------------------------------------------------------------
// Hiring plan
// ---------------------------------------------------------------------------

export const HIRING_PLAN_STATUSES = Object.freeze([
  'planned',
  'in_progress',
  'completed',
  'delayed',
  'cancelled',
]);

export const HIRING_PLAN_STATUS_LABELS = Object.freeze({
  planned: 'Planned',
  in_progress: 'In progress',
  completed: 'Completed',
  delayed: 'Delayed',
  cancelled: 'Cancelled',
});

/**
 * The legal moves, declared as DATA.
 *
 * 🔴 The reference declares all five statuses and then ships NO update
 * endpoint at all — `status` defaults to `planned`, `actualByDate` defaults to
 * null, and neither can ever change. Four of the five statuses and two of its
 * four table columns are decoration.
 *
 * A plan that is late is `delayed` and can still be finished, so `delayed`
 * returns to `in_progress` and goes on to `completed`. A finished or abandoned
 * plan is done: reopening one is a new plan, because the target date it was
 * measured against has passed.
 */
export const HIRING_PLAN_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['in_progress', 'delayed', 'cancelled']),
  in_progress: Object.freeze(['completed', 'delayed', 'cancelled']),
  delayed: Object.freeze(['in_progress', 'completed', 'cancelled']),
  // Terminal. A new plan is the way to hire for this role again.
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/** Statuses that close a plan out. */
export const CLOSED_HIRING_PLAN_STATUSES = Object.freeze(['completed', 'cancelled']);

/**
 * The status that stamps `actualByDate`.
 *
 * The reference has the column and nothing that could ever fill it; a plan is
 * "actually" hired on the day it completes.
 */
export const HIRING_PLAN_COMPLETED_STATUS = 'completed';

// ---------------------------------------------------------------------------
// Financial year
// ---------------------------------------------------------------------------

/**
 * The shape a financial year must take.
 *
 * 🔴 The reference types this as a bare `z.string().min(1).max(20)` with the
 * comment `// e.g., "FY2026"`, and its filter is a free text box. So "FY2026",
 * "2026", "fy2026" and "FY 2026" are four different years to both the unique
 * index and the filter — plans fragment silently and the uniqueness guarantee
 * evaporates. One shape, enforced, is what makes `(year, department)` mean
 * anything.
 */
export const FINANCIAL_YEAR_PATTERN = /^FY\d{4}$/;

/** How the label reads: FY2026 covers Apr 2025 – Mar 2026 in the Indian convention. */
export const FINANCIAL_YEAR_HINT = 'FY followed by four digits, e.g. FY2026.';

/** Bounds, so a typo cannot create a plan for the year 9999. */
export const FINANCIAL_YEAR_MIN = 2000;
export const FINANCIAL_YEAR_MAX = 2100;

/**
 * The financial year a date falls in, on the Indian April–March convention.
 *
 * Used only to seed the form's default; nothing branches on it.
 */
export function financialYearFor(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  // April (month 3) starts the next financial year.
  return `FY${d.getUTCMonth() >= 3 ? year + 1 : year}`;
}

// ---------------------------------------------------------------------------
// Headcount
// ---------------------------------------------------------------------------

/**
 * Employee statuses that count toward actual headcount.
 *
 * The reference counts `status: 'active'` only. `probation` and `notice` are
 * deliberately NOT added here — somebody on notice is still on the payroll, but
 * the reference does not count them and counting them would change what every
 * utilization figure means.
 */
export const HEADCOUNT_ACTIVE_STATUSES = Object.freeze(['active']);

/** A plan cannot ask for an unbounded number of people. */
export const PLANNED_HEADCOUNT_MAX = 100_000;

export default {
  HIRING_PLAN_STATUSES,
  HIRING_PLAN_STATUS_LABELS,
  HIRING_PLAN_TRANSITIONS,
  CLOSED_HIRING_PLAN_STATUSES,
  HIRING_PLAN_COMPLETED_STATUS,
  FINANCIAL_YEAR_PATTERN,
  FINANCIAL_YEAR_HINT,
  FINANCIAL_YEAR_MIN,
  FINANCIAL_YEAR_MAX,
  financialYearFor,
  HEADCOUNT_ACTIVE_STATUSES,
  PLANNED_HEADCOUNT_MAX,
};
