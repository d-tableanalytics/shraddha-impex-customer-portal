/**
 * Org Structure HTTP layer.
 *
 * Thin, exactly as Employee Master's controller is: validation happens in the
 * `validate` middleware, authorization in `requirePermission`, business rules
 * and the audit entry in the service. What remains here is shaping the
 * response.
 *
 * ---------------------------------------------------------------------------
 * The envelope
 * ---------------------------------------------------------------------------
 * Every payload goes UNDER `data`, never spread beside it. The employee list
 * shipped as `json({ success: true, ...result })`, the client unwrapped one
 * level and got a bare array, and the directory died on `rows.length`. A test
 * now scans every HRMS controller for a spread in property position; these
 * endpoints are written to pass it by construction, not by luck.
 *
 * The reference returns bare payloads with no envelope at all, and 204 with an
 * empty body on delete. Neither is followed: this codebase has one response
 * shape and every HRMS client unwraps it the same way.
 */

import * as departmentService from './department.service.js';
import * as locationService from './location.service.js';
import { getOrgChart } from './orgChart.service.js';

/**
 * The audit context every write hands to the service.
 *
 * The services record the audit themselves so a future seed or import cannot
 * skip it; they need the user and the request to attribute the entry.
 */
const contextOf = (req) => ({ user: req.user, req });

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

/** GET /api/v1/hrms/org/departments */
export const listDepartments = async (req, res, next) => {
  try {
    const data = await departmentService.listDepartments({
      includeDeleted: req.query.includeDeleted === true,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/org/departments/:id */
export const getDepartment = async (req, res, next) => {
  try {
    const data = await departmentService.getDepartment(req.params.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/org/departments */
export const createDepartment = async (req, res, next) => {
  try {
    const data = await departmentService.createDepartment(req.body, contextOf(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/org/departments/:id */
export const updateDepartment = async (req, res, next) => {
  try {
    const data = await departmentService.updateDepartment(req.params.id, req.body, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/v1/hrms/org/departments/:id
 *
 * Soft (O-3). The service refuses while any live employee still references it,
 * and 200-with-a-body rather than the reference's 204 so the caller gets the
 * same envelope as every other endpoint.
 */
export const deleteDepartment = async (req, res, next) => {
  try {
    const data = await departmentService.deleteDepartment(req.params.id, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** GET /api/v1/hrms/org/locations */
export const listLocations = async (req, res, next) => {
  try {
    const data = await locationService.listLocations({
      includeDeleted: req.query.includeDeleted === true,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/org/locations/:id */
export const getLocation = async (req, res, next) => {
  try {
    const data = await locationService.getLocation(req.params.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/org/locations */
export const createLocation = async (req, res, next) => {
  try {
    const data = await locationService.createLocation(req.body, contextOf(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/org/locations/:id */
export const updateLocation = async (req, res, next) => {
  try {
    const data = await locationService.updateLocation(req.params.id, req.body, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/v1/hrms/org/locations/:id — soft, guarded (O-3). */
export const deleteLocation = async (req, res, next) => {
  try {
    const data = await locationService.deleteLocation(req.params.id, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/hrms/org/tree
 *
 * A flat list, as the reference returns; the client assembles the tree. Read
 * only, so nothing is audited — the reference audits none of its reads either,
 * and an entry per chart view would bury the accesses that matter.
 */
export const getTree = async (req, res, next) => {
  try {
    const data = await getOrgChart(req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
