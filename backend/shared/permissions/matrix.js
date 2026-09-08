/**
 * The canonical HRMS role -> permission grant table.
 *
 * Ported from the DTA HRMS reference (`packages/rbac/src/matrix.ts`). This object
 * is the single source of truth: the backend guard, the frontend nav filter and
 * the database seed all read it. Do not restate any of it anywhere else.
 *
 * ---------------------------------------------------------------------------
 * AD-4 - THE MOST IMPORTANT RULE IN THIS FILE
 * ---------------------------------------------------------------------------
 * `SELF_BASELINE` is spread into HRMS ROLES. It is never granted for merely
 * being authenticated.
 *
 * In a system where customers and employees share one login (AD-14), granting a
 * "self" baseline at the authentication layer would hand every logged-in
 * customer their own payslip page. The baseline therefore belongs to the
 * `hrms_employee` role and to the roles that build on it - and a portal
 * Customer holds none of them.
 *
 * ---------------------------------------------------------------------------
 * Portal roles are deliberately absent FROM THIS TABLE
 * ---------------------------------------------------------------------------
 * Admin, Sales, Inventory Manager, Warehouse User, Management and Customer are
 * not keys here, and this file maps nothing but `hrms_*` roles. That has not
 * changed and should not: what an HRMS role may do is decided here, in one
 * reviewed table, in HRMS's own vocabulary.
 *
 * WHAT HAS CHANGED IS HOW AN ACCOUNT COMES TO HOLD ONE.
 *
 * This header used to add that the portal's `Admin: ['*']` wildcard "does not
 * reach HRMS", because mapping it across would silently hand every portal
 * administrator full payroll, PAN and bank-detail access. That is no longer
 * true, and the requirement it answered has been superseded: HR, Admin and
 * Super Admin are now required to hold complete HRMS access.
 *
 * They acquire it the same way anyone does - by holding `hrms_*` role keys.
 * `backend/utils/hrmsAccessBridge.js` derives those keys from the portal's
 * Roles & Permissions matrix and unions them into `User.roles[]` before
 * `buildHrmsActor` ever sees them, so every grant still comes from this table
 * and nothing downstream can tell an implied role key from an explicit one.
 *
 * The objection that comment recorded was to access granted SILENTLY. It is not
 * silent now: HRMS is a labelled block of cells in the permission matrix that a
 * Super Admin ticks deliberately and can withhold.
 *
 * AD-4 is untouched. A portal-only role still resolves no permission outside
 * the customer portal, so no Customer can reach a key the bridge reads.
 */

import { HRMS_MODULES as M, HRMS_ACTIONS as A, SCOPES as S, HRMS_ROLES as R, permission as p } from './constants.js';

/**
 * Self-service baseline. Everything an ordinary employee may do with their own
 * records. Spread into every role that includes employee self-service.
 */
const SELF_BASELINE = Object.freeze([
  p(M.DASHBOARD, A.VIEW, S.SELF),
  p(M.INBOX, A.VIEW, S.SELF),

  // Daily-ops flows need submit AND view together: someone who can clock in
  // must be able to see their own attendance history. Same for leave, expenses
  // and helpdesk.
  p(M.ATTENDANCE, A.SUBMIT, S.SELF),
  p(M.ATTENDANCE, A.VIEW, S.SELF),
  p(M.LEAVE, A.SUBMIT, S.SELF),
  p(M.LEAVE, A.VIEW, S.SELF),
  p(M.EXPENSES, A.SUBMIT, S.SELF),
  p(M.EXPENSES, A.VIEW, S.SELF),
  p(M.HELPDESK, A.SUBMIT, S.SELF),
  p(M.HELPDESK, A.VIEW, S.SELF),

  p(M.DOCUMENTS, A.VIEW, S.SELF),
  // Uploading to one's OWN repository, and acknowledging a policy. The
  // reference authorises both with `documents:view:self` - a read grant
  // permitting a write; every other self-service flow here uses SUBMIT.
  p(M.DOCUMENTS, A.SUBMIT, S.SELF),
  p(M.PERFORMANCE, A.VIEW, S.SELF),
  p(M.PERFORMANCE, A.SUBMIT, S.SELF),
  p(M.EMPLOYEES, A.VIEW, S.SELF),
  p(M.EMPLOYEES, A.EDIT, S.SELF),

  // Reference-data reads. Department and location names appear on every profile
  // and on the org chart, so any HRMS user must be able to resolve those ids to
  // labels or the UI shows raw keys.
  p(M.ORG_STRUCTURE, A.VIEW, S.SELF),

  p(M.PAYROLL, A.VIEW, S.SELF),
  p(M.ONBOARDING, A.VIEW, S.SELF),
  p(M.EXITS, A.SUBMIT, S.SELF),

  // Assets: an employee sees the kit issued to them and may request more.
  // CLAUDE.md's own matrix reads "Assets (assign/manage) - Employee: Request
  // only", and the reference gates its request endpoints on an assets self
  // grant. Writing uses SUBMIT rather than VIEW, as every other self-service
  // flow here does - the reference authorises creating a request with a read
  // permission.
  p(M.ASSETS, A.VIEW, S.SELF),
  p(M.ASSETS, A.SUBMIT, S.SELF),
  p(M.EXITS, A.VIEW, S.SELF),
  p(M.ENGAGE, A.VIEW, S.SELF),
]);

export const HRMS_PERMISSION_MATRIX = Object.freeze({
  [R.SUPER_ADMIN]: Object.freeze([
    ...SELF_BASELINE,
    p(M.EMPLOYEES, A.VIEW, S.ORG),
    p(M.EMPLOYEES, A.CREATE, S.ORG),
    p(M.EMPLOYEES, A.EDIT, S.ORG),
    p(M.EMPLOYEES, A.DELETE, S.ORG),
    p(M.EMPLOYEES_COMPENSATION, A.VIEW, S.ORG),
    p(M.EMPLOYEES_COMPENSATION, A.EDIT, S.ORG),
    p(M.ORG_STRUCTURE, A.VIEW, S.ORG),
    p(M.ORG_STRUCTURE, A.EDIT, S.ORG),
    p(M.ONBOARDING, A.VIEW, S.ORG),
    p(M.ONBOARDING, A.EDIT, S.ORG),
    p(M.EXITS, A.VIEW, S.ORG),
    p(M.EXITS, A.EDIT, S.ORG),
    p(M.ATTENDANCE, A.VIEW, S.ORG),
    p(M.ATTENDANCE, A.APPROVE, S.ORG),
    p(M.ATTENDANCE, A.EDIT, S.ORG),
    p(M.LEAVE, A.VIEW, S.ORG),
    p(M.LEAVE, A.APPROVE, S.ORG),
    p(M.LEAVE, A.EDIT, S.ORG),
    p(M.PAYROLL, A.VIEW, S.ORG),
    p(M.PAYROLL, A.RUN, S.ORG),
    p(M.PAYROLL, A.APPROVE, S.ORG),
    p(M.PAYROLL_STRUCTURE, A.VIEW, S.ORG),
    p(M.PAYROLL_STRUCTURE, A.EDIT, S.ORG),
    p(M.EXPENSES, A.VIEW, S.ORG),
    p(M.EXPENSES, A.APPROVE, S.ORG),
    p(M.PERFORMANCE, A.VIEW, S.ORG),
    p(M.PERFORMANCE, A.APPROVE, S.ORG),
    p(M.HIRING, A.VIEW, S.ORG),
    p(M.HIRING, A.EDIT, S.ORG),
    p(M.ASSETS, A.VIEW, S.ORG),
    p(M.ASSETS, A.ASSIGN, S.ORG),
    p(M.ENGAGE, A.EDIT, S.ORG),
    p(M.DOCUMENTS, A.VIEW, S.ORG),
    p(M.DOCUMENTS, A.EDIT, S.ORG),
    p(M.HELPDESK, A.VIEW, S.ORG),
    p(M.HELPDESK, A.RESOLVE, S.ORG),
    p(M.REPORTS, A.VIEW, S.ORG),
    p(M.REPORTS, A.EXPORT, S.ORG),
    p(M.SETTINGS, A.VIEW, S.ORG),
    p(M.SETTINGS, A.EDIT, S.ORG),
    p(M.SETTINGS_INTEGRATIONS, A.EDIT, S.ORG),
    p(M.AUDIT_LOGS, A.VIEW, S.ORG),
    p(M.PLANNING, A.VIEW, S.ORG),
    p(M.PLANNING, A.EDIT, S.ORG),
  ]),

  [R.HR_ADMIN]: Object.freeze([
    ...SELF_BASELINE,
    p(M.EMPLOYEES, A.VIEW, S.ORG),
    p(M.EMPLOYEES, A.CREATE, S.ORG),
    p(M.EMPLOYEES, A.EDIT, S.ORG),
    p(M.ORG_STRUCTURE, A.VIEW, S.ORG),
    p(M.ORG_STRUCTURE, A.EDIT, S.ORG),
    p(M.ONBOARDING, A.VIEW, S.ORG),
    p(M.ONBOARDING, A.EDIT, S.ORG),
    p(M.EXITS, A.VIEW, S.ORG),
    p(M.EXITS, A.EDIT, S.ORG),
    p(M.ATTENDANCE, A.VIEW, S.ORG),
    p(M.ATTENDANCE, A.APPROVE, S.ORG),
    p(M.ATTENDANCE, A.EDIT, S.ORG),
    p(M.LEAVE, A.VIEW, S.ORG),
    p(M.LEAVE, A.APPROVE, S.ORG),
    p(M.LEAVE, A.EDIT, S.ORG),
    // Separation of duties: HR sees payroll but cannot run it. Only
    // payroll_admin and super_admin hold `payroll/run`.
    p(M.PAYROLL, A.VIEW, S.ORG),
    p(M.PAYROLL, A.APPROVE, S.ORG), // advance-salary decisions
    p(M.EXPENSES, A.VIEW, S.ORG),
    p(M.EXPENSES, A.APPROVE, S.ORG), // policy-level approvals
    p(M.PERFORMANCE, A.VIEW, S.ORG),
    p(M.PERFORMANCE, A.APPROVE, S.ORG),
    p(M.HIRING, A.VIEW, S.ORG),
    p(M.HIRING, A.EDIT, S.ORG),
    p(M.ASSETS, A.VIEW, S.ORG),
    p(M.ASSETS, A.ASSIGN, S.ORG),
    p(M.ENGAGE, A.EDIT, S.ORG),
    p(M.DOCUMENTS, A.VIEW, S.ORG),
    p(M.DOCUMENTS, A.EDIT, S.ORG),
    p(M.HELPDESK, A.VIEW, S.ORG),
    p(M.HELPDESK_HR, A.RESOLVE, S.ORG),
    p(M.REPORTS, A.VIEW, S.ORG),
    p(M.AUDIT_LOGS, A.VIEW, S.ORG),
    p(M.PLANNING, A.VIEW, S.ORG),
    p(M.PLANNING, A.EDIT, S.ORG),
  ]),

  [R.PAYROLL_ADMIN]: Object.freeze([
    ...SELF_BASELINE,
    p(M.EMPLOYEES_COMPENSATION, A.VIEW, S.ORG),
    p(M.PAYROLL, A.VIEW, S.ORG),
    p(M.PAYROLL, A.RUN, S.ORG),
    p(M.PAYROLL_STRUCTURE, A.VIEW, S.ORG),
    p(M.PAYROLL_STRUCTURE, A.EDIT, S.ORG),
    p(M.EXPENSES, A.VIEW, S.ORG),
    p(M.EXPENSES, A.APPROVE, S.ORG), // finance-level approvals
    p(M.REPORTS_PAYROLL, A.VIEW, S.ORG),
    p(M.REPORTS_PAYROLL, A.EXPORT, S.ORG),
    p(M.HELPDESK_PAYROLL, A.RESOLVE, S.ORG),
  ]),

  [R.MANAGER]: Object.freeze([
    ...SELF_BASELINE,
    p(M.EMPLOYEES, A.VIEW, S.TEAM),
    p(M.ORG_STRUCTURE, A.VIEW, S.ORG), // org chart / reporting lines
    p(M.ATTENDANCE, A.VIEW, S.TEAM),
    p(M.ATTENDANCE, A.APPROVE, S.TEAM),
    p(M.LEAVE, A.VIEW, S.TEAM),
    p(M.LEAVE, A.APPROVE, S.TEAM),
    p(M.EXPENSES, A.VIEW, S.TEAM),
    p(M.EXPENSES, A.APPROVE, S.TEAM),
    p(M.PERFORMANCE, A.VIEW, S.TEAM),
    p(M.PERFORMANCE, A.APPROVE, S.TEAM),
    p(M.ONBOARDING, A.VIEW, S.TEAM),
    p(M.EXITS, A.APPROVE, S.TEAM),
    p(M.HIRING, A.VIEW, S.TEAM), // interviewer view
    p(M.REPORTS_TEAM, A.VIEW, S.TEAM),
  ]),

  [R.EMPLOYEE]: Object.freeze([...SELF_BASELINE]),

  [R.RECRUITER]: Object.freeze([
    ...SELF_BASELINE,
    p(M.HIRING, A.VIEW, S.ORG),
    p(M.HIRING, A.EDIT, S.ORG),
    p(M.REPORTS_HIRING, A.VIEW, S.ORG),
    p(M.PAYROLL, A.APPROVE, S.ORG), // advance-salary decisions
    // Recruiter maintains employee profiles (personal details, job details,
    // probation confirmation). Compensation stays with HR / payroll admin.
    p(M.EMPLOYEES, A.VIEW, S.ORG),
    p(M.EMPLOYEES, A.EDIT, S.ORG),
    // Attendance visibility for onboarding follow-ups and contract queries.
    // Approve is granted alongside HR and super_admin so any of the three can
    // clear the correction queue.
    p(M.ATTENDANCE, A.VIEW, S.ORG),
    p(M.ATTENDANCE, A.APPROVE, S.ORG),
  ]),

  [R.IT_ADMIN]: Object.freeze([
    ...SELF_BASELINE,
    p(M.ASSETS, A.VIEW, S.ORG),
    p(M.ASSETS, A.ASSIGN, S.ORG),
    p(M.HELPDESK, A.VIEW, S.ORG),
    p(M.HELPDESK_IT, A.RESOLVE, S.ORG),
    p(M.EXITS, A.VIEW, S.ORG), // needed for the asset-clearance step
    p(M.REPORTS_ASSETS, A.VIEW, S.ORG),
  ]),

  // Read-only oversight. Deliberately NOT given SELF_BASELINE: an auditor is a
  // reviewing role, not an employee self-service one. If a person needs both,
  // they hold `hrms_auditor` and `hrms_employee` together (AD-3 multi-role).
  [R.AUDITOR]: Object.freeze([
    p(M.DASHBOARD, A.VIEW, S.SELF),
    p(M.INBOX, A.VIEW, S.SELF),
    p(M.EMPLOYEES, A.VIEW, S.ORG),
    p(M.ATTENDANCE, A.VIEW, S.ORG),
    p(M.LEAVE, A.VIEW, S.ORG),
    p(M.PAYROLL, A.VIEW, S.ORG),
    p(M.EXPENSES, A.VIEW, S.ORG),
    p(M.PERFORMANCE, A.VIEW, S.ORG),
    p(M.HIRING, A.VIEW, S.ORG),
    p(M.ASSETS, A.VIEW, S.ORG),
    p(M.REPORTS, A.VIEW, S.ORG),
    p(M.AUDIT_LOGS, A.VIEW, S.ORG),
  ]),
});

/** Permissions for a set of HRMS role keys. Unknown keys contribute nothing. */
export function permissionsForHrmsRoles(roleKeys = []) {
  const out = [];
  const seen = new Set();
  for (const key of roleKeys) {
    const grants = HRMS_PERMISSION_MATRIX[key];
    if (!grants) continue;
    for (const g of grants) {
      const id = `${g.module}|${g.action}|${g.scope}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(g);
    }
  }
  return out;
}

/** The distinct module keys granted by a set of roles. Drives the nav filter. */
export function modulesForHrmsRoles(roleKeys = []) {
  return [...new Set(permissionsForHrmsRoles(roleKeys).map((g) => g.module))];
}

export { SELF_BASELINE };
