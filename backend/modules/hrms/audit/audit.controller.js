/**
 * Audit log HTTP handlers.
 *
 * Express 4 will not forward a rejected promise, so both catch explicitly.
 */

import * as audit from './audit.service.js';

const ok = (res, data) => res.status(200).json({ success: true, data });

/** GET /api/v1/hrms/audit-logs */
export const list = async (req, res, next) => {
  try {
    return ok(res, await audit.listAuditLogs(req.query));
  } catch (error) {
    return next(error);
  }
};

/** GET /api/v1/hrms/audit-logs/actions — the filter dropdown's options. */
export const actions = async (req, res, next) => {
  try {
    return ok(res, await audit.listAuditActions());
  } catch (error) {
    return next(error);
  }
};

export default { list, actions };
