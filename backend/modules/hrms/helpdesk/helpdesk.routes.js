/**
 * Helpdesk routes, mounted at /api/v1/hrms/helpdesk.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission at its own scope.
 *
 * Permissions are the reference's own module keys — no matrix change was
 * needed, because Shraddha already grants exactly what CLAUDE.md §4.2
 * describes:
 *
 *   read a ticket, the catalogue,
 *   the knowledge base            helpdesk:view:self
 *   raise a ticket, comment,
 *   close or reopen my own        helpdesk:submit:self
 *   work a queue                  ANY-OF helpdesk:{hr,payroll,it}:resolve:org
 *                                 or helpdesk:resolve:org
 *   administer the catalogue      helpdesk:resolve:org
 *
 * The gate at the route admits any resolver; the SERVICE then requires the
 * grant for that ticket's own category. That two-step is the whole correction
 * to the reference, which collapses the three category grants into one boolean
 * and lets an IT admin read HR grievances.
 *
 * The reference's own route/service disagreement is also gone: it gates PATCH
 * on `helpdesk:resolve:org` (super admin only) while its service accepts any of
 * the four, so a category resolver is blocked from the action the service was
 * written to allow.
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
  createTicketCategorySchema,
  updateTicketCategorySchema,
  createTicketSchema,
  updateTicketSchema,
  assignTicketSchema,
  changeTicketStatusSchema,
  createTicketCommentSchema,
  createKbArticleSchema,
  updateKbArticleSchema,
} from '../../../shared/schemas/helpdesk.js';
import * as controller from './helpdesk.controller.js';

const router = express.Router();

/** Anyone with the self-service baseline. Wider scopes satisfy it by ranking. */
const canView = requirePermission({ module: M.HELPDESK, action: A.VIEW, scope: S.SELF });

/** Raising a ticket, commenting, and closing or reopening one's own. */
const canSubmit = requirePermission({ module: M.HELPDESK, action: A.SUBMIT, scope: S.SELF });

/**
 * Any resolver team. The service narrows to the ticket's own category, so this
 * gate is deliberately the union and never the decision.
 */
const canResolve = requirePermission(
  { module: M.HELPDESK, action: A.RESOLVE, scope: S.ORG },
  { module: M.HELPDESK_HR, action: A.RESOLVE, scope: S.ORG },
  { module: M.HELPDESK_PAYROLL, action: A.RESOLVE, scope: S.ORG },
  { module: M.HELPDESK_IT, action: A.RESOLVE, scope: S.ORG },
);

/** The catalogue decides which team answers for what — a super-admin call. */
const canAdminister = requirePermission({
  module: M.HELPDESK,
  action: A.RESOLVE,
  scope: S.ORG,
});

// ---------------------------------------------------------------------------
// Categories. Declared before `/tickets/:id` cannot shadow them anyway, but
// kept together for readability.
// ---------------------------------------------------------------------------

router.get('/categories', canView, controller.listCategories);
router.post(
  '/categories',
  canAdminister,
  validate({ body: createTicketCategorySchema }),
  controller.createCategory,
);
router.patch(
  '/categories/:id',
  canAdminister,
  validate({ body: updateTicketCategorySchema }),
  controller.updateCategory,
);
router.delete('/categories/:id', canAdminister, controller.deleteCategory);

// ---------------------------------------------------------------------------
// Knowledge base. `/kb` before `/kb/:id`.
// ---------------------------------------------------------------------------

router.get('/kb', canView, controller.listArticles);
router.post(
  '/kb',
  canResolve,
  validate({ body: createKbArticleSchema }),
  controller.createArticle,
);
router.patch(
  '/kb/:id',
  canResolve,
  validate({ body: updateKbArticleSchema }),
  controller.updateArticle,
);
router.delete('/kb/:id', canResolve, controller.deleteArticle);
router.get('/kb/:id', canView, controller.getArticle);

// ---------------------------------------------------------------------------
// Tickets. Fixed paths first, then the `/:id` family.
// ---------------------------------------------------------------------------

router.get('/tickets/me', canView, controller.myTickets);
router.get('/tickets', canView, controller.listTickets);
router.post(
  '/tickets',
  canSubmit,
  validate({ body: createTicketSchema }),
  controller.createTicket,
);

router.post(
  '/tickets/:id/assign',
  canResolve,
  validate({ body: assignTicketSchema }),
  controller.assignTicket,
);
/**
 * A status change is `canSubmit`, not `canResolve`: a requester may close or
 * reopen their OWN resolved ticket, and the service enforces exactly which
 * moves each party may make. The reference gives the requester nothing.
 */
router.post(
  '/tickets/:id/status',
  canSubmit,
  validate({ body: changeTicketStatusSchema }),
  controller.changeStatus,
);
router.post(
  '/tickets/:id/comments',
  canSubmit,
  validate({ body: createTicketCommentSchema }),
  controller.addComment,
);

router.patch(
  '/tickets/:id',
  canResolve,
  validate({ body: updateTicketSchema }),
  controller.updateTicket,
);
router.get('/tickets/:id', canView, controller.getTicket);

export default router;
