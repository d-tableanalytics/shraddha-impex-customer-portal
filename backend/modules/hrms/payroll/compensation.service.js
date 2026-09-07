/**
 * Employee compensation — what someone is paid, from when.
 *
 * Ported from the reference's `employee-compensation.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Effective dating is the whole design
 * ---------------------------------------------------------------------------
 * A raise does not edit a row; it opens a new one and closes the previous one
 * the day before. That is what lets March's payroll still compute on March's
 * salary after an April increase, and it is why a historic payslip can be
 * regenerated and match the one the employee was given. Mutating the figure in
 * place would silently rewrite history the next time anything recomputed.
 *
 * ---------------------------------------------------------------------------
 * 🔴 This is the most sensitive read in the HRMS
 * ---------------------------------------------------------------------------
 * A CTC is compensation data. It is gated on `employees:compensation`, NOT on
 * `payroll:view` and not on `employees:view` — someone who may edit a profile
 * has no business reading its salary, which is the same line Employee Master
 * already draws for bank details and PAN.
 */

import mongoose from 'mongoose';

import {
  EmployeeCompensation,
  PayGroup,
  SalaryStructure,
} from '../../../models/hrms/PayrollModels.js';
import Employee from '../../../models/hrms/Employee.js';
import CompanyProfile from '../../../models/hrms/CompanyProfile.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { toDecimalString, fromDecimal } from '../../../shared/payroll/money.js';
import { HrmsNotFoundError, HrmsValidationError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  employeeId: idStr(row.employeeId),
  payGroupId: idStr(row.payGroupId),
  structureId: idStr(row.structureId),
  ctc: fromDecimal(row.ctc),
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo ?? null,
  overrides: row.overrides ?? {},
  stateCode: row.stateCode ?? null,
  employeeRegime: row.employeeRegime ?? null,
  pfExcluded: Boolean(row.pfExcluded),
  disabled: Boolean(row.disabled),
  exemptions: row.exemptions ?? {},
  revisionReason: row.revisionReason ?? null,
  isCurrent: row.effectiveTo === null || row.effectiveTo === undefined,
  ...extras,
});

/**
 * The state whose PT and LWF rules apply to an employee.
 *
 * Resolution order, most specific first:
 *   1. the compensation row's own `stateCode` — an explicit override
 *   2. the company's `defaultStateCode`
 *
 * Returns null when neither answers, and the CALLER refuses the run. AD-12 is
 * explicit that an unresolved state BLOCKS payroll rather than silently
 * deducting zero, because "this state has no professional tax" and "nobody
 * told us which state this is" produce the same ₹0 and mean opposite things.
 * `CompanyProfile.statutoryReadiness()` exists to report that before anyone
 * tries a run.
 *
 * 🔴 THE MIDDLE TIER IS MISSING, DELIBERATELY. CompanyProfile's own readiness
 * message says `defaultStateCode` is "required unless every location sets its
 * own state" — but `Location` has no state field today. Adding one is an Org
 * Structure change, not a Payroll one, so this resolver does not invent it;
 * the gap is reported rather than papered over. A company operating in two
 * states must set `stateCode` per compensation until Location carries it.
 */
export async function resolveStateCode(compensation) {
  if (compensation?.stateCode) return compensation.stateCode;
  const company = await CompanyProfile.findOne({}).select('defaultStateCode').lean();
  return company?.defaultStateCode ?? null;
}

/**
 * Every employee's live compensation in a pay group on a date.
 *
 * The payroll run's central query. One pass, indexed on
 * `(payGroupId, effectiveFrom, effectiveTo)`.
 */
export async function listEffectiveForPayGroup(payGroupId, on) {
  return EmployeeCompensation.find({
    payGroupId: oid(payGroupId),
    effectiveFrom: { $lte: on },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: on } }],
  }).lean();
}

/** One employee's compensation history, newest first. */
export async function listForEmployee(employeeId, { page = 1, pageSize = PAGE_SIZE_DEFAULT } = {}) {
  if (!mongoose.isValidObjectId(employeeId)) throw new HrmsNotFoundError('Employee');

  const filter = { employeeId: oid(employeeId) };
  const [rows, total] = await Promise.all([
    EmployeeCompensation.find(filter)
      .sort({ effectiveFrom: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    EmployeeCompensation.countDocuments(filter),
  ]);

  return { data: rows.map((r) => toDto(r)), total, page, pageSize };
}

/** The row in force for an employee on a date, or null. */
export async function currentForEmployee(employeeId, on = new Date().toISOString().slice(0, 10)) {
  if (!mongoose.isValidObjectId(employeeId)) return null;
  const row = await EmployeeCompensation.findOne({
    employeeId: oid(employeeId),
    effectiveFrom: { $lte: on },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: on } }],
  })
    .sort({ effectiveFrom: -1 })
    .lean();
  return row ? toDto(row) : null;
}

/**
 * Record a compensation, or a revision of one.
 *
 * References are checked before the write because AD-2 left no foreign key to
 * catch a dangling id, and a compensation pointing at a structure that does not
 * exist is a payroll run that fails halfway through a month.
 */
export async function createCompensation(input, context = {}) {
  const [employee, payGroup, structure] = await Promise.all([
    Employee.findOne({ _id: input.employeeId, deletedAt: null })
      .select('_id employeeCode firstName lastName locationId')
      .lean(),
    PayGroup.findOne({ _id: input.payGroupId, deletedAt: null }).select('_id').lean(),
    SalaryStructure.findOne({ _id: input.structureId, deletedAt: null })
      .select('_id payGroupId')
      .lean(),
  ]);

  if (!employee) {
    throw new HrmsValidationError('Unknown employee.', [
      { path: 'employeeId', message: 'That employee does not exist or has been removed.' },
    ]);
  }
  if (!payGroup) {
    throw new HrmsValidationError('Unknown pay group.', [
      { path: 'payGroupId', message: 'That pay group does not exist.' },
    ]);
  }
  if (!structure) {
    throw new HrmsValidationError('Unknown salary structure.', [
      { path: 'structureId', message: 'That structure does not exist.' },
    ]);
  }
  // A structure belongs to one pay group; crossing them would compute an
  // employee's salary against components their group does not use.
  if (idStr(structure.payGroupId) !== idStr(payGroup._id)) {
    throw new HrmsValidationError('That structure belongs to a different pay group.', [
      { path: 'structureId', message: 'Pick a structure from the selected pay group.' },
    ]);
  }

  // Close the row this one supersedes, the day before the new one starts.
  const previous = await EmployeeCompensation.findOne({
    employeeId: oid(input.employeeId),
    effectiveTo: null,
  }).lean();

  if (previous && previous.effectiveFrom >= input.effectiveFrom) {
    throw new HrmsValidationError(
      `This employee already has a compensation effective from ${previous.effectiveFrom}. A revision must start after it.`,
      [{ path: 'effectiveFrom', message: `Choose a date after ${previous.effectiveFrom}.` }],
    );
  }

  const row = await EmployeeCompensation.create({
    ...input,
    employeeId: oid(input.employeeId),
    payGroupId: oid(input.payGroupId),
    structureId: oid(input.structureId),
    // A string into Decimal128 — never a float. See shared/payroll/money.js.
    ctc: mongoose.Types.Decimal128.fromString(toDecimalString(input.ctc)),
    createdByUserId: context.user?._id ?? null,
  });

  if (previous) {
    const dayBefore = new Date(`${input.effectiveFrom}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    await EmployeeCompensation.updateOne(
      { _id: previous._id },
      { $set: { effectiveTo: dayBefore.toISOString().slice(0, 10) } },
    );
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.COMPENSATION_CHANGED,
    `Compensation for ${employee.employeeCode} effective ${input.effectiveFrom}` +
      (previous ? ' (revision)' : ' (initial)'),
    context.req,
    {
      meta: {
        compensationId: idStr(row._id),
        employeeId: idStr(employee._id),
        employeeCode: employee.employeeCode,
        effectiveFrom: input.effectiveFrom,
        // Before and after, because "what did this person's pay change from"
        // is the question an audit of a raise has to answer.
        previousCtc: previous ? fromDecimal(previous.ctc) : null,
        newCtc: fromDecimal(row.ctc),
        revisionReason: input.revisionReason ?? null,
      },
    },
  );

  return toDto(row.toObject());
}

/**
 * Delete a compensation row that has not taken effect yet.
 *
 * A row already in force is history and stays; correcting it means another
 * revision. Deleting reopens whatever it had closed, so the timeline keeps no
 * gap.
 */
export async function deleteCompensation(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Compensation');

  const existing = await EmployeeCompensation.findById(id).lean();
  if (!existing) throw new HrmsNotFoundError('Compensation');

  if (existing.effectiveFrom <= new Date().toISOString().slice(0, 10)) {
    throw new HrmsValidationError(
      `This compensation took effect on ${existing.effectiveFrom}. Record a revision instead of deleting it.`,
    );
  }

  await EmployeeCompensation.deleteOne({ _id: id });

  const dayBefore = new Date(`${existing.effectiveFrom}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  await EmployeeCompensation.updateOne(
    { employeeId: existing.employeeId, effectiveTo: dayBefore.toISOString().slice(0, 10) },
    { $set: { effectiveTo: existing.effectiveTo ?? null } },
  );

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.COMPENSATION_CHANGED,
    `Deleted the not-yet-effective compensation dated ${existing.effectiveFrom}`,
    context.req,
    { meta: { compensationId: idStr(existing._id), employeeId: idStr(existing.employeeId) } },
  );

  return { id: idStr(existing._id), deleted: true };
}

export default {
  listForEmployee,
  currentForEmployee,
  listEffectiveForPayGroup,
  createCompensation,
  deleteCompensation,
  resolveStateCode,
};
