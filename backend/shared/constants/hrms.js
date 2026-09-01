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

  // retention (AD-16)
  RETENTION_SWEEP: 'hrms.retention.sweep',
  RETENTION_CONFIG_CHANGED: 'hrms.retention.config.changed',

  // import (AD-11)
  IMPORT_PREVIEWED: 'hrms.import.previewed',
  IMPORT_COMMITTED: 'hrms.import.committed',
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
