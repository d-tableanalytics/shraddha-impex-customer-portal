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
