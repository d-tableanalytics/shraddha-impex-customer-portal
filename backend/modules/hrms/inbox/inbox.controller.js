/**
 * Inbox HTTP layer.
 *
 * ---------------------------------------------------------------------------
 * The actor is the ONLY source of identity here
 * ---------------------------------------------------------------------------
 * Every handler passes `req.hrmsActor` and nothing else that could name a
 * person. No route reads a recipient from a body, a query string or a path, and
 * there is no create endpoint at all — inbox items are produced by business
 * events, never by a request. That is what makes recipient spoofing structurally
 * impossible rather than merely checked for.
 *
 * Every payload goes UNDER `data`. 🔴 The reference returns a bare ARRAY from
 * `GET /inbox` — no envelope, no total, no page.
 */

import * as inbox from './inbox.service.js';

const contextOf = (req) => ({ user: req.user, req, actor: req.hrmsActor });

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const query = (req) => req.validated?.query ?? req.query;
const body = (req) => req.validated?.body ?? req.body;

export const list = handler(async (req, res) =>
  ok(res, await inbox.listInbox(query(req), req.hrmsActor)),
);

/** The badge. Polled every 15s per signed-in user, as the reference's is. */
export const unreadCount = handler(async (req, res) =>
  ok(res, await inbox.unreadCount(req.hrmsActor)),
);

export const markRead = handler(async (req, res) =>
  ok(res, await inbox.markRead(req.params.id, req.hrmsActor)),
);

/** No way back in the reference: once read, permanently read. */
export const markUnread = handler(async (req, res) =>
  ok(res, await inbox.markUnread(req.params.id, req.hrmsActor)),
);

export const markManyRead = handler(async (req, res) =>
  ok(res, await inbox.markManyRead(body(req).ids, req.hrmsActor, contextOf(req))),
);

export const markAllRead = handler(async (req, res) =>
  ok(res, await inbox.markAllRead(req.hrmsActor, contextOf(req))),
);

export const archive = handler(async (req, res) =>
  ok(res, await inbox.archive(body(req).ids, req.hrmsActor, contextOf(req))),
);
