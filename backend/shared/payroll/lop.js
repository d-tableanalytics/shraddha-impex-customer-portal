/**
 * Loss of Pay: how many days of a payroll month an employee is not paid for.
 *
 * ---------------------------------------------------------------------------
 * This is the ONLY thing that connects Payroll to Leave
 * ---------------------------------------------------------------------------
 * Worth stating plainly, because it is easy to assume otherwise: in the
 * reference, unpaid approved leave is the sole non-salary input to a payslip.
 * Attendance is not consulted anywhere in its payroll module — there is no
 * working-days count, no payable-days proration, no absence deduction and no
 * overtime. A search of `apps/api/src/modules/payroll` for "attendance"
 * returns nothing. None of that is invented here.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Why this does NOT call Leave's `computeLeaveDays`
 * ---------------------------------------------------------------------------
 * It looks like the obvious reuse, and it would be wrong. The two answer
 * different questions, and Leave's own helper says so in its code:
 *
 *   `computeLeaveDays` applies a SANDWICH RULE — a weekend or holiday lying
 *   between two full leave days is charged, because taking the Friday and the
 *   Monday either side of a weekend spends the weekend from your entitlement.
 *
 *   LOP must NOT sandwich. The reference's `leave-lop.ts` skips every weekend
 *   and holiday outright (`if (isWeekend(cursor) || holidayDates.has(iso))
 *   continue;`), and that is the humane and defensible rule: an employee on
 *   unpaid leave around a public holiday is still PAID for the holiday. Docking
 *   it would charge them for a day the company was closed.
 *
 * So a three-day unpaid leave containing one holiday costs 3 days of LEAVE
 * BALANCE and 2 days of PAY. Both numbers are right; they are answers to
 * different questions, and collapsing them into one helper would silently pick
 * one and be wrong about the other.
 *
 * What IS reused is every date primitive — `eachDay`, `isWeekend` — so the two
 * modules cannot disagree about what a day or a weekend is. Only the portion
 * rule is payroll's own, and it is the part that genuinely differs.
 *
 * The remaining rules, all the reference's:
 *   - only `approved` requests count
 *   - only leave TYPES marked `paid: false` cost anything; paid leave is
 *     already funded and is not a deduction
 *   - hourly leave contributes nothing
 *   - a half day costs half a day of pay
 */

import { eachDay, isWeekend } from '../leave/dates.js';
import { round2 } from './money.js';

/** The first and last calendar day of a payroll month, as `YYYY-MM-DD`. */
export function payrollMonthWindow(year, month) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(daysInMonth)}`,
    daysInMonth,
  };
}

/**
 * What one working day of this request costs, in days of pay.
 *
 * Mirrors Leave's `portionOf` for the shapes payroll cares about, minus the
 * hour case (which never contributes) and minus the sandwich handling.
 */
function portionForDay(request, iso) {
  switch (request.durationUnit) {
    case 'full_day':
      return 1;
    case 'half_day':
      return 0.5;
    case 'mixed': {
      const entry = request.dayBreakdown?.find((e) => e.date === iso);
      // No entry for a day inside the range means a full day, which is how
      // Leave reads a mixed breakdown too.
      return !entry || entry.kind === 'full' ? 1 : 0.5;
    }
    default:
      return 0;
  }
}

/**
 * LOP days for one employee in one payroll month.
 *
 * The request may start before or end after the month; only the days that fall
 * inside the window are charged, so a leave spanning a month boundary is split
 * correctly across two payslips rather than counted twice.
 *
 * @param {Array} requests  approved leave requests overlapping the month, each
 *   carrying `{ paid }` for its leave type and `{ status, startDate, endDate,
 *   durationUnit, dayBreakdown }`
 * @param {{start: string, end: string}} window  from `payrollMonthWindow`
 * @param {Set<string>} holidayDates  `YYYY-MM-DD`
 * @returns {number} days, to two decimals; halves are possible
 */
export function computeLopDays(requests = [], window, holidayDates = new Set()) {
  let total = 0;

  for (const request of requests) {
    if (request.status && request.status !== 'approved') continue;
    // A paid leave type costs the employee nothing. This single flag is the
    // whole distinction between "on leave" and "not paid for the day", and
    // getting it wrong would dock people for their annual leave.
    if (request.paid !== false) continue;
    // Hourly leave is deliberately not prorated, matching the reference.
    if (request.durationUnit === 'hour') continue;

    // Clip to the payroll month.
    const start = request.startDate > window.start ? request.startDate : window.start;
    const end = request.endDate < window.end ? request.endDate : window.end;
    if (start > end) continue;

    for (const iso of eachDay(start, end)) {
      // No sandwich: a non-working day inside unpaid leave is still paid.
      if (isWeekend(iso) || holidayDates.has(iso)) continue;
      total += portionForDay(request, iso);
    }
  }

  return round2(total);
}

export default { computeLopDays, payrollMonthWindow };
