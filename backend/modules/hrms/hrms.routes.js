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
import { hrmsErrorHandler } from './hrms.errors.js';
import storageRoutes from './storage/storage.routes.js';
import retentionRoutes from './retention/retention.routes.js';
import employeeImportRoutes from './import/import.routes.js';

const router = express.Router();

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
