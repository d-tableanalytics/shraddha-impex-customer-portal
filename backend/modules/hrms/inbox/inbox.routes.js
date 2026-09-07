/**
 * Inbox routes, mounted at /api/v1/hrms/inbox.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant. Each route adds its own permission.
 *
 * Inbox has exactly ONE permission spec, and the reference uses no others —
 * every one of its four endpoints, reads and writes alike, carries it:
 *
 *   inbox:view:self
 *
 * It sits in the self baseline, so every HRMS role has it. That is not a hole:
 * the grant says "you may see YOUR inbox", and the scope is enforced by the
 * service, which puts the actor's own employee id in every filter. There is no
 * org scope and no admin view of anybody else's inbox — in either codebase.
 *
 * Portal Customers hold no HRMS grant at all, so `requireHrmsAccess` refuses
 * them before any of this. Nothing here changes that.
 *
 * 🔴 There is no POST that creates an item. The reference has none either, and
 * that is the single most important thing about this surface: a notification's
 * recipient is derived from a business event on the server, so no request can
 * address one to somebody else.
 */

import express from 'express';

import { requirePermission } from '../../../middlewares/hrmsAuth.js';
import { validate } from '../../../middlewares/validate.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import { listInboxQuery, inboxIdsSchema } from '../../../shared/schemas/inbox.js';
import * as controller from './inbox.controller.js';

const router = express.Router();

/** The whole module, reads and writes. */
const canUseInbox = requirePermission({ module: M.INBOX, action: A.VIEW, scope: S.SELF });

router.get('/', canUseInbox, validate({ query: listInboxQuery }), controller.list);

/**
 * Registered before `/:id`-shaped routes so "unread-count" is never read as an
 * id. It is also the most-hit endpoint in the app, being polled.
 */
router.get('/unread-count', canUseInbox, controller.unreadCount);

router.post(
  '/read',
  canUseInbox,
  validate({ body: inboxIdsSchema }),
  controller.markManyRead,
);

router.post('/read-all', canUseInbox, controller.markAllRead);

/** No equivalent in the reference: once read, permanently read. */
router.post(
  '/archive',
  canUseInbox,
  validate({ body: inboxIdsSchema }),
  controller.archive,
);

router.post('/:id/read', canUseInbox, controller.markRead);
router.post('/:id/unread', canUseInbox, controller.markUnread);

export default router;
