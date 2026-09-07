/**
 * Audit log routes, mounted at /api/v1/hrms/audit-logs.
 *
 * Its own module key, and deliberately NOT under /settings: the reference gives
 * Audit Logs its own nav entry and its own `audit-logs` permission, and the two
 * audiences differ. `settings:view:org` is super_admin only; this is held by
 * super_admin, hr_admin AND auditor — the oversight roles.
 *
 * That asymmetry is exactly why the service redacts. The reference stores
 * `req.body` in its audit payload and renders it verbatim on this page, so its
 * hr_admin and auditor can read the SSO client secrets and integration API keys
 * that Settings never shows them. Nothing that reaches this endpoint carries a
 * secret value.
 */

import express from 'express';

import { requirePermission } from '../../../middlewares/hrmsAuth.js';
import { validate } from '../../../middlewares/validate.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import { auditLogQuerySchema } from '../../../shared/schemas/settings.js';
import * as controller from './audit.controller.js';

const router = express.Router();

const canView = requirePermission({ module: M.AUDIT_LOGS, action: A.VIEW, scope: S.ORG });

/** Declared before nothing else can shadow it, but kept first for readability. */
router.get('/actions', canView, controller.actions);

router.get('/', canView, validate({ query: auditLogQuerySchema }), controller.list);

export default router;
