/**
 * Asset HTTP handlers.
 *
 * Every response is `{ success: true, data }` — the envelope every HRMS
 * controller uses and a test enforces across all of them. The reference returns
 * bare objects and arrays.
 */

import * as assets from './asset.service.js';

const context = (req) => ({ user: req.user, req });

// ---- categories -----------------------------------------------------------

/** GET /api/v1/hrms/assets/categories */
export const listCategories = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await assets.listCategories() });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/assets/categories */
export const createCategory = async (req, res, next) => {
  try {
    const data = await assets.createCategory(req.body, req.hrmsActor, context(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/assets/categories/:id */
export const updateCategory = async (req, res, next) => {
  try {
    const data = await assets.updateCategory(
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

/** DELETE /api/v1/hrms/assets/categories/:id — soft. */
export const deleteCategory = async (req, res, next) => {
  try {
    const data = await assets.deleteCategory(req.params.id, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---- inventory ------------------------------------------------------------

/** GET /api/v1/hrms/assets/items */
export const listItems = async (req, res, next) => {
  try {
    const data = await assets.listItems(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/assets/items/:id */
export const getItem = async (req, res, next) => {
  try {
    const data = await assets.getItem(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/assets/items */
export const createItem = async (req, res, next) => {
  try {
    const data = await assets.createItem(req.body, req.hrmsActor, context(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/assets/items/:id */
export const updateItem = async (req, res, next) => {
  try {
    const data = await assets.updateItem(req.params.id, req.body, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/assets/items/:id/status */
export const setItemStatus = async (req, res, next) => {
  try {
    const data = await assets.setItemStatus(
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

// ---- assignment -----------------------------------------------------------

/** POST /api/v1/hrms/assets/items/assign */
export const assignItem = async (req, res, next) => {
  try {
    const data = await assets.assignItem(req.body, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/assets/items/:id/return */
export const returnItem = async (req, res, next) => {
  try {
    const data = await assets.returnItem(req.params.id, req.body, req.hrmsActor, context(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/assets/assignments/me */
export const myAssignments = async (req, res, next) => {
  try {
    const data = await assets.assignmentsForEmployee(null, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/hrms/assets/assignments/employee/:employeeId
 *
 * What one person is holding. Used by an IT admin working the `it` clearance on
 * an exit — see documentation/hrms-assets-analysis.md §9.1.
 */
export const employeeAssignments = async (req, res, next) => {
  try {
    const data = await assets.assignmentsForEmployee(req.params.employeeId, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---- requests -------------------------------------------------------------

/** GET /api/v1/hrms/assets/requests */
export const listRequests = async (req, res, next) => {
  try {
    const data = await assets.listRequests(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/assets/requests */
export const createRequest = async (req, res, next) => {
  try {
    const data = await assets.createRequest(req.body, req.hrmsActor, context(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/assets/requests/:id/decide */
export const decideRequest = async (req, res, next) => {
  try {
    const data = await assets.decideRequest(
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

/** POST /api/v1/hrms/assets/requests/:id/fulfill */
export const fulfillRequest = async (req, res, next) => {
  try {
    const data = await assets.fulfillRequest(
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

/** POST /api/v1/hrms/assets/requests/:id/cancel */
export const cancelRequest = async (req, res, next) => {
  try {
    const data = await assets.cancelRequest(req.params.id, req.hrmsActor, context(req));
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
  listItems,
  getItem,
  createItem,
  updateItem,
  setItemStatus,
  assignItem,
  returnItem,
  myAssignments,
  employeeAssignments,
  listRequests,
  createRequest,
  decideRequest,
  fulfillRequest,
  cancelRequest,
};
