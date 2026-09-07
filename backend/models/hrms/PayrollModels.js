/**
 * Payroll collections.
 *
 * Ported from the reference's Prisma models, adapted to Mongoose and the
 * accepted decisions:
 *
 *   AD-1   single tenant, so no organizationId anywhere
 *   AD-2   ObjectId keys, no foreign keys — the services check references,
 *          and MONEY IS Decimal128, never a float
 *   AD-12  statutory rules are versioned configuration, never constants
 *   AD-13  every list is server-paginated, so the indexes below matter
 *
 * Grouped in one file because these six collections are one aggregate: a
 * structure is meaningless without its components, a run without its payslips.
 * Splitting them into six files would spread one schema across six imports
 * with no gain — Attendance's three models earned their own files because they
 * are independently useful; these are not.
 *
 * ---------------------------------------------------------------------------
 * Money is Decimal128, and the reason is not theoretical
 * ---------------------------------------------------------------------------
 * The reference stores its payroll money in Postgres `Decimal` and is correct
 * to. Here every monetary path is `Schema.Types.Decimal128`, written from a
 * STRING (see shared/payroll/money.js#toDecimalString). A CTC of 1,00,000 and a
 * net of 43,192.50 both survive a round trip exactly; stored as doubles they
 * would accumulate the residue that makes a year's payslips fail to sum to the
 * annual figure by a few paise.
 */

import mongoose from 'mongoose';

import {
  COMPONENT_TYPES,
  CALCULATION_TYPES,
  STATUTORY_LINKS,
  COMPONENT_CODE_PATTERN,
  RUN_STATUSES,
} from '../../shared/constants/payroll.js';

const { Schema } = mongoose;

/** A monetary field. Always Decimal128; never `Number`. */
const money = (extra = {}) => ({ type: Schema.Types.Decimal128, ...extra });

/** `YYYY-MM-DD`, matching how Leave and Holidays already store calendar days. */
const isoDay = {
  type: String,
  match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'],
};

// ---------------------------------------------------------------------------
// PayGroup — the payroll's legal-entity grouping
// ---------------------------------------------------------------------------

/**
 * A pay group is what a run runs FOR.
 *
 * The reference carries `legalEntityName` separately from `name` because the
 * name on a payslip is the registered entity, which is often not what HR calls
 * the group internally.
 */
const payGroupSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 30,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    legalEntityName: { type: String, required: true, trim: true, maxlength: 160 },
    /** Exactly one group may be the default; the service enforces it. */
    isDefault: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, collection: 'hrms_pay_groups' },
);

// Partial over live rows, so a retired group's code can be reused — the same
// choice Org Structure made for departments.
payGroupSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

// ---------------------------------------------------------------------------
// SalaryComponent — the catalogue of things a payslip can contain
// ---------------------------------------------------------------------------

const salaryComponentSchema = new Schema(
  {
    /** UPPER_SNAKE_CASE, because a formula names components by code. */
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 30,
      match: [COMPONENT_CODE_PATTERN, 'Use UPPER_SNAKE_CASE, starting with a letter'],
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: COMPONENT_TYPES, required: true },
    /** Whether the amount forms part of taxable income. */
    taxable: { type: Boolean, default: true },
    calculationType: { type: String, enum: CALCULATION_TYPES, required: true },
    /**
     * The formula AST (see shared/payroll/formula.js). Mixed because the shape
     * varies by node type — which is exactly why the schema validates it
     * through `isValidFormula` before a write rather than trusting the blob.
     */
    formula: { type: Schema.Types.Mixed, default: () => ({}) },
    /** Which statutory bucket a `statutory` component draws from. */
    statutoryLink: { type: String, enum: [...STATUTORY_LINKS, null], default: null },
    order: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, collection: 'hrms_salary_components' },
);

salaryComponentSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
salaryComponentSchema.index({ deletedAt: 1, order: 1 });

// ---------------------------------------------------------------------------
// SalaryStructure — an ordered set of components, per pay group
// ---------------------------------------------------------------------------

const structureComponentSchema = new Schema(
  {
    componentId: { type: Schema.Types.ObjectId, required: true },
    order: { type: Number, default: 0 },
    /**
     * Overlays the component's own formula for THIS structure, so one
     * component can appear at different rates in two structures without
     * duplicating the catalogue entry.
     */
    calculation: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false },
);

const salaryStructureSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    payGroupId: { type: Schema.Types.ObjectId, required: true, index: true },
    isDefault: { type: Boolean, default: false },
    components: {
      type: [structureComponentSchema],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'A salary structure needs at least one component.',
      },
    },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, collection: 'hrms_salary_structures' },
);

salaryStructureSchema.index({ deletedAt: 1, payGroupId: 1, name: 1 });

// ---------------------------------------------------------------------------
// EmployeeCompensation — effective-dated CTC + structure assignment
// ---------------------------------------------------------------------------

/**
 * What an employee is paid, from when.
 *
 * Effective-dated rather than mutable: a revision opens a NEW row and closes
 * the previous one the day before. That is what lets a payroll run for March
 * still compute on March's salary after an April raise, and it is why a
 * historic payslip can be regenerated and match.
 */
const employeeCompensationSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    payGroupId: { type: Schema.Types.ObjectId, required: true, index: true },
    structureId: { type: Schema.Types.ObjectId, required: true },

    /** Annual cost to company. Decimal128 — see the header. */
    ctc: money({ required: true }),

    effectiveFrom: { ...isoDay, required: true },
    /** Null while this is the live row. */
    effectiveTo: { ...isoDay, default: null },

    /**
     * Per-employee pinning and flags.
     *
     * Numeric keys pin a component to a fixed monthly amount. The reserved
     * non-numeric keys carry the statutory switches the engine needs:
     * `stateCode` (drives PT and LWF), `employeeRegime` ('old'|'new' for TDS),
     * `pfExcluded`, `disabled`. The reference stuffs all of these into the same
     * untyped jsonb; they are broken out here so they can be validated.
     */
    overrides: { type: Schema.Types.Mixed, default: () => ({}) },

    /** Drives PT and LWF. Falls back to the location's state, then the company's. */
    stateCode: { type: String, default: null, maxlength: 2 },
    employeeRegime: { type: String, enum: ['old', 'new', null], default: null },
    pfExcluded: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    /** Old-regime TDS declarations. */
    exemptions: { type: Schema.Types.Mixed, default: () => ({}) },

    revisionReason: { type: String, default: null, maxlength: 300 },
    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_employee_compensations' },
);

/** The run's central query: everyone in a pay group effective on a date. */
employeeCompensationSchema.index({ payGroupId: 1, effectiveFrom: 1, effectiveTo: 1 });
/** One employee's revision history, newest first. */
employeeCompensationSchema.index({ employeeId: 1, effectiveFrom: -1 });

// ---------------------------------------------------------------------------
// StatutoryConfig — versioned PF/ESI/PT/LWF/TDS rules
// ---------------------------------------------------------------------------

/**
 * The rules in force over a date range.
 *
 * Versioned, never edited once effective: a payroll run that has already used a
 * config must keep computing the same way, or a regenerated payslip would
 * disagree with the one the employee was given. AD-12 in practice.
 */
const statutoryConfigSchema = new Schema(
  {
    effectiveFrom: { ...isoDay, required: true },
    effectiveTo: { ...isoDay, default: null },
    /** The whole PF/ESI/PT/LWF/TDS payload; validated by Zod before a write. */
    config: { type: Schema.Types.Mixed, required: true },
    note: { type: String, default: null, maxlength: 300 },
    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_statutory_configs' },
);

statutoryConfigSchema.index({ effectiveFrom: -1 });

// ---------------------------------------------------------------------------
// PayrollRun
// ---------------------------------------------------------------------------

const runTotalsSchema = new Schema(
  {
    gross: money({ default: null }),
    netPay: money({ default: null }),
    deductions: money({ default: null }),
    employerContributions: money({ default: null }),
    headcount: { type: Number, default: 0 },
  },
  { _id: false },
);

const payrollRunSchema = new Schema(
  {
    payGroupId: { type: Schema.Types.ObjectId, required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true, min: 2000, max: 2100 },

    status: { type: String, enum: RUN_STATUSES, default: 'draft', required: true, index: true },
    totals: { type: runTotalsSchema, default: () => ({}) },

    /** Which statutory config the run computed against — provenance. */
    statutoryConfigId: { type: Schema.Types.ObjectId, default: null },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
    computedAt: { type: Date, default: null },
    lockedByUserId: { type: Schema.Types.ObjectId, default: null },
    lockedAt: { type: Date, default: null },
    disbursedByUserId: { type: Schema.Types.ObjectId, default: null },
    disbursedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_payroll_runs' },
);

/**
 * ONE run per pay group per month.
 *
 * This is what actually prevents a duplicate payroll: two admins creating the
 * same month at once both read "no run", both create, and the index refuses the
 * second. A read-then-write check alone loses that race — and the cost of
 * losing it is paying everybody twice.
 */
payrollRunSchema.index({ payGroupId: 1, year: 1, month: 1 }, { unique: true });
payrollRunSchema.index({ year: -1, month: -1 });

// ---------------------------------------------------------------------------
// Payslip
// ---------------------------------------------------------------------------

const payslipLineSchema = new Schema(
  {
    componentCode: { type: String, required: true },
    componentName: { type: String, required: true },
    type: { type: String, enum: COMPONENT_TYPES, required: true },
    amount: money({ required: true }),
    taxable: { type: Boolean, default: false },
    /** Small secondary text under the name; used by the LOP line. */
    subtitle: { type: String, default: null },
  },
  { _id: false },
);

const payslipSchema = new Schema(
  {
    runId: { type: Schema.Types.ObjectId, required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },

    /**
     * Denormalised from the run.
     *
     * A payslip outlives the question "which run made this": an employee asks
     * for "March 2026", and month/year on the row answers it without a join.
     */
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true, min: 2000, max: 2100 },

    gross: money({ required: true }),
    netPay: money({ required: true }),
    totalDeductions: money({ required: true }),
    employerContributions: money({ required: true }),

    lines: { type: [payslipLineSchema], default: [] },

    /**
     * The statutory breakdown the engines produced.
     *
     * Kept because it is the audit trail for a number an employee may dispute:
     * "why is my PF ₹1,800" is answerable from the stored breakdown without
     * re-running anything.
     */
    statutoryBreakdown: { type: Schema.Types.Mixed, default: null },

    /** Days of unpaid leave priced into this slip. */
    lopDays: { type: Number, default: 0 },

    /** Storage key for the rendered PDF. Null until one is generated. */
    pdfKey: { type: String, default: null },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'hrms_payslips' },
);

/** One payslip per employee per run; a recompute replaces rather than duplicates. */
payslipSchema.index({ runId: 1, employeeId: 1 }, { unique: true });
/** "My payslips", newest first. */
payslipSchema.index({ employeeId: 1, year: -1, month: -1 });

// ---------------------------------------------------------------------------
// PayrollAdjustment
// ---------------------------------------------------------------------------

/**
 * A one-off correction applied to an employee in one run.
 *
 * Survives a recompute deliberately — an adjustment is an intentional
 * instruction, not derived data, so wiping it when payslips are regenerated
 * would quietly undo an HR decision. The reference behaves the same way.
 */
const payrollAdjustmentSchema = new Schema(
  {
    runId: { type: Schema.Types.ObjectId, required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    componentCode: { type: String, required: true, trim: true, maxlength: 40 },
    /** Signed: positive adds an earning, negative adds a deduction. */
    amount: money({ required: true }),
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_payroll_adjustments' },
);

payrollAdjustmentSchema.index({ runId: 1, employeeId: 1 });

// ---------------------------------------------------------------------------

export const PayGroup =
  mongoose.models.PayGroup || mongoose.model('PayGroup', payGroupSchema);
export const SalaryComponent =
  mongoose.models.SalaryComponent || mongoose.model('SalaryComponent', salaryComponentSchema);
export const SalaryStructure =
  mongoose.models.SalaryStructure || mongoose.model('SalaryStructure', salaryStructureSchema);
export const EmployeeCompensation =
  mongoose.models.EmployeeCompensation ||
  mongoose.model('EmployeeCompensation', employeeCompensationSchema);
export const StatutoryConfig =
  mongoose.models.StatutoryConfig || mongoose.model('StatutoryConfig', statutoryConfigSchema);
export const PayrollRun =
  mongoose.models.PayrollRun || mongoose.model('PayrollRun', payrollRunSchema);
export const Payslip = mongoose.models.Payslip || mongoose.model('Payslip', payslipSchema);
export const PayrollAdjustment =
  mongoose.models.PayrollAdjustment ||
  mongoose.model('PayrollAdjustment', payrollAdjustmentSchema);

export default {
  PayGroup,
  SalaryComponent,
  SalaryStructure,
  EmployeeCompensation,
  StatutoryConfig,
  PayrollRun,
  Payslip,
  PayrollAdjustment,
};
