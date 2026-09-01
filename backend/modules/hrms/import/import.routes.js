/**
 * Employee import routes, mounted at /api/v1/hrms/imports/employees.
 *
 * The pipeline is source-agnostic (AD-11): these endpoints accept canonical
 * records directly. When a source is chosen, its adapter produces that shape
 * and an upload endpoint is added beside these - the stages below do not change.
 *
 * NO ADAPTER IS SHIPPED, so there is deliberately no upload route yet.
 */

import express from 'express';

import { requirePermission } from '../../../middlewares/hrmsAuth.js';
import { previewImport, commitImport } from './pipeline.js';
import {
  registeredImportAdapters,
  getEmployeePersistence,
} from './adapter.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';

const router = express.Router();

// Importing employees creates accounts, so it needs the create permission -
// not merely edit.
const canImport = requirePermission({ module: M.EMPLOYEES, action: A.CREATE, scope: S.ORG });

const MAX_RECORDS_PER_REQUEST = Number(process.env.HRMS_IMPORT_MAX_RECORDS ?? 5000);

const readRecords = (req, res) => {
  const records = req.body?.records;
  if (!Array.isArray(records)) {
    res.status(400).json({ success: false, message: '"records" must be an array.' });
    return null;
  }
  if (records.length > MAX_RECORDS_PER_REQUEST) {
    res.status(413).json({
      success: false,
      message: `Too many records in one request (max ${MAX_RECORDS_PER_REQUEST}). Split the import.`,
    });
    return null;
  }
  return records;
};

/** GET /status - what is wired up, so the UI can say why a commit is unavailable. */
router.get('/status', canImport, (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      adapters: registeredImportAdapters(),
      persistenceRegistered: Boolean(getEmployeePersistence()),
      maxRecordsPerRequest: MAX_RECORDS_PER_REQUEST,
      note:
        'AD-11: the migration source is not decided. The pipeline is complete; ' +
        'only a source adapter and the Phase 1 persistence port remain.',
    },
  });
});

/**
 * POST /preview
 *
 * Validates, sanitises and dependency-checks without writing anything. This is
 * what an operator approves before a commit.
 */
router.post('/preview', canImport, async (req, res, next) => {
  try {
    const records = readRecords(req, res);
    if (!records) return undefined;

    const report = await previewImport(records);

    await recordAudit(
      req.user,
      AUDIT_ACTIONS.IMPORT_PREVIEWED,
      `Previewed an employee import of ${records.length} record(s): ${report.totals.importable} importable, ${report.totals.errors} error(s)`,
      req,
      { meta: { totals: report.totals } },
    );

    return res.status(200).json({ success: true, data: report });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /commit
 *
 * Runs the preview again and refuses if it reports any error - a partial
 * migration is worse than none, because the retry has to reason about what the
 * first attempt already wrote.
 */
router.post('/commit', canImport, async (req, res, next) => {
  try {
    const records = readRecords(req, res);
    if (!records) return undefined;

    const outcome = await commitImport(records);

    if (!outcome.committed) {
      return res.status(422).json({
        success: false,
        message: outcome.reason,
        data: outcome.preview,
      });
    }

    await recordAudit(
      req.user,
      AUDIT_ACTIONS.IMPORT_COMMITTED,
      `Committed an employee import: ${outcome.result.created} created, ${outcome.result.updated} updated`,
      req,
      { meta: outcome.result },
    );

    return res.status(200).json({ success: true, data: outcome });
  } catch (error) {
    // The port not being registered is a wiring state, not a server fault.
    if (/No employee persistence port is registered/.test(error.message)) {
      return res.status(503).json({ success: false, message: error.message });
    }
    return next(error);
  }
});

export default router;
