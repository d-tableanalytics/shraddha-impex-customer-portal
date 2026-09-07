/**
 * Payroll validation schemas (AD-6).
 *
 * Ported from the reference's `packages/shared-types/src/payroll.ts` and used
 * by both the Express validator and the React forms, so a rule cannot drift
 * between them.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections to the reference
 * ---------------------------------------------------------------------------
 * 1. MONEY IS A STRING ON THE WIRE. The reference types CTC and amounts as
 *    `z.number()`. AD-2 forbids that: by the time a float has been parsed the
 *    precision is already gone, and the value is on its way to a Decimal128.
 *    `moneyString` accepts a well-formed number for ergonomics but always
 *    yields a string.
 *
 * 2. FORMULAS ARE VALIDATED. The reference's `formulaSchema` is
 *    `z.record(z.string(), z.unknown())` — any object at all. A typo'd formula
 *    is therefore stored happily and surfaces as an unexplained ₹0 line on
 *    payday. `isValidFormula` refuses it at the boundary.
 *
 * 3. STATUTORY CONFIG HAS NO DEFAULTS. The reference defaults every rate and
 *    ceiling (`employeeRate: 0.12`, `wageCeiling: 15000`, …), so a config
 *    posted with an empty `pf: {}` silently becomes one particular year's
 *    Indian rules. AD-12 requires statutory values to be supplied data — a
 *    missing rate must be a 400, not an assumption. Every field is required.
 */

import { z } from 'zod';

import { objectId, isoDay, money, moneyString, paginationQuery } from '../validation/common.js';

import { isValidFormula } from '../payroll/formula.js';
import {
  COMPONENT_TYPES,
  CALCULATION_TYPES,
  STATUTORY_LINKS,
  COMPONENT_CODE_PATTERN,
  RUN_STATUSES,
} from '../constants/payroll.js';
import { INDIAN_STATE_CODES } from '../constants/hrms.js';

/**
 * A SIGNED money string.
 *
 * `moneyString` is non-negative, which is right for a CTC and wrong for an
 * adjustment: the sign is what distinguishes an extra payment from a recovery.
 */
const signedMoneyString = money({ allowNegative: true });

/** A formula AST the evaluator actually understands. */
const formula = z
  .record(z.string(), z.unknown())
  .default({})
  .refine(isValidFormula, {
    message:
      'Unrecognised formula. Use { amount }, { of, percent }, { of, proportion }, ' +
      '{ pct_of_annual, percent } or { op, args }.',
  });

// ---------------------------------------------------------------------------
// Pay group
// ---------------------------------------------------------------------------

const payGroupCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'Code is required.')
  .max(30)
  .regex(/^[A-Z0-9_-]+$/, 'Use uppercase letters, numbers, hyphen or underscore only.');

export const createPayGroupSchema = z
  .object({
    code: payGroupCode,
    name: z.string().trim().min(1).max(120),
    legalEntityName: z.string().trim().min(1).max(160),
    isDefault: z.boolean().default(false),
  })
  .strict();

export const updatePayGroupSchema = createPayGroupSchema.partial().strict();

// ---------------------------------------------------------------------------
// Salary component
// ---------------------------------------------------------------------------

export const createSalaryComponentSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(30)
      .regex(COMPONENT_CODE_PATTERN, 'Use UPPER_SNAKE_CASE, starting with a letter.'),
    name: z.string().trim().min(1).max(120),
    type: z.enum(COMPONENT_TYPES),
    taxable: z.boolean().default(true),
    calculationType: z.enum(CALCULATION_TYPES),
    formula,
    statutoryLink: z.enum(STATUTORY_LINKS).nullable().default(null),
    order: z.number().int().min(0).max(9999).default(0),
  })
  .strict()
  /**
   * A `statutory` component MUST name its bucket, and a non-statutory one must
   * not. The reference allows either combination: a statutory component with no
   * link silently computes zero, and a `fixed` component carrying a stray link
   * is simply confusing.
   */
  .refine((v) => (v.calculationType === 'statutory') === (v.statutoryLink !== null), {
    message:
      'A statutory component must set statutoryLink; any other calculation type must leave it null.',
    path: ['statutoryLink'],
  });

export const updateSalaryComponentSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    taxable: z.boolean().optional(),
    formula: formula.optional(),
    order: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Salary structure
// ---------------------------------------------------------------------------

const structureComponent = z
  .object({
    componentId: objectId,
    order: z.number().int().min(0).max(9999).default(0),
    calculation: formula,
  })
  .strict();

export const createSalaryStructureSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    payGroupId: objectId,
    isDefault: z.boolean().default(false),
    components: z.array(structureComponent).min(1, 'Add at least one component.'),
  })
  .strict()
  .refine(
    (v) => new Set(v.components.map((c) => c.componentId)).size === v.components.length,
    { message: 'The same component cannot appear twice in one structure.', path: ['components'] },
  );

export const updateSalaryStructureSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isDefault: z.boolean().optional(),
    components: z.array(structureComponent).min(1).optional(),
  })
  .strict();

/** `POST /structures/:id/preview` — what a CTC yields under this structure. */
export const structurePreviewSchema = z
  .object({
    ctc: moneyString,
    stateCode: z.enum(INDIAN_STATE_CODES).optional(),
    month: z.number().int().min(1).max(12).optional(),
    year: z.number().int().min(2000).max(2100).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Employee compensation
// ---------------------------------------------------------------------------

/**
 * Per-employee component pinning.
 *
 * Numeric only. The reference mixes the statutory flags into the same blob as
 * the amounts and then type-sniffs them back out at run time; here the flags
 * are first-class fields and this record holds only what it says it does.
 */
const overrides = z.record(z.string().regex(COMPONENT_CODE_PATTERN), z.number()).default({});

/** Old-regime TDS declarations. Annual figures. */
export const tdsExemptionsSchema = z
  .object({
    hraExemptAnnual: z.number().nonnegative().optional(),
    chapter6AInvestments: z.number().nonnegative().optional(),
    section80D: z.number().nonnegative().optional(),
    section80CCD_1B: z.number().nonnegative().optional(),
    section80E: z.number().nonnegative().optional(),
    section80G: z.number().nonnegative().optional(),
    homeLoanInterest: z.number().nonnegative().optional(),
    professionalTaxAnnual: z.number().nonnegative().optional(),
  })
  .strict()
  .default({});

export const createCompensationSchema = z
  .object({
    employeeId: objectId,
    payGroupId: objectId,
    structureId: objectId,
    ctc: moneyString,
    effectiveFrom: isoDay,
    overrides,
    /** Drives PT and LWF. Optional; the service falls back to the company default. */
    stateCode: z.enum(INDIAN_STATE_CODES).optional().nullable(),
    employeeRegime: z.enum(['old', 'new']).optional().nullable(),
    pfExcluded: z.boolean().default(false),
    disabled: z.boolean().default(false),
    exemptions: tdsExemptionsSchema,
    revisionReason: z.string().trim().max(300).optional().nullable(),
  })
  .strict();

export const compensationListQuerySchema = paginationQuery
  .extend({ employeeId: objectId.optional(), payGroupId: objectId.optional() })
  .strict();

// ---------------------------------------------------------------------------
// Statutory config
// ---------------------------------------------------------------------------

const rate = z.number().min(0).max(1);

const pfConfig = z
  .object({
    employeeRate: rate,
    employerRate: rate,
    wageCeiling: z.number().nonnegative(),
    epsCap: z.number().nonnegative(),
  })
  .strict();

const esiConfig = z
  .object({
    employeeRate: rate,
    employerRate: rate,
    grossThreshold: z.number().nonnegative(),
    disabledThreshold: z.number().nonnegative().optional(),
  })
  .strict();

const ptSlab = z
  .object({
    /** Null is the open-ended top slab. */
    maxMonthlyWage: z.number().nonnegative().nullable(),
    tax: z.number().nonnegative(),
  })
  .strict();

const lwfStateRule = z
  .object({
    periodicity: z.enum(['monthly', 'biannual', 'annual']),
    employee: z.number().nonnegative(),
    employer: z.number().nonnegative(),
    /**
     * Which months a non-monthly rule fires in.
     *
     * Configurable rather than the reference's hardcoded June/December, which
     * is a convention rather than a rule and differs by state.
     */
    months: z.array(z.number().int().min(1).max(12)).optional(),
  })
  .strict();

const tdsSlab = z
  .object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative().nullable(),
    rate,
  })
  .strict();

/**
 * PT and LWF are keyed BY STATE CODE.
 *
 * This is the shape AD-12 asks for: adding a state is a configuration row, and
 * no state is privileged in code. A state absent from the record simply has no
 * PT or no LWF, which is the correct answer for several of them.
 */
export const statutoryConfigPayloadSchema = z
  .object({
    pf: pfConfig,
    esi: esiConfig,
    /**
     * `partialRecord`, NOT `record`.
     *
     * Zod 4's `z.record` with an enum key requires EVERY key to be present, so
     * a plain `record` here would demand PT slabs for all 36 states and union
     * territories before a configuration could be saved. That is precisely
     * backwards: a state absent from this map has no professional tax, which is
     * the correct and common answer.
     */
    pt: z.partialRecord(z.enum(INDIAN_STATE_CODES), z.array(ptSlab)),
    lwf: z.partialRecord(z.enum(INDIAN_STATE_CODES), lwfStateRule),
    tds: z
      .object({
        regime: z.enum(['old', 'new', 'either']),
        old: z
          .object({
            slabs: z.array(tdsSlab).min(1),
            standardDeduction: z.number().nonnegative(),
            chapter6AMax: z.number().nonnegative(),
            hraExemption: z.boolean(),
          })
          .strict(),
        new: z
          .object({
            slabs: z.array(tdsSlab).min(1),
            standardDeduction: z.number().nonnegative(),
          })
          .strict(),
        cess: rate,
      })
      .strict(),
  })
  .strict();

export const createStatutoryConfigSchema = z
  .object({
    effectiveFrom: isoDay,
    effectiveTo: isoDay.nullable().optional().default(null),
    config: statutoryConfigPayloadSchema,
    note: z.string().trim().max(300).optional().nullable(),
  })
  .strict()
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    message: 'effectiveTo must be on or after effectiveFrom.',
    path: ['effectiveTo'],
  });

/**
 * Editing a not-yet-effective version.
 *
 * Declared explicitly rather than as `createStatutoryConfigSchema.partial()`,
 * because Zod refuses `.partial()` on a schema carrying a `.refine()` — and the
 * date ordering rule cannot be checked on a partial anyway, since either half
 * of the pair may be absent. The service re-reads the row and validates the
 * resulting range against what is actually stored.
 */
export const updateStatutoryConfigSchema = z
  .object({
    effectiveFrom: isoDay.optional(),
    effectiveTo: isoDay.nullable().optional(),
    config: statutoryConfigPayloadSchema.optional(),
    note: z.string().trim().max(300).optional().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Runs, adjustments, payslips
// ---------------------------------------------------------------------------

export const createPayrollRunSchema = z
  .object({
    payGroupId: objectId,
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(2000).max(2100),
  })
  .strict();

export const runListQuerySchema = paginationQuery
  .extend({
    payGroupId: objectId.optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    status: z.enum(RUN_STATUSES).optional(),
  })
  .strict();

export const createAdjustmentSchema = z
  .object({
    employeeId: objectId,
    componentCode: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(40)
      .regex(COMPONENT_CODE_PATTERN, 'Use UPPER_SNAKE_CASE, starting with a letter.'),
    /** Signed — a negative adjustment is a recovery, not a payment. */
    amount: signedMoneyString.refine((v) => Number(v) !== 0, {
      message: 'An adjustment of zero has no effect.',
    }),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

export const payslipListQuerySchema = paginationQuery
  .extend({
    employeeId: objectId.optional(),
    runId: objectId.optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
  })
  .strict();

export default {
  createPayGroupSchema,
  updatePayGroupSchema,
  createSalaryComponentSchema,
  updateSalaryComponentSchema,
  createSalaryStructureSchema,
  updateSalaryStructureSchema,
  structurePreviewSchema,
  createCompensationSchema,
  compensationListQuerySchema,
  statutoryConfigPayloadSchema,
  createStatutoryConfigSchema,
  updateStatutoryConfigSchema,
  createPayrollRunSchema,
  runListQuerySchema,
  createAdjustmentSchema,
  payslipListQuerySchema,
};
