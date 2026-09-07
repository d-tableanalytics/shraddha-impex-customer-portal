/**
 * Retention policy routes, mounted at /api/v1/hrms/config/retention.
 *
 * The parent router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess. Retention is a settings concern, so reads need
 * `settings:view:org` and writes need `settings:edit:org`.
 */

import express from 'express';

import { requirePermission } from '../../../middlewares/hrmsAuth.js';
import {
  getRetentionConfig,
  getRetentionHistory,
  updateRetentionConfig,
  runSweepNow,
} from './retention.controller.js';
import { HRMS_MODULES as M, HRMS_ACTIONS as A, SCOPES as S } from '../../../shared/permissions/constants.js';

const router = express.Router();

const canView = requirePermission({ module: M.SETTINGS, action: A.VIEW, scope: S.ORG });
const canEdit = requirePermission({ module: M.SETTINGS, action: A.EDIT, scope: S.ORG });

router.get('/', canView, getRetentionConfig);
router.get('/history', canView, getRetentionHistory);
router.put('/', canEdit, updateRetentionConfig);

// Defaults to a dry run; performing a real sweep needs the edit permission.
router.post('/sweep', canEdit, runSweepNow);

export default router;
