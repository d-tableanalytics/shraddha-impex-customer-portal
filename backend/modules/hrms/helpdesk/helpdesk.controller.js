/**
 * Helpdesk HTTP handlers.
 *
 * Every response is `{ success: true, data }` — the envelope every HRMS
 * controller uses and a test enforces across all of them. The reference returns
 * bare objects and a `{ items, total }` shape for one endpoint only.
 */

import * as helpdesk from './helpdesk.service.js';

const context = (req) => ({ user: req.user, req });

// ---- categories -----------------------------------------------------------

/** GET /api/v1/hrms/helpdesk/categories */
export const listCategories = async (req, res, next) => {
  try {
    const data = await helpdesk.listCategories(req.hrmsActor, {
      // A query-string value is always a string; `=== true` never matches.
      includeInactive: req.query.includeInactive === 'true',
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/helpdesk/categories */
export const createCategory = async (req, res, next) => {
  try {
    const data = await helpdesk.createCategory(req.body, req.hrmsActor, context(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/helpdesk/categories/:id */
export const updateCategory = async (req, res, next) => {
  try {
    const data = await helpdesk.updateCategory(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/v1/hrms/helpdesk/categories/:id — soft. */
export const deleteCategory = async (req, res, next) => {
  try {
    const data = await helpdesk.deleteCategory(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---- tickets --------------------------------------------------------------

/** GET /api/v1/hrms/helpdesk/tickets */
export const listTickets = async (req, res, next) => {
  try {
    const data = await helpdesk.listTickets(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/helpdesk/tickets/me — the caller's own. */
export const myTickets = async (req, res, next) => {
  try {
    const data = await helpdesk.listTickets(req.hrmsActor, { ...req.query, mine: 'true' });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/helpdesk/tickets/:id */
export const getTicket = async (req, res, next) => {
  try {
    const data = await helpdesk.getTicket(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/helpdesk/tickets */
export const createTicket = async (req, res, next) => {
  try {
    const data = await helpdesk.createTicket(req.body, req.hrmsActor, context(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/helpdesk/tickets/:id */
export const updateTicket = async (req, res, next) => {
  try {
    const data = await helpdesk.updateTicket(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/helpdesk/tickets/:id/assign */
export const assignTicket = async (req, res, next) => {
  try {
    const data = await helpdesk.assignTicket(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/helpdesk/tickets/:id/status */
export const changeStatus = async (req, res, next) => {
  try {
    const data = await helpdesk.changeStatus(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/helpdesk/tickets/:id/comments */
export const addComment = async (req, res, next) => {
  try {
    const data = await helpdesk.addComment(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---- knowledge base -------------------------------------------------------

/** GET /api/v1/hrms/helpdesk/kb */
export const listArticles = async (req, res, next) => {
  try {
    const data = await helpdesk.listArticles(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/helpdesk/kb/:id */
export const getArticle = async (req, res, next) => {
  try {
    const data = await helpdesk.getArticle(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/helpdesk/kb */
export const createArticle = async (req, res, next) => {
  try {
    const data = await helpdesk.createArticle(req.body, req.hrmsActor, context(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/helpdesk/kb/:id */
export const updateArticle = async (req, res, next) => {
  try {
    const data = await helpdesk.updateArticle(
      req.params.id,
      req.body,
      req.hrmsActor,
      context(req),
    );
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/v1/hrms/helpdesk/kb/:id — soft. */
export const deleteArticle = async (req, res, next) => {
  try {
    const data = await helpdesk.deleteArticle(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export default {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listTickets,
  myTickets,
  getTicket,
  createTicket,
  updateTicket,
  assignTicket,
  changeStatus,
  addComment,
  listArticles,
  getArticle,
  createArticle,
  updateArticle,
  deleteArticle,
};
