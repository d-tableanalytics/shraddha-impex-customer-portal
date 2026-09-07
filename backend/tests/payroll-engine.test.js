/**
 * The payroll calculation core: money, formulas, statutory engines, LOP and
 * the salary engine.
 *
 * PURE tests — no database, no clock, no HTTP. That is possible because the
 * engine is pure, which is the brief's requirement and the reason these can
 * assert exact rupee figures rather than "roughly right".
 *
 * The statutory numbers used here are TEST FIXTURES, not the company's
 * configuration. They are shaped like real Indian rules so the assertions mean
 * something, but nothing in `shared/` or `modules/` contains them: AD-12
 * requires every rate, ceiling and slab to be supplied data, and
 * `payroll-api.test.js` proves a run with no configuration refuses.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  round2,
  ceilRupee,
  roundRupee,
  sumMoney,
  toDecimalString,
  fromDecimal,
} from '../shared/payroll/money.js';
import { evalFormula, isValidFormula, formulaDependencies } from '../shared/payroll/formula.js';
import {
  computePf,
  computeEsi,
  computePt,
  computeLwf,
  computeTds,
  computeStatutory,
  STATUTORY_ASSUMPTIONS,
} from '../shared/payroll/statutory.js';
import { computeLopDays, payrollMonthWindow } from '../shared/payroll/lop.js';
import {
  computePayslip,
  remainingMonthsInFinancialYear,
} from '../shared/payroll/salaryEngine.js';
import { RUN_TRANSITIONS, RUN_STATUSES } from '../shared/constants/payroll.js';

// ===========================================================================
// Money
// ===========================================================================

describe('money', () => {
  test('rounds to two places, half away from zero', () => {
    assert.equal(round2(1.005), 1.01, 'the classic float-representation case');
    assert.equal(round2(2.675), 2.68);
    assert.equal(round2(0.1 + 0.2), 0.3);
    assert.equal(round2(1234.5649), 1234.56);
    assert.equal(round2(1234.565), 1234.57);
  });

  test('negative amounts round symmetrically with positive ones', () => {
    // `Math.round` alone is half-UP, so -0.5 -> -0 while +0.5 -> +1. A payroll
    // correction must cancel exactly the thing it corrects.
    assert.equal(round2(-1.005), -1.01);
    assert.equal(round2(-2.675), -2.68);
    assert.equal(round2(1.005) + round2(-1.005), 0);
  });

  test('non-finite and empty inputs are zero, not NaN', () => {
    for (const value of [NaN, Infinity, -Infinity, null, undefined, '']) {
      assert.equal(round2(value), 0, String(value));
    }
  });

  test('ESI rounds up to the rupee; PT rounds to the rupee', () => {
    assert.equal(ceilRupee(112.01), 113);
    assert.equal(ceilRupee(112.0), 112);
    assert.equal(roundRupee(207.6), 208);
    assert.equal(roundRupee(207.4), 207);
  });

  test('sumMoney rounds once at the end', () => {
    assert.equal(sumMoney([0.1, 0.2, 0.3]), 0.6);
    assert.equal(sumMoney([]), 0);
    assert.equal(sumMoney([1234.56, 78.9, -12.34]), 1301.12);
  });

  test('a Decimal128 string always carries two places, and round-trips', () => {
    assert.equal(toDecimalString(1234.5), '1234.50');
    assert.equal(toDecimalString(0), '0.00');
    assert.equal(toDecimalString(-99.999), '-100.00');
    // A string, never a number — a float handed to the driver reintroduces the
    // imprecision Decimal128 exists to avoid.
    assert.equal(typeof toDecimalString(10), 'string');
    assert.equal(fromDecimal({ toString: () => '43192.50' }), 43192.5);
    assert.equal(fromDecimal(null), 0);
  });
});

// ===========================================================================
// Formula evaluator
// ===========================================================================

describe('formula evaluator', () => {
  const ctx = { monthly: { BASIC: 30000, HRA: 12000 }, annualCtc: 900000 };

  test('evaluates every supported node', () => {
    assert.equal(evalFormula({ amount: 5000 }, ctx), 5000);
    assert.equal(evalFormula({ of: 'BASIC', percent: 40 }, ctx), 12000);
    assert.equal(evalFormula({ of: 'BASIC', proportion: 0.5 }, ctx), 15000);
    assert.equal(evalFormula({ pct_of_annual: 'CTC', percent: 40 }, ctx), 30000);
    assert.equal(
      evalFormula({ op: 'sum', args: [{ amount: 100 }, { amount: 250 }] }, ctx),
      350,
    );
    assert.equal(
      evalFormula({ op: 'sub', args: [{ amount: 1000 }, { amount: 250 }] }, ctx),
      750,
    );
    assert.equal(
      evalFormula({ op: 'min', args: [{ of: 'BASIC', percent: 50 }, { amount: 10000 }] }, ctx),
      10000,
    );
    assert.equal(
      evalFormula({ op: 'max', args: [{ of: 'BASIC', percent: 10 }, { amount: 10000 }] }, ctx),
      10000,
    );
  });

  test('an unknown component is zero, not a throw', () => {
    // A run covering two hundred people must not abort because one component
    // carries a typo. The zero shows on the payslip and is noticed.
    assert.equal(evalFormula({ of: 'NOPE', percent: 40 }, ctx), 0);
    assert.equal(evalFormula({ op: 'wat', args: [{ amount: 1 }] }, ctx), 0);
    assert.equal(evalFormula(null, ctx), 0);
    assert.equal(evalFormula('BASIC * 0.4', ctx), 0, 'expression strings are not a formula');
  });

  test('validation refuses a malformed formula at the boundary', () => {
    assert.equal(isValidFormula({}), true, 'empty is valid — a statutory component');
    assert.equal(isValidFormula({ amount: 100 }), true);
    assert.equal(isValidFormula({ of: 'BASIC', percent: 40 }), true);
    assert.equal(isValidFormula({ op: 'min', args: [{ amount: 1 }] }), true);

    assert.equal(isValidFormula({ of: 'BASIC' }), false, 'no percent or proportion');
    assert.equal(isValidFormula({ op: 'min', args: [] }), false, 'no args');
    assert.equal(isValidFormula({ op: 'nope', args: [{ amount: 1 }] }), false);
    assert.equal(isValidFormula({ amount: 'lots' }), false);
    assert.equal(isValidFormula('BASIC * 0.4'), false);
  });

  test('dependencies are reported, including from nested nodes', () => {
    assert.deepEqual([...formulaDependencies({ of: 'BASIC', percent: 40 })], ['BASIC']);
    assert.deepEqual(
      [
        ...formulaDependencies({
          op: 'min',
          args: [{ of: 'BASIC', percent: 50 }, { of: 'DA', percent: 10 }],
        }),
      ],
      ['BASIC', 'DA'],
    );
    // CTC is the annual figure, not a component, so it is not a dependency.
    assert.deepEqual([...formulaDependencies({ pct_of_annual: 'CTC', percent: 40 })], []);
  });
});

// ===========================================================================
// Statutory engines
// ===========================================================================

const PF_CONFIG = { employeeRate: 0.12, employerRate: 0.12, wageCeiling: 15000, epsCap: 15000 };
const ESI_CONFIG = { employeeRate: 0.0075, employerRate: 0.0325, grossThreshold: 21000 };

describe('provident fund', () => {
  test('employee pays the configured rate on PF wages', () => {
    const pf = computePf({ pfWages: 20000, config: PF_CONFIG });
    assert.equal(pf.employee, 2400);
  });

  test("the employer's share splits into EPS and EPF, EPS capped at the ceiling", () => {
    const pf = computePf({ pfWages: 30000, config: PF_CONFIG });
    // EPS is 8.33% of min(30000, 15000) = 1249.50; EPF is the remainder of
    // 12% of 30000. The split must not change the employer total.
    assert.equal(pf.breakdown.epsBase, 15000);
    assert.equal(pf.breakdown.eps, 1249.5);
    assert.equal(pf.breakdown.epfEmployer, 2350.5);
    assert.equal(pf.employer, 3600);
  });

  test('an excluded employee and zero wages both yield nothing', () => {
    assert.equal(computePf({ pfWages: 30000, excluded: true, config: PF_CONFIG }).employee, 0);
    assert.equal(computePf({ pfWages: 0, config: PF_CONFIG }).employee, 0);
  });

  test('an employer rate below the EPS share cannot produce a negative EPF line', () => {
    const pf = computePf({
      pfWages: 15000,
      config: { ...PF_CONFIG, employerRate: 0.05 },
    });
    assert.ok(pf.breakdown.epfEmployer >= 0, 'EPF must never go negative');
  });

  test('the EPS rate is statute and is declared, not scattered', () => {
    assert.equal(STATUTORY_ASSUMPTIONS.EPS_RATE, 0.0833);
  });
});

describe('employees state insurance', () => {
  test('applies at or below the threshold, rounding each side UP to the rupee', () => {
    const esi = computeEsi({ monthlyGross: 20000, config: ESI_CONFIG });
    assert.equal(esi.employee, 150, '0.75% of 20000 is exactly 150');
    assert.equal(esi.employer, 650);

    const rounded = computeEsi({ monthlyGross: 15001, config: ESI_CONFIG });
    assert.equal(rounded.employee, ceilRupee(15001 * 0.0075));
    assert.equal(rounded.employee, 113, '112.5075 rounds UP, per ESIC');
  });

  test('does not apply above the threshold', () => {
    const esi = computeEsi({ monthlyGross: 21001, config: ESI_CONFIG });
    assert.equal(esi.employee, 0);
    assert.equal(esi.employer, 0);
    assert.match(esi.reason, /exceeds the ESI threshold/);
  });

  test('a disabled employee gets the raised threshold', () => {
    const esi = computeEsi({ monthlyGross: 24000, disabledEmployee: true, config: ESI_CONFIG });
    assert.ok(esi.employee > 0, 'still covered at 24000 when disabled');
    assert.equal(esi.breakdown.threshold, STATUTORY_ASSUMPTIONS.ESI_DISABLED_THRESHOLD);
  });
});

describe('professional tax — state-parameterised', () => {
  const PT = {
    MP: [{ maxMonthlyWage: 18750, tax: 0 }, { maxMonthlyWage: null, tax: 208 }],
    KA: [{ maxMonthlyWage: 24999, tax: 0 }, { maxMonthlyWage: null, tax: 200 }],
  };

  test('picks the slab the wage falls into', () => {
    assert.equal(computePt({ monthlyWage: 15000, state: 'MP', config: PT }).employee, 0);
    assert.equal(computePt({ monthlyWage: 47000, state: 'MP', config: PT }).employee, 208);
    assert.equal(computePt({ monthlyWage: 47000, state: 'KA', config: PT }).employee, 200);
  });

  test('a state with no configured slabs has no PT — a real answer, not a gap', () => {
    const pt = computePt({ monthlyWage: 90000, state: 'DL', config: PT });
    assert.equal(pt.employee, 0);
    assert.equal(pt.breakdown.appliesInState, false);
    assert.match(pt.reason, /does not apply in DL/);
  });

  test('PT is employee-only', () => {
    assert.equal(computePt({ monthlyWage: 47000, state: 'MP', config: PT }).employer, 0);
  });
});

describe('labour welfare fund — state-parameterised', () => {
  const LWF = {
    MP: { periodicity: 'biannual', employee: 10, employer: 30 },
    KA: { periodicity: 'monthly', employee: 20, employer: 40 },
    PB: { periodicity: 'annual', employee: 5, employer: 20, months: [3] },
  };

  test('a monthly rule fires every month', () => {
    for (const month of [1, 6, 12]) {
      assert.equal(computeLwf({ state: 'KA', month, config: LWF }).employee, 20);
    }
  });

  test('a biannual rule fires only in its months', () => {
    assert.equal(computeLwf({ state: 'MP', month: 6, config: LWF }).employee, 10);
    assert.equal(computeLwf({ state: 'MP', month: 12, config: LWF }).employee, 10);
    assert.equal(computeLwf({ state: 'MP', month: 7, config: LWF }).employee, 0);
  });

  test('a configured month list overrides the convention', () => {
    // The reference hardcodes December for an annual rule. Punjab here is
    // configured for March, and the configuration wins.
    assert.equal(computeLwf({ state: 'PB', month: 3, config: LWF }).employee, 5);
    assert.equal(computeLwf({ state: 'PB', month: 12, config: LWF }).employee, 0);
  });

  test('a state with no rule has no LWF', () => {
    assert.equal(computeLwf({ state: 'DL', month: 6, config: LWF }).employee, 0);
  });
});

describe('TDS', () => {
  const TDS = {
    regime: 'new',
    old: {
      slabs: [
        { min: 0, max: 250000, rate: 0 },
        { min: 250000, max: 500000, rate: 0.05 },
        { min: 500000, max: 1000000, rate: 0.2 },
        { min: 1000000, max: null, rate: 0.3 },
      ],
      standardDeduction: 50000,
      chapter6AMax: 150000,
      hraExemption: true,
    },
    new: {
      slabs: [
        { min: 0, max: 300000, rate: 0 },
        { min: 300000, max: 700000, rate: 0.05 },
        { min: 700000, max: 1000000, rate: 0.1 },
        { min: 1000000, max: null, rate: 0.15 },
      ],
      standardDeduction: 75000,
    },
    cess: 0.04,
  };

  test('the 87A rebate zeroes tax under the ceiling', () => {
    // 564000 gross - 75000 std = 489000 taxable; slab tax 9450; under the
    // 700000 new-regime ceiling so the rebate cancels it entirely.
    const tds = computeTds({ annualGross: 564000, config: TDS, employeeRegime: 'new' });
    assert.equal(tds.breakdown.taxableIncome, 489000);
    assert.equal(tds.breakdown.slabTax, 9450);
    assert.equal(tds.breakdown.rebate, 9450);
    assert.equal(tds.employee, 0);
  });

  test('above the rebate ceiling, tax accrues with cess and spreads over the year', () => {
    const tds = computeTds({
      annualGross: 1200000,
      config: TDS,
      employeeRegime: 'new',
      remainingMonths: 12,
    });
    // 1200000 - 75000 = 1125000 taxable.
    // 0 + (700-300)k*5% = 20000 + (1000-700)k*10% = 30000 + 125k*15% = 18750
    assert.equal(tds.breakdown.taxableIncome, 1125000);
    assert.equal(tds.breakdown.slabTax, 68750);
    assert.equal(tds.breakdown.rebate, 0);
    assert.equal(tds.breakdown.cess, round2(68750 * 0.04));
    assert.equal(tds.breakdown.annualTax, 71500);
    assert.equal(tds.employee, round2(71500 / 12));
  });

  test('old-regime deductions reduce taxable income and are each capped', () => {
    const tds = computeTds({
      annualGross: 1200000,
      config: TDS,
      employeeRegime: 'old',
      exemptions: {
        chapter6AInvestments: 200000, // capped at 150000
        section80CCD_1B: 80000, // capped at 50000
        homeLoanInterest: 300000, // capped at 200000
        section80D: 25000,
      },
    });
    const d = tds.breakdown.deductions;
    assert.equal(d.chapter6A, 150000, 'Chapter VI-A capped');
    assert.equal(d.section80CCD_1B, 50000, '80CCD(1B) capped');
    assert.equal(d.homeLoanInterest, 200000, 'section 24(b) capped');
    assert.equal(d.section80D, 25000, 'uncapped here');
    assert.equal(tds.breakdown.totalDeductions, 50000 + 150000 + 50000 + 200000 + 25000);
  });

  test('the new regime ignores old-regime exemptions entirely', () => {
    const withExemptions = computeTds({
      annualGross: 1200000,
      config: TDS,
      employeeRegime: 'new',
      exemptions: { chapter6AInvestments: 150000, section80D: 25000 },
    });
    const without = computeTds({ annualGross: 1200000, config: TDS, employeeRegime: 'new' });
    assert.equal(withExemptions.employee, without.employee);
  });

  test('the monthly figure divides by the months LEFT in the financial year', () => {
    const january = computeTds({
      annualGross: 1200000,
      config: TDS,
      employeeRegime: 'new',
      remainingMonths: remainingMonthsInFinancialYear(1),
    });
    assert.equal(remainingMonthsInFinancialYear(4), 12, 'April opens the year');
    assert.equal(remainingMonthsInFinancialYear(1), 3, 'January leaves Jan, Feb, Mar');
    assert.equal(january.employee, round2(71500 / 3));
  });

  test('TDS has no employer side', () => {
    assert.equal(computeTds({ annualGross: 1200000, config: TDS }).employer, 0);
  });
});

describe('statutory orchestration', () => {
  test('bundles all five and totals each side', () => {
    const bundle = computeStatutory({
      monthlyGross: 20000,
      pfWages: 12000,
      monthlyPtWage: 20000,
      state: 'KA',
      month: 6,
      annualGrossProjected: 240000,
      remainingMonthsInFy: 12,
      config: {
        pf: PF_CONFIG,
        esi: ESI_CONFIG,
        pt: { KA: [{ maxMonthlyWage: null, tax: 200 }] },
        lwf: { KA: { periodicity: 'monthly', employee: 20, employer: 40 } },
        tds: {
          regime: 'new',
          old: { slabs: [{ min: 0, max: null, rate: 0 }], standardDeduction: 0, chapter6AMax: 0, hraExemption: false },
          new: { slabs: [{ min: 0, max: null, rate: 0 }], standardDeduction: 75000 },
          cess: 0.04,
        },
      },
    });

    assert.equal(bundle.pf.employee, 1440);
    assert.equal(bundle.esi.employee, 150);
    assert.equal(bundle.pt.employee, 200);
    assert.equal(bundle.lwf.employee, 20);
    assert.equal(
      bundle.totalEmployee,
      round2(1440 + 150 + 200 + 20 + bundle.tds.employee),
    );
    assert.equal(bundle.totalEmployer, round2(bundle.pf.employer + bundle.esi.employer + 40));
  });
});

// ===========================================================================
// Loss of pay
// ===========================================================================

describe('loss of pay', () => {
  const window = payrollMonthWindow(2026, 6);
  const holidays = new Set(['2026-06-11']);
  const leave = (over) => ({
    status: 'approved',
    paid: false,
    durationUnit: 'full_day',
    ...over,
  });

  test('the month window is right, including February in a leap year', () => {
    assert.deepEqual(payrollMonthWindow(2026, 6), {
      start: '2026-06-01',
      end: '2026-06-30',
      daysInMonth: 30,
    });
    assert.equal(payrollMonthWindow(2024, 2).daysInMonth, 29);
    assert.equal(payrollMonthWindow(2026, 2).daysInMonth, 28);
  });

  test('only unpaid, approved leave costs anything', () => {
    const range = { startDate: '2026-06-15', endDate: '2026-06-17' };
    assert.equal(computeLopDays([leave(range)], window, holidays), 3);
    assert.equal(computeLopDays([leave({ ...range, paid: true })], window, holidays), 0);
    assert.equal(computeLopDays([leave({ ...range, status: 'pending' })], window, holidays), 0);
    assert.equal(computeLopDays([leave({ ...range, status: 'rejected' })], window, holidays), 0);
  });

  test('🔴 a holiday inside unpaid leave is NOT docked', () => {
    // The whole reason this does not reuse Leave's `computeLeaveDays`, which
    // applies a sandwich rule and would answer 3. The employee spends 3 days of
    // leave balance and loses 2 days of pay; both are correct.
    const days = computeLopDays(
      [leave({ startDate: '2026-06-10', endDate: '2026-06-12' })],
      window,
      holidays,
    );
    assert.equal(days, 2);
  });

  test('weekends are not docked either', () => {
    // 13 June 2026 is a Saturday, 14th a Sunday.
    const days = computeLopDays(
      [leave({ startDate: '2026-06-13', endDate: '2026-06-15' })],
      window,
      holidays,
    );
    assert.equal(days, 1);
  });

  test('half days cost half, hourly leave costs nothing', () => {
    assert.equal(
      computeLopDays(
        [leave({ startDate: '2026-06-15', endDate: '2026-06-15', durationUnit: 'half_day' })],
        window,
        holidays,
      ),
      0.5,
    );
    assert.equal(
      computeLopDays(
        [leave({ startDate: '2026-06-15', endDate: '2026-06-15', durationUnit: 'hour' })],
        window,
        holidays,
      ),
      0,
    );
  });

  test('a mixed request is priced per day', () => {
    const days = computeLopDays(
      [
        leave({
          startDate: '2026-06-15',
          endDate: '2026-06-17',
          durationUnit: 'mixed',
          dayBreakdown: [
            { date: '2026-06-15', kind: 'full' },
            { date: '2026-06-16', kind: 'half_first' },
            { date: '2026-06-17', kind: 'full' },
          ],
        }),
      ],
      window,
      holidays,
    );
    assert.equal(days, 2.5);
  });

  test('a leave spanning the month boundary is split, not double counted', () => {
    // 29 and 30 June are a Monday and Tuesday; 1-3 July belong to July.
    const june = computeLopDays(
      [leave({ startDate: '2026-06-29', endDate: '2026-07-03' })],
      window,
      holidays,
    );
    assert.equal(june, 2);

    const july = computeLopDays(
      [leave({ startDate: '2026-06-29', endDate: '2026-07-03' })],
      payrollMonthWindow(2026, 7),
      new Set(),
    );
    assert.equal(july, 3, 'the July slice, priced against July');
  });

  test('a leave entirely outside the month costs nothing', () => {
    assert.equal(
      computeLopDays([leave({ startDate: '2026-08-01', endDate: '2026-08-05' })], window, holidays),
      0,
    );
  });
});

// ===========================================================================
// Salary engine
// ===========================================================================

const CONFIG = {
  pf: PF_CONFIG,
  esi: ESI_CONFIG,
  pt: { MP: [{ maxMonthlyWage: 18750, tax: 0 }, { maxMonthlyWage: null, tax: 208 }] },
  lwf: { MP: { periodicity: 'monthly', employee: 10, employer: 30 } },
  tds: {
    regime: 'new',
    old: { slabs: [{ min: 0, max: null, rate: 0 }], standardDeduction: 50000, chapter6AMax: 150000, hraExemption: true },
    new: {
      slabs: [
        { min: 0, max: 300000, rate: 0 },
        { min: 300000, max: 700000, rate: 0.05 },
        { min: 700000, max: null, rate: 0.1 },
      ],
      standardDeduction: 75000,
    },
    cess: 0.04,
  },
};

const component = (code, name, type, calculationType, formula, extra = {}) => ({
  order: extra.order ?? 0,
  calculation: extra.calculation ?? {},
  component: {
    code,
    name,
    type,
    taxable: extra.taxable ?? true,
    calculationType,
    formula,
    statutoryLink: extra.link ?? null,
  },
});

/** A conventional structure: 40% basic, 40%-of-basic HRA, fixed special. */
const STRUCTURE = [
  component('BASIC', 'Basic', 'earning', 'percent_of', { pct_of_annual: 'CTC', percent: 40 }, { order: 1 }),
  component('HRA', 'House Rent Allowance', 'earning', 'percent_of', { of: 'BASIC', percent: 40 }, { order: 2 }),
  component('SPECIAL', 'Special Allowance', 'earning', 'fixed', { amount: 5000 }, { order: 3 }),
  component('PF_EE', 'Provident Fund', 'deduction', 'statutory', {}, { order: 10, link: 'pf', taxable: false }),
  component('PT', 'Professional Tax', 'deduction', 'statutory', {}, { order: 11, link: 'pt', taxable: false }),
  component('PF_ER', 'PF (Employer)', 'employer_contribution', 'statutory', {}, { order: 20, link: 'pf', taxable: false }),
];

const baseInput = (over = {}) => ({
  annualCtc: 900000,
  overrides: {},
  structureComponents: STRUCTURE,
  month: 6,
  year: 2026,
  stateCode: 'MP',
  statutoryConfig: CONFIG,
  daysInMonth: 30,
  lopDays: 0,
  adjustments: [],
  ...over,
});

describe('salary engine', () => {
  test('computes a conventional payslip end to end', () => {
    const out = computePayslip(baseInput());
    const by = Object.fromEntries(out.lines.map((l) => [l.componentCode, l.amount]));

    assert.equal(by.BASIC, 30000, '40% of 900000, monthlyised');
    assert.equal(by.HRA, 12000, '40% of BASIC');
    assert.equal(by.SPECIAL, 5000);
    assert.equal(out.gross, 47000);

    assert.equal(by.PF_EE, 3600, '12% of BASIC — no DA in this structure');
    assert.equal(by.PT, 208, 'MP top slab');
    assert.equal(out.totalDeductions, 3808);
    assert.equal(out.netPay, 43192);

    assert.equal(by.PF_ER, 3600);
    assert.equal(
      out.employerContributions,
      3600,
      'employer cost is reported separately and never deducted from net',
    );
  });

  test('is DETERMINISTIC — the same inputs give the same payslip', () => {
    const a = computePayslip(baseInput());
    const b = computePayslip(baseInput());
    assert.deepEqual(a.lines, b.lines);
    assert.equal(a.netPay, b.netPay);
  });

  test('resolves a forward reference in two passes', () => {
    // HRA is listed BEFORE the BASIC it depends on. One pass would give zero.
    const reordered = [
      component('HRA', 'HRA', 'earning', 'percent_of', { of: 'BASIC', percent: 40 }, { order: 1 }),
      component('BASIC', 'Basic', 'earning', 'percent_of', { pct_of_annual: 'CTC', percent: 40 }, { order: 2 }),
    ];
    const out = computePayslip(baseInput({ structureComponents: reordered }));
    const by = Object.fromEntries(out.lines.map((l) => [l.componentCode, l.amount]));
    assert.equal(by.BASIC, 30000);
    assert.equal(by.HRA, 12000);
  });

  test('a per-employee override pins a component and wins over its formula', () => {
    const out = computePayslip(baseInput({ overrides: { SPECIAL: 9000 } }));
    const by = Object.fromEntries(out.lines.map((l) => [l.componentCode, l.amount]));
    assert.equal(by.SPECIAL, 9000);
    assert.equal(out.gross, 51000);
  });

  test('PF wages are BASIC + DA, so adding DA changes PF but HRA is untouched', () => {
    const withDa = [
      ...STRUCTURE,
      component('DA', 'Dearness Allowance', 'earning', 'fixed', { amount: 5000 }, { order: 4 }),
    ];
    const out = computePayslip(baseInput({ structureComponents: withDa }));
    const by = Object.fromEntries(out.lines.map((l) => [l.componentCode, l.amount]));
    assert.equal(by.PF_EE, round2((30000 + 5000) * 0.12), 'PF is on BASIC + DA');
    assert.equal(by.HRA, 12000, 'HRA still keys off BASIC alone');
  });

  test('a statutory component takes the side its own type implies', () => {
    const out = computePayslip(baseInput());
    const employeeSide = out.lines.find((l) => l.componentCode === 'PF_EE');
    const employerSide = out.lines.find((l) => l.componentCode === 'PF_ER');
    assert.equal(employeeSide.type, 'deduction');
    assert.equal(employerSide.type, 'employer_contribution');
    assert.equal(employeeSide.amount, 3600);
    assert.equal(employerSide.amount, 3600);
  });

  test('PF exclusion and the ESI threshold are honoured', () => {
    const excluded = computePayslip(baseInput({ pfExcluded: true }));
    const by = Object.fromEntries(excluded.lines.map((l) => [l.componentCode, l.amount]));
    assert.equal(by.PF_EE, 0);
    assert.equal(by.PF_ER, 0);
  });

  // ---- loss of pay --------------------------------------------------------

  test('LOP is priced off structure earnings and the days in the month', () => {
    const out = computePayslip(baseInput({ lopDays: 2 }));
    const lop = out.lines.find((l) => l.componentCode === 'LOP');
    // 47000 gross / 30 days = 1566.67 a day; two days is 3133.34.
    assert.equal(lop.amount, round2(round2(47000 / 30) * 2));
    assert.equal(lop.type, 'deduction');
    assert.equal(lop.meta.dailyRate, round2(47000 / 30));
    assert.equal(out.netPay, round2(47000 - 3808 - lop.amount));
  });

  test('a half day of LOP costs half', () => {
    const half = computePayslip(baseInput({ lopDays: 0.5 }));
    const full = computePayslip(baseInput({ lopDays: 1 }));
    const amount = (o) => o.lines.find((l) => l.componentCode === 'LOP').amount;
    assert.equal(amount(half), round2(amount(full) / 2));
  });

  test('no LOP line at all when nothing is unpaid', () => {
    const out = computePayslip(baseInput({ lopDays: 0 }));
    assert.equal(out.lines.some((l) => l.componentCode === 'LOP'), false);
  });

  test('the LOP daily rate ignores deductions, so it does not move with TDS', () => {
    // Priced off the offer letter, not off a fluctuating net.
    const out = computePayslip(baseInput({ lopDays: 1 }));
    const lop = out.lines.find((l) => l.componentCode === 'LOP');
    assert.equal(lop.amount, round2(47000 / 30));
  });

  // ---- adjustments --------------------------------------------------------

  test('a positive adjustment on an existing component adds to it', () => {
    const out = computePayslip(
      baseInput({ adjustments: [{ componentCode: 'SPECIAL', amount: 1000, reason: 'bonus' }] }),
    );
    const by = Object.fromEntries(out.lines.map((l) => [l.componentCode, l.amount]));
    assert.equal(by.SPECIAL, 6000);
    assert.equal(out.gross, 48000);
  });

  test('an adjustment on an unknown component opens a new line of the right type', () => {
    const out = computePayslip(
      baseInput({
        adjustments: [
          { componentCode: 'BONUS', amount: 5000, reason: 'Diwali bonus' },
          { componentCode: 'RECOVERY', amount: -1500, reason: 'Laptop damage' },
        ],
      }),
    );
    const bonus = out.lines.find((l) => l.componentCode === 'BONUS');
    const recovery = out.lines.find((l) => l.componentCode === 'RECOVERY');

    assert.equal(bonus.type, 'earning');
    assert.equal(bonus.amount, 5000);
    // The ABSOLUTE amount: the line's type already carries the sign, so storing
    // a negative on a deduction would subtract it back out of the total.
    assert.equal(recovery.type, 'deduction');
    assert.equal(recovery.amount, 1500);

    assert.equal(out.gross, 52000);
    assert.equal(out.totalDeductions, 3808 + 1500);
    assert.equal(out.netPay, round2(52000 - 3808 - 1500));
  });

  test('a zero adjustment is ignored', () => {
    const out = computePayslip(
      baseInput({ adjustments: [{ componentCode: 'NOTHING', amount: 0, reason: 'x' }] }),
    );
    assert.equal(out.lines.some((l) => l.componentCode === 'NOTHING'), false);
  });

  test('a negative adjustment can pull an existing earning down', () => {
    const out = computePayslip(
      baseInput({ adjustments: [{ componentCode: 'SPECIAL', amount: -2000, reason: 'overpaid' }] }),
    );
    const by = Object.fromEntries(out.lines.map((l) => [l.componentCode, l.amount]));
    assert.equal(by.SPECIAL, 3000);
  });

  // ---- totals -------------------------------------------------------------

  test('totals are summed by component type, and net excludes employer cost', () => {
    const out = computePayslip(baseInput());
    const earnings = out.lines.filter((l) => l.type === 'earning' || l.type === 'reimbursement');
    const deductions = out.lines.filter((l) => l.type === 'deduction');

    assert.equal(out.gross, sumMoney(earnings.map((l) => l.amount)));
    assert.equal(out.totalDeductions, sumMoney(deductions.map((l) => l.amount)));
    assert.equal(out.netPay, round2(out.gross - out.totalDeductions));
    assert.ok(
      out.netPay < out.gross && out.employerContributions > 0,
      'employer contributions exist but do not reduce net',
    );
  });

  test('a reimbursement adds to gross like an earning', () => {
    const withReimbursement = [
      ...STRUCTURE,
      component('TRAVEL', 'Travel Reimbursement', 'reimbursement', 'fixed', { amount: 2000 }, {
        order: 5,
        taxable: false,
      }),
    ];
    const out = computePayslip(baseInput({ structureComponents: withReimbursement }));
    assert.equal(out.gross, 49000);
  });
});

// ===========================================================================
// The declared state machine
// ===========================================================================

describe('run state machine', () => {
  test('has exactly the four states the reference has', () => {
    assert.deepEqual([...RUN_STATUSES], ['draft', 'review', 'locked', 'disbursed']);
    // The brief names these as states not to invent; asserting their absence
    // is what stops one being added later "because it would be useful".
    for (const invented of ['approved', 'paid', 'processing', 'cancelled']) {
      assert.equal(RUN_STATUSES.includes(invented), false, `${invented} must not exist`);
    }
  });

  test('declares only the legal transitions', () => {
    assert.deepEqual([...RUN_TRANSITIONS.compute.from], ['draft', 'review']);
    assert.equal(RUN_TRANSITIONS.compute.to, 'review');
    assert.deepEqual([...RUN_TRANSITIONS.lock.from], ['review']);
    assert.deepEqual([...RUN_TRANSITIONS.disburse.from], ['locked']);
    assert.deepEqual([...RUN_TRANSITIONS.rollback.from], ['draft', 'review']);

    // Nothing leaves locked except disburse, and nothing leaves disbursed.
    for (const [action, rule] of Object.entries(RUN_TRANSITIONS)) {
      if (action !== 'disburse') {
        assert.equal(rule.from.includes('locked'), false, `${action} must not accept locked`);
      }
      assert.equal(rule.from.includes('disbursed'), false, `${action} must not accept disbursed`);
    }
  });
});
