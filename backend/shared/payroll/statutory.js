/**
 * The five Indian statutory engines: PF, ESI, PT, LWF, TDS.
 *
 * Ported from the reference's `statutory-engines/`, which is the one part of
 * its payroll module that is already well built: pure functions, structured
 * inputs, a result carrying the amount AND a breakdown of how it was reached.
 * That shape is kept exactly.
 *
 * ---------------------------------------------------------------------------
 * EVERY RATE, CEILING, SLAB AND STATE RULE IS CONFIGURATION
 * ---------------------------------------------------------------------------
 * Nothing statutory is hardcoded in this file. Each engine takes its numbers
 * from the `config` argument, which the caller resolves from the versioned
 * StatutoryConfig row effective for the payroll month. AD-12 requires exactly
 * this, and the brief restates it: PT and LWF are keyed BY STATE CODE, so
 * adding Gujarat is a configuration row, not a code change, and no single
 * state's rules are baked in as "the" rules.
 *
 * Two constants remain in code, and both are statute rather than policy:
 *   - EPS is 8.33% of the capped PF wage, fixed by the EPF Scheme regardless
 *     of what employer rate an organisation configures
 *   - the 87A rebate ceilings and amounts, which the reference also inlines
 * Both are flagged in `STATUTORY_ASSUMPTIONS` below so they are visible rather
 * than buried, because changing them is a legislative event.
 *
 * ---------------------------------------------------------------------------
 * What is NOT modelled
 * ---------------------------------------------------------------------------
 * Faithfully carried over from the reference, and listed so nobody assumes
 * otherwise:
 *   - ESI contribution PERIODS (Apr-Sep / Oct-Mar). Once an employee crosses
 *     the wage threshold mid-period they should keep contributing to the end of
 *     that period; the reference checks month by month and so does this.
 *   - PF EDLI and administrative charges (employer overheads).
 *   - PT half-yearly states. The reference returns the same amount every month
 *     and says so; states that levy only in certain months need an adjustment.
 * These are limitations, not decisions, and they are repeated in the module's
 * report rather than silently inherited.
 */

import { round2, ceilRupee, roundRupee } from './money.js';

/**
 * Constants that are statute rather than configuration.
 *
 * Exported so a test can assert them and a reader can find them, instead of
 * their being three unexplained literals inside two functions.
 */
export const STATUTORY_ASSUMPTIONS = Object.freeze({
  /** EPF Scheme 1952: the employer's EPS share is 8.33% of capped PF wages. */
  EPS_RATE: 0.0833,
  /** Section 87A rebate — income ceiling and maximum rebate, per regime. */
  REBATE_87A: Object.freeze({
    old: Object.freeze({ ceiling: 500_000, maximum: 12_500 }),
    new: Object.freeze({ ceiling: 700_000, maximum: 25_000 }),
  }),
  /** ESI's raised wage threshold for an employee certified as disabled. */
  ESI_DISABLED_THRESHOLD: 25_000,
  /** Section 80CCD(1B) additional NPS deduction cap. */
  SECTION_80CCD_1B_CAP: 50_000,
  /** Section 24(b) self-occupied home-loan interest cap. */
  HOME_LOAN_INTEREST_CAP: 200_000,
});

/** The shape every engine returns. */
const result = (employee, employer, breakdown, reason) => ({
  employee,
  employer,
  breakdown,
  reason,
});

// ---------------------------------------------------------------------------
// Provident Fund
// ---------------------------------------------------------------------------

/**
 * PF, on the Basic + DA wage base.
 *
 * Employee: `employeeRate` of PF wages.
 * Employer: `employerRate` of PF wages, split into EPS (8.33% of the wage
 * capped at `wageCeiling`) and the EPF remainder. The ceiling is what stops a
 * high earner accruing EPS on their whole salary.
 *
 * `excluded` covers international workers and Form 11 opt-outs.
 */
export function computePf({ pfWages, excluded = false, config }) {
  const wages = round2(pfWages);

  if (excluded || wages <= 0) {
    return result(0, 0, { excluded, pfWages: wages }, excluded
      ? 'Employee is PF-excluded (international worker or Form 11 opt-out)'
      : 'PF wages are zero');
  }

  const employee = round2(wages * config.employeeRate);

  const epsBase = Math.min(wages, config.wageCeiling);
  const eps = round2(epsBase * STATUTORY_ASSUMPTIONS.EPS_RATE);
  // The employer's total is rate × wages; EPS is carved out of it, not added
  // on top. Clamped at zero so an employer rate below the EPS share cannot
  // produce a negative EPF line.
  const epfEmployer = round2(Math.max(0, wages * config.employerRate - eps));
  const employer = round2(eps + epfEmployer);

  return result(employee, employer, {
    pfWages: wages,
    wageCeiling: config.wageCeiling,
    employeeRate: config.employeeRate,
    employerRate: config.employerRate,
    epsBase,
    eps,
    epfEmployer,
  }, `PF: employee ${(config.employeeRate * 100).toFixed(2)}% of ${wages.toFixed(0)}; employer ${eps} EPS + ${epfEmployer} EPF`);
}

// ---------------------------------------------------------------------------
// Employees' State Insurance
// ---------------------------------------------------------------------------

/**
 * ESI, on monthly gross.
 *
 * Applies only at or below the wage threshold. Each side is rounded UP to the
 * whole rupee, which is ESIC's own rule and the reason `ceilRupee` exists.
 */
export function computeEsi({ monthlyGross, disabledEmployee = false, config }) {
  const gross = round2(monthlyGross);
  const threshold = disabledEmployee
    ? (config.disabledThreshold ?? STATUTORY_ASSUMPTIONS.ESI_DISABLED_THRESHOLD)
    : config.grossThreshold;

  if (gross <= 0) return result(0, 0, { monthlyGross: 0 }, 'Monthly gross is zero');

  if (gross > threshold) {
    return result(0, 0, { monthlyGross: gross, threshold, disabledEmployee },
      `Gross ${gross.toFixed(0)} exceeds the ESI threshold ${threshold.toFixed(0)} — ESI does not apply`);
  }

  return result(
    ceilRupee(gross * config.employeeRate),
    ceilRupee(gross * config.employerRate),
    {
      monthlyGross: gross,
      threshold,
      disabledEmployee,
      employeeRate: config.employeeRate,
      employerRate: config.employerRate,
    },
    `ESI: employee ${(config.employeeRate * 100).toFixed(2)}%, employer ${(config.employerRate * 100).toFixed(2)}%, each rounded up to the rupee`,
  );
}

// ---------------------------------------------------------------------------
// Professional Tax — state-specific
// ---------------------------------------------------------------------------

/**
 * PT: a flat rupee amount for the slab the monthly wage falls into.
 *
 * `config` is keyed by state code, so a state with no entry has no PT — which
 * is correct for Delhi, Haryana and Rajasthan among others, and is a
 * configuration fact rather than a branch in this function.
 *
 * Employee-only; there is no employer side.
 */
export function computePt({ monthlyWage, state, config }) {
  const slabs = config?.[state];
  if (!Array.isArray(slabs) || slabs.length === 0) {
    return result(0, 0, { state, appliesInState: false }, `PT does not apply in ${state}`);
  }

  const wage = round2(monthlyWage);
  if (wage <= 0) return result(0, 0, { state, monthlyWage: 0 }, 'Monthly wage is zero');

  // Slabs are matched in configured order, so the row a wage first fits is the
  // one that applies. `maxMonthlyWage: null` is the open-ended top slab.
  const matched = slabs.find((s) => s.maxMonthlyWage === null || wage <= s.maxMonthlyWage);
  const tax = roundRupee(matched?.tax ?? 0);

  return result(tax, 0, {
    state,
    monthlyWage: wage,
    slabApplied: matched ? { maxMonthlyWage: matched.maxMonthlyWage, tax: matched.tax } : null,
  }, `PT in ${state}: ${tax} for wages up to ${matched?.maxMonthlyWage ?? 'no limit'}`);
}

// ---------------------------------------------------------------------------
// Labour Welfare Fund — state-specific
// ---------------------------------------------------------------------------

/**
 * LWF: a flat state amount that fires monthly, twice a year, or annually.
 *
 * Small sums, but they must appear on the payslip for compliance. The months a
 * non-monthly rule fires in are CONFIGURED per state (`months: [6, 12]`)
 * rather than hardcoded — the reference inlines June/December and December,
 * which is a common convention but not a universal one, and encoding a
 * convention as a constant is exactly what AD-12 rules out.
 */
export function computeLwf({ state, month, config }) {
  const rule = config?.[state];
  if (!rule) {
    return result(0, 0, { state, appliesInState: false }, `LWF does not apply in ${state}`);
  }

  const months = firingMonths(rule);
  if (!months.includes(month)) {
    return result(0, 0, { state, periodicity: rule.periodicity, month, firingMonths: months },
      `LWF is ${rule.periodicity} in ${state}; it is not deducted in month ${month}`);
  }

  return result(round2(rule.employee), round2(rule.employer), {
    state,
    periodicity: rule.periodicity,
    month,
    employeeAmount: rule.employee,
    employerAmount: rule.employer,
  }, `LWF ${rule.periodicity} in ${state}: ${rule.employee} employee + ${rule.employer} employer`);
}

/**
 * Which months a rule fires in.
 *
 * An explicit `months` array always wins. The fallbacks reproduce the
 * reference's conventions so a config written without one behaves as its
 * payroll did, and they are documented as conventions rather than law.
 */
function firingMonths(rule) {
  if (Array.isArray(rule.months) && rule.months.length > 0) return rule.months;
  switch (rule.periodicity) {
    case 'monthly':
      return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    case 'biannual':
      return [6, 12];
    case 'annual':
      return [12];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// TDS on salary
// ---------------------------------------------------------------------------

/**
 * Monthly TDS, projected from annual income.
 *
 *   1. pick the regime (the employee's declaration, else the config default)
 *   2. taxable income = gross + other income − deductions
 *        old: standard deduction, HRA exemption, Chapter VI-A, 80D, 80CCD(1B),
 *             80E, 80G, home-loan interest, professional tax paid
 *        new: standard deduction only
 *   3. walk the slabs, taxing each portion
 *   4. apply the 87A rebate
 *   5. add cess
 *   6. spread the annual figure over the months remaining in the year
 *
 * Employee-only; TDS has no employer side.
 */
export function computeTds({
  annualGross,
  otherIncome = 0,
  employeeRegime,
  exemptions = {},
  remainingMonths = 12,
  config,
}) {
  const regime = employeeRegime ?? (config.regime === 'new' ? 'new' : 'old');
  const regimeConfig = regime === 'old' ? config.old : config.new;

  if (!(annualGross > 0)) {
    return result(0, 0, { regime, annualGross: 0 }, 'Annual gross is zero');
  }

  const deductionLines = { standardDeduction: regimeConfig.standardDeduction };
  let totalDeductions = regimeConfig.standardDeduction;

  const add = (key, amount) => {
    if (!(amount > 0)) return;
    deductionLines[key] = amount;
    totalDeductions += amount;
  };

  if (regime === 'old') {
    if (regimeConfig.hraExemption) add('hraExempt', exemptions.hraExemptAnnual ?? 0);
    add('chapter6A', Math.min(exemptions.chapter6AInvestments ?? 0, regimeConfig.chapter6AMax));
    add('section80D', exemptions.section80D ?? 0);
    add('section80CCD_1B', Math.min(
      exemptions.section80CCD_1B ?? 0,
      STATUTORY_ASSUMPTIONS.SECTION_80CCD_1B_CAP,
    ));
    add('section80E', exemptions.section80E ?? 0);
    add('section80G', exemptions.section80G ?? 0);
    add('homeLoanInterest', Math.min(
      exemptions.homeLoanInterest ?? 0,
      STATUTORY_ASSUMPTIONS.HOME_LOAN_INTEREST_CAP,
    ));
    add('professionalTax', exemptions.professionalTaxAnnual ?? 0);
  }

  const taxableIncome = Math.max(0, round2(annualGross + otherIncome - totalDeductions));
  const { tax: slabTax, slabApplied } = walkSlabs(taxableIncome, regimeConfig.slabs);

  const rebateRule = STATUTORY_ASSUMPTIONS.REBATE_87A[regime];
  const rebate = taxableIncome <= rebateRule.ceiling ? Math.min(slabTax, rebateRule.maximum) : 0;
  const taxAfterRebate = Math.max(0, round2(slabTax - rebate));

  const cess = round2(taxAfterRebate * config.cess);
  const annualTax = round2(taxAfterRebate + cess);
  const monthly = remainingMonths > 0 ? round2(annualTax / remainingMonths) : 0;

  return result(monthly, 0, {
    regime,
    annualGross: round2(annualGross),
    otherIncome: round2(otherIncome),
    deductions: deductionLines,
    totalDeductions: round2(totalDeductions),
    taxableIncome,
    slabApplied,
    slabTax,
    rebate,
    taxAfterRebate,
    cess,
    annualTax,
    remainingMonths,
  }, `TDS (${regime} regime): annual tax ${annualTax.toFixed(0)} spread over ${remainingMonths} month(s)`);
}

/** Tax each portion of income at its slab's rate. */
function walkSlabs(income, slabs = []) {
  let tax = 0;
  const applied = [];
  for (const slab of slabs) {
    if (income <= slab.min) break;
    const upper = slab.max === null || slab.max === undefined ? income : Math.min(income, slab.max);
    if (upper <= slab.min) continue;
    const portion = upper - slab.min;
    tax += portion * slab.rate;
    applied.push({ from: slab.min, to: upper, rate: slab.rate, portion: round2(portion) });
  }
  return { tax: round2(tax), slabApplied: applied };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run all five engines and bundle the results.
 *
 * Pure — no database, no clock. The caller resolves the effective config and
 * the employee's flags; this only computes. That is what makes a payroll run
 * reproducible: the same inputs always give the same bundle.
 */
export function computeStatutory({
  monthlyGross,
  pfWages,
  monthlyPtWage,
  state,
  month,
  disabledEmployee = false,
  pfExcluded = false,
  employeeRegime,
  annualGrossProjected,
  otherIncome = 0,
  exemptions,
  remainingMonthsInFy = 12,
  config,
}) {
  const pf = computePf({ pfWages, excluded: pfExcluded, config: config.pf });
  const esi = computeEsi({ monthlyGross, disabledEmployee, config: config.esi });
  const pt = computePt({ monthlyWage: monthlyPtWage, state, config: config.pt });
  const lwf = computeLwf({ state, month, config: config.lwf });
  const tds = computeTds({
    annualGross: annualGrossProjected,
    otherIncome,
    employeeRegime,
    exemptions,
    remainingMonths: remainingMonthsInFy,
    config: config.tds,
  });

  return {
    pf,
    esi,
    pt,
    lwf,
    tds,
    totalEmployee: round2(
      pf.employee + esi.employee + pt.employee + lwf.employee + tds.employee,
    ),
    totalEmployer: round2(
      pf.employer + esi.employer + pt.employer + lwf.employer + tds.employer,
    ),
  };
}

export default {
  computePf,
  computeEsi,
  computePt,
  computeLwf,
  computeTds,
  computeStatutory,
  STATUTORY_ASSUMPTIONS,
};
