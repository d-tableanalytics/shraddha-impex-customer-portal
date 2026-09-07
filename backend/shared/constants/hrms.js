/**
 * HRMS constants shared by both halves of the application.
 *
 * Phase 0 scope only: values the foundation actually uses (retention, audit,
 * storage, consent, and the employee enums the canonical import record needs).
 * Module-specific enums arrive with their modules.
 *
 * Dependency-free.
 */

/** URL prefix for every HRMS API route (AD-14). */
export const HRMS_API_PREFIX = '/api/v1/hrms';

/** URL prefix for every HRMS screen in the SPA (AD-14). */
export const HRMS_ROUTE_PREFIX = '/hrms';

// ---------------------------------------------------------------------------
// Employee enums - needed by the canonical import record (AD-11)
// ---------------------------------------------------------------------------

export const EMPLOYMENT_TYPES = Object.freeze([
  'full_time',
  'part_time',
  'contract',
  'intern',
  'consultant',
]);

export const EMPLOYEE_STATUSES = Object.freeze([
  'invited',
  'active',
  'probation',
  'notice',
  'exited',
  'suspended',
  // Terminal post-exit state, set once offboarding is complete. Cascades to
  // User.status = 'suspended' so the account can no longer sign in.
  'inactive',
]);

/**
 * Employee document upload categories.
 *
 * `personal` slots hold one active document each; `prev_employment` slots may
 * hold several per company, grouped by label.
 */
export const EMPLOYEE_UPLOAD_CATEGORIES = Object.freeze([
  // personal
  'photo',
  'aadhar',
  'pan',
  'marksheet_10',
  'marksheet_12',
  'marksheet_grad',
  'bank_statement',
  // previous employment
  'offer_letter',
  'joining_letter',
  'experience_letter',
  'leaving_certificate',
  'salary_slip',
]);

// ---------------------------------------------------------------------------
// Storage (AD-7)
// ---------------------------------------------------------------------------

/**
 * Logical buckets for stored objects. The key prefix and the retention category
 * both derive from this, so a new category cannot be added in one place and
 * forgotten in the other.
 */
export const STORAGE_CATEGORIES = Object.freeze({
  ATTENDANCE_SELFIE: 'attendance-selfie',
  EMPLOYEE_DOCUMENT: 'employee-document',
  EXPENSE_RECEIPT: 'expense-receipt',
  CANDIDATE_RESUME: 'candidate-resume',
  PAYSLIP: 'payslip',
  FORM16: 'form16',
  LETTER: 'letter',
  OFFER_LETTER: 'offer-letter',
  BANK_FILE: 'bank-file',
  COMPANY_ASSET: 'company-asset',
  AUDIT_ARCHIVE: 'audit-archive',
});

export const STORAGE_CATEGORY_LIST = Object.freeze(Object.values(STORAGE_CATEGORIES));

/** S3 key prefix per category. */
export const STORAGE_PREFIXES = Object.freeze({
  [STORAGE_CATEGORIES.ATTENDANCE_SELFIE]: 'hrms/attendance/selfies',
  [STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT]: 'hrms/employees/documents',
  [STORAGE_CATEGORIES.EXPENSE_RECEIPT]: 'hrms/expenses/receipts',
  [STORAGE_CATEGORIES.CANDIDATE_RESUME]: 'hrms/hiring/resumes',
  [STORAGE_CATEGORIES.PAYSLIP]: 'hrms/payroll/payslips',
  [STORAGE_CATEGORIES.FORM16]: 'hrms/payroll/form16',
  [STORAGE_CATEGORIES.LETTER]: 'hrms/letters',
  [STORAGE_CATEGORIES.OFFER_LETTER]: 'hrms/onboarding/offer-letters',
  [STORAGE_CATEGORIES.BANK_FILE]: 'hrms/payroll/bank-files',
  [STORAGE_CATEGORIES.COMPANY_ASSET]: 'hrms/company',
  [STORAGE_CATEGORIES.AUDIT_ARCHIVE]: 'hrms/audit-archive',
});

/**
 * Presigned URL lifetimes, in seconds.
 *
 * A selfie is viewed inline once, so it gets the shortest window. A presigned
 * URL is bearer-capable for its whole lifetime, which is what these bound.
 */
export const PRESIGNED_URL_TTL = Object.freeze({
  DEFAULT: 300,
  SELFIE: 60,
  BANK_FILE: 60,
});

/** Per-category upload size ceilings, in bytes. */
export const MAX_UPLOAD_BYTES = Object.freeze({
  [STORAGE_CATEGORIES.ATTENDANCE_SELFIE]: 2 * 1024 * 1024, // the global 10 MB cap is far too generous here
  [STORAGE_CATEGORIES.CANDIDATE_RESUME]: 5 * 1024 * 1024, // a CV is a few hundred KB; 10 MB is an upload budget, not a résumé
  // Server-GENERATED, never uploaded. The ceiling exists so a template bug
  // cannot write an unbounded object.
  [STORAGE_CATEGORIES.OFFER_LETTER]: 1 * 1024 * 1024,
  DEFAULT: 10 * 1024 * 1024,
});

// ---------------------------------------------------------------------------
// Retention (AD-16)
// ---------------------------------------------------------------------------

export const RETENTION_CATEGORIES = Object.freeze({
  ATTENDANCE_SELFIES: 'attendanceSelfies',
  AUDIT_LOG: 'auditLog',
  INBOX_ITEMS: 'inboxItems',
  PAYSLIPS: 'payslips',
  RESUMES: 'resumes',
  EMPLOYEE_DOCUMENTS: 'employeeDocuments',
  EXPENSE_RECEIPTS: 'expenseReceipts',
  BANK_FILES: 'bankFiles',
});

export const RETENTION_CATEGORY_LIST = Object.freeze(Object.values(RETENTION_CATEGORIES));

export const RETENTION_ACTIONS = Object.freeze({
  RETAIN: 'retain',
  DELETE: 'delete',
  ARCHIVE: 'archive',
});

export const RETENTION_ACTION_LIST = Object.freeze(Object.values(RETENTION_ACTIONS));

/**
 * Seed values.
 *
 * AD-16 decides two categories. Everything else ships `days: null`, which means
 * RETAIN INDEFINITELY - never "delete immediately". An unconfigured category
 * must fail toward keeping data, the same way an unconfigured statutory state
 * blocks payroll rather than silently deducting zero (AD-12).
 *
 * These are seed defaults for the config document, not constants read by
 * business logic. Nothing may branch on the numbers below.
 */
export const DEFAULT_RETENTION_POLICY = Object.freeze({
  [RETENTION_CATEGORIES.ATTENDANCE_SELFIES]: { days: 90, action: RETENTION_ACTIONS.DELETE },
  [RETENTION_CATEGORIES.AUDIT_LOG]: { days: 1095, action: RETENTION_ACTIONS.ARCHIVE },
  [RETENTION_CATEGORIES.INBOX_ITEMS]: { days: null, action: RETENTION_ACTIONS.RETAIN },
  [RETENTION_CATEGORIES.PAYSLIPS]: { days: null, action: RETENTION_ACTIONS.RETAIN },
  [RETENTION_CATEGORIES.RESUMES]: { days: null, action: RETENTION_ACTIONS.RETAIN },
  [RETENTION_CATEGORIES.EMPLOYEE_DOCUMENTS]: { days: null, action: RETENTION_ACTIONS.RETAIN },
  [RETENTION_CATEGORIES.EXPENSE_RECEIPTS]: { days: null, action: RETENTION_ACTIONS.RETAIN },
  [RETENTION_CATEGORIES.BANK_FILES]: { days: null, action: RETENTION_ACTIONS.RETAIN },
});

// ---------------------------------------------------------------------------
// Consent (AD-15)
// ---------------------------------------------------------------------------

export const CONSENT_PURPOSES = Object.freeze({
  ATTENDANCE_SELFIE: 'attendance_selfie',
  ATTENDANCE_LOCATION: 'attendance_location',
});

export const CONSENT_PURPOSE_LIST = Object.freeze(Object.values(CONSENT_PURPOSES));

/**
 * Bump when the consent wording changes: a new version invalidates prior
 * consent and the employee is asked again.
 */
export const CURRENT_CONSENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Org Structure
// ---------------------------------------------------------------------------

/**
 * Shape of a Department / Location code.
 *
 * The reference enforces this pattern ONLY in the browser
 * (`DepartmentsTab.tsx:188`); its server schema is a bare
 * `z.string().min(1).max(30)`, so `POST /departments {"code":"eng dept!"}`
 * succeeds. Declared here once and applied on the server, so the rule binds
 * every client - the form, the API, and the import.
 */
export const ORG_CODE_PATTERN = /^[A-Z0-9_-]+$/;
export const ORG_CODE_MAX_LENGTH = 30;
export const ORG_NAME_MAX_LENGTH = 100;

/** Location free-text caps, matching the reference's column widths. */
export const LOCATION_ADDRESS_MAX_LENGTH = 500;
export const LOCATION_CITY_MAX_LENGTH = 100;
export const LOCATION_COUNTRY_MAX_LENGTH = 100;

// ---------------------------------------------------------------------------
// Audit (AD-16 / AD-10 / AD-15)
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = Object.freeze({
  // authentication
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_REFRESH: 'auth.refresh',
  AUTH_REFRESH_REUSE_DETECTED: 'auth.refresh.reuse_detected',
  AUTH_PASSWORD_CHANGED: 'auth.password.changed',

  // sensitive access (AD-10)
  SENSITIVE_FIELD_VIEWED: 'hrms.sensitive.viewed',
  SENSITIVE_FIELD_WRITTEN: 'hrms.sensitive.written',
  CUSTOM_FIELD_SANITISED: 'hrms.custom_field.sanitised',

  // storage (AD-7)
  FILE_URL_ISSUED: 'hrms.file.url_issued',
  FILE_UPLOADED: 'hrms.file.uploaded',
  FILE_DELETED: 'hrms.file.deleted',

  // attendance (AD-15)
  SELFIE_VIEWED: 'hrms.attendance.selfie.viewed',
  LOCATION_VIEWED: 'hrms.attendance.location.viewed',
  CONSENT_GRANTED: 'hrms.attendance.consent.granted',
  CONSENT_WITHDRAWN: 'hrms.attendance.consent.withdrawn',
  // The punches themselves. The reference audits both
  // (`@Audited({ action: 'attendance.clock-in' })`), and a punch is the
  // record a pay dispute turns on, so who recorded it from where is not
  // optional detail.
  ATTENDANCE_CLOCK_IN: 'hrms.attendance.clock_in',
  ATTENDANCE_CLOCK_OUT: 'hrms.attendance.clock_out',
  ATTENDANCE_CORRECTION_SUBMITTED: 'hrms.attendance.correction.submitted',
  ATTENDANCE_CORRECTION_DECIDED: 'hrms.attendance.correction.decided',
  // An unauthenticated webhook that writes attendance is audited whether it
  // succeeds or not: a run of rejected signatures is the only visible sign of
  // someone probing the endpoint.
  ATTENDANCE_BIOMETRIC_INGESTED: 'hrms.attendance.biometric.ingested',
  ATTENDANCE_BIOMETRIC_REJECTED: 'hrms.attendance.biometric.rejected',

  // retention (AD-16)
  RETENTION_SWEEP: 'hrms.retention.sweep',
  RETENTION_CONFIG_CHANGED: 'hrms.retention.config.changed',

  // import (AD-11)
  IMPORT_PREVIEWED: 'hrms.import.previewed',
  IMPORT_COMMITTED: 'hrms.import.committed',

  // expenses
  EXPENSE_CLAIM_CREATED: 'hrms.expense_claim.created',
  EXPENSE_CLAIM_UPDATED: 'hrms.expense_claim.updated',
  EXPENSE_CLAIM_SUBMITTED: 'hrms.expense_claim.submitted',
  EXPENSE_CLAIM_DECIDED: 'hrms.expense_claim.decided',
  EXPENSE_CLAIM_REIMBURSED: 'hrms.expense_claim.reimbursed',
  EXPENSE_RECEIPT_UPLOADED: 'hrms.expense_receipt.uploaded',
  EXPENSE_RECEIPT_VIEWED: 'hrms.expense_receipt.viewed',
  EXPENSE_CATEGORY_CREATED: 'hrms.expense_category.created',
  EXPENSE_CATEGORY_UPDATED: 'hrms.expense_category.updated',
  EXPENSE_CATEGORY_DELETED: 'hrms.expense_category.deleted',
  EXPENSE_POLICY_UPSERTED: 'hrms.expense_policy.upserted',

  // assets
  ASSET_CATEGORY_CREATED: 'hrms.asset_category.created',
  ASSET_CATEGORY_UPDATED: 'hrms.asset_category.updated',
  ASSET_CATEGORY_DELETED: 'hrms.asset_category.deleted',
  ASSET_ITEM_CREATED: 'hrms.asset_item.created',
  ASSET_ITEM_UPDATED: 'hrms.asset_item.updated',
  ASSET_STATUS_CHANGED: 'hrms.asset_item.status_changed',
  ASSET_ASSIGNED: 'hrms.asset.assigned',
  ASSET_RETURNED: 'hrms.asset.returned',
  ASSET_REQUEST_CREATED: 'hrms.asset_request.created',
  ASSET_REQUEST_DECIDED: 'hrms.asset_request.decided',
  ASSET_REQUEST_FULFILLED: 'hrms.asset_request.fulfilled',
  ASSET_REQUEST_CANCELLED: 'hrms.asset_request.cancelled',

  // documents
  DOCUMENT_FOLDER_CREATED: 'hrms.document_folder.created',
  DOCUMENT_FOLDER_UPDATED: 'hrms.document_folder.updated',
  DOCUMENT_FOLDER_DELETED: 'hrms.document_folder.deleted',
  DOCUMENT_UPLOADED: 'hrms.document.uploaded',
  DOCUMENT_UPDATED: 'hrms.document.updated',
  DOCUMENT_DELETED: 'hrms.document.deleted',
  DOCUMENT_VIEWED: 'hrms.document.viewed',
  DOCUMENT_POLICY_PUBLISHED: 'hrms.document.policy_published',
  DOCUMENT_ACKNOWLEDGED: 'hrms.document.acknowledged',

  // helpdesk
  TICKET_CATEGORY_CREATED: 'hrms.ticket_category.created',
  TICKET_CATEGORY_UPDATED: 'hrms.ticket_category.updated',
  TICKET_CATEGORY_DELETED: 'hrms.ticket_category.deleted',
  TICKET_CREATED: 'hrms.ticket.created',
  TICKET_UPDATED: 'hrms.ticket.updated',
  TICKET_ASSIGNED: 'hrms.ticket.assigned',
  TICKET_STATUS_CHANGED: 'hrms.ticket.status_changed',
  TICKET_COMMENT_ADDED: 'hrms.ticket.comment_added',
  KB_ARTICLE_CREATED: 'hrms.kb_article.created',
  KB_ARTICLE_UPDATED: 'hrms.kb_article.updated',
  KB_ARTICLE_DELETED: 'hrms.kb_article.deleted',

  // exits
  EXIT_INITIATED: 'hrms.exit.initiated',
  EXIT_MANAGER_APPROVED: 'hrms.exit.manager_approved',
  EXIT_HR_APPROVED: 'hrms.exit.hr_approved',
  EXIT_CLEARANCES_OPENED: 'hrms.exit.clearances_opened',
  EXIT_CLEARANCE_UPDATED: 'hrms.exit.clearance_updated',
  EXIT_UPDATED: 'hrms.exit.updated',
  EXIT_CANCELLED: 'hrms.exit.cancelled',
  EXIT_FNF_CREATED: 'hrms.exit.fnf_created',
  EXIT_FNF_DISBURSED: 'hrms.exit.fnf_disbursed',
  EXIT_LETTER_GENERATED: 'hrms.exit.letter_generated',
  EXIT_LETTER_VIEWED: 'hrms.exit.letter_viewed',

  // leave
  LEAVE_REQUESTED: 'hrms.leave.requested',
  LEAVE_DECIDED: 'hrms.leave.decided',
  LEAVE_CANCELLED: 'hrms.leave.cancelled',
  LEAVE_TYPE_CREATED: 'hrms.leave_type.created',
  LEAVE_TYPE_UPDATED: 'hrms.leave_type.updated',

  // holidays
  HOLIDAY_CREATED: 'hrms.holiday.created',
  HOLIDAY_UPDATED: 'hrms.holiday.updated',
  HOLIDAY_DELETED: 'hrms.holiday.deleted',
  HOLIDAY_BULK_IMPORTED: 'hrms.holiday.bulk_imported',

  // org structure
  DEPARTMENT_CREATED: 'hrms.department.created',
  DEPARTMENT_UPDATED: 'hrms.department.updated',
  DEPARTMENT_DELETED: 'hrms.department.deleted',
  LOCATION_CREATED: 'hrms.location.created',
  LOCATION_UPDATED: 'hrms.location.updated',
  LOCATION_DELETED: 'hrms.location.deleted',

  // payroll
  //
  // Payroll is the most consequential module in the system: these entries are
  // the record of who changed what somebody is paid, who ran the month, and
  // who saw a payslip. Compensation changes and payslip access are audited
  // even on the read side, for the same reason AD-10 audits a PAN view.
  PAY_GROUP_CREATED: 'hrms.payroll.pay_group.created',
  PAY_GROUP_UPDATED: 'hrms.payroll.pay_group.updated',
  PAY_GROUP_DELETED: 'hrms.payroll.pay_group.deleted',
  SALARY_COMPONENT_CREATED: 'hrms.payroll.component.created',
  SALARY_COMPONENT_UPDATED: 'hrms.payroll.component.updated',
  SALARY_COMPONENT_DELETED: 'hrms.payroll.component.deleted',
  SALARY_STRUCTURE_CREATED: 'hrms.payroll.structure.created',
  SALARY_STRUCTURE_UPDATED: 'hrms.payroll.structure.updated',
  SALARY_STRUCTURE_DELETED: 'hrms.payroll.structure.deleted',
  COMPENSATION_CHANGED: 'hrms.payroll.compensation.changed',
  STATUTORY_CONFIG_CREATED: 'hrms.payroll.statutory.created',
  STATUTORY_CONFIG_UPDATED: 'hrms.payroll.statutory.updated',
  STATUTORY_CONFIG_DELETED: 'hrms.payroll.statutory.deleted',
  PAYROLL_RUN_CREATED: 'hrms.payroll.run.created',
  PAYROLL_RUN_COMPUTED: 'hrms.payroll.run.computed',
  PAYROLL_RUN_LOCKED: 'hrms.payroll.run.locked',
  PAYROLL_RUN_DISBURSED: 'hrms.payroll.run.disbursed',
  PAYROLL_RUN_ROLLED_BACK: 'hrms.payroll.run.rolled_back',
  PAYROLL_ADJUSTMENT_CREATED: 'hrms.payroll.adjustment.created',
  PAYROLL_ADJUSTMENT_DELETED: 'hrms.payroll.adjustment.deleted',
  PAYSLIP_VIEWED: 'hrms.payroll.payslip.viewed',

  // hiring
  //
  // The offer entries carry the most weight: an offer is a salary commitment,
  // and its acceptance arrives from an unauthenticated caller holding a token.
  // Who issued it, who sent it, and what the accepting request looked like are
  // the facts a later dispute turns on.
  REQUISITION_CREATED: 'hrms.hiring.requisition.created',
  REQUISITION_UPDATED: 'hrms.hiring.requisition.updated',
  REQUISITION_APPROVED: 'hrms.hiring.requisition.approved',
  REQUISITION_STATUS_CHANGED: 'hrms.hiring.requisition.status_changed',
  POSTING_CREATED: 'hrms.hiring.posting.created',
  POSTING_PUBLISHED: 'hrms.hiring.posting.published',
  POSTING_CLOSED: 'hrms.hiring.posting.closed',
  CANDIDATE_CREATED: 'hrms.hiring.candidate.created',
  CANDIDATE_UPDATED: 'hrms.hiring.candidate.updated',
  RESUME_UPLOADED: 'hrms.hiring.resume.uploaded',
  RESUME_VIEWED: 'hrms.hiring.resume.viewed',
  APPLICATION_CREATED: 'hrms.hiring.application.created',
  APPLICATION_STAGE_MOVED: 'hrms.hiring.application.stage_moved',
  INTERVIEW_SCHEDULED: 'hrms.hiring.interview.scheduled',
  INTERVIEW_STATUS_CHANGED: 'hrms.hiring.interview.status_changed',
  INTERVIEW_FEEDBACK_SUBMITTED: 'hrms.hiring.interview.feedback_submitted',
  OFFER_CREATED: 'hrms.hiring.offer.created',
  OFFER_SENT: 'hrms.hiring.offer.sent',
  OFFER_ACCEPTED: 'hrms.hiring.offer.accepted',
  OFFER_REJECTED: 'hrms.hiring.offer.rejected',
  OFFER_LINK_REFUSED: 'hrms.hiring.offer.link_refused',
  PUBLIC_APPLICATION_RECEIVED: 'hrms.hiring.public_application.received',

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------
  // The offer entries are distinct from the hiring ones above on purpose: the
  // reference ships two separate offer flows, one against a Candidate and one
  // against an Employee, and collapsing them here would make an audit trail
  // that cannot say which was signed.
  ONBOARDING_TEMPLATE_CREATED: 'hrms.onboarding.template.created',
  ONBOARDING_TEMPLATE_UPDATED: 'hrms.onboarding.template.updated',
  ONBOARDING_TEMPLATE_RETIRED: 'hrms.onboarding.template.retired',
  ONBOARDING_CHECKLIST_STARTED: 'hrms.onboarding.checklist.started',
  ONBOARDING_CHECKLIST_COMPLETED: 'hrms.onboarding.checklist.completed',
  ONBOARDING_CHECKLIST_REOPENED: 'hrms.onboarding.checklist.reopened',
  ONBOARDING_CHECKLIST_CANCELLED: 'hrms.onboarding.checklist.cancelled',
  ONBOARDING_TASK_UPDATED: 'hrms.onboarding.task.updated',
  ONBOARDING_TASK_REASSIGNED: 'hrms.onboarding.task.reassigned',
  OFFER_LETTER_CREATED: 'hrms.onboarding.offer_letter.created',
  OFFER_LETTER_SENT: 'hrms.onboarding.offer_letter.sent',
  OFFER_LETTER_ACCEPTED: 'hrms.onboarding.offer_letter.accepted',
  OFFER_LETTER_REJECTED: 'hrms.onboarding.offer_letter.rejected',
  OFFER_LETTER_VIEWED: 'hrms.onboarding.offer_letter.viewed',

  // -------------------------------------------------------------------------
  // Performance
  // -------------------------------------------------------------------------
  // A rating is a statement about a person that outlives the cycle it was
  // written in, so submission and phase changes are recorded in full. Feedback
  // records the SENDER even when the note is anonymous to its recipient — that
  // is what makes moderation possible — but never the message body.
  GOAL_CREATED: 'hrms.performance.goal.created',
  GOAL_UPDATED: 'hrms.performance.goal.updated',
  GOAL_DELETED: 'hrms.performance.goal.deleted',
  REVIEW_CYCLE_CREATED: 'hrms.performance.review_cycle.created',
  REVIEW_CYCLE_PHASE_CHANGED: 'hrms.performance.review_cycle.phase_changed',
  REVIEW_RESPONSE_CREATED: 'hrms.performance.review_response.created',
  REVIEW_RESPONSE_SUBMITTED: 'hrms.performance.review_response.submitted',
  FEEDBACK_GIVEN: 'hrms.performance.feedback.given',
  ONE_ON_ONE_SCHEDULED: 'hrms.performance.one_on_one.scheduled',
  ONE_ON_ONE_STATUS_CHANGED: 'hrms.performance.one_on_one.status_changed',

  // -------------------------------------------------------------------------
  // Engage
  // -------------------------------------------------------------------------
  // Publishing an announcement and giving recognition record WHO acted — both
  // are attributable acts, and recognition's sender is retained precisely so
  // abusive kudos can be dealt with. A POLL or eNPS RESPONSE on an anonymous
  // survey is recorded as a SYSTEM event with no actor: the reference attaches
  // the acting user to both, which makes every "anonymous" answer attributable
  // from the audit log.
  ANNOUNCEMENT_CREATED: 'hrms.engage.announcement.created',
  ANNOUNCEMENT_PUBLISHED: 'hrms.engage.announcement.published',
  ANNOUNCEMENT_DELETED: 'hrms.engage.announcement.deleted',
  POLL_CREATED: 'hrms.engage.poll.created',
  POLL_LAUNCHED: 'hrms.engage.poll.launched',
  POLL_RESPONDED: 'hrms.engage.poll.responded',
  RECOGNITION_GIVEN: 'hrms.engage.recognition.given',
  RECOGNITION_BADGE_CREATED: 'hrms.engage.recognition_badge.created',
  ENPS_SURVEY_CREATED: 'hrms.engage.enps_survey.created',
  ENPS_RESPONDED: 'hrms.engage.enps.responded',

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------
  // The reference audits the two creates and nothing else, because creating is
  // the only thing its Planning module can do. A hiring plan's status is what
  // the module exists to track, so the move that changes it is audited too.
  HEADCOUNT_PLAN_CREATED: 'hrms.planning.headcount_plan.created',
  HEADCOUNT_PLAN_UPDATED: 'hrms.planning.headcount_plan.updated',
  HIRING_PLAN_CREATED: 'hrms.planning.hiring_plan.created',
  HIRING_PLAN_UPDATED: 'hrms.planning.hiring_plan.updated',
  HIRING_PLAN_STATUS_CHANGED: 'hrms.planning.hiring_plan.status_changed',

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------
  // The reference audits NOTHING here. A super admin can export the entire
  // employee directory - every name, work email, department and join date - and
  // no record survives that it happened. Both actions are recorded, with the
  // filters and the row count but never the rows themselves.
  REPORT_RUN: 'hrms.report.run',
  REPORT_EXPORTED: 'hrms.report.exported',

  // -------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------
  // The reference audits NOTHING here - not marking read, not clearing an
  // entire inbox. Reading a list is deliberately NOT audited either: the badge
  // is polled every fifteen seconds per signed-in user, and a row per poll
  // would drown the log. What is recorded is the bulk CLEARS, with counts only
  // - never the titles, because an audit row listing what was in somebody's
  // inbox would be a second copy of it readable by every auditor.
  INBOX_MARKED_READ: 'hrms.inbox.marked_read',
  INBOX_MARKED_ALL_READ: 'hrms.inbox.marked_all_read',
  INBOX_ARCHIVED: 'hrms.inbox.archived',

  // -------------------------------------------------------------------------
  // Settings / Administration
  // -------------------------------------------------------------------------
  // The reference audits these through an interceptor that stores `req.body`
  // verbatim - so its SSO client secrets and integration API keys land in the
  // trail in plaintext, readable by every hr_admin and auditor. Each writer
  // here passes an explicit meta naming WHICH fields changed and whether a
  // secret rotated, never a secret value.
  SETTINGS_COMPANY_UPDATED: 'hrms.settings.company.updated',
  SETTINGS_LOGO_UPDATED: 'hrms.settings.logo.updated',
  SETTINGS_SSO_UPDATED: 'hrms.settings.sso.updated',
  SETTINGS_INTEGRATION_UPDATED: 'hrms.settings.integration.updated',
});

/**
 * Audit actions that must survive their own retention window.
 *
 * The retention sweep writes a summary of what it deleted. If that summary were
 * itself subject to the window, the record of deletion would eventually be
 * deleted - and the audit trail would quietly lose the fact that data was
 * removed at all.
 */
export const RETENTION_EXEMPT_AUDIT_ACTIONS = Object.freeze([
  AUDIT_ACTIONS.RETENTION_SWEEP,
  AUDIT_ACTIONS.RETENTION_CONFIG_CHANGED,
]);

// ---------------------------------------------------------------------------
// Statutory (AD-12)
// ---------------------------------------------------------------------------

/**
 * Indian state/UT subdivision codes, without the `IN-` prefix.
 *
 * This is a FORMAT vocabulary, not a configuration: no PT or LWF slab is
 * declared anywhere in the codebase, and no state is the default. Resolution is
 * employee override -> location -> company default -> block.
 */
export const INDIAN_STATE_CODES = Object.freeze([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CH', 'CT', 'DH', 'DL', 'GA', 'GJ', 'HP', 'HR',
  'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OR',
  'PB', 'PY', 'RJ', 'SK', 'TG', 'TN', 'TR', 'UP', 'UT', 'WB',
]);

/** PT and LWF may be levied monthly, twice a year, or annually. */
export const STATUTORY_PERIODICITY = Object.freeze(['monthly', 'biannual', 'annual']);

// ---------------------------------------------------------------------------
// Pagination (AD-13)
// ---------------------------------------------------------------------------

/**
 * Defaults only. Headcount is never encoded in business logic; these are the
 * starting values for a configurable page size.
 */
export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 200;
