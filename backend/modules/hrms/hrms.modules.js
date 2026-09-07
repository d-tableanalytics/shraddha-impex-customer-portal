/**
 * Which HRMS modules actually exist right now.
 *
 * The permission matrix declares 31 module keys, because permissions were
 * modelled up front (Phase 0). Very few of them have any screen or endpoint
 * behind them yet.
 *
 * Those are two different questions, and conflating them is how a nav ends up
 * full of links to nothing. `canAccessHrmsModule` answers "is this person
 * ALLOWED here"; this file answers "does this exist yet". The nav needs both,
 * and the dashboard needs the second to show honest empty states rather than
 * invented numbers.
 *
 * Add a key here in the same commit that ships its screens - never before.
 */

import { HRMS_MODULES as M } from '../../shared/permissions/constants.js';

/**
 * Modules with a real, reachable SCREEN.
 *
 * The company profile and retention endpoints exist too, but they are
 * foundation infrastructure consumed by the shell rather than a module a user
 * navigates to - listing `settings` here would put a nav link in front of a
 * page nobody has built.
 */
export const IMPLEMENTED_HRMS_MODULES = Object.freeze([
  M.DASHBOARD,
  M.EMPLOYEES,
  M.ORG_STRUCTURE,
  M.LEAVE,
  // Punches, history, corrections, consent and selfies all have screens and
  // endpoints behind them. Added in the same commit that ships them, per the
  // note above.
  M.ATTENDANCE,
  M.EXPENSES,
  M.EXITS,
  M.ASSETS,
  M.DOCUMENTS,
  M.HELPDESK,
  // Pay groups, components, structures, compensation, statutory configuration,
  // the run lifecycle and payslips all have screens and endpoints behind them.
  M.PAYROLL,
  M.PAYROLL_STRUCTURE,
  // Requisitions, postings, candidates, the pipeline, interviews and offers
  // all have screens and endpoints behind them.
  M.HIRING,
  // Templates, checklists with per-task assignment, and the offer letter a new
  // hire signs in the portal.
  M.ONBOARDING,
  // Goals, review cycles and calibration, the review queue, continuous
  // feedback and 1:1s all have screens and endpoints behind them.
  M.PERFORMANCE,
  // Announcements, polls, peer recognition and the eNPS pulse all have screens
  // and endpoints behind them.
  M.ENGAGE,
  // Headcount plans with derived actuals and budget, and the hiring plan
  // calendar, both have screens and endpoints behind them.
  M.PLANNING,
  // The report catalogue, the three built-in reports and CSV export all have
  // a screen and endpoints behind them. The four `reports:*` SUBMODULE keys
  // stay planned: the reference grants them, gates on them, and then declares
  // no report that requires any of them.
  M.REPORTS,
  // The notification centre: a page, a header bell, and twenty-one producer
  // events raised by eleven other modules.
  M.INBOX,
  // The audit trail's read side: filters, paging and a redacted detail view.
  M.AUDIT_LOGS,
  // Company profile and branding, the role matrix, SSO and integrations.
  // `settings:integrations` stays a submodule KEY rather than a nav entry -
  // it gates the integration tabs, it is not a module of its own.
  M.SETTINGS,
]);

/**
 * Modules whose permissions exist but whose implementation does not.
 *
 * Exposed so the UI can distinguish "you may not" from "not built yet" - a
 * distinction a user notices immediately and a 403 cannot express.
 */
export const PLANNED_HRMS_MODULES = Object.freeze(
  Object.values(M).filter((m) => !IMPLEMENTED_HRMS_MODULES.includes(m)),
);

export const isModuleImplemented = (module) => IMPLEMENTED_HRMS_MODULES.includes(module);

export default { IMPLEMENTED_HRMS_MODULES, PLANNED_HRMS_MODULES, isModuleImplemented };
