/**
 * The dashboard's Quick Access catalogue, and its bounds.
 *
 * Declared ONCE and shared, because both halves need it: the server filters it
 * by permission and returns what this actor may do, and the browser maps each
 * `icon` name onto a real component. A second copy on the client is how a
 * dashboard ends up offering a button the API refuses.
 *
 * Dependency-free and environment-free — bundled into the browser as well as
 * run in Node (`shared/README.md` rule 1).
 *
 * ---------------------------------------------------------------------------
 * Every entry points at a route that exists
 * ---------------------------------------------------------------------------
 * The reference hardcodes hrefs like `/payroll/payslips` and `/leave` inside
 * its `buildQuickAccess`. Those are its route shapes; the paths below are this
 * application's, and each was checked against `routes/index.jsx`. A tile that
 * navigates nowhere is worse than no tile.
 */

import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../permissions/constants.js';

/**
 * `requires` is ANY-OF, matching `requirePermission` on the routes. An entry
 * with an empty `requires` is offered to everybody who can open the dashboard.
 *
 * `icon` is a name the client resolves to a lucide component; keeping it a
 * string is what lets this file stay free of any UI dependency.
 */
export const QUICK_ACCESS_CATALOGUE = Object.freeze([
  // --- Everyone -----------------------------------------------------------
  {
    key: 'clock',
    label: 'Clock In / Out',
    icon: 'Clock',
    path: '/attendance/me',
    tone: 'primary',
    requires: [{ module: M.ATTENDANCE, action: A.SUBMIT, scope: S.SELF }],
  },
  {
    key: 'applyLeave',
    label: 'Apply for Leave',
    icon: 'CalendarDays',
    path: '/leave/me',
    tone: 'success',
    requires: [{ module: M.LEAVE, action: A.SUBMIT, scope: S.SELF }],
  },
  {
    key: 'myPayslip',
    label: 'My Payslip',
    icon: 'ReceiptIndianRupee',
    path: '/payroll/payslips',
    tone: 'warning',
    requires: [{ module: M.PAYROLL, action: A.VIEW, scope: S.SELF }],
  },
  {
    key: 'submitExpense',
    label: 'Submit Expense',
    icon: 'Wallet',
    path: '/expenses/claims',
    tone: 'primary',
    requires: [{ module: M.EXPENSES, action: A.SUBMIT, scope: S.SELF }],
  },
  {
    key: 'raiseTicket',
    label: 'Raise Ticket',
    icon: 'LifeBuoy',
    path: '/helpdesk/my-tickets',
    tone: 'danger',
    requires: [{ module: M.HELPDESK, action: A.SUBMIT, scope: S.SELF }],
  },
  {
    key: 'myDocuments',
    label: 'My Documents',
    icon: 'FileText',
    path: '/documents/mine',
    tone: 'neutral',
    requires: [{ module: M.DOCUMENTS, action: A.VIEW, scope: S.SELF }],
  },

  // --- Manager ------------------------------------------------------------
  {
    key: 'approvals',
    label: 'Team Approvals',
    icon: 'CheckSquare',
    path: '/leave/approvals',
    tone: 'primary',
    requires: [{ module: M.LEAVE, action: A.APPROVE, scope: S.TEAM }],
  },
  {
    key: 'myTeam',
    label: 'My Team',
    icon: 'Users',
    path: '/attendance/team',
    tone: 'primary',
    requires: [{ module: M.ATTENDANCE, action: A.VIEW, scope: S.TEAM }],
  },

  // --- HR and administration ---------------------------------------------
  {
    key: 'addEmployee',
    label: 'Add Employee',
    icon: 'UserPlus',
    path: '/employees',
    tone: 'success',
    requires: [{ module: M.EMPLOYEES, action: A.CREATE, scope: S.ORG }],
  },
  {
    key: 'newAnnouncement',
    label: 'New Announcement',
    icon: 'Megaphone',
    path: '/engage/announcements',
    tone: 'warning',
    requires: [{ module: M.ENGAGE, action: A.EDIT, scope: S.ORG }],
  },
  {
    key: 'newPoll',
    label: 'New Poll',
    icon: 'BarChart3',
    path: '/engage/polls',
    tone: 'primary',
    requires: [{ module: M.ENGAGE, action: A.EDIT, scope: S.ORG }],
  },
  {
    key: 'newRequisition',
    label: 'New Requisition',
    icon: 'FileSearch',
    path: '/hiring/requisitions',
    tone: 'primary',
    requires: [{ module: M.HIRING, action: A.EDIT, scope: S.ORG }],
  },
  {
    key: 'runPayroll',
    label: 'Run Payroll',
    icon: 'Banknote',
    path: '/payroll/runs',
    tone: 'warning',
    requires: [{ module: M.PAYROLL, action: A.RUN, scope: S.ORG }],
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'Settings',
    path: '/settings',
    tone: 'neutral',
    requires: [{ module: M.SETTINGS, action: A.EDIT, scope: S.ORG }],
  },
]);

/** How far ahead the celebrations widget looks. The reference's own fortnight. */
export const CELEBRATION_WINDOW_DAYS = 14;

/** The ceiling on any dashboard list. A home page is a summary, not a report. */
export const DASHBOARD_LIST_LIMIT = 10;

/** The login chart's windows — the reference's 7d / 14d / 30d. */
export const LOGIN_TREND_RANGES = Object.freeze({ '7d': 7, '14d': 14, '30d': 30 });

export const LOGIN_TREND_RANGE_LIST = Object.freeze(Object.keys(LOGIN_TREND_RANGES));

export default {
  QUICK_ACCESS_CATALOGUE,
  CELEBRATION_WINDOW_DAYS,
  DASHBOARD_LIST_LIMIT,
  LOGIN_TREND_RANGES,
  LOGIN_TREND_RANGE_LIST,
};
