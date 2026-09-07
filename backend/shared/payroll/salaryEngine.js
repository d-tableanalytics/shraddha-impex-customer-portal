/**
 * Per-employee payslip computation.
 *
 * Ported from the reference's `salary-engine.service.ts`. PURE: given the same
 * employee, structure, compensation, statutory config, LOP days and
 * adjustments it always produces the same payslip. The brief requires exactly
 * that, and it is what makes a payroll run reproducible and unit-testable
 * without a database.
 *
 * ---------------------------------------------------------------------------
 * Resolution order — the order matters and is the reference's
 * ---------------------------------------------------------------------------
 *   1. non-statutory components, evaluated in two passes
 *   2. per-employee overrides pin a component to a fixed amount
 *   3. preliminary gross feeds the statutory engines
 *   4. statutory components take their amount from the bundle
 *   5. Loss of Pay, priced off the structure's own earnings
 *   6. adjustments applied on top
 *   7. totals summed by component type
 *
 * ---------------------------------------------------------------------------
 * Why TWO passes over the components
 * ---------------------------------------------------------------------------
 * HRA is `40% of BASIC`, and a structure may list HRA before BASIC. The first
 * pass evaluates HRA against a BASIC that is not resolved yet and gets zero;
 * the second pass, with BASIC now in the map, gets the real figure. The
 * reference does the same, and two passes settle every ordering a
 * single-reference formula can produce. A formula chain three deep in the
 * wrong order would still need a third pass — which is why the structure
 * service refuses a component whose dependency the structure does not contain,
 * and why `formulaDependencies` exists.
 */

import { round2, sumMoney } from './money.js';
import { evalFormula } from './formula.js';
import { computeStatutory } from './statutory.js';
import {
  PF_WAGE_COMPONENT_CODES,
  LOP_COMPONENT_CODE,
  FINANCIAL_YEAR_START_MONTH,
} from '../constants/payroll.js';

/** Earnings and reimbursements both add to gross. */
const isEarning = (type) => type === 'earning' || type === 'reimbursement';

/**
 * Which side of a statutory bucket a component takes.
 *
 * The component's own `type` decides: a `deduction` linked to PF is the
 * employee's share, an `employer_contribution` linked to PF is the employer's.
 * PT and TDS have no employer side, so both always read the employee figure.
 */
function statutoryAmount(component, bundle) {
  const link = component.statutoryLink;
  if (!link) return 0;
  const employerSide = component.type === 'employer_contribution';
  switch (link) {
    case 'pf':
      return employerSide ? bundle.pf.employer : bundle.pf.employee;
    case 'esi':
      return employerSide ? bundle.esi.employer : bundle.esi.employee;
    case 'lwf':
      return employerSide ? bundle.lwf.employer : bundle.lwf.employee;
    case 'pt':
      return bundle.pt.employee;
    case 'tds':
      return bundle.tds.employee;
    default:
      return 0;
  }
}

/**
 * Months left in the Indian financial year, counting this one.
 *
 * April is month 4 and the year's first month, so April leaves 12 and March
 * leaves 1. TDS divides the projected annual liability across these, which is
 * why an employee joining in December pays a larger monthly TDS than one who
 * has been contributing since April.
 */
export function remainingMonthsInFinancialYear(month) {
  return 12 - ((month - FINANCIAL_YEAR_START_MONTH + 12) % 12);
}

/**
 * Compute one employee's payslip for one month.
 *
 * @param {object} input
 * @param {number} input.annualCtc
 * @param {Record<string, number>} input.overrides       component code -> fixed monthly amount
 * @param {Array} input.structureComponents              ordered, each { order, calculation, component }
 * @param {number} input.month                           1-12
 * @param {number} input.year
 * @param {string} input.stateCode                       drives PT and LWF
 * @param {boolean} [input.disabled]                     raises the ESI threshold
 * @param {boolean} [input.pfExcluded]
 * @param {'old'|'new'} [input.employeeRegime]
 * @param {object} [input.exemptions]                    old-regime TDS declarations
 * @param {Array} [input.adjustments]                    [{ componentCode, amount, reason }]
 * @param {object} input.statutoryConfig
 * @param {number} input.daysInMonth
 * @param {number} input.lopDays
 * @returns {{lines, gross, totalDeductions, netPay, employerContributions, statutoryBundle, lopDays}}
 */
export function computePayslip(input) {
  const {
    annualCtc = 0,
    overrides = {},
    structureComponents = [],
    month,
    year,
    stateCode,
    disabled = false,
    pfExcluded = false,
    employeeRegime,
    exemptions,
    adjustments = [],
    statutoryConfig,
    daysInMonth,
    lopDays = 0,
  } = input;

  const monthly = {};
  const ordered = [...structureComponents].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const nonStatutory = ordered.filter((sc) => sc.component.calculationType !== 'statutory');

  // ---- 1 & 2. Non-statutory components, overrides winning -----------------
  const resolve = (sc) => {
    const override = overrides[sc.component.code];
    if (typeof override === 'number') {
      monthly[sc.component.code] = round2(override);
      return;
    }
    // The structure's per-assignment `calculation` overlays the component's own
    // default formula, so one component can be reused at different rates.
    monthly[sc.component.code] = evalFormula(
      { ...sc.component.formula, ...sc.calculation },
      { monthly, annualCtc },
    );
  };
  for (const sc of nonStatutory) resolve(sc);
  for (const sc of nonStatutory) resolve(sc);

  // ---- 3. Preliminary gross drives the statutory engines ------------------
  const preliminaryGross = sumMoney(
    nonStatutory.filter((sc) => isEarning(sc.component.type)).map((sc) => monthly[sc.component.code]),
  );
  const pfWages = sumMoney(PF_WAGE_COMPONENT_CODES.map((code) => monthly[code] ?? 0));

  const statutoryBundle = computeStatutory({
    monthlyGross: preliminaryGross,
    pfWages,
    monthlyPtWage: preliminaryGross,
    state: stateCode,
    month,
    disabledEmployee: disabled,
    pfExcluded,
    employeeRegime,
    annualGrossProjected: round2(preliminaryGross * 12),
    exemptions,
    remainingMonthsInFy: remainingMonthsInFinancialYear(month),
    config: statutoryConfig,
  });

  // ---- 4. Statutory components take their amount from the bundle ----------
  for (const sc of ordered) {
    if (sc.component.calculationType !== 'statutory') continue;
    monthly[sc.component.code] = round2(statutoryAmount(sc.component, statutoryBundle));
  }

  // ---- 5. The structure's lines -------------------------------------------
  const lines = ordered.map((sc) => ({
    componentCode: sc.component.code,
    componentName: sc.component.name,
    type: sc.component.type,
    amount: round2(monthly[sc.component.code] ?? 0),
    taxable: Boolean(sc.component.taxable),
  }));

  // ---- 6. Loss of Pay ------------------------------------------------------
  // Priced off the STRUCTURE's earnings, not off net pay: the daily rate an
  // employee expects is the one implied by their offer letter, and pricing a
  // day off a net that moves with TDS and loan EMIs would make the same absence
  // cost a different amount each month. The reference prices it the same way.
  if (lopDays > 0 && daysInMonth > 0) {
    const structureEarnings = sumMoney(
      lines.filter((l) => isEarning(l.type)).map((l) => l.amount),
    );
    const dailyRate = round2(structureEarnings / daysInMonth);
    lines.push({
      componentCode: LOP_COMPONENT_CODE,
      componentName: `Loss of Pay (${lopDays} day${lopDays === 1 ? '' : 's'})`,
      type: 'deduction',
      amount: round2(dailyRate * lopDays),
      taxable: false,
      meta: { lopDays, daysInMonth, dailyRate },
    });
  }

  // ---- 7. Adjustments ------------------------------------------------------
  // A positive amount adds to an existing line or opens a new earning; a
  // negative one subtracts or opens a new deduction. A new line takes the
  // ABSOLUTE amount because its type already carries the sign — storing a
  // negative on a deduction line would subtract it back out of the total.
  for (const adj of adjustments) {
    if (!adj || adj.amount === 0) continue;
    const existing = lines.find((l) => l.componentCode === adj.componentCode);
    if (existing) {
      existing.amount = round2(existing.amount + adj.amount);
      continue;
    }
    lines.push({
      componentCode: adj.componentCode,
      componentName: `Adjustment: ${String(adj.reason ?? '').slice(0, 60)}`,
      type: adj.amount >= 0 ? 'earning' : 'deduction',
      amount: round2(Math.abs(adj.amount)),
      taxable: true,
    });
  }

  // ---- 8. Totals by type ---------------------------------------------------
  const gross = sumMoney(lines.filter((l) => isEarning(l.type)).map((l) => l.amount));
  const totalDeductions = sumMoney(
    lines.filter((l) => l.type === 'deduction').map((l) => l.amount),
  );
  const employerContributions = sumMoney(
    lines.filter((l) => l.type === 'employer_contribution').map((l) => l.amount),
  );

  return {
    lines,
    gross,
    totalDeductions,
    // Employer contributions are cost-to-company and deliberately absent from
    // net pay: they are never deducted from the employee.
    netPay: round2(gross - totalDeductions),
    employerContributions,
    statutoryBundle,
    lopDays,
  };
}

export default { computePayslip, remainingMonthsInFinancialYear };
