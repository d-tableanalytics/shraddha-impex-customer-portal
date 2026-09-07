/**
 * The dashboard: read-only aggregation over what the modules already own.
 *
 * Ported from the reference's `DashboardService` + `DashboardWidgetsService`
 * (750 lines across two files).
 *
 * ---------------------------------------------------------------------------
 * This module owns NO business logic
 * ---------------------------------------------------------------------------
 * Every figure here comes from a model another module owns, and wherever an
 * existing service already applies the right visibility rule, that service is
 * CALLED rather than its query restated:
 *
 *   announcements   engage/announcement.service#listAnnouncements — targeting
 *                   and expiry applied inside the query
 *   polls           engage/poll.service#listPolls
 *   on leave today  leave/leave.service#calendar — scoped by the same filter
 *                   as the leave list, so the dashboard cannot show somebody
 *                   the caller could not already see
 *
 * The rest are counts and projections over Employee, Holiday, AttendanceRecord
 * and AuditLog. Nothing computes a leave balance, a payroll figure or an
 * attendance status; those belong to the modules that define them.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. ANNOUNCEMENTS AND POLLS RESPECT TARGETING. 🔴 The reference's widget query
 *    is `findMany({ where: { publishedAt: { not: null } } })` — no role filter,
 *    no department filter, and no `expiresAt` check, while its own Engage list
 *    applies all three. So its dashboard shows every employee announcements
 *    aimed at other departments, and ones that have expired.
 *
 * 2. LOGIN ACTIVITY NEEDS THE AUDIT GRANT. 🔴 The reference gates it on
 *    `dashboard:view:self`, which is in the baseline — so an ordinary employee
 *    can read company-wide authentication volume off the home page. It is
 *    audit data and is gated as audit data.
 *
 * 3. CELEBRATIONS ARE PROJECTED, NOT LOADED. 🔴 The reference pulls the WHOLE
 *    employee table with a user join and filters it in JavaScript — twice.
 *
 * 4. ANNIVERSARY YEARS ARE COMPUTED FROM THE OCCURRENCE. 🔴 The reference
 *    writes `y - doj.getUTCFullYear() + (daysUntil > 0 ? 0 : 0)` — a ternary
 *    that adds zero either way, so a January view of a December anniversary is
 *    off by one.
 *
 * 5. EACH WIDGET FAILS ALONE. The reference runs one `Promise.all`, so a single
 *    failing query blanks the entire dashboard.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import Holiday from '../../../models/hrms/Holiday.js';
import AttendanceRecord from '../../../models/hrms/AttendanceRecord.js';
import AttendanceCorrection from '../../../models/hrms/AttendanceCorrection.js';
import LeaveRequest from '../../../models/hrms/LeaveRequest.js';
import AuditLog from '../../../models/AuditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import { listAnnouncements } from '../engage/announcement.service.js';
import { listPolls } from '../engage/poll.service.js';
import { calendar as leaveCalendar } from '../leave/leave.service.js';
import {
  QUICK_ACCESS_CATALOGUE,
  CELEBRATION_WINDOW_DAYS,
  DASHBOARD_LIST_LIMIT,
  LOGIN_TREND_RANGES,
} from '../../../shared/constants/dashboard.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/** Midnight UTC, n days back. */
function daysAgo(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/**
 * Run each widget independently — correction 5.
 *
 * A widget that throws contributes its fallback and the rest of the page still
 * renders. The failure is logged rather than swallowed silently, so a broken
 * query is visible in the server output instead of only as a blank card.
 */
async function settle(label, fallback, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`[hrms:dashboard] ${label} failed:`, error?.message ?? error);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

const seesOrg = (actor) => hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.ORG);
const seesTeam = (actor) =>
  hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.TEAM) ||
  hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.ORG);
const seesAudit = (actor) => hasHrmsPermission(actor, M.AUDIT_LOGS, A.VIEW, S.ORG);

/**
 * The employees this actor may see in a team-scoped widget.
 *
 * Org scope means everybody. Team scope means the actor's own reporting tree,
 * which `managerChain` already records — the same field every other team-scoped
 * query in this codebase uses.
 */
function teamScopeFilter(actor) {
  if (seesOrg(actor) || hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.ORG)) return {};
  const me = actor?.employeeId;
  if (!me) return { _id: null };
  return { managerChain: new mongoose.Types.ObjectId(String(me)) };
}

/**
 * The Quick Access tiles this actor may actually use.
 *
 * Filtered with the SAME evaluator the routes use, against the shared
 * catalogue — so a tile can never offer an action the API would refuse, and
 * the client cannot show one the server did not return.
 *
 * `requires` is ANY-OF, matching `requirePermission`.
 */
export function buildQuickAccess(actor) {
  return QUICK_ACCESS_CATALOGUE.filter(
    (item) =>
      item.requires.length === 0 ||
      item.requires.some((r) => hasHrmsPermission(actor, r.module, r.action, r.scope)),
  ).map(({ key, label, icon, path, tone }) => ({ key, label, icon, path, tone }));
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/**
 * Who is looking, for the hero greeting.
 *
 * Resolved from the SESSION's own employee id — the client has no display name
 * of its own (`/hrms/me` returns ids, roles and permissions, deliberately), and
 * a greeting assembled from anything the browser supplied would be a name the
 * server never checked.
 *
 * An HRMS account with no employee record still gets a dashboard; it just gets
 * "Welcome back" instead of a first name.
 */
async function viewerFor(actor) {
  if (!actor?.employeeId || !mongoose.isValidObjectId(actor.employeeId)) return null;

  const me = await Employee.findById(actor.employeeId)
    .select('firstName lastName employeeCode')
    .lean();
  if (!me) return null;

  return {
    firstName: me.firstName ?? null,
    fullName: nameOf(me),
    employeeCode: me.employeeCode ?? null,
  };
}

/** The next few holidays. Everyone sees these. */
async function upcomingHolidays() {
  const rows = await Holiday.find({ deletedAt: null, date: { $gte: isoDay(new Date()) } })
    .sort({ date: 1 })
    .limit(6)
    .select('name date type isOptional region')
    .lean();

  return rows.map((h) => ({
    id: idStr(h._id),
    name: h.name,
    date: h.date,
    type: h.type,
    isOptional: Boolean(h.isOptional),
    region: h.region ?? null,
  }));
}

/**
 * Who is on approved leave today.
 *
 * Straight through Leave's own `calendar`, which applies the module's scope
 * filter — so this cannot widen what the caller may see. Only APPROVED leave
 * counts: a pending request is not an absence.
 */
async function onLeaveToday(actor) {
  if (!seesTeam(actor)) return [];

  const today = isoDay(new Date());
  const { requests } = await leaveCalendar(actor, { from: today, to: today });

  return requests
    .filter((r) => r.status === 'approved')
    .slice(0, DASHBOARD_LIST_LIMIT)
    .map((r) => ({
      employeeId: r.employeeId,
      name: r.employeeName ?? 'Unknown',
      leaveTypeCode: r.leaveTypeCode ?? null,
    }));
}

/**
 * Mobile clock-ins today.
 *
 * 🔴 The reference calls this "Working Remotely". It is not a remote-work
 * state — there is no such state in either codebase — it is the `source` of a
 * punch, and its own comment says so ("proxied by source=mobile clock-ins").
 * Reported here as what it actually measures.
 */
async function mobileClockInsToday(actor) {
  if (!seesTeam(actor)) return [];

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const scope = teamScopeFilter(actor);
  const scopedIds = Object.keys(scope).length
    ? (await Employee.find({ ...scope, deletedAt: null }).select('_id').lean()).map((e) => e._id)
    : null;

  const rows = await AttendanceRecord.find({
    date: { $gte: start, $lt: end },
    source: 'mobile',
    clockIn: { $ne: null },
    ...(scopedIds ? { employeeId: { $in: scopedIds } } : {}),
  })
    .limit(DASHBOARD_LIST_LIMIT)
    .select('employeeId clockIn')
    .lean();

  if (rows.length === 0) return [];

  const employees = await Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } })
    .select('_id firstName lastName')
    .lean();
  const byId = new Map(employees.map((e) => [idStr(e._id), e]));

  return rows.map((r) => ({
    employeeId: idStr(r.employeeId),
    name: nameOf(byId.get(idStr(r.employeeId))),
    clockedInAt: new Date(r.clockIn).toISOString(),
  }));
}

/**
 * Birthdays and joining anniversaries in the next fortnight.
 *
 * Org-wide for everybody, which is the reference's own decision and the right
 * one — a celebration is low-sensitivity and the whole point is that colleagues
 * can wish each other.
 *
 * 🔴 Projected, not loaded (correction 3): three fields per live employee,
 * no joins. The reference pulls the entire employee table with a user join and
 * filters it in JavaScript.
 *
 * This is the DASHBOARD widget only. The reference's separate `/celebrations`
 * "see all" page is not built — see the analysis, §7.
 */
async function celebrations() {
  const rows = await Employee.find({
    deletedAt: null,
    status: { $nin: ['exited', 'inactive'] },
  })
    .select('_id firstName lastName dateOfBirth dateOfJoining')
    .lean();

  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const year = now.getUTCFullYear();

  /** Days until the next occurrence of a month/day, or null if beyond the window. */
  const daysUntilNext = (month, day) => {
    for (let offset = 0; offset <= 1; offset += 1) {
      const candidate = Date.UTC(year + offset, month, day);
      const days = Math.floor((candidate - todayMs) / 86_400_000);
      if (days >= 0 && days <= CELEBRATION_WINDOW_DAYS) return { days, year: year + offset };
    }
    return null;
  };

  const birthdays = [];
  const anniversaries = [];

  for (const e of rows) {
    if (e.dateOfBirth) {
      const dob = new Date(e.dateOfBirth);
      const next = daysUntilNext(dob.getUTCMonth(), dob.getUTCDate());
      if (next) {
        birthdays.push({
          employeeId: idStr(e._id),
          name: nameOf(e),
          daysUntil: next.days,
        });
      }
    }

    if (e.dateOfJoining) {
      const doj = new Date(e.dateOfJoining);
      const next = daysUntilNext(doj.getUTCMonth(), doj.getUTCDate());
      if (next) {
        // 🔴 From the OCCURRENCE year, not today's — correction 4. The
        // reference's `+ (daysUntil > 0 ? 0 : 0)` adds nothing either way, so
        // a December anniversary viewed in January counts a year short.
        const years = next.year - doj.getUTCFullYear();
        if (years > 0) {
          anniversaries.push({
            employeeId: idStr(e._id),
            name: nameOf(e),
            yearsCount: years,
            daysUntil: next.days,
          });
        }
      }
    }
  }

  const soonest = (a, b) => a.daysUntil - b.daysUntil;
  return {
    birthdays: birthdays.sort(soonest).slice(0, 8),
    anniversaries: anniversaries.sort(soonest).slice(0, 8),
  };
}

/**
 * Everything the home page renders, in one request.
 *
 * Each widget is settled independently, and the whole set runs in parallel.
 */
export async function dashboardWidgets(actor) {
  const [viewer, holidays, announcements, polls, leaveToday, mobileToday, celebration] = await Promise.all([
    settle('viewer', null, () => viewerFor(actor)),
    settle('holidays', [], upcomingHolidays),
    settle('announcements', [], async () => {
      // Engage's own list: targeting and expiry applied INSIDE the query.
      const res = await listAnnouncements({ page: 1, pageSize: 3, state: 'published' }, actor);
      return (res?.data ?? []).map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        publishedAt: a.publishedAt,
        createdByName: a.createdByName ?? null,
      }));
    }),
    settle('polls', [], async () => {
      const res = await listPolls({ page: 1, pageSize: 3, open: true }, actor);
      return (res?.data ?? []).map((p) => ({
        id: p.id,
        question: p.question,
        kind: p.kind,
        closesAt: p.closesAt ?? null,
        hasResponded: Boolean(p.hasResponded),
      }));
    }),
    settle('onLeaveToday', [], () => onLeaveToday(actor)),
    settle('mobileClockIns', [], () => mobileClockInsToday(actor)),
    settle('celebrations', { birthdays: [], anniversaries: [] }, celebrations),
  ]);

  return {
    viewer,
    upcomingHolidays: holidays,
    announcements,
    polls,
    onLeaveToday: leaveToday,
    mobileClockInsToday: mobileToday,
    birthdays: celebration.birthdays,
    anniversaries: celebration.anniversaries,
    /** Permission-derived, no data — see quickAccess.js. */
    quickAccess: buildQuickAccess(actor),
    /** So the client can render the right empty state rather than guessing. */
    scope: { team: seesTeam(actor), org: seesOrg(actor), audit: seesAudit(actor) },
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Sign-ins per day, zero-filled so the line stays continuous.
 *
 * 🔴 Requires `audit-logs:view:org` — correction 2. The reference gates this on
 * `dashboard:view:self`, which every role holds, so any employee can read
 * company-wide authentication volume from the home page.
 */
export async function loginTrend(actor, range = '7d') {
  if (!seesAudit(actor)) return [];

  const days = LOGIN_TREND_RANGES[range] ?? LOGIN_TREND_RANGES['7d'];
  const from = daysAgo(days - 1);

  const rows = await AuditLog.aggregate([
    { $match: { action: AUDIT_ACTIONS.AUTH_LOGIN, createdAt: { $gte: from } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
        logins: { $sum: 1 },
      },
    },
  ]);

  const byDay = new Map(rows.map((r) => [r._id, r.logins]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = isoDay(daysAgo(i));
    out.push({ date: day, logins: byDay.get(day) ?? 0 });
  }
  return out;
}

/** The five workforce counts, and the two queues behind them. */
async function orgSummary(actor, range) {
  const live = { deletedAt: null };
  const thirtyDaysAgo = daysAgo(30);

  const [total, active, probation, notice, invited, pendingLeave, pendingCorrections, hires, exits, trend] =
    await Promise.all([
      Employee.countDocuments(live),
      Employee.countDocuments({ ...live, status: 'active' }),
      Employee.countDocuments({ ...live, status: 'probation' }),
      Employee.countDocuments({ ...live, status: 'notice' }),
      Employee.countDocuments({ ...live, status: 'invited' }),
      LeaveRequest.countDocuments({ status: 'pending' }),
      AttendanceCorrection.countDocuments({ status: 'pending' }),
      Employee.find({ ...live, dateOfJoining: { $gte: thirtyDaysAgo } })
        .sort({ dateOfJoining: -1 })
        .limit(5)
        .select('_id firstName lastName departmentId dateOfJoining')
        .lean(),
      Employee.find({ status: 'exited', updatedAt: { $gte: thirtyDaysAgo } })
        .sort({ updatedAt: -1 })
        .limit(5)
        .select('_id firstName lastName departmentId updatedAt')
        .lean(),
      settle('loginTrend', [], () => loginTrend(actor, range)),
    ]);

  const departmentNames = await departmentNamesFor([...hires, ...exits]);

  return {
    role: 'org',
    kpis: [
      { key: 'total', label: 'Total headcount', value: total, tone: 'neutral', href: '/employees' },
      { key: 'active', label: 'Active', value: active, tone: 'positive', href: '/employees?status=active' },
      { key: 'probation', label: 'On probation', value: probation, tone: 'warning', href: '/employees?status=probation' },
      { key: 'notice', label: 'On notice', value: notice, tone: 'warning', href: '/employees?status=notice' },
      { key: 'invited', label: 'Not yet registered', value: invited, tone: 'neutral', href: '/employees?status=invited' },
    ],
    pendingActions: [
      {
        key: 'leave',
        label: 'Leave requests',
        value: pendingLeave,
        tone: pendingLeave > 0 ? 'warning' : 'neutral',
        href: '/leave/approvals',
      },
      {
        key: 'attendance-corrections',
        label: 'Attendance corrections',
        value: pendingCorrections,
        tone: pendingCorrections > 0 ? 'warning' : 'neutral',
        href: '/attendance/corrections',
      },
    ],
    newHires: hires.map((e) => ({
      employeeId: idStr(e._id),
      name: nameOf(e),
      department: departmentNames.get(idStr(e.departmentId)) ?? null,
      effectiveOn: e.dateOfJoining ? isoDay(e.dateOfJoining) : null,
    })),
    exits: exits.map((e) => ({
      employeeId: idStr(e._id),
      name: nameOf(e),
      department: departmentNames.get(idStr(e.departmentId)) ?? null,
      effectiveOn: e.updatedAt ? isoDay(e.updatedAt) : null,
    })),
    loginTrend: trend,
  };
}

/** Department labels for a handful of rows — one query, not one per row. */
async function departmentNamesFor(rows) {
  const ids = [...new Set(rows.map((r) => idStr(r.departmentId)).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const { default: Department } = await import('../../../models/hrms/Department.js');
  const departments = await Department.find({ _id: { $in: ids } })
    .select('_id name')
    .lean();
  return new Map(departments.map((d) => [idStr(d._id), d.name]));
}

/** A manager's own team: how many report in, and what is waiting on them. */
async function teamSummary(actor) {
  const me = actor?.employeeId ? new mongoose.Types.ObjectId(String(actor.employeeId)) : null;
  if (!me) return { role: 'team', team: { directReports: 0, onLeaveToday: 0, pendingApprovals: 0 } };

  const today = isoDay(new Date());

  const [directReports, teamIds] = await Promise.all([
    Employee.countDocuments({ deletedAt: null, reportingManagerId: me }),
    Employee.find({ deletedAt: null, managerChain: me }).select('_id').lean(),
  ]);

  const ids = teamIds.map((e) => e._id);
  const [onLeave, pendingApprovals] = await Promise.all([
    ids.length
      ? LeaveRequest.countDocuments({
          employeeId: { $in: ids },
          status: 'approved',
          startDate: { $lte: today },
          endDate: { $gte: today },
        })
      : 0,
    ids.length
      ? LeaveRequest.countDocuments({ employeeId: { $in: ids }, status: 'pending' })
      : 0,
  ]);

  return {
    role: 'team',
    team: { directReports, onLeaveToday: onLeave, pendingApprovals },
    pendingActions:
      pendingApprovals > 0
        ? [
            {
              key: 'leave',
              label: 'Leave requests',
              value: pendingApprovals,
              tone: 'warning',
              href: '/leave/approvals',
            },
          ]
        : [],
  };
}

/**
 * The summary, shaped by what the caller may see — the reference's own
 * widest-first branch, on this codebase's permission keys.
 */
export async function dashboardSummary(actor, { range = '7d' } = {}) {
  if (seesOrg(actor)) return orgSummary(actor, range);
  if (hasHrmsPermission(actor, M.LEAVE, A.APPROVE, S.TEAM)) return teamSummary(actor);
  // An ordinary employee gets no workforce figures at all. Their own numbers
  // live on the module screens that own them.
  return { role: 'self' };
}

export default { dashboardWidgets, dashboardSummary, loginTrend };
