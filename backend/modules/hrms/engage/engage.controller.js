/**
 * Engage HTTP layer.
 *
 * Thin, as every other HRMS controller is: validation in the `validate`
 * middleware, authorization in `requirePermission` and re-checked in the
 * services, business rules and audit in the services.
 *
 * One controller over four services, as the reference has it — its own header
 * gives the reason, and it holds here too: these share one audience and differ
 * only in the permission on their write endpoints.
 *
 * Every payload goes UNDER `data`, never spread beside it — the envelope bug
 * that once killed the employee directory.
 */

import * as announcements from './announcement.service.js';
import * as polls from './poll.service.js';
import * as recognitions from './recognition.service.js';
import * as enps from './enps.service.js';

/**
 * The actor is taken from the SESSION, never from the body or the path.
 *
 * Engage has several endpoints that record "who did this" — a poll response, a
 * recognition, an eNPS answer — and not one of them accepts an identity from
 * the client.
 */
const contextOf = (req) => ({
  user: req.user,
  req,
  actor: req.hrmsActor,
  actorEmployeeId: req.hrmsActor?.employeeId ?? null,
});

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export const listAnnouncements = handler(async (req, res) =>
  ok(res, await announcements.listAnnouncements(req.validated?.query ?? req.query, req.hrmsActor)),
);

export const getAnnouncement = handler(async (req, res) =>
  ok(res, await announcements.getAnnouncement(req.params.id, req.hrmsActor)),
);

export const createAnnouncement = handler(async (req, res) =>
  ok(res, await announcements.createAnnouncement(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const publishAnnouncement = handler(async (req, res) =>
  ok(res, await announcements.publishAnnouncement(req.params.id, contextOf(req))),
);

export const deleteAnnouncement = handler(async (req, res) => {
  await announcements.deleteAnnouncement(req.params.id, contextOf(req));
  // 204, as the reference returns. There is nothing meaningful to hand back.
  return res.status(204).send();
});

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export const listPolls = handler(async (req, res) =>
  ok(res, await polls.listPolls(req.validated?.query ?? req.query, req.hrmsActor)),
);

export const getPoll = handler(async (req, res) =>
  ok(res, await polls.getPoll(req.params.id, req.hrmsActor)),
);

export const createPoll = handler(async (req, res) =>
  ok(res, await polls.createPoll(req.validated?.body ?? req.body, contextOf(req)), 201),
);

/** The endpoint the reference lacks, which is why its drafts are unreachable. */
export const launchPoll = handler(async (req, res) =>
  ok(res, await polls.launchPoll(req.params.id, contextOf(req))),
);

export const respondToPoll = handler(async (req, res) =>
  ok(res, await polls.respondToPoll(req.params.id, req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const pollResults = handler(async (req, res) =>
  ok(res, await polls.pollResults(req.params.id)),
);

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

export const recognitionWall = handler(async (req, res) =>
  ok(res, await recognitions.recognitionWall(req.validated?.query ?? req.query, req.hrmsActor)),
);

export const recognitionsReceived = handler(async (req, res) =>
  ok(res, await recognitions.recognitionsReceived(req.validated?.query ?? req.query, req.hrmsActor)),
);

export const recognitionsGiven = handler(async (req, res) =>
  ok(res, await recognitions.recognitionsGiven(req.validated?.query ?? req.query, req.hrmsActor)),
);

export const giveRecognition = handler(async (req, res) =>
  ok(res, await recognitions.giveRecognition(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const listBadges = handler(async (req, res) => ok(res, await recognitions.listBadges()));

export const createBadge = handler(async (req, res) =>
  ok(res, await recognitions.createBadge(req.validated?.body ?? req.body, contextOf(req)), 201),
);

// ---------------------------------------------------------------------------
// eNPS
// ---------------------------------------------------------------------------

export const listEnpsSurveys = handler(async (req, res) =>
  ok(res, await enps.listEnpsSurveys(req.validated?.query ?? req.query, req.hrmsActor)),
);

export const createEnpsSurvey = handler(async (req, res) =>
  ok(res, await enps.createEnpsSurvey(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const submitEnpsResponse = handler(async (req, res) =>
  ok(res, await enps.submitEnpsResponse(req.params.id, req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const enpsResults = handler(async (req, res) =>
  ok(res, await enps.enpsResults(req.params.id)),
);

export default {
  listAnnouncements,
  getAnnouncement,
  createAnnouncement,
  publishAnnouncement,
  deleteAnnouncement,
  listPolls,
  getPoll,
  createPoll,
  launchPoll,
  respondToPoll,
  pollResults,
  recognitionWall,
  recognitionsReceived,
  recognitionsGiven,
  giveRecognition,
  listBadges,
  createBadge,
  listEnpsSurveys,
  createEnpsSurvey,
  submitEnpsResponse,
  enpsResults,
};
