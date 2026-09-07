/**
 * Onboarding HTTP layer.
 *
 * Thin, as every other HRMS controller is: validation in the `validate`
 * middleware, authorization in `requirePermission` and re-checked in the
 * services, business rules and audit in the services.
 *
 * Every payload goes UNDER `data`, never spread beside it — the envelope bug
 * that once killed the employee directory.
 */

import * as templates from './template.service.js';
import * as checklists from './checklist.service.js';
import * as offerLetters from './offerLetter.service.js';
import { FileAccessError } from '../storage/storage.service.js';

/**
 * The actor is taken from the SESSION, never from the body or the path.
 *
 * `actor` carries the resolved permission set and the caller's own employee id;
 * every scope decision in the services reads it from here.
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
    if (error instanceof FileAccessError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const listTemplates = handler(async (req, res) =>
  ok(res, await templates.listTemplates(req.validated?.query ?? req.query)),
);

export const getTemplate = handler(async (req, res) =>
  ok(res, await templates.getTemplate(req.params.id)),
);

export const createTemplate = handler(async (req, res) =>
  ok(res, await templates.createTemplate(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const updateTemplate = handler(async (req, res) =>
  ok(res, await templates.updateTemplate(req.params.id, req.validated?.body ?? req.body, contextOf(req))),
);

export const retireTemplate = handler(async (req, res) => {
  await templates.retireTemplate(req.params.id, contextOf(req));
  // 204, as the reference returns. There is nothing meaningful to hand back.
  return res.status(204).send();
});

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export const listChecklists = handler(async (req, res) =>
  ok(res, await checklists.listChecklists(req.validated?.query ?? req.query, req.hrmsActor)),
);

export const getChecklist = handler(async (req, res) =>
  ok(res, await checklists.getChecklist(req.params.id, req.hrmsActor)),
);

/** The caller's own checklist. No id is accepted — it comes from the session. */
export const myChecklist = handler(async (req, res) =>
  ok(res, await checklists.myChecklist(req.hrmsActor)),
);

export const startChecklist = handler(async (req, res) =>
  ok(res, await checklists.startChecklist(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const cancelChecklist = handler(async (req, res) =>
  ok(res, await checklists.cancelChecklist(req.params.id, req.validated?.body ?? req.body, contextOf(req))),
);

export const updateTask = handler(async (req, res) =>
  ok(
    res,
    await checklists.updateTask(
      req.params.id,
      req.params.taskId,
      req.validated?.body ?? req.body,
      contextOf(req),
    ),
  ),
);

/** Every onboarding task assigned to the caller, across checklists. */
export const listMyTasks = handler(async (req, res) =>
  ok(res, await checklists.listMyTasks(req.hrmsActor, req.validated?.query ?? req.query)),
);

// ---------------------------------------------------------------------------
// Offer letters
// ---------------------------------------------------------------------------

export const listOfferLetters = handler(async (req, res) =>
  ok(res, await offerLetters.listOfferLetters(req.validated?.query ?? req.query)),
);

export const listOfferLettersForEmployee = handler(async (req, res) =>
  ok(
    res,
    await offerLetters.listOfferLettersForEmployee(req.params.employeeId, req.hrmsActor),
  ),
);

/** The caller's own offers. No id on the wire. */
export const myOfferLetters = handler(async (req, res) =>
  ok(res, await offerLetters.myOfferLetters(req.hrmsActor)),
);

export const createOfferLetter = handler(async (req, res) =>
  ok(res, await offerLetters.createOfferLetter(req.validated?.body ?? req.body, contextOf(req)), 201),
);

export const sendOfferLetter = handler(async (req, res) =>
  ok(res, await offerLetters.sendOfferLetter(req.params.id, contextOf(req))),
);

export const signOfferLetter = handler(async (req, res) =>
  ok(res, await offerLetters.signOfferLetter(req.params.id, req.validated?.body ?? req.body, contextOf(req))),
);

export const rejectOfferLetter = handler(async (req, res) =>
  ok(res, await offerLetters.rejectOfferLetter(req.params.id, req.validated?.body ?? req.body, contextOf(req))),
);

/**
 * A short-lived URL for the generated letter.
 *
 * The reference streams a PDF through the API on every view. Here the storage
 * layer authorises, audits the issuance and presigns — the same path résumés,
 * receipts and relieving letters take.
 */
export const offerLetterUrl = handler(async (req, res) =>
  ok(res, await offerLetters.issueOfferLetterUrl(req.params.id, req.hrmsActor, req)),
);

export default {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  retireTemplate,
  listChecklists,
  getChecklist,
  myChecklist,
  startChecklist,
  cancelChecklist,
  updateTask,
  listMyTasks,
  listOfferLetters,
  listOfferLettersForEmployee,
  myOfferLetters,
  createOfferLetter,
  sendOfferLetter,
  signOfferLetter,
  rejectOfferLetter,
  offerLetterUrl,
};
