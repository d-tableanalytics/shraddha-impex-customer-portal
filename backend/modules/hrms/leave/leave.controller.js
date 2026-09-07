/**
 * Leave and Holiday HTTP layer.
 *
 * Thin, as Employee Master's and Org Structure's controllers are: validation in
 * the `validate` middleware and the service, authorization in
 * `requirePermission` plus the service's own resource check, business rules and
 * audit in the service.
 *
 * Every payload goes UNDER `data`, never spread beside it — the mistake that
 * once took the employee directory down, and which a test now scans every HRMS
 * controller for.
 */

import * as leave from './leave.service.js';
import * as holidays from './holiday.service.js';

const contextOf = (req) => ({ user: req.user, req });

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

/** GET /api/v1/hrms/leave/types */
export const listLeaveTypes = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await leave.listLeaveTypes(req.hrmsActor) });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/hrms/leave/types
 *
 * An addition: the reference has no endpoint for this and seeds its types from
 * a script, which leaves no supported way to add one afterwards. Gated on
 * `leave:edit:org`, the same grant that manages holidays.
 */
export const createLeaveType = async (req, res, next) => {
  try {
    const data = await leave.createLeaveType(req.body, contextOf(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/** GET /api/v1/hrms/leave/balances/me */
export const myBalances = async (req, res, next) => {
  try {
    const actor = req.hrmsActor;
    const data = await leave.listBalances(actor?.employeeId, actor, { year: req.query.year });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/hrms/leave/balances/:employeeId
 *
 * The route guard admits anyone with a leave view grant; the service checks
 * this particular employee against the actor's scope.
 */
export const employeeBalances = async (req, res, next) => {
  try {
    const data = await leave.listBalances(req.params.employeeId, req.hrmsActor, {
      year: req.query.year,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** GET /api/v1/hrms/leave/requests */
export const listRequests = async (req, res, next) => {
  try {
    const data = await leave.listRequests(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/hrms/leave/requests
 *
 * Always filed for the ACTOR. No employeeId is read from the payload, so a
 * browser cannot request leave on someone else's behalf.
 */
export const createRequest = async (req, res, next) => {
  try {
    const data = await leave.createRequest(req.body, req.hrmsActor, contextOf(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/leave/requests/:id/decide */
export const decideRequest = async (req, res, next) => {
  try {
    const data = await leave.decideRequest(req.params.id, req.body, req.hrmsActor, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/leave/requests/:id/cancel */
export const cancelRequest = async (req, res, next) => {
  try {
    const data = await leave.cancelRequest(req.params.id, req.hrmsActor, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/leave/calendar?from=&to= */
export const calendar = async (req, res, next) => {
  try {
    const data = await leave.calendar(req.hrmsActor, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

/** GET /api/v1/hrms/holidays?year= */
export const listHolidays = async (req, res, next) => {
  try {
    const year = req.query.year ?? new Date().getUTCFullYear();
    res.status(200).json({ success: true, data: await holidays.listHolidays({ year }) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/holidays/years */
export const listHolidayYears = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await holidays.listHolidayYears() });
  } catch (error) {
    next(error);
  }
};

export const createHoliday = async (req, res, next) => {
  try {
    const data = await holidays.createHoliday(req.body, contextOf(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateHoliday = async (req, res, next) => {
  try {
    const data = await holidays.updateHoliday(req.params.id, req.body, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** Soft delete, matching every other HRMS catalogue. */
export const deleteHoliday = async (req, res, next) => {
  try {
    const data = await holidays.deleteHoliday(req.params.id, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const bulkImportHolidays = async (req, res, next) => {
  try {
    const data = await holidays.bulkImportHolidays(req.body, contextOf(req));
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
