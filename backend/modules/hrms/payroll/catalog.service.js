/**
 * The payroll catalogue: pay groups, salary components, salary structures.
 *
 * Ported from the reference's `pay-group.service.ts`,
 * `salary-component.service.ts` and `salary-structure.service.ts`. Grouped
 * because they are one editorial surface — an admin building a structure moves
 * between all three — and because the structure service needs both others to
 * validate a write.
 *
 * ---------------------------------------------------------------------------
 * What changes, and why
 * ---------------------------------------------------------------------------
 * 1. DELETES ARE SOFT (as Org Structure decided, O-3). The reference hard
 *    deletes and lets a Postgres foreign key refuse. AD-2 removed foreign keys,
 *    so nothing would refuse: a component would vanish and every structure
 *    holding it would compute a silent zero on the next payroll.
 *
 * 2. A STRUCTURE'S FORMULA DEPENDENCIES ARE CHECKED. `HRA = 40% of BASIC` in a
 *    structure that has no BASIC evaluates to zero in the reference and
 *    underpays without a word. Here the write is refused.
 *
 * 3. AUDIT LIVES HERE, not in the controller — these services are also the path
 *    a seed or import would take, and an audit entry that only exists when the
 *    change arrived over HTTP is one that quietly goes missing.
 */

import mongoose from 'mongoose';

import {
  PayGroup,
  SalaryComponent,
  SalaryStructure,
  EmployeeCompensation,
} from '../../../models/hrms/PayrollModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import { formulaDependencies } from '../../../shared/payroll/formula.js';
import { computePayslip } from '../../../shared/payroll/salaryEngine.js';
import { fromDecimal, toDecimalString, round2 } from '../../../shared/payroll/money.js';
import { resolveEffectiveConfig } from './statutory.service.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// ===========================================================================
// Pay groups
// ===========================================================================

const payGroupDto = (row) => ({
  id: idStr(row._id),
  code: row.code,
  name: row.name,
  legalEntityName: row.legalEntityName,
  isDefault: Boolean(row.isDefault),
  deletedAt: row.deletedAt ?? null,
});

export async function listPayGroups({ includeDeleted = false } = {}) {
  const rows = await PayGroup.find(includeDeleted ? {} : { deletedAt: null })
    .sort({ name: 1 })
    .lean();
  return rows.map(payGroupDto);
}

export async function getPayGroup(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Pay group');
  const row = await PayGroup.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Pay group');
  return payGroupDto(row);
}

/**
 * Exactly one group is the default.
 *
 * Enforced by clearing the flag everywhere else in the same operation, so two
 * defaults cannot coexist — which would make "the default pay group" a question
 * with two answers at the moment a new employee is onboarded.
 */
async function enforceSingleDefault(keepId) {
  await PayGroup.updateMany(
    { _id: { $ne: keepId }, isDefault: true },
    { $set: { isDefault: false } },
  );
}

export async function createPayGroup(input, context = {}) {
  try {
    const row = await PayGroup.create(input);
    if (row.isDefault) await enforceSingleDefault(row._id);
    await recordAudit(
      context.user,
      AUDIT_ACTIONS.PAY_GROUP_CREATED,
      `Created pay group ${row.code} (${row.name})`,
      context.req,
      { meta: { payGroupId: idStr(row._id), code: row.code } },
    );
    return payGroupDto(row.toObject());
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`Pay group code "${input.code}" is already in use.`, {
        code: 'PAY_GROUP_CODE_TAKEN',
      });
    }
    throw error;
  }
}

export async function updatePayGroup(id, input, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Pay group');
  try {
    const row = await PayGroup.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: input },
      { new: true },
    );
    if (!row) throw new HrmsNotFoundError('Pay group');
    if (row.isDefault) await enforceSingleDefault(row._id);
    await recordAudit(
      context.user,
      AUDIT_ACTIONS.PAY_GROUP_UPDATED,
      `Updated pay group ${row.code}`,
      context.req,
      { meta: { payGroupId: idStr(row._id), changed: Object.keys(input) } },
    );
    return payGroupDto(row.toObject());
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`Pay group code "${input.code}" is already in use.`, {
        code: 'PAY_GROUP_CODE_TAKEN',
      });
    }
    throw error;
  }
}

/** Soft delete. Refused while anyone is still paid through it. */
export async function deletePayGroup(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Pay group');

  const assigned = await EmployeeCompensation.countDocuments({
    payGroupId: id,
    effectiveTo: null,
  });
  if (assigned > 0) {
    throw new HrmsConflictError(
      `${assigned} employee(s) are still paid through this group. Reassign them first.`,
      { code: 'PAY_GROUP_IN_USE' },
    );
  }

  const row = await PayGroup.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date(), isDefault: false } },
    { new: true },
  );
  if (!row) throw new HrmsNotFoundError('Pay group');

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.PAY_GROUP_DELETED,
    `Retired pay group ${row.code}`,
    context.req,
    { meta: { payGroupId: idStr(row._id) } },
  );
  return { id: idStr(row._id), deleted: true };
}

// ===========================================================================
// Salary components
// ===========================================================================

const componentDto = (row) => ({
  id: idStr(row._id),
  code: row.code,
  name: row.name,
  type: row.type,
  taxable: Boolean(row.taxable),
  calculationType: row.calculationType,
  formula: row.formula ?? {},
  statutoryLink: row.statutoryLink ?? null,
  order: row.order ?? 0,
  deletedAt: row.deletedAt ?? null,
});

export async function listComponents({ includeDeleted = false } = {}) {
  const rows = await SalaryComponent.find(includeDeleted ? {} : { deletedAt: null })
    .sort({ order: 1, code: 1 })
    .lean();
  return rows.map(componentDto);
}

export async function createComponent(input, context = {}) {
  try {
    const row = await SalaryComponent.create(input);
    await recordAudit(
      context.user,
      AUDIT_ACTIONS.SALARY_COMPONENT_CREATED,
      `Created salary component ${row.code} (${row.type})`,
      context.req,
      { meta: { componentId: idStr(row._id), code: row.code, type: row.type } },
    );
    return componentDto(row.toObject());
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`Component code "${input.code}" is already in use.`, {
        code: 'COMPONENT_CODE_TAKEN',
      });
    }
    throw error;
  }
}

/**
 * Update a component.
 *
 * `code`, `type`, `calculationType` and `statutoryLink` are deliberately NOT
 * editable: every one of them changes what existing structures and historic
 * payslips mean. Turning an earning into a deduction would silently invert its
 * sign in every structure holding it. A component that is wrong in those ways
 * is retired and replaced.
 */
export async function updateComponent(id, input, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Salary component');
  const row = await SalaryComponent.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: input },
    { new: true },
  );
  if (!row) throw new HrmsNotFoundError('Salary component');

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.SALARY_COMPONENT_UPDATED,
    `Updated salary component ${row.code}`,
    context.req,
    { meta: { componentId: idStr(row._id), changed: Object.keys(input) } },
  );
  return componentDto(row.toObject());
}

/** Soft delete. Refused while a live structure still references it. */
export async function deleteComponent(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Salary component');

  const used = await SalaryStructure.countDocuments({
    deletedAt: null,
    'components.componentId': id,
  });
  if (used > 0) {
    throw new HrmsConflictError(
      `${used} salary structure(s) still use this component. Remove it from them first.`,
      { code: 'COMPONENT_IN_USE' },
    );
  }

  const row = await SalaryComponent.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date() } },
    { new: true },
  );
  if (!row) throw new HrmsNotFoundError('Salary component');

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.SALARY_COMPONENT_DELETED,
    `Retired salary component ${row.code}`,
    context.req,
    { meta: { componentId: idStr(row._id) } },
  );
  return { id: idStr(row._id), deleted: true };
}

// ===========================================================================
// Salary structures
// ===========================================================================

/**
 * Hydrate a structure's component references.
 *
 * ONE query for all components rather than one per row — the reference relies
 * on Prisma's `include`, and the naive Mongoose translation is an N+1 that a
 * payroll run would then multiply by the headcount.
 */
async function hydrate(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const componentIds = [
    ...new Set(list.flatMap((s) => (s.components ?? []).map((c) => idStr(c.componentId)))),
  ].filter(Boolean);

  const components = await SalaryComponent.find({ _id: { $in: componentIds } }).lean();
  const byId = new Map(components.map((c) => [idStr(c._id), componentDto(c)]));

  const hydrateOne = (s) => ({
    id: idStr(s._id),
    name: s.name,
    payGroupId: idStr(s.payGroupId),
    isDefault: Boolean(s.isDefault),
    deletedAt: s.deletedAt ?? null,
    components: (s.components ?? [])
      .map((sc) => ({
        componentId: idStr(sc.componentId),
        order: sc.order ?? 0,
        calculation: sc.calculation ?? {},
        component: byId.get(idStr(sc.componentId)) ?? null,
      }))
      // A component that has been hard-removed from the database leaves a
      // dangling reference; dropping it here keeps the structure renderable
      // rather than crashing every screen that reads it.
      .filter((sc) => sc.component !== null)
      .sort((a, b) => a.order - b.order),
  });

  return Array.isArray(rows) ? list.map(hydrateOne) : hydrateOne(list[0]);
}

export async function listStructures({ payGroupId, includeDeleted = false } = {}) {
  const filter = includeDeleted ? {} : { deletedAt: null };
  if (payGroupId) filter.payGroupId = oid(payGroupId);
  const rows = await SalaryStructure.find(filter).sort({ name: 1 }).lean();
  return hydrate(rows);
}

export async function getStructure(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Salary structure');
  const row = await SalaryStructure.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Salary structure');
  return hydrate(row);
}

/**
 * Validate a structure's component set before it is written.
 *
 * Two checks the reference does not make:
 *   - every referenced component must exist and be live
 *   - every formula dependency must be satisfied BY THIS STRUCTURE
 *
 * The second is the one that matters on payday. `HRA = 40% of BASIC` in a
 * structure with no BASIC evaluates to zero, and the reference stores it
 * happily; the employee is then short their entire house rent allowance and
 * nothing anywhere says why.
 */
async function assertComponentsResolve(components) {
  const ids = components.map((c) => c.componentId);
  const rows = await SalaryComponent.find({ _id: { $in: ids }, deletedAt: null }).lean();

  if (rows.length !== new Set(ids.map(String)).size) {
    const found = new Set(rows.map((r) => idStr(r._id)));
    const missing = ids.filter((id) => !found.has(String(id)));
    throw new HrmsValidationError('Some components do not exist or have been retired.', [
      { path: 'components', message: `Unknown component id(s): ${missing.join(', ')}` },
    ]);
  }

  const byId = new Map(rows.map((r) => [idStr(r._id), r]));
  const presentCodes = new Set(rows.map((r) => r.code));

  for (const sc of components) {
    const component = byId.get(String(sc.componentId));
    const effectiveFormula = { ...(component.formula ?? {}), ...(sc.calculation ?? {}) };
    for (const dependency of formulaDependencies(effectiveFormula)) {
      if (!presentCodes.has(dependency)) {
        throw new HrmsValidationError(
          `${component.code} is calculated from ${dependency}, which this structure does not contain.`,
          [{ path: 'components', message: `Add ${dependency}, or change ${component.code}.` }],
        );
      }
    }
  }

  return rows;
}

async function enforceSingleDefaultStructure(payGroupId, keepId) {
  await SalaryStructure.updateMany(
    { payGroupId, _id: { $ne: keepId }, isDefault: true },
    { $set: { isDefault: false } },
  );
}

export async function createStructure(input, context = {}) {
  const payGroup = await PayGroup.findOne({ _id: input.payGroupId, deletedAt: null }).lean();
  if (!payGroup) {
    throw new HrmsValidationError('Unknown pay group.', [
      { path: 'payGroupId', message: 'That pay group does not exist.' },
    ]);
  }

  await assertComponentsResolve(input.components);

  const row = await SalaryStructure.create({
    ...input,
    components: input.components.map((c) => ({ ...c, componentId: oid(c.componentId) })),
  });
  if (row.isDefault) await enforceSingleDefaultStructure(row.payGroupId, row._id);

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.SALARY_STRUCTURE_CREATED,
    `Created salary structure "${row.name}" with ${row.components.length} component(s)`,
    context.req,
    { meta: { structureId: idStr(row._id), payGroupId: idStr(row.payGroupId) } },
  );
  return getStructure(row._id);
}

/**
 * Update a structure.
 *
 * Refused once an employee is assigned to it, because changing the components
 * of a live structure silently changes what those people are paid next month
 * with no record of the before state. A revision is a NEW structure and a
 * compensation change — the same discipline the compensation service applies
 * to a raise.
 */
export async function updateStructure(id, input, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Salary structure');

  const existing = await SalaryStructure.findOne({ _id: id, deletedAt: null }).lean();
  if (!existing) throw new HrmsNotFoundError('Salary structure');

  if (input.components) {
    const assigned = await EmployeeCompensation.countDocuments({
      structureId: id,
      effectiveTo: null,
    });
    if (assigned > 0) {
      throw new HrmsConflictError(
        `${assigned} employee(s) are on this structure. Create a new structure and move them to it, ` +
          'so their previous pay basis stays on record.',
        { code: 'STRUCTURE_IN_USE' },
      );
    }
    await assertComponentsResolve(input.components);
  }

  const row = await SalaryStructure.findOneAndUpdate(
    { _id: id, deletedAt: null },
    {
      $set: {
        ...input,
        ...(input.components && {
          components: input.components.map((c) => ({ ...c, componentId: oid(c.componentId) })),
        }),
      },
    },
    { new: true },
  );
  if (row.isDefault) await enforceSingleDefaultStructure(row.payGroupId, row._id);

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.SALARY_STRUCTURE_UPDATED,
    `Updated salary structure "${row.name}"`,
    context.req,
    { meta: { structureId: idStr(row._id), changed: Object.keys(input) } },
  );
  return getStructure(id);
}

export async function deleteStructure(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Salary structure');

  const assigned = await EmployeeCompensation.countDocuments({
    structureId: id,
    effectiveTo: null,
  });
  if (assigned > 0) {
    throw new HrmsConflictError(
      `${assigned} employee(s) are still on this structure. Reassign them first.`,
      { code: 'STRUCTURE_IN_USE' },
    );
  }

  const row = await SalaryStructure.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date(), isDefault: false } },
    { new: true },
  );
  if (!row) throw new HrmsNotFoundError('Salary structure');

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.SALARY_STRUCTURE_DELETED,
    `Retired salary structure "${row.name}"`,
    context.req,
    { meta: { structureId: idStr(row._id) } },
  );
  return { id: idStr(row._id), deleted: true };
}

/**
 * What a CTC yields under this structure, before anyone is assigned to it.
 *
 * The reference's "preview" — and it runs the REAL engine rather than a
 * simplified copy, so what the admin sees while designing a structure is what
 * payroll will actually produce. A preview computed by a second implementation
 * is a preview that can lie.
 *
 * Statutory numbers need a config; without one the preview reports the
 * structure-only figures and says so, rather than pretending PF is zero.
 */
export async function previewStructure(id, { ctc, stateCode, month, year } = {}) {
  const structure = await getStructure(id);

  const now = new Date();
  const targetMonth = month ?? now.getUTCMonth() + 1;
  const targetYear = year ?? now.getUTCFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  const on = `${targetYear}-${pad(targetMonth)}-15`;

  const config = await resolveEffectiveConfig(on);
  if (!config) {
    throw new HrmsValidationError(
      'No statutory configuration is effective for that month, so a preview cannot include PF, ESI, PT, LWF or TDS. Create one first.',
      [{ path: 'config', message: 'No effective statutory configuration.' }],
    );
  }

  const daysInMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();

  const output = computePayslip({
    annualCtc: Number(ctc),
    overrides: {},
    structureComponents: structure.components,
    month: targetMonth,
    year: targetYear,
    stateCode: stateCode ?? null,
    statutoryConfig: config.config,
    daysInMonth,
    lopDays: 0,
    adjustments: [],
  });

  return {
    structureId: structure.id,
    structureName: structure.name,
    ctc: toDecimalString(ctc),
    stateCode: stateCode ?? null,
    month: targetMonth,
    year: targetYear,
    monthlyGross: output.gross,
    monthlyNet: output.netPay,
    monthlyDeductions: output.totalDeductions,
    employerContributions: output.employerContributions,
    /** Annualised alongside the monthly figure, as the reference's preview does. */
    lines: output.lines.map((l) => ({
      componentCode: l.componentCode,
      componentName: l.componentName,
      type: l.type,
      monthly: l.amount,
      annual: round2(l.amount * 12),
    })),
    statutoryBreakdown: output.statutoryBundle,
  };
}

export { fromDecimal };

export default {
  listPayGroups,
  getPayGroup,
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
};
