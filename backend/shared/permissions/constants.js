/**
 * HRMS authorization primitives: module x action x scope.
 *
 * Ported from the DTA HRMS reference (`packages/rbac/src/types.ts`), with two
 * deliberate reductions recorded in documentation/architecture-decisions.md:
 *
 *   AD-5  `operations` and `projects` are out of scope, so their module keys and
 *         the `project_manager` role are absent. 33 modules -> 31, 9 roles -> 8.
 *   AD-1  Single tenant, so there is no organisation dimension. `org` scope means
 *         "the whole company".
 *
 * One module key has been ADDED since: `academy` (SI Academy, internal
 * learning), taking the count to 32. It is additive in the strict sense - no
 * existing key, action, scope or role grant changed - which is what makes it
 * safe to land in a file both portals must hold byte-identical.
 *
 * SHARED-CONTRACT.md §2 is worth re-reading before touching this file again.
 * The failure it warns about is a key being REMOVED, because `Role.grants` is
 * recompiled from config/moduleRegistry.js on every role save. Nothing in THIS
 * file is ever written back to the `roles` collection, and the registry's
 * `hrms` block is grant-only (`path: null`) because HRMS draws its own menu -
 * so the Customer Portal needs no matching behaviour to keep working; it simply
 * never evaluates the key. It carries the same bytes regardless, because
 * identical-or-drifted is the only state the verifier can check.
 *
 * This file is dependency-free on purpose (see ../README.md).
 */

/** Every HRMS module key. Sub-modules use `parent:child`. */
export const HRMS_MODULES = Object.freeze({
  EMPLOYEES: 'employees',
  EMPLOYEES_COMPENSATION: 'employees:compensation',
  ORG_STRUCTURE: 'org-structure',
  ONBOARDING: 'onboarding',
  EXITS: 'exits',
  ATTENDANCE: 'attendance',
  LEAVE: 'leave',
  PAYROLL: 'payroll',
  PAYROLL_STRUCTURE: 'payroll:structure',
  EXPENSES: 'expenses',
  DOCUMENTS: 'documents',
  ENGAGE: 'engage',
  PERFORMANCE: 'performance',
  /**
   * SI Academy - internal learning: paths, courses, lessons, assessments and
   * certificates.
   *
   * Beside PERFORMANCE rather than under ONBOARDING because the module outlives
   * onboarding: a compliance refresher reassigned every year to existing staff
   * is the same machinery. Nesting it would also have made
   * `onboarding:view:self` - which every employee already holds - the grant
   * that silently opens a whole second module.
   */
  ACADEMY: 'academy',
  HIRING: 'hiring',
  ASSETS: 'assets',
  HELPDESK: 'helpdesk',
  HELPDESK_HR: 'helpdesk:hr',
  HELPDESK_PAYROLL: 'helpdesk:payroll',
  HELPDESK_IT: 'helpdesk:it',
  REPORTS: 'reports',
  REPORTS_PAYROLL: 'reports:payroll',
  REPORTS_TEAM: 'reports:team',
  REPORTS_HIRING: 'reports:hiring',
  REPORTS_ASSETS: 'reports:assets',
  SETTINGS: 'settings',
  SETTINGS_INTEGRATIONS: 'settings:integrations',
  AUDIT_LOGS: 'audit-logs',
  DASHBOARD: 'dashboard',
  INBOX: 'inbox',
  PLANNING: 'planning',
});

export const HRMS_MODULE_LIST = Object.freeze(Object.values(HRMS_MODULES));

/** Every HRMS action verb. */
export const HRMS_ACTIONS = Object.freeze({
  VIEW: 'view',
  CREATE: 'create',
  EDIT: 'edit',
  DELETE: 'delete',
  APPROVE: 'approve',
  RUN: 'run',
  SUBMIT: 'submit',
  ASSIGN: 'assign',
  RESOLVE: 'resolve',
  EXPORT: 'export',
});

export const HRMS_ACTION_LIST = Object.freeze(Object.values(HRMS_ACTIONS));

/**
 * Scope narrows a permission to a slice of the company.
 *   self       - only the actor's own records
 *   team       - the actor's direct and indirect reports (walks managerChain)
 *   department - the actor's own department
 *   org        - the whole company
 */
export const SCOPES = Object.freeze({
  SELF: 'self',
  TEAM: 'team',
  DEPARTMENT: 'department',
  ORG: 'org',
});

export const SCOPE_LIST = Object.freeze(Object.values(SCOPES));

/**
 * Scope precedence. A wider granted scope satisfies a narrower requirement, so
 * `leave/approve/org` also passes a check that only needs `leave/approve/team`.
 */
export const SCOPE_RANK = Object.freeze({
  [SCOPES.SELF]: 0,
  [SCOPES.TEAM]: 1,
  [SCOPES.DEPARTMENT]: 2,
  [SCOPES.ORG]: 3,
});

/**
 * The eight HRMS roles.
 *
 * These are NOT the portal's roles (Admin, Sales, Inventory Manager, Warehouse
 * User, Management, Customer) - those live in `legacy.js` and are a separate
 * axis. Per AD-3 a User may hold both; per AD-4 a Customer may hold none of the
 * roles below.
 */
export const HRMS_ROLES = Object.freeze({
  SUPER_ADMIN: 'hrms_super_admin',
  HR_ADMIN: 'hrms_hr_admin',
  PAYROLL_ADMIN: 'hrms_payroll_admin',
  RECRUITER: 'hrms_recruiter',
  MANAGER: 'hrms_manager',
  EMPLOYEE: 'hrms_employee',
  IT_ADMIN: 'hrms_it_admin',
  AUDITOR: 'hrms_auditor',
});

export const HRMS_ROLE_LIST = Object.freeze(Object.values(HRMS_ROLES));

export const HRMS_ROLE_LABELS = Object.freeze({
  [HRMS_ROLES.SUPER_ADMIN]: 'HRMS Super Admin',
  [HRMS_ROLES.HR_ADMIN]: 'HR Admin',
  [HRMS_ROLES.PAYROLL_ADMIN]: 'Payroll Admin',
  [HRMS_ROLES.RECRUITER]: 'Recruiter',
  [HRMS_ROLES.MANAGER]: 'Reporting Manager',
  [HRMS_ROLES.EMPLOYEE]: 'Employee',
  [HRMS_ROLES.IT_ADMIN]: 'IT / Asset Admin',
  [HRMS_ROLES.AUDITOR]: 'Auditor (read-only)',
});

/**
 * ---------------------------------------------------------------------------
 * SALARY IS SUPER-ADMIN ONLY
 * ---------------------------------------------------------------------------
 * Modules in this set resolve for a PORTAL Super Admin and for nobody else,
 * whatever the matrix, a custom role or an explicit `User.roles[]` entry says.
 *
 * `employees:compensation` is the one gate every salary figure in the HRMS
 * already sits behind - a CTC and its revision history, somebody else's
 * payslip (payroll/payslip.service.js `seesEveryone`), an F&F settlement
 * amount (exits/exit.service.js) and the plaintext reveal of bank account and
 * PAN in Employee Master. Narrowing that one key therefore narrows all of
 * them at once, which is what "across all relevant modules" has to mean if it
 * is to be true rather than merely repeated in five places.
 *
 * WHY A CEILING AND NOT JUST A SMALLER MATRIX. Three routes reach the grant
 * and only one of them is the matrix:
 *
 *   1. `HRMS_PERMISSION_MATRIX` - now grants it to `hrms_super_admin` alone.
 *   2. `utils/hrmsAccessBridge.js` - maps the portal's `administer_hrms` to
 *      EVERY hrms role key, so the HR role (which is not a portal Super Admin)
 *      comes away holding `hrms_super_admin` and, through it, the matrix grant.
 *   3. `modules/hrms/rbac/customRole.middleware.js` - REPLACES the actor's
 *      permissions with database rows every request, so an administrator who
 *      ticks the compensation cell for any role re-grants it.
 *
 * A smaller matrix closes the first and neither of the others. The ceiling is
 * applied at both points where `actor.permissions` is finally set, so all
 * three routes end at the same answer. It is modelled on PORTAL_ONLY_ROLES in
 * config/permissions.js, for the same reason: a fence that a database row can
 * reopen is not a fence.
 */
export const SUPER_ADMIN_ONLY_MODULES = Object.freeze([
  HRMS_MODULES.EMPLOYEES_COMPENSATION,
]);

export const isSuperAdminOnlyModule = (module) =>
  SUPER_ADMIN_ONLY_MODULES.includes(module);

/**
 * Drop the Super-Admin-only grants unless the caller IS a portal Super Admin.
 *
 * Takes and returns the `{module, action, scope}` list, so it can sit at the
 * end of every path that builds one. Returns the array unchanged (same
 * reference) when nothing is removed, which keeps the common case free.
 *
 * @param {Array<{module:string,action:string,scope:string}>} permissions
 * @param {boolean} portalSuperAdmin
 */
export const fenceSuperAdminOnly = (permissions, portalSuperAdmin) => {
  if (portalSuperAdmin) return permissions;
  if (!Array.isArray(permissions) || permissions.length === 0) return permissions;
  const kept = permissions.filter((g) => !isSuperAdminOnlyModule(g?.module));
  return kept.length === permissions.length ? permissions : kept;
};

/**
 * Role keys carry an `hrms_` prefix so they can never collide with a portal role
 * inside the single `User.roles[]` array (AD-3). It also makes the invariant in
 * AD-4 trivially checkable: an HRMS role is any key matching this test.
 */
export const isHrmsRoleKey = (key) =>
  typeof key === 'string' && key.startsWith('hrms_');

/** Convenience for building a permission tuple. */
export const permission = (module, action, scope) => ({ module, action, scope });

export const isValidModule = (m) => HRMS_MODULE_LIST.includes(m);
export const isValidAction = (a) => HRMS_ACTION_LIST.includes(a);
export const isValidScope = (s) => SCOPE_LIST.includes(s);
