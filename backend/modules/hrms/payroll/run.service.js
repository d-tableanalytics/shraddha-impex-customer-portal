/**
 * The payroll run: its state machine, and the compute that fills it.
 *
 * Ported from the reference's `payroll-run.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * The state machine
 * ---------------------------------------------------------------------------
 *   draft  --compute--> review  --lock--> locked  --disburse--> disbursed
 *     ^                   |
 *     +----- rollback ----+
 *
 * Four states, and only the four the reference has. `RUN_TRANSITIONS` declares
 * the legal moves as DATA, so every transition is one lookup against a table a
 * test can assert directly, rather than a chain of `if` statements where a
 * missed branch is an illegal transition nobody notices.
 *
 * Nothing leaves `locked` except to `disbursed`, and nothing leaves
 * `disbursed`. That is what makes a payslip an employee has seen immutable.
 *
 * ---------------------------------------------------------------------------
 * Compute is DETERMINISTIC
 * ---------------------------------------------------------------------------
 * Every input is read from the database at the start and handed to a pure
 * function. Given the same compensation, structure, statutory config, leave and
 * adjustments, the same payslips come out — which is the brief's requirement
 * and the reason the engine lives in `shared/payroll/` with no database access
 * of its own.
 *
 * The one non-deterministic thing a payroll engine can do is read the clock,
 * so it does not: the month being run decides the dates, not `new Date()`.
 */

import mongoose from 'mongoose';

import {
  PayrollRun,
  Payslip,
  PayrollAdjustment,
  PayGroup,
  SalaryComponent,
  SalaryStructure,
} from '../../../models/hrms/PayrollModels.js';
import Employee from '../../../models/hrms/Employee.js';
import LeaveRequest from '../../../models/hrms/LeaveRequest.js';
import LeaveType from '../../../models/hrms/LeaveType.js';
import { holidayDateSet } from '../leave/holiday.service.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { RUN_TRANSITIONS, IMMUTABLE_RUN_STATUSES } from '../../../shared/constants/payroll.js';
import { computePayslip } from '../../../shared/payroll/salaryEngine.js';
import { computeLopDays, payrollMonthWindow } from '../../../shared/payroll/lop.js';
import { toDecimalString, fromDecimal, sumMoney } from '../../../shared/payroll/money.js';
import { resolveEffectiveConfig } from './statutory.service.js';
import { listEffectiveForPayGroup, resolveStateCode } from './compensation.service.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const decimal = (v) => mongoose.Types.Decimal128.fromString(toDecimalString(v));

const runDto = (row, payGroupName = null) => ({
  id: idStr(row._id),
  payGroupId: idStr(row.payGroupId),
  payGroupName,
  month: row.month,
  year: row.year,
  status: row.status,
  totals: {
    gross: fromDecimal(row.totals?.gross),
    netPay: fromDecimal(row.totals?.netPay),
    deductions: fromDecimal(row.totals?.deductions),
    employerContributions: fromDecimal(row.totals?.employerContributions),
    headcount: row.totals?.headcount ?? 0,
  },
  statutoryConfigId: idStr(row.statutoryConfigId),
  computedAt: row.computedAt ? new Date(row.computedAt).toISOString() : null,
  lockedAt: row.lockedAt ? new Date(row.lockedAt).toISOString() : null,
  disbursedAt: row.disbursedAt ? new Date(row.disbursedAt).toISOString() : null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/**
 * Check a transition against the declared table.
 *
 * Every state change goes through here, so an illegal one is refused in one
 * place with one message rather than by whichever guard happened to be written
 * on that path.
 */
function assertTransition(run, action) {
  const rule = RUN_TRANSITIONS[action];
  if (!rule) throw new HrmsValidationError(`Unknown payroll action "${action}".`);
  if (!rule.from.includes(run.status)) {
    throw new HrmsConflictError(
      `A ${run.status} payroll run cannot be ${action}${action.endsWith('e') ? 'd' : 'ed'}. ` +
        `Only ${rule.from.join(' or ')} runs can.`,
      { code: 'PAYROLL_RUN_INVALID_TRANSITION' },
    );
  }
  return rule.to;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRuns(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, payGroupId, year, status } = query;

  const filter = {
    ...(payGroupId ? { payGroupId: oid(payGroupId) } : {}),
    ...(year ? { year } : {}),
    ...(status ? { status } : {}),
  };

  const [rows, total] = await Promise.all([
    PayrollRun.find(filter)
      .sort({ year: -1, month: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    PayrollRun.countDocuments(filter),
  ]);

  // One lookup for every group on the page rather than one per row.
  const groups = await PayGroup.find({
    _id: { $in: [...new Set(rows.map((r) => idStr(r.payGroupId)))] },
  })
    .select('name')
    .lean();
  const nameById = new Map(groups.map((g) => [idStr(g._id), g.name]));

  return {
    data: rows.map((r) => runDto(r, nameById.get(idStr(r.payGroupId)) ?? null)),
    total,
    page,
    pageSize,
  };
}

export async function getRun(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Payroll run');
  const row = await PayrollRun.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Payroll run');
  const group = await PayGroup.findById(row.payGroupId).select('name').lean();
  return runDto(row, group?.name ?? null);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Open a run for a pay group and month.
 *
 * The unique `(payGroupId, year, month)` index is what actually prevents a
 * duplicate payroll — a read-then-write check loses the race between two
 * admins, and the cost of losing it is paying everybody twice.
 */
export async function createRun(input, context = {}) {
  const payGroup = await PayGroup.findOne({ _id: input.payGroupId, deletedAt: null }).lean();
  if (!payGroup) {
    throw new HrmsValidationError('Unknown pay group.', [
      { path: 'payGroupId', message: 'That pay group does not exist.' },
    ]);
  }

  try {
    const row = await PayrollRun.create({
      payGroupId: oid(input.payGroupId),
      month: input.month,
      year: input.year,
      status: 'draft',
      createdByUserId: context.user?._id ?? null,
    });

    await recordAudit(
      context.user,
      AUDIT_ACTIONS.PAYROLL_RUN_CREATED,
      `Opened the ${input.year}-${String(input.month).padStart(2, '0')} payroll for ${payGroup.name}`,
      context.req,
      { meta: { runId: idStr(row._id), payGroupId: idStr(payGroup._id), month: input.month, year: input.year } },
    );

    return runDto(row.toObject(), payGroup.name);
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(
        `A payroll run for ${input.year}-${String(input.month).padStart(2, '0')} already exists in this pay group.`,
        { code: 'PAYROLL_RUN_EXISTS' },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

/**
 * Run the engine for everyone in the pay group and write their payslips.
 *
 * Idempotent: recomputing replaces the payslips. Adjustments SURVIVE a
 * recompute — they are an intentional instruction from HR, not derived data,
 * so wiping them would quietly undo a decision somebody made.
 */
export async function computeRun(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Payroll run');

  const run = await PayrollRun.findById(id).lean();
  if (!run) throw new HrmsNotFoundError('Payroll run');
  assertTransition(run, 'compute');

  const window = payrollMonthWindow(run.year, run.month);
  // Mid-month, so a compensation effective from the 1st and one ending on the
  // last day both resolve — the reference picks the 15th for the same reason.
  const on = `${run.year}-${String(run.month).padStart(2, '0')}-15`;

  // ---- statutory configuration -------------------------------------------
  const config = await resolveEffectiveConfig(on);
  if (!config) {
    throw new HrmsValidationError(
      `No statutory configuration is effective for ${window.start}. Payroll cannot run without one — ` +
        'PF, ESI, PT, LWF and TDS would all silently compute as zero.',
      [{ path: 'statutoryConfig', message: 'Create a statutory configuration first.' }],
    );
  }

  // ---- who is being paid ---------------------------------------------------
  const compensations = await listEffectiveForPayGroup(run.payGroupId, on);
  if (compensations.length === 0) {
    throw new HrmsValidationError(
      'No employee has an effective compensation in this pay group for that month.',
      [{ path: 'payGroupId', message: 'Assign compensation before running payroll.' }],
    );
  }

  const employeeIds = compensations.map((c) => c.employeeId);

  // Every remaining input, in a fixed number of queries regardless of headcount.
  const [employees, structures, components, adjustments, leaves, leaveTypes, holidays] =
    await Promise.all([
      Employee.find({ _id: { $in: employeeIds } })
        .select('_id employeeCode firstName lastName status deletedAt')
        .lean(),
      SalaryStructure.find({ _id: { $in: compensations.map((c) => c.structureId) } }).lean(),
      SalaryComponent.find({}).lean(),
      PayrollAdjustment.find({ runId: oid(id) }).lean(),
      LeaveRequest.find({
        employeeId: { $in: employeeIds },
        status: 'approved',
        startDate: { $lte: window.end },
        endDate: { $gte: window.start },
      }).lean(),
      LeaveType.find({}).select('_id paid').lean(),
      holidayDateSet([run.year]),
    ]);

  const employeeById = new Map(employees.map((e) => [idStr(e._id), e]));
  const structureById = new Map(structures.map((s) => [idStr(s._id), s]));
  const componentById = new Map(components.map((c) => [idStr(c._id), c]));
  const leaveTypePaid = new Map(leaveTypes.map((t) => [idStr(t._id), t.paid !== false]));

  const adjustmentsByEmployee = new Map();
  for (const adj of adjustments) {
    const key = idStr(adj.employeeId);
    if (!adjustmentsByEmployee.has(key)) adjustmentsByEmployee.set(key, []);
    adjustmentsByEmployee.get(key).push({
      componentCode: adj.componentCode,
      amount: fromDecimal(adj.amount),
      reason: adj.reason,
    });
  }

  const leavesByEmployee = new Map();
  for (const leave of leaves) {
    const key = idStr(leave.employeeId);
    if (!leavesByEmployee.has(key)) leavesByEmployee.set(key, []);
    leavesByEmployee.get(key).push({
      status: leave.status,
      // The ONE flag that decides whether a leave costs pay. Resolved from the
      // leave TYPE, never from the request.
      paid: leaveTypePaid.get(idStr(leave.leaveTypeId)) !== false,
      startDate: leave.startDate,
      endDate: leave.endDate,
      durationUnit: leave.durationUnit,
      dayBreakdown: leave.dayBreakdown ?? null,
    });
  }

  // ---- compute -------------------------------------------------------------
  const payslips = [];
  const skipped = [];

  for (const comp of compensations) {
    const employeeId = idStr(comp.employeeId);
    const employee = employeeById.get(employeeId);

    // A soft-deleted employee still holding a live compensation is a data
    // problem, not a reason to abort the month. Reported, not paid.
    if (!employee || employee.deletedAt) {
      skipped.push({ employeeId, reason: 'employee record is missing or deleted' });
      continue;
    }

    const structure = structureById.get(idStr(comp.structureId));
    if (!structure) {
      skipped.push({ employeeId, reason: 'assigned salary structure no longer exists' });
      continue;
    }

    const stateCode = await resolveStateCode(comp);
    if (!stateCode) {
      // AD-12: an unresolved state blocks rather than silently deducting zero.
      skipped.push({
        employeeId,
        reason:
          'no state could be resolved for professional tax and labour welfare fund — ' +
          'set one on the compensation or configure the company default state',
      });
      continue;
    }

    const structureComponents = (structure.components ?? [])
      .map((sc) => {
        const component = componentById.get(idStr(sc.componentId));
        if (!component) return null;
        return {
          order: sc.order ?? 0,
          calculation: sc.calculation ?? {},
          component: {
            code: component.code,
            name: component.name,
            type: component.type,
            taxable: component.taxable,
            calculationType: component.calculationType,
            formula: component.formula ?? {},
            statutoryLink: component.statutoryLink ?? null,
          },
        };
      })
      .filter(Boolean);

    const lopDays = computeLopDays(leavesByEmployee.get(employeeId) ?? [], window, holidays);

    const output = computePayslip({
      annualCtc: fromDecimal(comp.ctc),
      overrides: comp.overrides ?? {},
      structureComponents,
      month: run.month,
      year: run.year,
      stateCode,
      disabled: Boolean(comp.disabled),
      pfExcluded: Boolean(comp.pfExcluded),
      employeeRegime: comp.employeeRegime ?? undefined,
      exemptions: comp.exemptions ?? {},
      adjustments: adjustmentsByEmployee.get(employeeId) ?? [],
      statutoryConfig: config.config,
      daysInMonth: window.daysInMonth,
      lopDays,
    });

    payslips.push({
      runId: oid(id),
      employeeId: oid(employeeId),
      month: run.month,
      year: run.year,
      gross: decimal(output.gross),
      netPay: decimal(output.netPay),
      totalDeductions: decimal(output.totalDeductions),
      employerContributions: decimal(output.employerContributions),
      lines: output.lines.map((l) => ({
        componentCode: l.componentCode,
        componentName: l.componentName,
        type: l.type,
        amount: decimal(l.amount),
        taxable: Boolean(l.taxable),
        subtitle: l.subtitle ?? null,
      })),
      statutoryBreakdown: output.statutoryBundle,
      lopDays,
      generatedAt: new Date(),
    });
  }

  // ---- persist -------------------------------------------------------------
  // Replace wholesale: a recompute must not leave a payslip for an employee who
  // has since left the pay group.
  await Payslip.deleteMany({ runId: oid(id) });
  if (payslips.length > 0) await Payslip.insertMany(payslips);

  const totals = {
    gross: decimal(sumMoney(payslips.map((p) => fromDecimal(p.gross)))),
    netPay: decimal(sumMoney(payslips.map((p) => fromDecimal(p.netPay)))),
    deductions: decimal(sumMoney(payslips.map((p) => fromDecimal(p.totalDeductions)))),
    employerContributions: decimal(
      sumMoney(payslips.map((p) => fromDecimal(p.employerContributions))),
    ),
    headcount: payslips.length,
  };

  const updated = await PayrollRun.findOneAndUpdate(
    // Conditional on the status we validated, so two concurrent computes
    // cannot both proceed against a run one of them has already moved.
    { _id: id, status: { $in: RUN_TRANSITIONS.compute.from } },
    {
      $set: {
        status: 'review',
        totals,
        statutoryConfigId: oid(config.id),
        computedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('The run changed state while it was being computed.', {
      code: 'PAYROLL_RUN_INVALID_TRANSITION',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.PAYROLL_RUN_COMPUTED,
    `Computed ${payslips.length} payslip(s) for ${run.year}-${String(run.month).padStart(2, '0')}`,
    context.req,
    {
      meta: {
        runId: idStr(id),
        headcount: payslips.length,
        skipped,
        statutoryConfigId: config.id,
        totals: {
          gross: fromDecimal(totals.gross),
          netPay: fromDecimal(totals.netPay),
          deductions: fromDecimal(totals.deductions),
          employerContributions: fromDecimal(totals.employerContributions),
        },
      },
    },
  );

  return {
    run: runDto(updated.toObject()),
    payslipsGenerated: payslips.length,
    // Surfaced, not swallowed: a skipped employee is somebody who is not being
    // paid this month, and that must be visible before the run is locked.
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Lock / disburse / rollback
// ---------------------------------------------------------------------------

/**
 * Freeze the run.
 *
 * After this the payslips are final and visible to employees, and neither a
 * recompute nor a rollback is possible.
 */
export async function lockRun(id, context = {}) {
  const run = await loadRun(id);
  assertTransition(run, 'lock');

  const count = await Payslip.countDocuments({ runId: oid(id) });
  if (count === 0) {
    throw new HrmsConflictError('There are no payslips to lock. Compute the run first.', {
      code: 'PAYROLL_RUN_EMPTY',
    });
  }

  const updated = await PayrollRun.findOneAndUpdate(
    { _id: id, status: 'review' },
    { $set: { status: 'locked', lockedByUserId: context.user?._id ?? null, lockedAt: new Date() } },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('The run changed state before it could be locked.', {
      code: 'PAYROLL_RUN_INVALID_TRANSITION',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.PAYROLL_RUN_LOCKED,
    `Locked the ${run.year}-${String(run.month).padStart(2, '0')} payroll; ${count} payslip(s) are now final`,
    context.req,
    { meta: { runId: idStr(id), headcount: count } },
  );

  return runDto(updated.toObject());
}

export async function disburseRun(id, context = {}) {
  const run = await loadRun(id);
  assertTransition(run, 'disburse');

  const updated = await PayrollRun.findOneAndUpdate(
    { _id: id, status: 'locked' },
    {
      $set: {
        status: 'disbursed',
        disbursedByUserId: context.user?._id ?? null,
        disbursedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('The run changed state before it could be disbursed.', {
      code: 'PAYROLL_RUN_INVALID_TRANSITION',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.PAYROLL_RUN_DISBURSED,
    `Marked the ${run.year}-${String(run.month).padStart(2, '0')} payroll disbursed`,
    context.req,
    { meta: { runId: idStr(id), netPay: fromDecimal(run.totals?.netPay) } },
  );

  return runDto(updated.toObject());
}

/**
 * Return a run to draft and discard its payslips.
 *
 * Only from draft or review. A locked run is refused, which is the guarantee
 * that a payslip an employee has already seen cannot be withdrawn.
 */
export async function rollbackRun(id, context = {}) {
  const run = await loadRun(id);
  assertTransition(run, 'rollback');

  const removed = await Payslip.deleteMany({ runId: oid(id) });

  const updated = await PayrollRun.findOneAndUpdate(
    { _id: id, status: { $in: RUN_TRANSITIONS.rollback.from } },
    {
      $set: { status: 'draft', totals: {}, computedAt: null, statutoryConfigId: null },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('The run changed state before it could be rolled back.', {
      code: 'PAYROLL_RUN_INVALID_TRANSITION',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.PAYROLL_RUN_ROLLED_BACK,
    `Rolled the ${run.year}-${String(run.month).padStart(2, '0')} payroll back to draft; ` +
      `${removed.deletedCount ?? 0} payslip(s) discarded`,
    context.req,
    { meta: { runId: idStr(id), payslipsDiscarded: removed.deletedCount ?? 0 } },
  );

  return runDto(updated.toObject());
}

async function loadRun(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Payroll run');
  const run = await PayrollRun.findById(id).lean();
  if (!run) throw new HrmsNotFoundError('Payroll run');
  return run;
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

/**
 * Add a one-off correction to an employee in this run.
 *
 * Refused once the run is locked: an adjustment changes what somebody is paid,
 * and a locked run's payslips are final. It does NOT recompute — the admin
 * recomputes when they have entered every adjustment, which is one pass over
 * the headcount rather than one per correction.
 */
export async function createAdjustment(runId, input, context = {}) {
  const run = await loadRun(runId);
  if (IMMUTABLE_RUN_STATUSES.includes(run.status)) {
    throw new HrmsConflictError(
      `The ${run.status} payroll run can no longer be adjusted.`,
      { code: 'PAYROLL_RUN_IMMUTABLE' },
    );
  }

  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null })
    .select('_id employeeCode')
    .lean();
  if (!employee) {
    throw new HrmsValidationError('Unknown employee.', [
      { path: 'employeeId', message: 'That employee does not exist.' },
    ]);
  }

  const row = await PayrollAdjustment.create({
    runId: oid(runId),
    employeeId: oid(input.employeeId),
    componentCode: input.componentCode,
    amount: decimal(input.amount),
    reason: input.reason,
    createdByUserId: context.user?._id ?? null,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.PAYROLL_ADJUSTMENT_CREATED,
    `Adjustment of ${input.amount} on ${input.componentCode} for ${employee.employeeCode}: ${input.reason}`,
    context.req,
    {
      meta: {
        runId: idStr(runId),
        adjustmentId: idStr(row._id),
        employeeId: idStr(employee._id),
        componentCode: input.componentCode,
        amount: Number(input.amount),
      },
    },
  );

  return adjustmentDto(row.toObject());
}

export async function listAdjustments(runId) {
  if (!mongoose.isValidObjectId(runId)) throw new HrmsNotFoundError('Payroll run');
  const rows = await PayrollAdjustment.find({ runId: oid(runId) }).sort({ createdAt: -1 }).lean();
  return rows.map(adjustmentDto);
}

export async function deleteAdjustment(runId, adjustmentId, context = {}) {
  const run = await loadRun(runId);
  if (IMMUTABLE_RUN_STATUSES.includes(run.status)) {
    throw new HrmsConflictError(`The ${run.status} payroll run can no longer be adjusted.`, {
      code: 'PAYROLL_RUN_IMMUTABLE',
    });
  }
  if (!mongoose.isValidObjectId(adjustmentId)) throw new HrmsNotFoundError('Adjustment');

  const row = await PayrollAdjustment.findOneAndDelete({
    _id: adjustmentId,
    runId: oid(runId),
  });
  if (!row) throw new HrmsNotFoundError('Adjustment');

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.PAYROLL_ADJUSTMENT_DELETED,
    `Removed an adjustment of ${fromDecimal(row.amount)} on ${row.componentCode}`,
    context.req,
    { meta: { runId: idStr(runId), adjustmentId: idStr(row._id) } },
  );

  return { id: idStr(row._id), deleted: true };
}

const adjustmentDto = (row) => ({
  id: idStr(row._id),
  runId: idStr(row.runId),
  employeeId: idStr(row.employeeId),
  componentCode: row.componentCode,
  amount: fromDecimal(row.amount),
  reason: row.reason,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

export { assertTransition, runDto };

export default {
  listRuns,
  getRun,
  createRun,
  computeRun,
  lockRun,
  disburseRun,
  rollbackRun,
  createAdjustment,
  listAdjustments,
  deleteAdjustment,
};
