/**
 * Reports HTTP handlers.
 *
 * Three, matching the reference's controller one for one.
 *
 * Every handler catches and calls `next(error)`, which is the house pattern and
 * not decoration: this is Express 4, where a rejected promise from an async
 * handler is NOT forwarded to the error middleware. Without the catch an
 * `HrmsForbiddenError` becomes an unhandled rejection rather than a 403.
 */

import * as service from './report.service.js';

const ok = (res, data) => res.status(200).json({ success: true, data });

/** GET /api/v1/hrms/reports/catalog */
export const catalog = (req, res, next) => {
  try {
    return ok(res, service.catalog(req.hrmsActor));
  } catch (error) {
    return next(error);
  }
};

/** GET /api/v1/hrms/reports/:key/run */
export const run = async (req, res, next) => {
  try {
    const data = await service.run(req.params.key, req.hrmsActor, req.query, req);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
};

/**
 * GET /api/v1/hrms/reports/:key/export.csv
 *
 * The filename comes from the DEFINITION's key, not from the URL parameter.
 * The reference interpolates `:key` straight into the header — safe only
 * because the registry lookup happens to reject unknown keys first, which is
 * one refactor away from header injection. Taking the name from the object the
 * lookup returned removes the question.
 *
 * `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff` so a
 * browser downloads the file rather than rendering it, whatever it contains.
 */
export const exportCsv = async (req, res, next) => {
  try {
    const { csv, filename, rows, total, truncated } = await service.exportCsv(
      req.params.key,
      req.hrmsActor,
      req.query,
      req,
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // So the caller can tell a capped export from a complete one.
    res.setHeader('X-Report-Rows', String(rows));
    res.setHeader('X-Report-Total', String(total));
    res.setHeader('X-Report-Truncated', truncated ? 'true' : 'false');

    return res.status(200).send(csv);
  } catch (error) {
    return next(error);
  }
};

export default { catalog, run, exportCsv };
