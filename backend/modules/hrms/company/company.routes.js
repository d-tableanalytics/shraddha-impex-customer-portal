/**
 * Company profile routes, mounted at /api/v1/hrms/company.
 *
 * Reading is open to any HRMS user - the company name and logo appear in the
 * shell header, so every screen needs it. Writing is a settings action.
 */

import express from 'express';

import { requirePermission } from '../../../middlewares/hrmsAuth.js';
import { validate } from '../../../middlewares/validate.js';
import {
  getCompanyProfile,
  updateCompanyProfile,
  updateCompanyProfileSchema,
} from './company.controller.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';

const router = express.Router();

// Every HRMS role holds org-structure:view at self scope via the baseline, so
// this is readable by anyone who has HRMS access at all - which is what the
// shell header needs.
router.get(
  '/',
  requirePermission(
    { module: M.ORG_STRUCTURE, action: A.VIEW, scope: S.SELF },
    { module: M.SETTINGS, action: A.VIEW, scope: S.ORG },
  ),
  getCompanyProfile,
);

router.put(
  '/',
  requirePermission({ module: M.SETTINGS, action: A.EDIT, scope: S.ORG }),
  validate({ body: updateCompanyProfileSchema }),
  updateCompanyProfile,
);

export default router;
