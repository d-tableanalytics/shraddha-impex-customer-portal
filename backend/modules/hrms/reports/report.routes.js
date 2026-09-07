/**
 * Reports routes, mounted at /api/v1/hrms/reports.
 *
 * The parent HRMS router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds some HRMS
 * grant.
 *
 * Permissions are the reference's own module keys — no matrix change was
 * needed. Shraddha's `matrix.js` already grants the identical seven mappings
 * that `packages/rbac/src/matrix.ts` does:
 *
 *   super_admin     reports:view:org, reports:export:org
 *   hr_admin        reports:view:org
 *   payroll_admin   reports:payroll:view:org, reports:payroll:export:org
 *   manager         reports:team:view:team
 *   recruiter       reports:hiring:view:org
 *   it_admin        reports:assets:view:org
 *   auditor         reports:view:org
 *
 * TWO LAYERS, and they check different things. This gate is the union of the
 * five `reports*` keys and only decides whether the module is reachable. The
 * SERVICE then checks each report's own `moduleRequired` at its own
 * `scopeRequired` — `employees:view:org` for the directory, not `reports:*`.
 * That second check is the real gate, and it runs in `catalog`, in `run` AND in
 * `export`, so guessing a key that is missing from your catalogue is a 403.
 *
 * This is the reference's design, ported intact — it is the module's one
 * genuinely good idea. Its consequence, which the reference does not
 * acknowledge, is that `reports:payroll`, `reports:hiring`, `reports:assets`
 * and `reports:team` are dead keys: they open the door and no report behind it
 * declares them, so a payroll admin, recruiter, IT admin and manager each reach
 * an empty catalogue. That is faithfully reproduced. Inventing a payroll,
 * hiring or asset report to fill the gap would be inventing functionality.
 */

import express from 'express';

import { requirePermission } from '../../../middlewares/hrmsAuth.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import * as controller from './report.controller.js';

const router = express.Router();

/**
 * Anyone holding ANY report-related grant may reach the catalogue and attempt
 * a run. Mirrors `REPORT_PERMS` in the reference's controller, and the sidebar
 * gate in `navItems.js`, so a user who can see the nav item can load the page.
 */
const canReachReports = requirePermission(
  { module: M.REPORTS, action: A.VIEW, scope: S.ORG },
  { module: M.REPORTS_PAYROLL, action: A.VIEW, scope: S.ORG },
  { module: M.REPORTS_HIRING, action: A.VIEW, scope: S.ORG },
  { module: M.REPORTS_ASSETS, action: A.VIEW, scope: S.ORG },
  { module: M.REPORTS_TEAM, action: A.VIEW, scope: S.TEAM },
);

/**
 * Export.
 *
 * The reference's `REPORT_EXPORT_PERMS` is the four `*:export:org` grants PLUS
 * the four `*:view:org` grants, with the comment that this "mirrors the CSV
 * download button being visible whenever any report is opened" — i.e. the
 * permission was widened to match the UI, which makes `reports:export:org`
 * grant nothing that `reports:view:org` did not already grant.
 *
 * Kept, because narrowing it is a product decision rather than a defect fix:
 * doing so would take CSV export away from `hr_admin` and `auditor`, who hold
 * view-org and no export grant, and who are exactly the roles the reference
 * expects to export. The point is recorded as DTA defect D7 instead, and the
 * real protection is that the per-report check runs on export too — so this
 * gate can never widen WHICH report anyone can export.
 */
const canExport = requirePermission(
  { module: M.REPORTS, action: A.EXPORT, scope: S.ORG },
  { module: M.REPORTS_PAYROLL, action: A.EXPORT, scope: S.ORG },
  { module: M.REPORTS_HIRING, action: A.EXPORT, scope: S.ORG },
  { module: M.REPORTS_ASSETS, action: A.EXPORT, scope: S.ORG },
  { module: M.REPORTS, action: A.VIEW, scope: S.ORG },
  { module: M.REPORTS_PAYROLL, action: A.VIEW, scope: S.ORG },
  { module: M.REPORTS_HIRING, action: A.VIEW, scope: S.ORG },
  { module: M.REPORTS_ASSETS, action: A.VIEW, scope: S.ORG },
);

// ---------------------------------------------------------------------------

/** Declared before `/:key/...` so the literal cannot be read as a key. */
router.get('/catalog', canReachReports, controller.catalog);

router.get('/:key/export.csv', canExport, controller.exportCsv);
router.get('/:key/run', canReachReports, controller.run);

export default router;
