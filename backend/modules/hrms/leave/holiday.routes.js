/**
 * Holiday routes, mounted at /api/v1/hrms/holidays.
 *
 * Holidays are governed by the LEAVE permission keys, as in the reference:
 * anyone who can see their own leave can read the calendar (the apply form
 * needs it to price a request), and only `leave:edit:org` can change it.
 *
 * Mounted at its own top-level path rather than under /leave, matching the
 * reference's `@Controller('holidays')` — the calendar is read by more than the
 * leave screens.
 */

import express from 'express';

import { requirePermission } from '../../../middlewares/hrmsAuth.js';
import { validate } from '../../../middlewares/validate.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
  upsertHolidaySchema,
  bulkImportHolidaysSchema,
  holidayListQuerySchema,
} from '../../../shared/schemas/leave.js';
import * as controller from './leave.controller.js';

const router = express.Router();

const canRead = requirePermission({ module: M.LEAVE, action: A.VIEW, scope: S.SELF });
const canEdit = requirePermission({ module: M.LEAVE, action: A.EDIT, scope: S.ORG });

// `/years` before nothing else can shadow it, and before `/:id` on the writes.
router.get('/years', canRead, controller.listHolidayYears);
router.get('/', canRead, validate({ query: holidayListQuerySchema }), controller.listHolidays);

router.post('/', canEdit, validate({ body: upsertHolidaySchema }), controller.createHoliday);

/** Before `/:id`, or "bulk-import" would be read as a holiday id. */
router.post(
  '/bulk-import',
  canEdit,
  validate({ body: bulkImportHolidaysSchema }),
  controller.bulkImportHolidays,
);

router.patch('/:id', canEdit, validate({ body: upsertHolidaySchema }), controller.updateHoliday);

/** Soft delete. */
router.delete('/:id', canEdit, controller.deleteHoliday);

export default router;
