/**
 * Payroll HTTP layer.
 *
 * Thin, as every other HRMS controller is: validation in the `validate`
 * middleware, authorization in `requirePermission` and re-checked in the
 * services, business rules and audit in the services. What remains here is
 * shaping the response.
 *
 * Every payload goes UNDER `data`, never spread beside it — the envelope bug
 * that once killed the employee directory.
 */

import * as catalog from './catalog.service.js';
import * as statutory from './statutory.service.js';
import * as compensation from './compensation.service.js';
import * as runs from './run.service.js';
import * as payslips from './payslip.service.js';

/** The audit context every write hands to its service. */
const contextOf = (req) => ({ user: req.user, req });

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

/** Wraps a handler so a rejection reaches the HRMS error handler. */
const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Pay groups
// ---------------------------------------------------------------------------

export const listPayGroups = handler(async (req, res) =>
  ok(res, await catalog.listPayGroups({ includeDeleted: req.query.includeDeleted === true })),
);
export const createPayGroup = handler(async (req, res) =>
  ok(res, await catalog.createPayGroup(req.body, contextOf(req)), 201),
);
export const updatePayGroup = handler(async (req, res) =>
  ok(res, await catalog.updatePayGroup(req.params.id, req.body, contextOf(req))),
);
export const deletePayGroup = handler(async (req, res) =>
  ok(res, await catalog.deletePayGroup(req.params.id, contextOf(req))),
);

// ---------------------------------------------------------------------------
// Salary components
// ---------------------------------------------------------------------------

export const listComponents = handler(async (req, res) =>
  ok(res, await catalog.listComponents({ includeDeleted: req.query.includeDeleted === true })),
);
export const createComponent = handler(async (req, res) =>
  ok(res, await catalog.createComponent(req.body, contextOf(req)), 201),
);
export const updateComponent = handler(async (req, res) =>
  ok(res, await catalog.updateComponent(req.params.id, req.body, contextOf(req))),
);
export const deleteComponent = handler(async (req, res) =>
  ok(res, await catalog.deleteComponent(req.params.id, contextOf(req))),
);

// ---------------------------------------------------------------------------
// Salary structures
// ---------------------------------------------------------------------------

export const listStructures = handler(async (req, res) =>
  ok(res, await catalog.listStructures({ payGroupId: req.query.payGroupId })),
);
export const getStructure = handler(async (req, res) =>
  ok(res, await catalog.getStructure(req.params.id)),
);
export const createStructure = handler(async (req, res) =>
  ok(res, await catalog.createStructure(req.body, contextOf(req)), 201),
);
export const updateStructure = handler(async (req, res) =>
  ok(res, await catalog.updateStructure(req.params.id, req.body, contextOf(req))),
);
export const deleteStructure = handler(async (req, res) =>
  ok(res, await catalog.deleteStructure(req.params.id, contextOf(req))),
);

/**
 * What a CTC yields under a structure.
 *
 * A POST rather than a GET because the CTC is a body value, and because the
 * reference does the same. Nothing is persisted.
 */
export const previewStructure = handler(async (req, res) =>
  ok(res, await catalog.previewStructure(req.params.id, req.body)),
);

// ---------------------------------------------------------------------------
// Statutory configuration
// ---------------------------------------------------------------------------

export const listStatutoryConfigs = handler(async (req, res) =>
  ok(res, await statutory.listConfigs()),
);
export const getEffectiveStatutoryConfig = handler(async (req, res) => {
  const config = await statutory.resolveEffectiveConfig(req.query.on);
  // `data: null` rather than a 404: "nothing is configured yet" is the answer
  // the Statutory screen renders its empty state from, and it is not an error.
  return ok(res, config ? { ...config, coveredStates: statutory.coveredStates(config) } : null);
});
export const createStatutoryConfig = handler(async (req, res) =>
  ok(res, await statutory.createConfig(req.body, contextOf(req)), 201),
);
export const updateStatutoryConfig = handler(async (req, res) =>
  ok(res, await statutory.updateConfig(req.params.id, req.body, contextOf(req))),
);
export const deleteStatutoryConfig = handler(async (req, res) =>
  ok(res, await statutory.deleteConfig(req.params.id, contextOf(req))),
);

// ---------------------------------------------------------------------------
// Employee compensation
// ---------------------------------------------------------------------------

export const listCompensation = handler(async (req, res) =>
  ok(res, await compensation.listForEmployee(req.params.employeeId, req.query)),
);
export const getCurrentCompensation = handler(async (req, res) =>
  ok(res, await compensation.currentForEmployee(req.params.employeeId)),
);
export const createCompensation = handler(async (req, res) =>
  ok(res, await compensation.createCompensation(req.body, contextOf(req)), 201),
);
export const deleteCompensation = handler(async (req, res) =>
  ok(res, await compensation.deleteCompensation(req.params.id, contextOf(req))),
);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const listRuns = handler(async (req, res) => ok(res, await runs.listRuns(req.query)));
export const getRun = handler(async (req, res) => ok(res, await runs.getRun(req.params.id)));
export const createRun = handler(async (req, res) =>
  ok(res, await runs.createRun(req.body, contextOf(req)), 201),
);
export const computeRun = handler(async (req, res) =>
  ok(res, await runs.computeRun(req.params.id, contextOf(req))),
);
export const lockRun = handler(async (req, res) =>
  ok(res, await runs.lockRun(req.params.id, contextOf(req))),
);
export const disburseRun = handler(async (req, res) =>
  ok(res, await runs.disburseRun(req.params.id, contextOf(req))),
);
export const rollbackRun = handler(async (req, res) =>
  ok(res, await runs.rollbackRun(req.params.id, contextOf(req))),
);

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

export const listAdjustments = handler(async (req, res) =>
  ok(res, await runs.listAdjustments(req.params.id)),
);
export const createAdjustment = handler(async (req, res) =>
  ok(res, await runs.createAdjustment(req.params.id, req.body, contextOf(req)), 201),
);
export const deleteAdjustment = handler(async (req, res) =>
  ok(res, await runs.deleteAdjustment(req.params.id, req.params.adjustmentId, contextOf(req))),
);

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

export const listPayslips = handler(async (req, res) =>
  ok(res, await payslips.listPayslips(req.hrmsActor, req.query)),
);

/**
 * The caller's own payslips.
 *
 * A separate route from the filtered list so an employee never has to name
 * themselves — the actor supplies the id, which is the whole point.
 */
export const listMyPayslips = handler(async (req, res) =>
  ok(
    res,
    await payslips.listPayslips(req.hrmsActor, {
      ...req.query,
      employeeId: req.hrmsActor?.employeeId ?? undefined,
    }),
  ),
);

export const getPayslip = handler(async (req, res) =>
  ok(res, await payslips.getPayslip(req.params.id, req.hrmsActor, contextOf(req))),
);

export const listRunPayslips = handler(async (req, res) =>
  ok(res, await payslips.listForRun(req.params.id, req.hrmsActor)),
);

export default {
  listPayGroups,
  createPayGroup,
  updatePayGroup,
  deletePayGroup,
  listComponents,
  createComponent,
  updateComponent,
  deleteComponent,
  listStructures,
  getStructure,
  createStructure,
  updateStructure,
  deleteStructure,
  previewStructure,
  listStatutoryConfigs,
  getEffectiveStatutoryConfig,
  createStatutoryConfig,
  updateStatutoryConfig,
  deleteStatutoryConfig,
  listCompensation,
  getCurrentCompensation,
  createCompensation,
  deleteCompensation,
  listRuns,
  getRun,
  createRun,
  computeRun,
  lockRun,
  disburseRun,
  rollbackRun,
  listAdjustments,
  createAdjustment,
  deleteAdjustment,
  listPayslips,
  listMyPayslips,
  getPayslip,
  listRunPayslips,
};
