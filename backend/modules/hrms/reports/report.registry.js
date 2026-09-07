/**
 * The report registry, and the reference's three built-in reports.
 *
 * The reference's `ReportsService` keeps a `Map<string, ReportDefinition>` and
 * seeds it in its constructor. `register()` is exported so other modules can
 * add reports on boot — and **nothing in the repository ever calls it**. A
 * whole-repo search for `.register(` finds three hits, all inside
 * `registerBuiltins()`. Three is the complete inventory, not a starting set.
 *
 * The shape is kept because the split it encodes is the module's one genuinely
 * good idea: a report declares the DATA module it reads (`moduleRequired`), not
 * the reports module. So `employees_directory` requires `employees:view:org`,
 * and a recruiter holding only `reports:hiring:view:org` can reach the module
 * but cannot see or run the directory. That two-layer check is ported intact.
 *
 * What is NOT ported is how the reference reads the data:
 *
 *   - every generator returns an unbounded array;
 *   - every generator ignores its `params` argument entirely;
 *   - none filters soft-deleted employees;
 *   - `attendance_monthly` counts every attendance row as a "Present Day",
 *     including rows whose status is `absent`;
 *   - its date window has a lower bound and no upper bound.
 *
 * Each of those is corrected below, with the reason recorded at the site.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import AttendanceRecord from '../../../models/hrms/AttendanceRecord.js';
import { LeaveBalance } from '../../../models/hrms/LeaveBalance.js';
import { LeaveType } from '../../../models/hrms/LeaveType.js';
import { Department } from '../../../models/hrms/Department.js';
import User from '../../../models/User.js';
import {
  HRMS_MODULES as M,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
  attendanceDayString,
  dayToDate,
  dateToDay,
} from '../../../shared/attendance/status.js';
import {
  employeesDirectoryParams,
  attendanceMonthlyParams,
  leaveBalancesParams,
} from '../../../shared/schemas/report.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const idStr = (v) => (v == null ? null : String(v));

/**
 * Attendance statuses that count towards attendance.
 *
 * The reference counts EVERY row: `_count: { id: true }` over
 * `attendanceRecord.groupBy` with no status predicate, and the column is
 * labelled "Present Days". The model's own status column is
 * `present | absent | half_day | on_leave | holiday | weekly_off |
 * pending_regularization`, so a month of rows marked `absent` reports as a
 * month of full attendance.
 *
 * A half day counts as half. `holiday` and `weekly_off` are neither present nor
 * absent — they are not working days — so they count towards nothing, which is
 * why the three columns below do not sum to the number of rows.
 */
const PRESENT_STATUS = 'present';
const HALF_DAY_STATUS = 'half_day';
const ABSENT_STATUS = 'absent';
const LEAVE_STATUS = 'on_leave';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Build a registry.
 *
 * A factory rather than a module-level singleton so a test can construct an
 * isolated one, and so the built-ins are registered exactly once per instance
 * instead of at import time.
 */
export function createReportRegistry() {
  const registry = new Map();

  return {
    /**
     * Add a report.
     *
     * The reference logs a warning and OVERWRITES on a duplicate key — which
     * silently replaces the existing report's `moduleRequired`, so a
     * later-loading module could widen who may read an earlier module's data.
     * A duplicate is a programming error, so it throws.
     */
    register(definition) {
      if (registry.has(definition.key)) {
        throw new Error(`Report "${definition.key}" is already registered`);
      }
      registry.set(definition.key, definition);
      return this;
    },

    get: (key) => registry.get(key) ?? null,
    has: (key) => registry.has(key),
    all: () => Array.from(registry.values()),
    size: () => registry.size,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * The employees a report may read, as an id list plus a display map.
 *
 * Every report needs employee identity, and two of the three need it as a
 * filter rather than as a join. Resolving it once here keeps the reports to one
 * indexed query plus an `$in`, which is the house pattern (see
 * `claim.service.js`) — `$lookup` on every page is what it exists to avoid.
 *
 * `deletedAt: null` is not optional. The reference's directory filters
 * `status: 'active'` and nothing else, so a soft-deleted employee whose status
 * was never moved off `active` still appears in the export, with their email.
 * Its other two reports filter neither.
 */
async function employeeScope({ departmentId, status, search } = {}) {
  const filter = { deletedAt: null };
  if (status) filter.status = status;
  if (departmentId) filter.departmentId = oid(departmentId);
  if (search) {
    // Escaped: an unescaped `(` here is a 500, and `(a+)+$` is a stall.
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { employeeCode: rx }];
  }
  return filter;
}

/**
 * Hydrate names, emails and department labels for one PAGE of employees.
 *
 * Batched per page, never per row. Deliberately carries no `deletedAt` filter
 * on Department: this resolves a label for display, and an employee sitting in
 * a since-retired department still needs that department's name — the same
 * reasoning `employee.service.js` records for its own catalogue lookups.
 */
async function hydrateEmployees(rows) {
  const userIds = rows.map((r) => r.userId).filter(Boolean);
  const departmentIds = rows.map((r) => r.departmentId).filter(Boolean);

  const [users, departments] = await Promise.all([
    userIds.length ? User.find({ _id: { $in: userIds } }).select('email').lean() : [],
    departmentIds.length
      ? Department.find({ _id: { $in: departmentIds } }).select('name').lean()
      : [],
  ]);

  const emailByUser = new Map(users.map((u) => [idStr(u._id), u.email ?? '']));
  const nameByDept = new Map(departments.map((d) => [idStr(d._id), d.name ?? '']));

  return rows.map((r) => ({
    ...r,
    email: emailByUser.get(idStr(r.userId)) ?? '',
    departmentName: nameByDept.get(idStr(r.departmentId)) ?? '',
    displayName: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(),
  }));
}

/**
 * The employee columns a report may project.
 *
 * An allow-list, not an exclusion list. AD-10 already marks the encrypted
 * envelopes and blind indexes `select: false`, but naming the fields wanted is
 * what stops a future field — an address, a dependant, a custom field — from
 * silently joining every CSV export the day it is added to the model.
 */
const EMPLOYEE_PROJECTION = '_id employeeCode firstName lastName designation dateOfJoining status userId departmentId';

/** The current calendar month, in the configured attendance timezone. */
function currentMonthWindow(now = new Date()) {
  const today = attendanceDayString(now);
  const [year, month] = today.split('-');
  const from = `${year}-${month}-01`;
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(Number(year), Number(month), 0));
  return { from, to: dateToDay(last) };
}

/** `Date` on the wire is always `YYYY-MM-DD`, never a locale string. */
const day = (d) => (d ? dateToDay(d instanceof Date ? d : new Date(d)) : '');

// ---------------------------------------------------------------------------
// Report 1 — Employee Directory
// ---------------------------------------------------------------------------

const employeesDirectory = {
  key: 'employees_directory',
  label: 'Employee Directory',
  description: 'All active employees with contact + department',
  category: 'Employees',
  scopeRequired: S.ORG,
  moduleRequired: M.EMPLOYEES,
  paramsSchema: employeesDirectoryParams,
  columns: [
    { key: 'employeeCode', label: 'Code' },
    { key: 'displayName', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'departmentName', label: 'Department' },
    { key: 'designation', label: 'Designation' },
    { key: 'joinDate', label: 'Join Date', type: 'date' },
  ],

  async run(_actor, params, { skip, limit }) {
    const filter = await employeeScope(params);

    // `employeeCode` is the reference's ordering. `_id` is the tiebreak: a page
    // boundary that falls between two equal sort keys would otherwise drop or
    // repeat a row, and the reference has no tiebreak because it never pages.
    const sort = { employeeCode: params.sortDir === 'desc' ? -1 : 1, _id: 1 };

    const [rows, total] = await Promise.all([
      Employee.find(filter).select(EMPLOYEE_PROJECTION).sort(sort).skip(skip).limit(limit).lean(),
      Employee.countDocuments(filter),
    ]);

    const hydrated = await hydrateEmployees(rows);

    return {
      total,
      rows: hydrated.map((e) => ({
        employeeCode: e.employeeCode,
        displayName: e.displayName,
        email: e.email,
        departmentName: e.departmentName,
        designation: e.designation ?? '',
        joinDate: day(e.dateOfJoining),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Report 2 — Monthly Attendance Summary
// ---------------------------------------------------------------------------

const attendanceMonthly = {
  key: 'attendance_monthly',
  label: 'Monthly Attendance Summary',
  description: 'Per-employee attendance for the selected month',
  category: 'Attendance',
  scopeRequired: S.ORG,
  moduleRequired: M.ATTENDANCE,
  paramsSchema: attendanceMonthlyParams,
  columns: [
    { key: 'employeeCode', label: 'Code' },
    { key: 'displayName', label: 'Name' },
    { key: 'presentDays', label: 'Present Days', type: 'number' },
    { key: 'absentDays', label: 'Absent Days', type: 'number' },
    { key: 'leaveDays', label: 'Leave Days', type: 'number' },
  ],

  /**
   * Paged over EMPLOYEES, not over attendance rows.
   *
   * The reference groups attendance by `employeeId`, so an employee with no
   * record at all is simply missing from its "attendance summary" — which is
   * the one row a reader most needs. Grouping also gives no stable order to
   * page by. Paging the employee set instead is deterministic, indexed, and
   * shows a zero rather than a gap.
   *
   * The two extra columns are part of correcting `presentDays`, not new
   * analysis: without them the number silently disagrees with the reference's
   * and a reader cannot tell whether a low count means absence or no record.
   */
  async run(_actor, params, { skip, limit }, { now = new Date() } = {}) {
    const window = currentMonthWindow(now);
    const from = dayToDate(params.from ?? window.from);
    const to = dayToDate(params.to ?? window.to);

    const filter = await employeeScope({ departmentId: params.departmentId });
    const sort = { employeeCode: params.sortDir === 'desc' ? -1 : 1, _id: 1 };

    const [rows, total] = await Promise.all([
      Employee.find(filter).select(EMPLOYEE_PROJECTION).sort(sort).skip(skip).limit(limit).lean(),
      Employee.countDocuments(filter),
    ]);

    if (rows.length === 0) return { rows: [], total };

    // One aggregation for the page's employees only — bounded by `limit`, and
    // the `{ employeeId, date }` index carries both predicates.
    const counts = await AttendanceRecord.aggregate([
      {
        $match: {
          employeeId: { $in: rows.map((r) => r._id) },
          date: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: '$employeeId',
          full: { $sum: { $cond: [{ $eq: ['$status', PRESENT_STATUS] }, 1, 0] } },
          half: { $sum: { $cond: [{ $eq: ['$status', HALF_DAY_STATUS] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$status', ABSENT_STATUS] }, 1, 0] } },
          leave: { $sum: { $cond: [{ $eq: ['$status', LEAVE_STATUS] }, 1, 0] } },
        },
      },
    ]);

    const byEmployee = new Map(counts.map((c) => [idStr(c._id), c]));
    const hydrated = await hydrateEmployees(rows);

    return {
      total,
      rows: hydrated.map((e) => {
        const c = byEmployee.get(idStr(e._id)) ?? { full: 0, half: 0, absent: 0, leave: 0 };
        return {
          employeeCode: e.employeeCode,
          displayName: e.displayName,
          // Halves are exact in binary floating point, so this cannot drift.
          presentDays: c.full + c.half * 0.5,
          absentDays: c.absent,
          leaveDays: c.leave,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Report 3 — Leave Balances
// ---------------------------------------------------------------------------

const leaveBalances = {
  key: 'leave_balances',
  label: 'Leave Balances (current year)',
  description: 'Per-employee leave balances',
  category: 'Leave',
  scopeRequired: S.ORG,
  moduleRequired: M.LEAVE,
  paramsSchema: leaveBalancesParams,
  columns: [
    { key: 'employeeCode', label: 'Code' },
    { key: 'displayName', label: 'Name' },
    { key: 'leaveType', label: 'Leave Type' },
    { key: 'balance', label: 'Balance', type: 'number' },
  ],

  /**
   * One row per employee per leave type, as the reference has it.
   *
   * The reference returns every balance row for the year in one response —
   * headcount x leave types, unbounded. Paging here is over the balance rows,
   * ordered by `(employeeId, leaveTypeId)` so an employee's buckets stay
   * together and the page boundary is stable. Ordering by `employeeCode` would
   * need a join the house style avoids on every page; the code is projected, so
   * the exported CSV can be sorted on it.
   *
   * Balances are `Number`, not `Decimal128`, and deliberately so — AD-2 reserves
   * Decimal128 for MONEY. `LeaveBalance` records the reasoning: leave moves in
   * halves and quarter-days, which are exact in binary floating point, and every
   * write goes through `round2`. The reference's `Number(b.balance)` coerces a
   * SQL `Decimal(10,2)`; there is no equivalent coercion here because nothing is
   * stored as a decimal in the first place.
   */
  async run(_actor, params, { skip, limit }) {
    const year = params.year ?? new Date().getUTCFullYear();

    // Scope first: a balance row carries only ids, so "which employees may
    // appear" has to be decided on Employee and applied as an `$in`.
    const employeeFilter = await employeeScope({ departmentId: params.departmentId });
    const employees = await Employee.find(employeeFilter)
      .select(EMPLOYEE_PROJECTION)
      .lean();

    if (employees.length === 0) return { rows: [], total: 0 };

    const filter = {
      year,
      employeeId: { $in: employees.map((e) => e._id) },
    };
    if (params.leaveTypeId) filter.leaveTypeId = oid(params.leaveTypeId);

    const dir = params.sortDir === 'desc' ? -1 : 1;
    const [rows, total] = await Promise.all([
      LeaveBalance.find(filter)
        .select('employeeId leaveTypeId balance')
        .sort({ employeeId: dir, leaveTypeId: dir, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      LeaveBalance.countDocuments(filter),
    ]);

    if (rows.length === 0) return { rows: [], total };

    const types = await LeaveType.find({
      _id: { $in: rows.map((r) => r.leaveTypeId) },
    })
      .select('name')
      .lean();

    const employeeById = new Map(employees.map((e) => [idStr(e._id), e]));
    const typeById = new Map(types.map((t) => [idStr(t._id), t.name ?? '']));

    return {
      total,
      rows: rows.map((b) => {
        const e = employeeById.get(idStr(b.employeeId));
        return {
          employeeCode: e?.employeeCode ?? '',
          displayName: `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim(),
          leaveType: typeById.get(idStr(b.leaveTypeId)) ?? '',
          balance: b.balance ?? 0,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------

/** The three built-ins, in the reference's own registration order. */
export const BUILT_IN_REPORTS = Object.freeze([
  employeesDirectory,
  attendanceMonthly,
  leaveBalances,
]);

/** A registry seeded with the built-ins — the reference's constructor. */
export function createDefaultRegistry() {
  const registry = createReportRegistry();
  for (const report of BUILT_IN_REPORTS) registry.register(report);
  return registry;
}

export default { createReportRegistry, createDefaultRegistry, BUILT_IN_REPORTS };
