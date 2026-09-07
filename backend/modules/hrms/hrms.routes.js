/**
 * HRMS API router, mounted at /api/v1/hrms (AD-14).
 *
 * The middleware chain below is the security boundary for every HRMS endpoint.
 * It is declared ONCE here rather than per route, so a new endpoint cannot be
 * added without authentication and the AD-4 access check:
 *
 *   protect            authenticated, and User.status === 'Active'
 *   attachHrmsActor    resolve req.hrmsActor (skips the employee lookup for
 *                      accounts with no HRMS role)
 *   requireHrmsAccess  refuse anyone holding no HRMS grant at all - which is
 *                      every Customer, and every portal-only account
 *
 * Individual routes then add their own `requirePermission(...)`.
 *
 * Phase 0 exposes only foundation endpoints. Business modules (employees,
 * attendance, leave, payroll, ...) mount here in later phases.
 */

import express from 'express';

import { protect } from '../../middlewares/auth.js';
import { hrmsAuthorizationChain } from '../../middlewares/hrmsAuth.js';
import { getHrmsMe, getHrmsStatus } from './hrms.controller.js';
import companyRoutes from './company/company.routes.js';
import employeeRoutes from './employees/employee.routes.js';
import orgRoutes from './org/org.routes.js';
import leaveRoutes from './leave/leave.routes.js';
import holidayRoutes from './leave/holiday.routes.js';
import expenseRoutes from './expenses/expense.routes.js';
import exitRoutes from './exits/exit.routes.js';
import assetRoutes from './assets/asset.routes.js';
import documentRoutes from './documents/document.routes.js';
import helpdeskRoutes from './helpdesk/helpdesk.routes.js';
import { hrmsErrorHandler } from './hrms.errors.js';
import storageRoutes from './storage/storage.routes.js';
import retentionRoutes from './retention/retention.routes.js';
import employeeImportRoutes from './import/import.routes.js';
import attendanceRoutes from './attendance/attendance.routes.js';
import biometricRoutes from './attendance/biometric.routes.js';
import payrollRoutes from './payroll/payroll.routes.js';
import hiringRoutes from './hiring/hiring.routes.js';
import careersRoutes from './hiring/careers.routes.js';
import onboardingRoutes from './onboarding/onboarding.routes.js';
import performanceRoutes from './performance/performance.routes.js';
import engageRoutes from './engage/engage.routes.js';
import planningRoutes from './planning/planning.routes.js';
import reportRoutes from './reports/report.routes.js';
import settingsRoutes from './settings/settings.routes.js';
import auditRoutes from './audit/audit.routes.js';
import inboxRoutes from './inbox/inbox.routes.js';
import dashboardRoutes from './dashboard/dashboard.routes.js';

const router = express.Router();

/**
 * 🔴 THE ONE ROUTE MOUNTED BEFORE `protect`, AND THE ONLY ONE THAT MAY BE.
 *
 * A biometric punch clock has no session and cannot hold a JWT, so it
 * authenticates with an HMAC-SHA256 signature over the raw request body
 * instead. Express matches middleware in declaration order, so mounting this
 * ABOVE `router.use(protect)` is what leaves it reachable without a token —
 * and putting it anywhere below would break it silently.
 *
 * It is not unguarded. Its own router refuses outright unless a webhook secret
 * is configured, verifies the signature in constant time before parsing a byte
 * of the payload, rate-limits, and audits every rejection. See
 * attendance/biometric.routes.js.
 *
 * Nothing else goes here. Every other HRMS endpoint is authenticated by the
 * chain below, and a route added above it would quietly lose that.
 */
router.use('/attendance/biometric', biometricRoutes);

/**
 * 🔴 THE SECOND, AND LAST, UNAUTHENTICATED SURFACE.
 *
 * A job applicant has no account, and a candidate deciding on an offer is not
 * an employee yet — so the careers page and the offer accept/reject flow sit
 * above `protect` for the same structural reason the biometric webhook does.
 *
 * It is not unguarded. Offer routes are authorised by a 256-bit token stored
 * hashed and compared in constant time (the reference keys them on the offer's
 * own id, which lets anyone holding one read a salary or accept on the
 * candidate's behalf); the listing exposes only published adverts; everything
 * is rate limited and every refusal is audited. See hiring/careers.routes.js.
 */
router.use('/careers', careersRoutes);

router.use(protect);
router.use(hrmsAuthorizationChain);

/**
 * The actor for the signed-in user: HRMS role keys, resolved permissions and
 * the module list the frontend nav filter and route gate read.
 *
 * No `requirePermission` - reaching this point already means the account holds
 * HRMS access, and every actor may read their own.
 */
router.get('/me', getHrmsMe);

/**
 * What the foundation has wired up. No permission gate beyond HRMS access -
 * it reports capability, not data.
 */
router.get('/status', getHrmsStatus);

// AD-1: single tenant. One company profile, not an Organization per tenant.
router.use('/company', companyRoutes);

// Employee Master.
router.use('/employees', employeeRoutes);

// Org Structure: the department and location catalogues, and the org chart.
// Grouped under /org rather than mounted flat as the reference does
// (/departments, /locations, /organization/tree), so the module owns one
// prefix and the API reads the way the permission key does.
router.use('/org', orgRoutes);

// Leave, and the holiday calendar it prices requests against. Holidays sit
// at their own path, as in the reference, but are governed by the LEAVE
// permission keys - there is no separate holidays module.
router.use('/leave', leaveRoutes);
router.use('/holidays', holidayRoutes);

// Expenses: the claim catalogue, its policies, and the draft -> manager ->
// finance -> reimbursed workflow. Receipts go through the shared S3 storage.
router.use('/expenses', expenseRoutes);
router.use('/exits', exitRoutes);
// Assets: the category catalogue, the inventory, issue/return, and the
// employee request queue. No attachments - the reference's asset module has
// none, so nothing touches storage.
router.use('/assets', assetRoutes);
// Documents: the folder tree, the company library, personal repositories,
// and policy publication with acknowledgment tracking. Files are read
// through presigned URLs; the storage key never reaches a browser.
router.use('/documents', documentRoutes);
// Helpdesk: tickets routed to a resolver team by category, the
// conversation on each, and the knowledge base. A resolver sees only the
// categories they hold the grant for.
router.use('/helpdesk', helpdeskRoutes);

/**
 * Attendance: punches, history, corrections, consent and selfies.
 *
 * Mounted AFTER the authentication chain, unlike the biometric webhook above.
 * The prefix is shared deliberately — `/attendance/biometric` is part of the
 * same module and reads that way in the API — and Express has already matched
 * the more specific mount, so there is no shadowing.
 */
router.use('/attendance', attendanceRoutes);

// Payroll: pay groups, salary components and structures, employee
// compensation, versioned statutory rules, the run lifecycle, adjustments and
// payslips. Unpaid approved leave feeds it as loss of pay; nothing else does.
router.use('/payroll', payrollRoutes);

// Hiring: requisitions, postings, candidates and their résumés, the
// application pipeline, interviews with panel feedback, and offers. The public
// careers half is mounted above, outside the authentication chain.
router.use('/hiring', hiringRoutes);

// Onboarding: templates, the checklist a new hire works through, and the
// employee-facing offer letter they sign in the portal. Distinct from Hiring's
// candidate-facing offer, which is mounted above and keyed on a public token.
router.use('/onboarding', onboardingRoutes);

// Performance: cascading goals, review cycles with a competency template and
// an enforced phase machine, the review queue, continuous feedback and shared
// 1:1 notes.
router.use('/performance', performanceRoutes);

// Engage: the company announcement feed, polls, peer recognition with badges,
// and the eNPS pulse survey. Two permission levels and no team scope — the
// audience is the whole company.
router.use('/engage', engageRoutes);

// Planning: headcount plans per financial year, with actual headcount and
// budget DERIVED rather than stored, and the hiring plan calendar. Org scope
// only — HR planning has no self or team view in either codebase.
router.use('/planning', planningRoutes);

// Reports: the catalogue, one page of one report, and CSV export. Three
// built-in reports, as the reference has - the registry is an extension point
// nothing in either codebase uses. The route gate is the union of the five
// `reports*` grants; each report's own data-module grant is the real check.
router.use('/reports', reportRoutes);

// Audit logs: the read side of the trail every module already writes. Its own
// module key, not Settings' - super_admin, hr_admin and auditor hold it, and
// the last two may not open Settings at all. Secrets are redacted on the way
// out, because that asymmetry is a privilege-escalation path in the reference.
router.use('/audit-logs', auditRoutes);

// Settings: company profile and branding, the read-only role matrix, SSO
// providers and third-party integrations. Super admin only. The company
// profile is the EXISTING CompanyProfile document, not a second copy of it.
router.use('/settings', settingsRoutes);

// Inbox: the in-app notification centre. `self` scope only - every query is
// filtered by the actor's own employee id, and there is NO endpoint that
// creates an item, so a notification's recipient can only ever be derived from
// a business event on the server.
router.use('/inbox', inboxRoutes);

// Dashboard: read-only aggregation over the modules above. It owns no business
// logic and no writes — where an existing service already applies the right
// visibility rule (Engage's targeting, Leave's scope filter), it is CALLED
// rather than restated.
router.use('/dashboard', dashboardRoutes);

// AD-7: presigned, per-object-authorised file access.
router.use('/files', storageRoutes);

// AD-16: retention policy - configurable, versioned, audited.
router.use('/config/retention', retentionRoutes);

// AD-11: the source-agnostic employee import pipeline. No source adapter is
// shipped - the migration source is deliberately undecided.
router.use('/imports/employees', employeeImportRoutes);

// HRMS-specific errors become their own status codes here, ahead of the
// app-wide handler, so a missing department is a 404 and an unbuilt capability
// is a 503 rather than both surfacing as 500. Portal error handling is
// untouched - this is mounted on the HRMS router only.
router.use(hrmsErrorHandler);

export default router;
