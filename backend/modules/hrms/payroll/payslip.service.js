/**
 * Payslip reads.
 *
 * Ported from the reference's `payslip.service.ts`, whose authorisation shape
 * is sound and is kept: org-wide payroll view sees everyone, an employee sees
 * their own, nobody else sees anything.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Two rules that carry the whole module's security
 * ---------------------------------------------------------------------------
 * 1. AN EMPLOYEE ONLY SEES A FINAL PAYSLIP. A run in `draft` or `review` is
 *    working material — the figures move as adjustments land and the run is
 *    recomputed. Showing an employee a number that is about to change is worse
 *    than showing them nothing. Only `locked` and `disbursed` runs are visible
 *    to the subject; payroll admins see every state, because reviewing the
 *    draft is their job.
 *
 * 2. THE SUBJECT IS RESOLVED FROM THE ROW, NEVER FROM THE REQUEST. A payslip id
 *    is read first, its `employeeId` establishes whose it is, and the caller's
 *    scope is evaluated against THAT. A handler that trusted an `employeeId`
 *    query parameter would hand any authenticated employee anyone's salary.
 *
 * There is deliberately no `team` scope here. A manager can see their reports'
 * attendance and approve their leave; a manager cannot see what they are paid.
 * The permission matrix already reflects that — `payroll:view` exists at `self`
 * and `org`, never at `team` — and this service does not widen it.
 */

import mongoose from 'mongoose';

import { Payslip, PayrollRun } from '../../../models/hrms/PayrollModels.js';
import Employee from '../../../models/hrms/Employee.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { EMPLOYEE_VISIBLE_RUN_STATUSES } from '../../../shared/constants/payroll.js';
import { fromDecimal } from '../../../shared/payroll/money.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import { HrmsNotFoundError, HrmsForbiddenError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Whole-company payroll sight. The only thing that sees somebody else's slip. */
const seesEveryone = (actor) => hasHrmsPermission(actor, M.PAYROLL, A.VIEW, S.ORG);

const toDto = (row, employee = null) => ({
  id: idStr(row._id),
  runId: idStr(row.runId),
  employeeId: idStr(row.employeeId),
  employeeName: employee
    ? `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim()
    : null,
  employeeCode: employee?.employeeCode ?? null,
  month: row.month,
  year: row.year,
  gross: fromDecimal(row.gross),
  netPay: fromDecimal(row.netPay),
  totalDeductions: fromDecimal(row.totalDeductions),
  employerContributions: fromDecimal(row.employerContributions),
  lopDays: row.lopDays ?? 0,
  lines: (row.lines ?? []).map((l) => ({
    componentCode: l.componentCode,
    componentName: l.componentName,
    type: l.type,
    amount: fromDecimal(l.amount),
    taxable: Boolean(l.taxable),
    subtitle: l.subtitle ?? null,
  })),
  statutoryBreakdown: row.statutoryBreakdown ?? null,
  pdfKey: row.pdfKey ?? null,
  generatedAt: row.generatedAt ? new Date(row.generatedAt).toISOString() : null,
});

/**
 * The scope filter for a payslip listing.
 *
 * Applied to the QUERY so pagination totals describe what the caller may
 * actually see. Filtering after the fetch would return short pages with a
 * count that lied.
 */
function readFilterFor(actor) {
  if (seesEveryone(actor)) return {};
  if (hasHrmsPermission(actor, M.PAYROLL, A.VIEW, S.SELF)) {
    if (!actor.employeeId) {
      throw new HrmsForbiddenError('Your account has no employee record.');
    }
    return { employeeId: oid(actor.employeeId) };
  }
  throw new HrmsForbiddenError('You do not have permission to view payslips.');
}

/**
 * Runs whose payslips this actor may see.
 *
 * An admin sees every state; anyone else sees only final ones. Resolved to a
 * concrete id list so the visibility rule is part of the query rather than a
 * post-filter that would break the count.
 */
async function visibleRunIds(actor, baseFilter = {}) {
  if (seesEveryone(actor)) return null; // no restriction
  const runs = await PayrollRun.find({ ...baseFilter, status: { $in: EMPLOYEE_VISIBLE_RUN_STATUSES } })
    .select('_id')
    .lean();
  return runs.map((r) => r._id);
}

export async function listPayslips(actor, query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, employeeId, runId, year, month } = query;

  const scope = readFilterFor(actor);

  // A caller naming someone else must hold the org grant; otherwise the scope
  // filter already pins them to themselves and asking for another id is a
  // refusal rather than an empty page.
  if (employeeId && !seesEveryone(actor) && idStr(employeeId) !== idStr(actor.employeeId)) {
    throw new HrmsForbiddenError("You may not view another employee's payslips.");
  }

  const runIds = await visibleRunIds(actor);

  const filter = {
    ...scope,
    ...(employeeId ? { employeeId: oid(employeeId) } : {}),
    ...(runId ? { runId: oid(runId) } : {}),
    ...(year ? { year } : {}),
    ...(month ? { month } : {}),
    ...(runIds === null ? {} : { runId: { $in: runIds } }),
  };

  const [rows, total] = await Promise.all([
    Payslip.find(filter)
      .sort({ year: -1, month: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Payslip.countDocuments(filter),
  ]);

  const employees = await Employee.find({
    _id: { $in: [...new Set(rows.map((r) => idStr(r.employeeId)))] },
  })
    .select('_id employeeCode firstName lastName')
    .lean();
  const byId = new Map(employees.map((e) => [idStr(e._id), e]));

  return {
    data: rows.map((r) => toDto(r, byId.get(idStr(r.employeeId)))),
    total,
    page,
    pageSize,
  };
}

/**
 * One payslip.
 *
 * The read is AUDITED. A payslip is compensation data, and AD-10 already
 * establishes that viewing sensitive employee information is the auditable
 * act rather than storing it. An admin opening somebody's salary leaves a
 * record; the employee opening their own does too, which is what makes the
 * trail answer "who looked at this".
 */
export async function getPayslip(id, actor, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Payslip');

  const row = await Payslip.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Payslip');

  await assertCanView(row, actor);

  const employee = await Employee.findById(row.employeeId)
    .select('_id employeeCode firstName lastName')
    .lean();

  await recordAudit(
    context.user ?? { _id: actor.userId },
    AUDIT_ACTIONS.PAYSLIP_VIEWED,
    `Viewed the ${row.year}-${String(row.month).padStart(2, '0')} payslip for ${employee?.employeeCode ?? 'an employee'}`,
    context.req,
    {
      meta: {
        payslipId: idStr(row._id),
        subjectEmployeeId: idStr(row.employeeId),
        own: idStr(row.employeeId) === idStr(actor.employeeId),
        month: row.month,
        year: row.year,
      },
    },
  );

  return toDto(row, employee);
}

/**
 * May this actor see this payslip?
 *
 * Both rules from the header, in order: who it belongs to, then whether it is
 * final. The finality check comes second so an admin is never blocked by it.
 */
async function assertCanView(payslip, actor) {
  if (seesEveryone(actor)) return;

  const isOwn = actor.employeeId && idStr(payslip.employeeId) === idStr(actor.employeeId);
  if (!isOwn || !hasHrmsPermission(actor, M.PAYROLL, A.VIEW, S.SELF)) {
    throw new HrmsForbiddenError('You may not view this payslip.');
  }

  const run = await PayrollRun.findById(payslip.runId).select('status').lean();
  if (!run || !EMPLOYEE_VISIBLE_RUN_STATUSES.includes(run.status)) {
    // Deliberately a 403 and not a 404: the payslip exists, and saying so is
    // fine — the employee simply cannot see a figure that is still moving.
    throw new HrmsForbiddenError(
      'This payslip is not final yet. It becomes available once payroll for the month is locked.',
    );
  }
}

/** Every payslip in a run. Payroll admins only — used by the run detail screen. */
export async function listForRun(runId, actor) {
  if (!seesEveryone(actor)) {
    throw new HrmsForbiddenError('You do not have permission to view a payroll run.');
  }
  return listPayslips(actor, { runId, pageSize: 500 });
}

export default { listPayslips, getPayslip, listForRun };
