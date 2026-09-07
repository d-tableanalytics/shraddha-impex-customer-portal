/**
 * Attendance routes, mounted at /api/v1/hrms/attendance.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * ---------------------------------------------------------------------------
 * Permissions, taken from the reference decorator for decorator
 * ---------------------------------------------------------------------------
 *   clock-in / clock-out    attendance:submit:self       (attendance.controller.ts:63,74)
 *   today                   attendance:view:self         (:84)
 *   list                    ANY-OF view org | team | self (:91)
 *   team-grid               ANY-OF view org | team       (:106)
 *   corrections POST        attendance:submit:self       (:170)
 *   corrections GET         ANY-OF view org | team | self (:180)
 *   corrections decide      ANY-OF approve org | team    (:194)
 *
 * No permission is invented. Every key above already exists in the matrix and
 * is already granted to the roles that need it — `attendance:submit:self` and
 * `attendance:view:self` sit in SELF_BASELINE, `view`/`approve` at `team` on
 * the manager, at `org` on super_admin, hr_admin and recruiter, and
 * `view:org` on the auditor.
 *
 * ---------------------------------------------------------------------------
 * No `resourceParam` on the collection reads, and why that is correct here
 * ---------------------------------------------------------------------------
 * `isSelf`/`isInTeamOf` return true when no resource is supplied, so a
 * collection route without one is a pass at the guard. That is deliberate and
 * safe ONLY because the SERVICE narrows the query by scope — see
 * `readFilterFor`. The routes that CAN address one identified record
 * (`/records/:id/selfie/:punch`, `/corrections/:id/decide`) do not rely on the
 * guard for their scope check: the service resolves the subject and re-checks
 * against it, because the row must be read to know whose it is.
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
  punchSchema,
  attendanceListQuerySchema,
  selfieParamsSchema,
  attendanceCorrectionSchema,
  attendanceCorrectionDecisionSchema,
  correctionListQuerySchema,
  consentDecisionSchema,
} from '../../../shared/schemas/attendance.js';
import { uploadSelfieFile, handleSelfieUploadErrors } from './selfieUpload.js';
import * as controller from './attendance.controller.js';

const router = express.Router();

/** Recording one's own attendance. The SELF_BASELINE grant every employee holds. */
const canPunch = requirePermission({ module: M.ATTENDANCE, action: A.SUBMIT, scope: S.SELF });

/** Reading attendance at whatever breadth the actor holds; the service narrows it. */
const canRead = requirePermission(
  { module: M.ATTENDANCE, action: A.VIEW, scope: S.ORG },
  { module: M.ATTENDANCE, action: A.VIEW, scope: S.TEAM },
  { module: M.ATTENDANCE, action: A.VIEW, scope: S.SELF },
);

/** Seeing other people's day. An ordinary employee holds neither grant. */
const canReadOthers = requirePermission(
  { module: M.ATTENDANCE, action: A.VIEW, scope: S.ORG },
  { module: M.ATTENDANCE, action: A.VIEW, scope: S.TEAM },
);

/**
 * Deciding a correction.
 *
 * The gate here answers "may this person approve anything at all". Whether they
 * may approve THIS request is settled in the service against the requester's
 * manager chain — a `team` grant is not a licence over the whole company.
 */
const canApprove = requirePermission(
  { module: M.ATTENDANCE, action: A.APPROVE, scope: S.ORG },
  { module: M.ATTENDANCE, action: A.APPROVE, scope: S.TEAM },
);

// ---------------------------------------------------------------------------
// Consent (AD-15) - before /:id-shaped routes, and before the punches that
// depend on it, so the ordering reads the way the flow runs.
// ---------------------------------------------------------------------------

/**
 * Always the caller's OWN consent, in both directions. There is no route
 * parameter for anyone else's, because consent recorded on someone's behalf is
 * not consent. `view:self` is the gate: reading your own consent state is not
 * an HR act.
 */
router.get(
  '/consent',
  requirePermission({ module: M.ATTENDANCE, action: A.VIEW, scope: S.SELF }),
  controller.getConsent,
);

router.post(
  '/consent',
  requirePermission({ module: M.ATTENDANCE, action: A.SUBMIT, scope: S.SELF }),
  validate({ body: consentDecisionSchema }),
  controller.setConsent,
);

// ---------------------------------------------------------------------------
// Selfie upload
// ---------------------------------------------------------------------------

/**
 * Gated on SUBMIT, not VIEW: uploading a selfie is part of making a punch.
 *
 * `handleSelfieUploadErrors` sits directly after multer so a rejected file
 * becomes a 400 or a 413 rather than escaping as a 500.
 */
router.post(
  '/selfie',
  canPunch,
  uploadSelfieFile,
  handleSelfieUploadErrors,
  controller.uploadSelfie,
);

// ---------------------------------------------------------------------------
// Corrections - before /records/:id, so neither shadows the other
// ---------------------------------------------------------------------------

router.post(
  '/corrections',
  canPunch,
  validate({ body: attendanceCorrectionSchema }),
  controller.submitCorrection,
);

router.get(
  '/corrections',
  canRead,
  validate({ query: correctionListQuerySchema }),
  controller.listCorrections,
);

router.post(
  '/corrections/:id/decide',
  canApprove,
  validate({ body: attendanceCorrectionDecisionSchema }),
  controller.decideCorrection,
);

// ---------------------------------------------------------------------------
// Punches
// ---------------------------------------------------------------------------

router.post('/clock-in', canPunch, validate({ body: punchSchema }), controller.clockIn);
router.post('/clock-out', canPunch, validate({ body: punchSchema }), controller.clockOut);

router.get(
  '/today',
  requirePermission({ module: M.ATTENDANCE, action: A.VIEW, scope: S.SELF }),
  controller.today,
);

router.get('/team-grid', canReadOthers, controller.teamGrid);

// ---------------------------------------------------------------------------
// One record's selfie
// ---------------------------------------------------------------------------

/**
 * A short-lived presigned URL for one punch's photograph.
 *
 * This is the replacement for the reference's `@Public()` filename endpoint.
 * `canRead` is only the outer gate; the storage service resolves who the
 * photograph is OF and evaluates the caller's scope against that person before
 * a URL exists at all.
 */
router.get(
  '/records/:id/selfie/:punch',
  canRead,
  validate({ params: selfieParamsSchema }),
  controller.getSelfieUrl,
);

// ---------------------------------------------------------------------------
// History - last, because '/' matches nothing else above
// ---------------------------------------------------------------------------

router.get('/', canRead, validate({ query: attendanceListQuerySchema }), controller.list);

export default router;
