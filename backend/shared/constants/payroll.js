/**
 * Payroll vocabulary.
 *
 * A file of its own rather than more entries in `./hrms.js`, matching what
 * Attendance and Leave did: that file carries the Phase 0 foundation values and
 * says so, and module enums arrive with their module.
 *
 * Dependency-free and environment-free, like every other file under
 * `shared/constants/` — this is bundled into the browser as well as run in
 * Node, so a `process.env` here would be a runtime crash in the SPA
 * (`shared/README.md` rule 1, and the guard test in shared-foundation).
 *
 * ---------------------------------------------------------------------------
 * Ported from the reference
 * ---------------------------------------------------------------------------
 * Every enum below is `packages/shared-types/src/payroll.ts` verbatim. Nothing
 * is invented: the brief is explicit that a status or a component type that the
 * reference does not have must not appear here because it would be useful.
 */

// ---------------------------------------------------------------------------
// Salary components
// ---------------------------------------------------------------------------

/**
 * What a component DOES to the payslip.
 *
 * `earning` and `reimbursement` both add to gross; `deduction` subtracts from
 * it; `employer_contribution` is cost-to-company and touches neither gross nor
 * net — it is reported separately, which is why the totals are summed by type
 * rather than by sign.
 */
export const COMPONENT_TYPES = Object.freeze([
  'earning',
  'deduction',
  'reimbursement',
  'employer_contribution',
]);

/** How a component's amount is arrived at. */
export const CALCULATION_TYPES = Object.freeze(['fixed', 'percent_of', 'formula', 'statutory']);

/**
 * The statutory bucket a `statutory` component draws from.
 *
 * The component's own `type` then decides which SIDE of that bucket it takes:
 * a `deduction` linked to `pf` is the employee's 12%, an
 * `employer_contribution` linked to `pf` is the employer's.
 */
export const STATUTORY_LINKS = Object.freeze(['pf', 'esi', 'pt', 'lwf', 'tds']);

/** Component codes must be UPPER_SNAKE_CASE so a formula can name them. */
export const COMPONENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Codes the engine gives special meaning to.
 *
 * `BASIC` + `DA` are the PF wage base, and `preliminaryGross` is what ESI and
 * PT are assessed on. These are conventions of the reference's engine, not
 * arbitrary: a structure that never defines BASIC computes PF on zero.
 */
export const PF_WAGE_COMPONENT_CODES = Object.freeze(['BASIC', 'DA']);

/** The synthetic component the engine emits for unpaid-leave days. */
export const LOP_COMPONENT_CODE = 'LOP';

// ---------------------------------------------------------------------------
// Payroll run lifecycle
// ---------------------------------------------------------------------------

/**
 * The reference's four states, and only those.
 *
 *   draft     created, nothing computed
 *   review    computed; payslips exist and may be recomputed or rolled back
 *   locked    frozen; payslips are final and visible to employees
 *   disbursed paid out
 *
 * There is deliberately no `approved` or `paid`: the brief calls those out by
 * name as states not to invent, and the reference has neither.
 */
export const RUN_STATUSES = Object.freeze(['draft', 'review', 'locked', 'disbursed']);

/**
 * The legal transitions, as the reference's service enforces them.
 *
 * Declared as data rather than as a chain of `if` statements so the state
 * machine can be asserted directly in a test and so an illegal transition is
 * one lookup rather than a missed branch.
 *
 *   draft     -> review     (compute)
 *   review    -> review     (recompute)
 *   review    -> locked     (lock)
 *   review    -> draft      (rollback)
 *   draft     -> draft      (rollback, a no-op that clears payslips)
 *   locked    -> disbursed  (disburse)
 *
 * Nothing leaves `disbursed`, and nothing returns from `locked` — the
 * reference blocks recompute and rollback once locked, which is what makes a
 * payslip an employee can see immutable.
 */
export const RUN_TRANSITIONS = Object.freeze({
  compute: Object.freeze({ from: Object.freeze(['draft', 'review']), to: 'review' }),
  lock: Object.freeze({ from: Object.freeze(['review']), to: 'locked' }),
  disburse: Object.freeze({ from: Object.freeze(['locked']), to: 'disbursed' }),
  rollback: Object.freeze({ from: Object.freeze(['draft', 'review']), to: 'draft' }),
});

/** Statuses whose payslips an ordinary employee may see. */
export const EMPLOYEE_VISIBLE_RUN_STATUSES = Object.freeze(['locked', 'disbursed']);

/** Statuses that may no longer be changed in any way. */
export const IMMUTABLE_RUN_STATUSES = Object.freeze(['locked', 'disbursed']);

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Payroll rounds to 2 decimal places, half away from zero.
 *
 * This is the reference's rule, applied at every step of its engine
 * (`round2` appears in salary-engine, salary-formula, statutory-engine and
 * every statutory engine). It is stated here as a named constant rather than
 * left as a bare `Math.round(n * 100) / 100` scattered through the services,
 * because the brief is explicit that rounding must be a documented rule rather
 * than an incidental call.
 *
 * The two DELIBERATE exceptions, both the reference's and both statutory:
 *   ESI rounds each side UP to the whole rupee (ESIC's own rule)
 *   PT is a flat rupee amount per slab and rounds to the whole rupee
 */
export const MONEY_DECIMAL_PLACES = 2;

/** Indian financial year starts in April. Used to project TDS over the year. */
export const FINANCIAL_YEAR_START_MONTH = 4;

export default {
  COMPONENT_TYPES,
  CALCULATION_TYPES,
  STATUTORY_LINKS,
  COMPONENT_CODE_PATTERN,
  PF_WAGE_COMPONENT_CODES,
  LOP_COMPONENT_CODE,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  EMPLOYEE_VISIBLE_RUN_STATUSES,
  IMMUTABLE_RUN_STATUSES,
  MONEY_DECIMAL_PLACES,
  FINANCIAL_YEAR_START_MONTH,
};
