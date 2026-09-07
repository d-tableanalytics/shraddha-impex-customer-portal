/**
 * Engage routes, mounted at /api/v1/hrms/engage.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission.
 *
 * Engage has exactly TWO permission levels, and the reference uses no others:
 *
 *   engage:view:self   read the feed, answer a poll, give recognition, answer eNPS
 *   engage:edit:org    create/publish/delete announcements, create and launch
 *                      polls and read their results, create badges, launch eNPS
 *                      and read its results
 *
 * There is no team scope anywhere in this module. The audience is the whole
 * company by design; the only narrowing is an announcement's optional
 * role/department targeting, which the SERVICE applies inside the query.
 *
 * Collection reads carry no resource check: the service narrows by visibility,
 * which is the only way a feed can be both targeted and paginated.
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
  createAnnouncementSchema,
  announcementListQuerySchema,
  createPollSchema,
  pollAnswerSchema,
  pollListQuerySchema,
  createBadgeSchema,
  giveRecognitionSchema,
  recognitionListQuerySchema,
  createEnpsSchema,
  submitEnpsSchema,
  enpsListQuerySchema,
} from '../../../shared/schemas/engage.js';
import * as controller from './engage.controller.js';

const router = express.Router();

/**
 * Everyone in the company.
 *
 * `edit:org` outranks `view:self` by scope, so an HR admin satisfies this too
 * without a second spec.
 */
const canParticipate = requirePermission(
  { module: M.ENGAGE, action: A.EDIT, scope: S.ORG },
  { module: M.ENGAGE, action: A.VIEW, scope: S.SELF },
);

/** HR's surface: publishing, launching, and reading aggregated results. */
const canManage = requirePermission({ module: M.ENGAGE, action: A.EDIT, scope: S.ORG });

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

router.get(
  '/announcements',
  canParticipate,
  validate({ query: announcementListQuerySchema }),
  controller.listAnnouncements,
);

router.get('/announcements/:id', canParticipate, controller.getAnnouncement);

router.post(
  '/announcements',
  canManage,
  validate({ body: createAnnouncementSchema }),
  controller.createAnnouncement,
);

router.post('/announcements/:id/publish', canManage, controller.publishAnnouncement);

router.delete('/announcements/:id', canManage, controller.deleteAnnouncement);

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------
//
// `/polls/:id/results` is HR-only while `/polls/:id` is not: a respondent may
// see the question they were asked, and only HR sees what everybody answered.

router.get('/polls', canParticipate, validate({ query: pollListQuerySchema }), controller.listPolls);

router.get('/polls/:id', canParticipate, controller.getPoll);

router.post('/polls', canManage, validate({ body: createPollSchema }), controller.createPoll);

/** The launch step the reference has no endpoint for. */
router.post('/polls/:id/launch', canManage, controller.launchPoll);

router.post(
  '/polls/:id/respond',
  canParticipate,
  validate({ body: pollAnswerSchema }),
  controller.respondToPoll,
);

router.get('/polls/:id/results', canManage, controller.pollResults);

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------
//
// Giving recognition is `view:self`, as the reference has it — kudos are
// peer-to-peer and not an HR act. Only the BADGE catalogue is HR's.

router.get(
  '/recognitions/wall',
  canParticipate,
  validate({ query: recognitionListQuerySchema }),
  controller.recognitionWall,
);

router.get(
  '/recognitions/received',
  canParticipate,
  validate({ query: recognitionListQuerySchema }),
  controller.recognitionsReceived,
);

router.get(
  '/recognitions/given',
  canParticipate,
  validate({ query: recognitionListQuerySchema }),
  controller.recognitionsGiven,
);

router.post(
  '/recognitions',
  canParticipate,
  validate({ body: giveRecognitionSchema }),
  controller.giveRecognition,
);

router.get('/badges', canParticipate, controller.listBadges);

router.post('/badges', canManage, validate({ body: createBadgeSchema }), controller.createBadge);

// ---------------------------------------------------------------------------
// eNPS
// ---------------------------------------------------------------------------

router.get('/enps', canParticipate, validate({ query: enpsListQuerySchema }), controller.listEnpsSurveys);

router.post('/enps', canManage, validate({ body: createEnpsSchema }), controller.createEnpsSurvey);

router.post(
  '/enps/:id/respond',
  canParticipate,
  validate({ body: submitEnpsSchema }),
  controller.submitEnpsResponse,
);

router.get('/enps/:id/results', canManage, controller.enpsResults);

export default router;
