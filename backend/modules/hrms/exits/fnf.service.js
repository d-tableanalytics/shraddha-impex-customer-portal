/**
 * Full-and-final settlement — the mini-payroll that runs at exit.
 *
 * Ported from the reference's `FullAndFinalService`, with its four defects
 * corrected:
 *
 *   1. PREVIEW IS PURE. The reference's `preview()` calls the same `compute()`
 *      its `create()` does, and `compute()` runs
 *      `tx.loanAdvance.update({ outstanding: 0 })` — so a GET on
 *      `/fnf/preview` permanently zeroes the employee's loan balances. Its own
 *      UI fires that GET automatically whenever HR opens the drawer on a
 *      cleared request. Here `computeSettlement` only reads; nothing outside
 *      `createSettlement` writes anything.
 *
 *   2. MONEY IS EXACT. The reference computes every figure in JavaScript
 *      numbers and stores them in a `Decimal(14,2)` column, so the precision
 *      the column promises is gone before the insert. Every figure here is a
 *      decimal string, summed in integer paise (AD-2).
 *
 *   3. THE NOTICE PERIOD IS THE EMPLOYEE'S OWN. The reference hardcodes
 *      `const noticeDue = 30; // TODO: pull from employment terms`. Shraddha's
 *      Employee already carries `noticeMonths` / `noticeStartDate` /
 *      `noticeEndDate`, so the real term is used and only falls back to 30 days
 *      when the employee has none recorded.
 *
 *   4. GRATUITY USES COMPLETED YEARS. The reference's comment says "completed
 *      years of service" and its code multiplies by fractional years, so a
 *      5.9-year tenure is paid as 5.9 years. The Payment of Gratuity Act counts
 *      completed years, with a part-year over six months rounding up.
 *
 * NOT PORTED: loan settlement. The reference deducts `LoanAdvance.outstanding`;
 * no loan model exists here, so the line is absent rather than invented. The
 * absence is visible — there is simply no LOAN line in the breakdown.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import LeaveBalance from '../../../models/hrms/LeaveBalance.js';
import LeaveType from '../../../models/hrms/LeaveType.js';
import { EmployeeCompensation } from '../../../models/hrms/PayrollModels.js';
import { sumMoney } from '../../../models/hrms/ExitRequest.js';
import { dayToUtcMs, utcMsToDay } from '../../../shared/leave/dates.js';

const DAY_MS = 86400000;

/** Basic pay as a share of CTC. The reference's own 40% India template. */
const BASIC_SHARE = 0.4;

/** Used only when the employee has no notice term recorded. */
const DEFAULT_NOTICE_DAYS = 30;

/** Leave types whose balance is encashed on exit. */
const ENCASHABLE_CODES = new Set(['EL', 'PL']);

/**
 * Multiply a decimal string by a ratio and round to paise.
 *
 * The multiplication itself is done in paise as an integer, so the only
 * floating point in the whole settlement is the ratio — never an accumulated
 * balance. Rounds half away from zero.
 */
function scale(amountString, ratio) {
  const text = String(amountString ?? '0');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const paise = Number(BigInt(whole || '0') * 100n + BigInt(`${fraction}00`.slice(0, 2)));

  const scaled = Math.round(Math.abs(paise * ratio));
  const sign = negative !== ratio < 0 ? '-' : '';
  return `${sign}${Math.floor(scaled / 100)}.${String(scaled % 100).padStart(2, '0')}`;
}

const negate = (amountString) =>
  String(amountString).startsWith('-')
    ? String(amountString).slice(1)
    : `-${amountString}`;

const isPositive = (amountString) =>
  !String(amountString).startsWith('-') && Number(amountString) > 0;

/**
 * Completed years of service, Gratuity Act style.
 *
 * A part-year of more than six months counts as a full year; anything less is
 * dropped. The reference uses the raw fraction.
 */
function completedYears(fromDay, toDay) {
  const years = (dayToUtcMs(toDay) - dayToUtcMs(fromDay)) / (365.25 * DAY_MS);
  if (years < 0) return 0;
  const whole = Math.floor(years);
  return years - whole > 0.5 ? whole + 1 : whole;
}

/**
 * Compute the settlement. PURE — it reads and returns, and writes nothing.
 *
 * @returns {Promise<object>} the breakdown, every figure a decimal string.
 */
export async function computeSettlement(request) {
  const employee = await Employee.findOne({ _id: request.employeeId }).lean();
  if (!employee) {
    // The request snapshots the name, so it still renders; there is simply
    // nothing to compute a settlement from.
    return emptySettlement('The employee record for this exit no longer exists.');
  }

  const lastDay = request.actualLastDay ?? request.requestedLastDay;

  const compensation = await EmployeeCompensation.findOne({
    employeeId: request.employeeId,
    effectiveTo: null,
  })
    .sort({ effectiveFrom: -1 })
    .lean();

  if (!compensation) {
    return emptySettlement(
      'This employee has no active compensation record, so no settlement can be computed.',
    );
  }

  const ctc = String(compensation.ctc);
  const monthly = scale(ctc, 1 / 12);
  const perDay = scale(ctc, 1 / 365);
  const basicMonthly = scale(monthly, BASIC_SHARE);
  const perDayBasic = scale(scale(basicMonthly, 12), 1 / 365);

  const earnings = [];
  const deductionLines = [];
  const notes = [];

  // ---- 1. Final month, prorated over the days actually worked -------------
  // Days from the first of the month to the last working day, over the real
  // length of that month. The reference divides by a hardcoded 30, which
  // overpays every February and underpays every 31-day month.
  const dayOfMonth = Number(lastDay.slice(8, 10));
  const [year, month] = [Number(lastDay.slice(0, 4)), Number(lastDay.slice(5, 7))];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const finalMonth = scale(monthly, dayOfMonth / daysInMonth);
  earnings.push({
    code: 'FINAL_MONTH',
    label: `Final month salary (${dayOfMonth} of ${daysInMonth} days)`,
    amount: finalMonth,
  });

  // ---- 2. Leave encashment ------------------------------------------------
  let leaveEncashment = null;
  const encashableTypes = await LeaveType.find({ deletedAt: null })
    .select('_id code')
    .lean();
  const encashableIds = encashableTypes
    .filter((type) => ENCASHABLE_CODES.has(String(type.code).toUpperCase()))
    .map((type) => type._id);

  if (encashableIds.length > 0) {
    const balances = await LeaveBalance.find({
      employeeId: request.employeeId,
      leaveTypeId: { $in: encashableIds },
      year: year,
    }).lean();

    const unusedDays = balances.reduce(
      (total, row) => total + Math.max(0, Number(row.balance ?? 0)),
      0,
    );
    if (unusedDays > 0) {
      leaveEncashment = scale(perDayBasic, unusedDays);
      earnings.push({
        code: 'LEAVE_ENCASHMENT',
        label: `Leave encashment (${unusedDays.toFixed(1)} days)`,
        amount: leaveEncashment,
      });
    }
  }

  // ---- 3. Gratuity — 15 days' basic per completed year, at 5+ years -------
  let gratuity = null;
  const joinDay = utcMsToDay(new Date(employee.dateOfJoining).getTime());
  const years = completedYears(joinDay, lastDay);
  if (years >= 5) {
    gratuity = scale(scale(basicMonthly, 15 / 26), years);
    earnings.push({
      code: 'GRATUITY',
      label: `Gratuity (${years} completed years)`,
      amount: gratuity,
    });
  }

  // ---- 4. Notice period shortfall ----------------------------------------
  // The employee's OWN term, not a hardcoded month.
  let noticeAdjustment = null;
  const noticeDueDays = employee.noticeMonths
    ? Math.round(employee.noticeMonths * 30)
    : DEFAULT_NOTICE_DAYS;
  if (!employee.noticeMonths) {
    notes.push(
      `No notice term is recorded for this employee; ${DEFAULT_NOTICE_DAYS} days assumed.`,
    );
  }

  const servedFrom = request.initiatedAt
    ? utcMsToDay(new Date(request.initiatedAt).getTime())
    : lastDay;
  const servedDays = Math.max(0, (dayToUtcMs(lastDay) - dayToUtcMs(servedFrom)) / DAY_MS);
  const shortfall = Math.max(0, noticeDueDays - servedDays);

  if (shortfall >= 1) {
    const amount = scale(perDay, shortfall);
    noticeAdjustment = negate(amount);
    deductionLines.push({
      code: 'NOTICE_SHORTFALL',
      label: `Notice shortfall (${Math.round(shortfall)} of ${noticeDueDays} days)`,
      amount,
    });
  }

  const gross = sumMoney(earnings.map((line) => line.amount));
  const deductions = sumMoney(deductionLines.map((line) => line.amount));
  const netPayable = sumMoney([gross, negate(deductions)]);

  return {
    gross,
    deductions,
    netPayable,
    earnings,
    deductionLines,
    leaveEncashment,
    gratuity,
    noticeAdjustment,
    notes,
    computable: true,
  };
}

function emptySettlement(note) {
  return {
    gross: '0.00',
    deductions: '0.00',
    netPayable: '0.00',
    earnings: [],
    deductionLines: [],
    leaveEncashment: null,
    gratuity: null,
    noticeAdjustment: null,
    notes: [note],
    computable: false,
  };
}

/** Decimal128 for storage; a settlement figure never becomes a float. */
export const toDecimal = (value) =>
  value === null || value === undefined
    ? null
    : mongoose.Types.Decimal128.fromString(String(value));

export default { computeSettlement, toDecimal };
