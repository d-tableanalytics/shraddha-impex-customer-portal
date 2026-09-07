/**
 * Dashboard — aggregation, scope and the widgets a role may see.
 *
 * A real Express app over a real MongoDB, following the pattern every other
 * HRMS module established. Only `protect` is stubbed; the permission chain, the
 * validator, the services and the error handler are the genuine article.
 *
 * The assertions that carry the most weight are the scope ones. The dashboard
 * is the one screen every role opens, and it reads from nine modules at once —
 * so it is where a leak would be least obvious and most damaging.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import User from '../models/User.js';
import Department from '../models/hrms/Department.js';
import Holiday from '../models/hrms/Holiday.js';
import AuditLog from '../models/AuditLog.js';
import LeaveType from '../models/hrms/LeaveType.js';
import LeaveRequest from '../models/hrms/LeaveRequest.js';
import AttendanceRecord from '../models/hrms/AttendanceRecord.js';
import AttendanceCorrection from '../models/hrms/AttendanceCorrection.js';
import { Announcement, Poll } from '../models/hrms/EngageModels.js';

import dashboardRoutes from '../modules/hrms/dashboard/dashboard.routes.js';
import { buildQuickAccess } from '../modules/hrms/dashboard/dashboard.service.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import {
  departmentReferenceProvider,
  locationReferenceProvider,
} from '../modules/hrms/org/org.provider.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { buildHrmsActor } from '../shared/permissions/has-permission.js';
import { AUDIT_ACTIONS } from '../shared/constants/hrms.js';
import { QUICK_ACCESS_CATALOGUE } from '../shared/constants/dashboard.js';
import { buildTestApp, stubProtect, withServer, get } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/dashboard';

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const dayFromNow = (n) => isoDay(new Date(Date.now() + n * 86_400_000));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

before(async () => {
  await startTestMongo();
  await syncIndexes(
    Employee,
    User,
    Department,
    Holiday,
    AuditLog,
    LeaveType,
    LeaveRequest,
    AttendanceRecord,
    AttendanceCorrection,
    Announcement,
    Poll,
  );
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  __resetReferenceProviders();
  registerReferenceProvider('employee', employeeReferenceProvider);
  registerReferenceProvider('department', departmentReferenceProvider);
  registerReferenceProvider('location', locationReferenceProvider);
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/dashboard', dashboardRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;

/** Created SERIALLY by every caller — `seq` is shared and races otherwise. */
async function makeEmployee({
  roles = [R.EMPLOYEE],
  departmentId = null,
  managerId = null,
  status = 'active',
  firstName = 'Person',
  dateOfBirth = null,
  dateOfJoining = new Date('2024-01-01'),
} = {}) {
  seq += 1;
  const user = await User.create({
    email: `dash${seq}@example.com`,
    password: 'x'.repeat(60),
    user: `Person ${seq}`,
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    userId: user._id,
    employeeCode: `DSH${String(seq).padStart(3, '0')}`,
    firstName,
    lastName: String(seq),
    dateOfJoining,
    dateOfBirth,
    status,
    ...(departmentId ? { departmentId } : {}),
    ...(managerId ? { reportingManagerId: managerId, managerChain: [managerId] } : {}),
  });
  return {
    user: { _id: user._id, role: 'Management', roles, status: 'Active' },
    employee,
    id: String(employee._id),
  };
}

const envelope = (res) => {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  return res.body.data;
};

// ===========================================================================
// Access
// ===========================================================================

describe('access', () => {
  test('every HRMS role can open the dashboard', async () => {
    for (const role of [
      R.SUPER_ADMIN,
      R.HR_ADMIN,
      R.PAYROLL_ADMIN,
      R.RECRUITER,
      R.MANAGER,
      R.EMPLOYEE,
      R.IT_ADMIN,
      R.AUDITOR,
    ]) {
      const actor = await makeEmployee({ roles: [role] });
      await withServer(appFor(actor.user), async (url) => {
        assert.equal((await get(url, `${P}/widgets`)).status, 200, `${role} widgets`);
        assert.equal((await get(url, `${P}/summary`)).status, 200, `${role} summary`);
      });
    }
  });

  test('a portal Customer is refused before any widget runs', async () => {
    const customer = { _id: new mongoose.Types.ObjectId(), role: 'Customer', roles: [], status: 'Active' };
    await withServer(appFor(customer), async (url) => {
      assert.equal((await get(url, `${P}/widgets`)).status, 403);
      assert.equal((await get(url, `${P}/summary`)).status, 403);
      assert.equal((await get(url, `${P}/login-trend`)).status, 403);
    });
  });

  test('the range is a closed enum, so no caller can ask for an unbounded window', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      assert.equal((await get(url, `${P}/login-trend?range=7d`)).status, 200);
      assert.equal((await get(url, `${P}/login-trend?range=3650d`)).status, 400);
      assert.equal((await get(url, `${P}/summary?range=all`)).status, 400);
    });
  });
});

// ===========================================================================
// Quick access
// ===========================================================================

describe('quick access', () => {
  test('an employee is offered only what an employee can do', async () => {
    const actor = buildHrmsActor({ userId: 'u', roles: [R.EMPLOYEE], employee: { id: 'e' } });
    const keys = buildQuickAccess(actor).map((i) => i.key);

    assert.ok(keys.includes('applyLeave'));
    assert.ok(keys.includes('raiseTicket'));
    // Nothing administrative.
    for (const forbidden of ['addEmployee', 'runPayroll', 'settings', 'newRequisition', 'approvals']) {
      assert.ok(!keys.includes(forbidden), `an employee must not be offered ${forbidden}`);
    }
  });

  test('a manager gains approvals and the team view, and nothing else', async () => {
    const actor = buildHrmsActor({ userId: 'u', roles: [R.MANAGER], employee: { id: 'e' } });
    const keys = buildQuickAccess(actor).map((i) => i.key);

    assert.ok(keys.includes('approvals'));
    assert.ok(keys.includes('myTeam'));
    assert.ok(!keys.includes('runPayroll'));
    assert.ok(!keys.includes('addEmployee'));
  });

  test('only a payroll admin is offered Run Payroll, and only a super admin Settings', async () => {
    const payroll = buildHrmsActor({ userId: 'u', roles: [R.PAYROLL_ADMIN], employee: { id: 'e' } });
    const hr = buildHrmsActor({ userId: 'u', roles: [R.HR_ADMIN], employee: { id: 'e' } });
    const admin = buildHrmsActor({ userId: 'u', roles: [R.SUPER_ADMIN], employee: { id: 'e' } });

    assert.ok(buildQuickAccess(payroll).map((i) => i.key).includes('runPayroll'));
    // HR sees payslips but cannot RUN payroll — the reference's §4.2 rule.
    assert.ok(!buildQuickAccess(hr).map((i) => i.key).includes('runPayroll'));
    assert.ok(!buildQuickAccess(hr).map((i) => i.key).includes('settings'));
    assert.ok(buildQuickAccess(admin).map((i) => i.key).includes('settings'));
  });

  test('every catalogue entry points at a path the router actually serves', async () => {
    const { readFile } = await import('node:fs/promises');
    const routes = await readFile(
      new URL('../../frontend/src/routes/index.jsx', import.meta.url),
      'utf8',
    );

    for (const item of QUICK_ACCESS_CATALOGUE) {
      // `/leave/approvals` -> the `leave` module route, which owns `:tab`.
      const [, moduleSegment] = item.path.split('/');
      assert.match(
        routes,
        new RegExp(`path: "${moduleSegment}"`),
        `${item.key} points at /${moduleSegment}, which no route declares`,
      );
    }
  });
});

// ===========================================================================
// Widgets and scope
// ===========================================================================

describe('widgets', () => {
  test('the greeting name is resolved from the SESSION, not sent by the client', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN], firstName: 'Meera' });
    await withServer(appFor(hr.user), async (url) => {
      const data = envelope(await get(url, `${P}/widgets`));
      assert.equal(data.viewer.firstName, 'Meera');
      assert.equal(data.viewer.employeeCode, hr.employee.employeeCode);
    });
  });

  test('upcoming holidays are shown to everybody, soonest first', async () => {
    await Holiday.create([
      { name: 'Diwali', date: dayFromNow(10), year: 2026, type: 'public' },
      { name: 'Republic Day', date: dayFromNow(2), year: 2026, type: 'public' },
      { name: 'Long past', date: dayFromNow(-30), year: 2026, type: 'public' },
    ]);
    const staff = await makeEmployee();

    await withServer(appFor(staff.user), async (url) => {
      const data = envelope(await get(url, `${P}/widgets`));
      assert.equal(data.upcomingHolidays.length, 2, 'a past holiday is not upcoming');
      assert.equal(data.upcomingHolidays[0].name, 'Republic Day');
    });
  });

  test('🔴 announcements respect targeting — the reference ignores it entirely', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const engineering = await Department.create({ code: 'ENG', name: 'Engineering' });
    const sales = await Department.create({ code: 'SLS', name: 'Sales' });
    const engineer = await makeEmployee({ departmentId: engineering._id });

    await Announcement.create([
      {
        title: 'For everybody',
        body: 'Org-wide.',
        publishedAt: new Date(),
        targetRoleKeys: [],
        targetDepartmentIds: [],
      },
      {
        title: 'Sales only',
        body: 'Not for engineering.',
        publishedAt: new Date(),
        targetRoleKeys: [],
        targetDepartmentIds: [sales._id],
      },
      {
        title: 'Expired',
        body: 'Gone.',
        publishedAt: new Date(Date.now() - 86_400_000),
        expiresAt: new Date(Date.now() - 3600_000),
        targetRoleKeys: [],
        targetDepartmentIds: [],
      },
    ]);

    await withServer(appFor(engineer.user), async (url) => {
      const titles = envelope(await get(url, `${P}/widgets`)).announcements.map((a) => a.title);
      assert.deepEqual(titles, ['For everybody']);
      assert.ok(!titles.includes('Sales only'), 'another department’s announcement must not leak');
      assert.ok(!titles.includes('Expired'), 'an expired announcement must not show');
    });
    void hr;
  });

  test('🔴 an ordinary employee sees no "on leave today" and no mobile punches', async () => {
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({ managerId: manager.employee._id });
    const stranger = await makeEmployee();

    const type = await LeaveType.create({ code: 'CL', name: 'Casual', annualQuota: 12 });
    await LeaveRequest.create({
      employeeId: report.employee._id,
      leaveTypeId: type._id,
      startDate: isoDay(new Date()),
      endDate: isoDay(new Date()),
      durationUnit: 'full_day',
      durationValue: 1,
      reason: 'Personal matter',
      status: 'approved',
      approvalChain: [],
    });

    // An employee holds no team scope: absence is other people's information.
    await withServer(appFor(stranger.user), async (url) => {
      const data = envelope(await get(url, `${P}/widgets`));
      assert.deepEqual(data.onLeaveToday, []);
      assert.deepEqual(data.mobileClockInsToday, []);
      assert.equal(data.scope.team, false);
    });

    // Their manager does, and sees only their own reporting line.
    await withServer(appFor(manager.user), async (url) => {
      const data = envelope(await get(url, `${P}/widgets`));
      assert.equal(data.scope.team, true);
      assert.equal(data.onLeaveToday.length, 1);
      assert.equal(data.onLeaveToday[0].employeeId, String(report.employee._id));
    });
  });

  test('celebrations are org-wide for everyone, and bounded to a fortnight', async () => {
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 3);
    const far = new Date();
    far.setUTCDate(far.getUTCDate() + 90);

    await makeEmployee({
      firstName: 'Birthday',
      dateOfBirth: new Date(Date.UTC(1990, soon.getUTCMonth(), soon.getUTCDate())),
    });
    await makeEmployee({
      firstName: 'Faraway',
      dateOfBirth: new Date(Date.UTC(1990, far.getUTCMonth(), far.getUTCDate())),
    });
    const staff = await makeEmployee({ firstName: 'Viewer' });

    await withServer(appFor(staff.user), async (url) => {
      const data = envelope(await get(url, `${P}/widgets`));
      const names = data.birthdays.map((b) => b.name);
      assert.ok(names.some((n) => n.startsWith('Birthday')), 'a birthday in 3 days shows');
      assert.ok(!names.some((n) => n.startsWith('Faraway')), 'one in 90 days does not');
    });
  });

  test('🔴 an anniversary counts years from the OCCURRENCE, not from today', async () => {
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 2);

    // Joined exactly five years before the upcoming occurrence.
    await makeEmployee({
      firstName: 'Veteran',
      dateOfJoining: new Date(Date.UTC(soon.getUTCFullYear() - 5, soon.getUTCMonth(), soon.getUTCDate())),
    });
    const staff = await makeEmployee({ firstName: 'Viewer' });

    await withServer(appFor(staff.user), async (url) => {
      const data = envelope(await get(url, `${P}/widgets`));
      const veteran = data.anniversaries.find((a) => a.name.startsWith('Veteran'));
      assert.ok(veteran, 'the anniversary is inside the window');
      assert.equal(veteran.yearsCount, 5);
    });
  });
});

// ===========================================================================
// Summary
// ===========================================================================

describe('summary', () => {
  test('an ordinary employee gets NO workforce figures at all', async () => {
    await makeEmployee({ status: 'probation' });
    const staff = await makeEmployee();

    await withServer(appFor(staff.user), async (url) => {
      const data = envelope(await get(url, `${P}/summary`));
      assert.equal(data.role, 'self');
      assert.equal(data.kpis, undefined, 'headcount is not an employee’s business');
      assert.equal(data.newHires, undefined);
      assert.equal(data.exits, undefined);
    });
  });

  test('a manager gets their own team and nothing org-wide', async () => {
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    await makeEmployee({ managerId: manager.employee._id });
    await makeEmployee({ managerId: manager.employee._id });
    await makeEmployee(); // somebody else's report

    await withServer(appFor(manager.user), async (url) => {
      const data = envelope(await get(url, `${P}/summary`));
      assert.equal(data.role, 'team');
      assert.equal(data.team.directReports, 2);
      assert.equal(data.kpis, undefined, 'a manager sees no org headcount');
    });
  });

  test('HR gets the five workforce counts and both pending queues', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await makeEmployee({ status: 'probation' });
    await makeEmployee({ status: 'notice' });
    await makeEmployee({ status: 'invited' });

    await withServer(appFor(hr.user), async (url) => {
      const data = envelope(await get(url, `${P}/summary`));
      assert.equal(data.role, 'org');
      const byKey = Object.fromEntries(data.kpis.map((k) => [k.key, k.value]));
      assert.equal(byKey.total, 4);
      assert.equal(byKey.active, 1, 'only the HR admin is active');
      assert.equal(byKey.probation, 1);
      assert.equal(byKey.notice, 1);
      assert.equal(byKey.invited, 1);

      assert.deepEqual(
        data.pendingActions.map((a) => a.key).sort(),
        ['attendance-corrections', 'leave'],
      );
    });
  });

  test('new hires and exits are the last 30 days, newest first', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await makeEmployee({ firstName: 'Recent', dateOfJoining: new Date(Date.now() - 5 * 86_400_000) });
    await makeEmployee({ firstName: 'Ancient', dateOfJoining: new Date('2020-01-01') });

    await withServer(appFor(hr.user), async (url) => {
      const data = envelope(await get(url, `${P}/summary`));
      const names = data.newHires.map((h) => h.name);
      assert.ok(names.some((n) => n.startsWith('Recent')));
      assert.ok(!names.some((n) => n.startsWith('Ancient')), 'a 2020 joiner is not a new hire');
    });
  });
});

// ===========================================================================
// Login activity
// ===========================================================================

describe('login activity', () => {
  test('🔴 it needs the AUDIT grant — the reference shows it to everyone', async () => {
    await AuditLog.create([
      { action: AUDIT_ACTIONS.AUTH_LOGIN, method: 'POST', endpoint: '/login', remarks: 'in' },
      { action: AUDIT_ACTIONS.AUTH_LOGIN, method: 'POST', endpoint: '/login', remarks: 'in' },
    ]);

    const staff = await makeEmployee();
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const auditor = await makeEmployee({ roles: [R.AUDITOR] });

    for (const actor of [staff, manager]) {
      await withServer(appFor(actor.user), async (url) => {
        const data = envelope(await get(url, `${P}/login-trend`));
        assert.deepEqual(data, [], 'company-wide sign-in volume is audit data');
        const widgets = envelope(await get(url, `${P}/widgets`));
        assert.equal(widgets.scope.audit, false);
      });
    }

    await withServer(appFor(auditor.user), async (url) => {
      const data = envelope(await get(url, `${P}/login-trend`));
      assert.equal(data.length, 7, '7d is the default window');
      assert.equal(
        data.reduce((sum, d) => sum + d.logins, 0),
        2,
      );
    });
  });

  test('the series is zero-filled, so the line has no gaps', async () => {
    const auditor = await makeEmployee({ roles: [R.AUDITOR] });

    await withServer(appFor(auditor.user), async (url) => {
      for (const [range, days] of [
        ['7d', 7],
        ['14d', 14],
        ['30d', 30],
      ]) {
        const data = envelope(await get(url, `${P}/login-trend?range=${range}`));
        assert.equal(data.length, days, range);
        assert.ok(
          data.every((d) => typeof d.logins === 'number'),
          'every day has a number, even with no sign-ins',
        );
        // Ascending, ending today.
        assert.equal(data[data.length - 1].date, isoDay(new Date()));
      }
    });
  });
});

// ===========================================================================
// Contract
// ===========================================================================

describe('contract', () => {
  test('every response puts its payload UNDER data', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const res = await get(url, `${P}/widgets`);
      assert.equal(res.body.success, true);
      assert.ok(res.body.data.quickAccess, 'the payload is under data');
      assert.equal(res.body.quickAccess, undefined, 'and not spread beside it');
    });
  });

  test('a widget that fails does not blank the dashboard', async () => {
    // 🔴 The reference runs one Promise.all, so one failing query loses the
    // whole page. Each widget here is settled independently — proven by
    // breaking one collection and checking the rest still arrive.
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const original = Holiday.find;
    Holiday.find = () => {
      throw new Error('holiday store is down');
    };

    try {
      await withServer(appFor(hr.user), async (url) => {
        const data = envelope(await get(url, `${P}/widgets`));
        assert.deepEqual(data.upcomingHolidays, [], 'the broken widget is empty');
        assert.ok(Array.isArray(data.quickAccess), 'its neighbours still render');
        assert.ok(data.viewer, 'and so does the greeting');
      });
    } finally {
      Holiday.find = original;
    }
  });
});
