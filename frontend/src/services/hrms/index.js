/**
 * HRMS API services.
 *
 * One module per domain, each a thin wrapper over `hrmsClient`. Screens call
 * these, never axios directly, so an endpoint change lands in one place.
 *
 * Phase 1 covers only what the foundation itself needs. A service is added in
 * the same commit as the module it serves - not in advance.
 */

export { hrmsClient, HrmsApiError } from "./client";
export { hrmsMeApi, hrmsStatusApi } from "./meta";
export { companyApi } from "./company";
export { retentionApi } from "./retention";
export { employeesApi, employeeCustomFieldsApi } from "./employees";
export {
  departmentsApi,
  locationsApi,
  orgChartApi,
  orgOptionLabel,
  optionsWithCurrent,
} from "./org";
export { leaveApi, holidaysApi, formatDay, formatDays } from "./leave";
export {
  attendanceApi,
  attendanceConsentApi,
  attendanceCorrectionsApi,
  uploadSelfie,
} from "./attendance";
export {
  expensesApi,
  uploadReceipt,
  formatMoney,
  formatInstant,
  todayIso,
  CLAIM_STATUS_LABELS,
} from "./expenses";
export {
  exitsApi,
  EXIT_STEPS,
  EXIT_STATUS_LABELS,
  CLEARANCE_STATUS_LABELS,
  CLEARANCE_AREA_LABELS,
  EXIT_REASON_LABELS,
} from "./exits";
export {
  assetsApi,
  ASSET_STATUS_LABELS,
  SETTABLE_ASSET_STATUSES,
  ASSET_REQUEST_STATUS_LABELS,
} from "./assets";
export {
  documentsApi,
  uploadDocument,
  formatFileSize,
  ACCEPTED_DOCUMENT_TYPES,
  FOLDER_VISIBILITY_LABELS,
} from "./documents";
export {
  helpdeskApi,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
  RESOLVER_TEAM_LABELS,
  formatSla,
} from "./helpdesk";
/**
 * Payroll.
 *
 * The APIs only. Payroll's own `formatMoney` and `formatPeriod` are NOT
 * re-exported here — Expenses already exports a `formatMoney` from this
 * barrel, and two same-named exports would collide. Payroll screens import
 * their formatters from `./payroll` directly.
 */
export {
  payGroupsApi,
  salaryComponentsApi,
  salaryStructuresApi,
  statutoryApi,
  compensationApi,
  payrollRunsApi,
  payslipsApi,
} from "./payroll";
/**
 * Hiring.
 *
 * The APIs only. Hiring's `formatCtc` and its display-tone tables are NOT
 * re-exported here — Expenses already exports a money formatter from this
 * barrel, and hiring screens import their own from `./hiring` directly, the
 * way Payroll's do.
 */
export {
  requisitionsApi,
  postingsApi,
  candidatesApi,
  applicationsApi,
  interviewsApi,
  offersApi,
  jdApi,
  uploadResume,
} from "./hiring";
/**
 * Onboarding.
 *
 * The APIs only. Its `formatDay`, `formatInstant` and money formatter are NOT
 * re-exported here — Leave already exports a `formatDay` and Expenses a
 * `formatInstant` from this barrel, and two same-named exports would collide.
 * Onboarding screens import their formatters from `./onboarding` directly, the
 * way Payroll's and Hiring's do.
 */
export {
  onboardingTemplatesApi,
  onboardingChecklistsApi,
  onboardingTasksApi,
  offerLettersApi,
} from "./onboarding";
/**
 * Performance.
 *
 * The APIs only. Its formatters are NOT re-exported here — Leave already
 * exports a `formatDay` and Expenses a `formatInstant` from this barrel, and
 * two same-named exports would collide. Performance screens import theirs from
 * `./performance` directly, the way Payroll's, Hiring's and Onboarding's do.
 */
export { goalsApi, cyclesApi, reviewsApi, feedbackApi, oneOnOnesApi } from "./performance";
/**
 * Engage.
 *
 * The APIs only. Its formatters are NOT re-exported here — Leave already
 * exports a `formatDay` and Expenses a `formatInstant` from this barrel, and
 * two same-named exports would collide. Engage screens import theirs from
 * `./engage` directly, as Payroll's, Hiring's, Onboarding's and Performance's
 * do.
 */
export { announcementsApi, pollsApi, recognitionApi, enpsApi } from "./engage";
/**
 * Planning.
 *
 * The APIs only. Its formatters are NOT re-exported here — Leave already
 * exports a `formatDay` and Expenses a `formatInstant` from this barrel, and
 * two same-named exports would collide. Planning screens import theirs from
 * `./planning` directly, as Payroll's, Hiring's, Onboarding's, Performance's
 * and Engage's do.
 */
export { headcountPlansApi, hiringPlansApi } from "./planning";

/**
 * Reports.
 *
 * `REPORT_FILTERS`, `monthRange` and the cell formatter stay on `./reports` —
 * they are screen concerns, and the barrel is for the API surface.
 */
export { reportsApi, downloadCsv } from "./reports";

/**
 * Settings and the audit trail.
 *
 * The labels and `formatAuditAction` stay on `./settings` — they are screen
 * concerns, and the barrel is for the API surface.
 */
export { settingsApi, auditApi } from "./settings";
/**
 * Inbox.
 *
 * The API only. Its `formatInboxTime` is NOT re-exported here — Leave already
 * exports a `formatDay` and Expenses a `formatInstant` from this barrel, and
 * two same-named exports would collide. Inbox screens import theirs from
 * `./inbox` directly, as every module since Payroll has.
 */
export { inboxApi } from "./inbox";
/**
 * Dashboard.
 *
 * The API only. Its formatters are NOT re-exported here — Leave already exports
 * a `formatDay` and Expenses a `formatInstant` from this barrel, and two
 * same-named exports would collide. Dashboard screens import theirs from
 * `./dashboard` directly, as every module since Payroll has.
 */
export { dashboardApi } from "./dashboard";
