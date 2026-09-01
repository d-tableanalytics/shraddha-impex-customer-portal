import {
  LayoutDashboard,
  Inbox,
  UserCircle,
  Clock,
  CalendarDays,
  CreditCard,
  Wallet,
  LineChart,
  FileText,
  Megaphone,
  LifeBuoy,
  Users,
  Network,
  UserPlus,
  LogOut,
  Laptop,
  Briefcase,
  BarChart3,
  ScrollText,
  Settings,
} from "lucide-react";

import { HRMS_MODULES as M, HRMS_ACTIONS as A, SCOPES as S } from "@shared/permissions/constants.js";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";

/**
 * The HRMS navigation.
 *
 * Structure and grouping are taken from the DTA reference's `nav-items.ts`,
 * which orders the modules as Core / My Work / People & Org / Admin. That
 * grouping is functional, not decorative: it separates "things I do for myself"
 * from "things I do to other people's records", which is the same line the
 * permission scopes draw.
 *
 * Two modules from the reference are absent by decision, not oversight:
 * Operations and Projects & Timesheets are out of scope (AD-5).
 *
 * ---------------------------------------------------------------------------
 * `requires` and `module` answer two different questions
 * ---------------------------------------------------------------------------
 *   requires  - MAY this person use it?  evaluated against the canonical
 *               permission matrix, never a role name
 *   module    - DOES it exist yet?       checked against the implemented list
 *               the backend reports at /hrms/status
 *
 * Both must pass for an item to render. Showing a link to an unbuilt page is
 * how a nav fills up with dead ends; hiding a built page from someone entitled
 * to it is a bug. Keeping the questions separate makes each answerable.
 *
 * The full list lives here from the start so that shipping a module is a
 * one-line change to the backend's IMPLEMENTED_HRMS_MODULES, rather than an
 * edit in two places that can disagree.
 */

const req = (module, action, scope) => ({ module, action, scope });

export const HRMS_NAV_GROUPS = Object.freeze({
  CORE: "core",
  MY_WORK: "my-work",
  PEOPLE_ORG: "people-org",
  ADMIN: "admin",
});

export const HRMS_NAV_GROUP_LABELS = Object.freeze({
  [HRMS_NAV_GROUPS.CORE]: "HRMS",
  [HRMS_NAV_GROUPS.MY_WORK]: "My Work",
  [HRMS_NAV_GROUPS.PEOPLE_ORG]: "People & Org",
  [HRMS_NAV_GROUPS.ADMIN]: "HRMS Admin",
});

export const HRMS_NAV_GROUP_ORDER = Object.freeze([
  HRMS_NAV_GROUPS.CORE,
  HRMS_NAV_GROUPS.MY_WORK,
  HRMS_NAV_GROUPS.PEOPLE_ORG,
  HRMS_NAV_GROUPS.ADMIN,
]);

const p = (path) => `${HRMS_ROUTE_PREFIX}${path}`;

export const HRMS_NAV_ITEMS = Object.freeze([
  // ---- Core -------------------------------------------------------------
  {
    key: "hrms-dashboard",
    label: "HR Dashboard",
    path: p("/dashboard"),
    icon: LayoutDashboard,
    group: HRMS_NAV_GROUPS.CORE,
    module: M.DASHBOARD,
    requires: [req(M.DASHBOARD, A.VIEW, S.SELF)],
  },
  {
    key: "hrms-inbox",
    label: "Inbox",
    path: p("/inbox"),
    icon: Inbox,
    group: HRMS_NAV_GROUPS.CORE,
    module: M.INBOX,
    requires: [req(M.INBOX, A.VIEW, S.SELF)],
  },
  {
    key: "hrms-me",
    label: "My Profile",
    path: p("/me"),
    icon: UserCircle,
    group: HRMS_NAV_GROUPS.CORE,
    module: M.EMPLOYEES,
    requires: [req(M.EMPLOYEES, A.VIEW, S.SELF)],
  },

  // ---- My Work ----------------------------------------------------------
  {
    key: "hrms-attendance",
    label: "Attendance",
    path: p("/attendance"),
    icon: Clock,
    group: HRMS_NAV_GROUPS.MY_WORK,
    module: M.ATTENDANCE,
    requires: [req(M.ATTENDANCE, A.VIEW, S.SELF)],
  },
  {
    key: "hrms-leave",
    label: "Leave",
    path: p("/leave"),
    icon: CalendarDays,
    group: HRMS_NAV_GROUPS.MY_WORK,
    module: M.LEAVE,
    requires: [req(M.LEAVE, A.VIEW, S.SELF)],
  },
  {
    key: "hrms-payroll",
    label: "Payroll",
    path: p("/payroll"),
    icon: CreditCard,
    group: HRMS_NAV_GROUPS.MY_WORK,
    module: M.PAYROLL,
    requires: [req(M.PAYROLL, A.VIEW, S.SELF)],
  },
  {
    key: "hrms-expenses",
    label: "Expenses",
    path: p("/expenses"),
    icon: Wallet,
    group: HRMS_NAV_GROUPS.MY_WORK,
    module: M.EXPENSES,
    requires: [req(M.EXPENSES, A.VIEW, S.SELF)],
  },
  {
    key: "hrms-performance",
    label: "Performance",
    path: p("/performance"),
    icon: LineChart,
    group: HRMS_NAV_GROUPS.MY_WORK,
    module: M.PERFORMANCE,
    requires: [req(M.PERFORMANCE, A.VIEW, S.SELF)],
  },
  {
    key: "hrms-documents",
    label: "Documents",
    path: p("/documents"),
    icon: FileText,
    group: HRMS_NAV_GROUPS.MY_WORK,
    module: M.DOCUMENTS,
    requires: [req(M.DOCUMENTS, A.VIEW, S.SELF)],
  },
  {
    key: "hrms-engage",
    label: "Engage",
    path: p("/engage"),
    icon: Megaphone,
    group: HRMS_NAV_GROUPS.MY_WORK,
    module: M.ENGAGE,
    requires: [req(M.ENGAGE, A.VIEW, S.SELF)],
  },
  {
    key: "hrms-helpdesk",
    label: "Helpdesk",
    path: p("/helpdesk"),
    icon: LifeBuoy,
    group: HRMS_NAV_GROUPS.MY_WORK,
    module: M.HELPDESK,
    requires: [req(M.HELPDESK, A.VIEW, S.SELF)],
  },

  // ---- People & Org -----------------------------------------------------
  {
    key: "hrms-employees",
    label: "Employees",
    path: p("/employees"),
    icon: Users,
    group: HRMS_NAV_GROUPS.PEOPLE_ORG,
    module: M.EMPLOYEES,
    requires: [req(M.EMPLOYEES, A.VIEW, S.TEAM)],
  },
  {
    key: "hrms-org",
    label: "Org Structure",
    path: p("/org"),
    icon: Network,
    group: HRMS_NAV_GROUPS.PEOPLE_ORG,
    module: M.ORG_STRUCTURE,
    requires: [req(M.ORG_STRUCTURE, A.VIEW, S.ORG)],
  },
  {
    key: "hrms-onboarding",
    label: "Onboarding",
    path: p("/onboarding"),
    icon: UserPlus,
    group: HRMS_NAV_GROUPS.PEOPLE_ORG,
    module: M.ONBOARDING,
    requires: [req(M.ONBOARDING, A.VIEW, S.TEAM)],
  },
  {
    key: "hrms-exits",
    label: "Exits",
    path: p("/exits"),
    icon: LogOut,
    group: HRMS_NAV_GROUPS.PEOPLE_ORG,
    module: M.EXITS,
    // Three ways in, matching the reference: a manager approves, HR edits, and
    // IT sees them for asset clearance.
    requires: [
      req(M.EXITS, A.VIEW, S.TEAM),
      req(M.EXITS, A.APPROVE, S.TEAM),
      req(M.EXITS, A.EDIT, S.ORG),
    ],
  },
  {
    key: "hrms-assets",
    label: "Assets",
    path: p("/assets"),
    icon: Laptop,
    group: HRMS_NAV_GROUPS.PEOPLE_ORG,
    module: M.ASSETS,
    requires: [req(M.ASSETS, A.VIEW, S.ORG)],
  },
  {
    key: "hrms-hiring",
    label: "Hiring",
    path: p("/hiring"),
    icon: Briefcase,
    group: HRMS_NAV_GROUPS.PEOPLE_ORG,
    module: M.HIRING,
    requires: [req(M.HIRING, A.VIEW, S.TEAM)],
  },
  {
    key: "hrms-planning",
    label: "Planning",
    path: p("/planning"),
    icon: BarChart3,
    group: HRMS_NAV_GROUPS.PEOPLE_ORG,
    module: M.PLANNING,
    requires: [req(M.PLANNING, A.VIEW, S.ORG)],
  },

  // ---- Admin ------------------------------------------------------------
  {
    key: "hrms-reports",
    label: "HR Reports",
    path: p("/reports"),
    icon: BarChart3,
    group: HRMS_NAV_GROUPS.ADMIN,
    module: M.REPORTS,
    // Role-specific report sub-modules also grant entry, matching the
    // reference: a recruiter who sees the nav item must not be bounced when
    // they click it.
    requires: [
      req(M.REPORTS, A.VIEW, S.ORG),
      req(M.REPORTS_PAYROLL, A.VIEW, S.ORG),
      req(M.REPORTS_HIRING, A.VIEW, S.ORG),
      req(M.REPORTS_ASSETS, A.VIEW, S.ORG),
      req(M.REPORTS_TEAM, A.VIEW, S.TEAM),
    ],
  },
  {
    key: "hrms-audit",
    label: "HR Audit Logs",
    path: p("/audit-logs"),
    icon: ScrollText,
    group: HRMS_NAV_GROUPS.ADMIN,
    module: M.AUDIT_LOGS,
    requires: [req(M.AUDIT_LOGS, A.VIEW, S.ORG)],
  },
  {
    key: "hrms-settings",
    label: "HR Settings",
    path: p("/settings"),
    icon: Settings,
    group: HRMS_NAV_GROUPS.ADMIN,
    module: M.SETTINGS,
    requires: [req(M.SETTINGS, A.VIEW, S.ORG)],
  },
]);

/**
 * The nav items this actor should actually see.
 *
 * @param {Function} can                 from useHrmsPermissions
 * @param {string[]} implementedModules  from /hrms/status
 */
export function visibleHrmsNavItems(can, implementedModules = []) {
  return HRMS_NAV_ITEMS.filter(
    (item) =>
      implementedModules.includes(item.module) &&
      item.requires.some((r) => can(r.module, r.action, r.scope)),
  );
}

/** Group the visible items for rendering, dropping groups that end up empty. */
export function groupHrmsNavItems(items) {
  return HRMS_NAV_GROUP_ORDER.map((group) => ({
    group,
    label: HRMS_NAV_GROUP_LABELS[group],
    items: items.filter((i) => i.group === group),
  })).filter((g) => g.items.length > 0);
}

/**
 * Modules the actor is entitled to but which are not built yet.
 *
 * The dashboard lists these so a user can see what is coming without a nav full
 * of links to nothing.
 */
export function plannedHrmsNavItems(can, implementedModules = []) {
  return HRMS_NAV_ITEMS.filter(
    (item) =>
      !implementedModules.includes(item.module) &&
      item.requires.some((r) => can(r.module, r.action, r.scope)),
  );
}
