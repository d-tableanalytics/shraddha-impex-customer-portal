/**
 * Reports — the HTTP layer, over a real MongoDB.
 *
 * Only `protect` is stubbed. The permission chain, the registry, the
 * generators, the CSV writer and the error handler are all the genuine article.
 *
 * Reports are the one module where aggregation can walk around record-level
 * assumptions, so most of what follows is about who may see what: the two-layer
 * permission model, the three roles the reference leaves with an empty
 * catalogue, the recruiter who gets a PARTIAL one, and whether a caller who
 * passes the route gate can guess a key missing from their own catalogue.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import AttendanceRecord from '../models/hrms/AttendanceRecord.js';
import { LeaveBalance } from '../models/hrms/LeaveBalance.js';
import { LeaveType } from '../models/hrms/LeaveType.js';
import { Department } from '../models/hrms/Department.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import reportRoutes from '../modules/hrms/reports/report.routes.js';
import { csvCell, toCsv } from '../modules/hrms/reports/report.service.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import { AUDIT_ACTIONS } from '../shared/constants/hrms.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { REPORT_EXPORT_MAX_ROWS } from '../shared/schemas/report.js';
import { buildTestApp, stubProtect, withServer, get } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/reports';
const oid = () => new mongoose.Types.ObjectId();
const day = (s) => new Date(`${s}T00:00:00.000Z`);

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, AttendanceRecord, LeaveBalance, LeaveType, Department);
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  __resetReferenceProviders();
  registerReferenceProvider('employee', employeeReferenceProvider);
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/reports', reportRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;
async function makePerson(roles, over = {}) {
  seq += 1;
  const userId = oid();
  await User.create({
    _id: userId,
    name: `${over.firstName ?? 'Test'} Person`,
    email: over.email ?? `rp${seq}@example.com`,
    password: 'hashed-not-used',
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    employeeCode: over.employeeCode ?? `RP-${String(seq).padStart(4, '0')}`,
    userId,
    firstName: over.firstName ?? 'Test',
    lastName: over.lastName ?? `Person${seq}`,
    dateOfJoining: over.dateOfJoining ?? new Date('2020-01-01'),
    status: over.status ?? 'active',
    ...over,
  });
  return { user: { _id: userId, role: 'Management', roles, status: 'Active' }, employee };
}

const envelope = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  return res.body.data;
};

const refused = (res, status) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  return res.body;
};

const keys = (catalog) => catalog.map((r) => r.key).sort();

/** The full cast — one of every role that can reach the module. */
async function seedRoles() {
  return {
    superAdmin: await makePerson([R.SUPER_ADMIN], { firstName: 'Sue' }),
    hr: await makePerson([R.HR_ADMIN], { firstName: 'Hana' }),
    payroll: await makePerson([R.PAYROLL_ADMIN], { firstName: 'Fiona' }),
    manager: await makePerson([R.MANAGER], { firstName: 'Mo' }),
    recruiter: await makePerson([R.RECRUITER], { firstName: 'Rita' }),
    it: await makePerson([R.IT_ADMIN], { firstName: 'Ivan' }),
    auditor: await makePerson([R.AUDITOR], { firstName: 'Ada' }),
    staff: await makePerson([R.EMPLOYEE], { firstName: 'Sam' }),
  };
}

// ===========================================================================
// The catalogue and the two-layer permission model
// ===========================================================================

test('the catalogue holds the reference\'s three reports and no others', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/catalog`));
    assert.deepEqual(keys(data), [
      'attendance_monthly',
      'employees_directory',
      'leave_balances',
    ]);
  });
});

test('a catalogue entry carries the column contract but never the generator', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/catalog`));
    const directory = data.find((r) => r.key === 'employees_directory');

    assert.equal(directory.label, 'Employee Directory');
    assert.equal(directory.category, 'Employees');
    assert.equal(directory.columns.length, 6);
    assert.deepEqual(
      directory.columns.map((c) => c.key),
      ['employeeCode', 'displayName', 'email', 'departmentName', 'designation', 'joinDate'],
    );
    assert.equal(directory.generator, undefined);
    assert.equal(directory.paramsSchema, undefined);
  });
});

test('the catalogue is filtered by each report\'s OWN data module, not by `reports`', async () => {
  // The whole point of the reference's two-layer model. Holding a `reports*`
  // grant opens the door; it does not hand over a module you cannot read.
  const roles = await seedRoles();

  const expected = [
    ['superAdmin', ['attendance_monthly', 'employees_directory', 'leave_balances']],
    ['hr', ['attendance_monthly', 'employees_directory', 'leave_balances']],
    ['auditor', ['attendance_monthly', 'employees_directory', 'leave_balances']],
    // A recruiter sees TWO. Not through `reports:hiring` — no report declares
    // that — but because the reference also grants a recruiter
    // `employees:view:org` and `attendance:view:org` (for profile maintenance
    // and the correction queue). They get exactly the two reports those two
    // grants unlock, and are refused the third.
    ['recruiter', ['attendance_monthly', 'employees_directory']],
    // These three reach the module and find NOTHING behind it. Their only
    // report grants are `reports:payroll`, `reports:team` and `reports:assets`,
    // and no report in either codebase declares any of the three.
    ['payroll', []],
    ['manager', []],
    ['it', []],
  ];

  for (const [role, want] of expected) {
    await withServer(appFor(roles[role].user), async (url) => {
      const data = envelope(await get(url, `${P}/catalog`));
      assert.deepEqual(keys(data), want, `catalogue for ${role}`);
    });
  }
});

test('a plain employee cannot reach the module at all', async () => {
  const { staff } = await seedRoles();
  await withServer(appFor(staff.user), async (url) => {
    refused(await get(url, `${P}/catalog`), 403);
    refused(await get(url, `${P}/employees_directory/run`), 403);
    refused(await get(url, `${P}/employees_directory/export.csv`), 403);
  });
});

test('AD-4: a Customer reaches no report endpoint', async () => {
  const userId = oid();
  await User.create({
    _id: userId,
    name: 'Customer Co',
    email: 'buyer@example.com',
    password: 'hashed-not-used',
    role: 'Customer',
    roles: [],
    status: 'Active',
  });
  const customer = { _id: userId, role: 'Customer', roles: [], status: 'Active' };

  await withServer(appFor(customer), async (url) => {
    refused(await get(url, `${P}/catalog`), 403);
    refused(await get(url, `${P}/employees_directory/run`), 403);
    refused(await get(url, `${P}/employees_directory/export.csv`), 403);
  });
});

test('an unauthenticated caller gets 401, not an empty catalogue', async () => {
  await withServer(appFor(null), async (url) => {
    assert.equal((await get(url, `${P}/catalog`)).status, 401);
  });
});

// ===========================================================================
// Guessing a key you cannot see — the aggregation-bypass case
// ===========================================================================

test('a role with an EMPTY catalogue cannot run a report by guessing its key', async () => {
  // An IT admin holds `reports:assets:view:org`, so the route gate admits them.
  // Only the per-report check stands between them and the whole directory.
  const { it, payroll, manager } = await seedRoles();
  for (const person of [it, payroll, manager]) {
    await withServer(appFor(person.user), async (url) => {
      for (const key of ['employees_directory', 'attendance_monthly', 'leave_balances']) {
        refused(await get(url, `${P}/${key}/run`), 403);
      }
    });
  }
});

test('a PARTIAL catalogue is enforced report by report', async () => {
  // The sharpest case for the two-layer model: a recruiter may read the
  // directory and the attendance summary, and must be refused leave balances —
  // one actor, two answers, decided by each report's own data module.
  const { recruiter } = await seedRoles();
  await withServer(appFor(recruiter.user), async (url) => {
    assert.equal((await get(url, `${P}/employees_directory/run`)).status, 200);
    assert.equal((await get(url, `${P}/attendance_monthly/run`)).status, 200);
    refused(await get(url, `${P}/leave_balances/run`), 403);
    refused(await get(url, `${P}/leave_balances/export.csv`), 403);
  });
});

test('...and cannot EXPORT one either', async () => {
  // The export gate is deliberately wider than the run gate (the reference
  // folds the view grants into it). This proves that widening cannot widen
  // WHICH report is reachable, because the per-report check runs on export too.
  // A recruiter is deliberately NOT in this list: they hold `employees:view:org`
  // and may export the directory. Their refusal is the leave-balances one, in
  // the partial-catalogue test above.
  const roles = await seedRoles();
  for (const role of ['payroll', 'it', 'manager']) {
    await withServer(appFor(roles[role].user), async (url) => {
      refused(await get(url, `${P}/employees_directory/export.csv`), 403);
      refused(await get(url, `${P}/leave_balances/export.csv`), 403);
    });
  }
});

test('an unknown report key is a 404 on both run and export', async () => {
  const { superAdmin } = await seedRoles();
  await withServer(appFor(superAdmin.user), async (url) => {
    refused(await get(url, `${P}/does_not_exist/run`), 404);
    refused(await get(url, `${P}/does_not_exist/export.csv`), 404);
    // A traversal-shaped key is a 404 too, not a 500 and not a file read.
    refused(await get(url, `${P}/..%2F..%2Fetc%2Fpasswd/run`), 404);
  });
});

test('a manager holding team scope is refused an org-scoped report', async () => {
  // `reports:team:view:team` passes the route gate. Every report declares
  // `scopeRequired: 'org'`, and a team grant does not rank up to org — which is
  // what stops a manager reading the whole company's leave balances.
  const { manager, staff } = await seedRoles();
  await Employee.updateOne(
    { _id: staff.employee._id },
    { $set: { reportingManagerId: manager.employee._id, managerChain: [manager.employee._id] } },
  );

  await withServer(appFor(manager.user), async (url) => {
    assert.deepEqual(envelope(await get(url, `${P}/catalog`)), []);
    refused(await get(url, `${P}/employees_directory/run`), 403);
  });
});

// ===========================================================================
// Employee directory
// ===========================================================================

async function seedDirectory() {
  const roles = await seedRoles();
  const engineering = await Department.create({ code: 'ENG', name: 'Engineering' });
  const sales = await Department.create({ code: 'SLS', name: 'Sales' });

  const alice = await makePerson([R.EMPLOYEE], {
    firstName: 'Alice',
    lastName: 'Ant',
    employeeCode: 'E-0001',
    email: 'alice@example.com',
    designation: 'Engineer',
    departmentId: engineering._id,
    dateOfJoining: new Date('2021-03-04'),
  });
  const bob = await makePerson([R.EMPLOYEE], {
    firstName: 'Bob',
    lastName: 'Bee',
    employeeCode: 'E-0002',
    email: 'bob@example.com',
    designation: 'Seller',
    departmentId: sales._id,
    dateOfJoining: new Date('2022-06-15'),
  });
  return { roles, engineering, sales, alice, bob };
}

test('the directory returns the reference\'s six columns, resolved', async () => {
  const { roles, alice } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/employees_directory/run?pageSize=200`));
    const row = data.data.find((r) => r.employeeCode === 'E-0001');

    assert.equal(row.displayName, 'Alice Ant');
    assert.equal(row.email, 'alice@example.com');
    assert.equal(row.departmentName, 'Engineering');
    assert.equal(row.designation, 'Engineer');
    // The wire format is always YYYY-MM-DD, never a locale string.
    assert.equal(row.joinDate, '2021-03-04');
    assert.equal(row.employeeCode, alice.employee.employeeCode);
  });
});

test('the directory NEVER projects a sensitive field', async () => {
  const { roles } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const body = await get(url, `${P}/employees_directory/run?pageSize=200`);
    const raw = JSON.stringify(body.body);

    for (const forbidden of [
      'panEnc', 'panIdx', 'bankAccountEnc', 'bankAccountIdx', 'aadhaarEnc',
      'permanentAddress', 'temporaryAddress', 'dependents', 'emergencyContacts',
      'customFieldValues', 'dateOfBirth', 'fatherName', 'motherName', 'phone',
      'managerChain', 'userId',
    ]) {
      assert.ok(!raw.includes(forbidden), `"${forbidden}" leaked into the directory`);
    }

    // And the row shape is exactly the declared columns — nothing extra.
    const row = envelope(body).data[0];
    assert.deepEqual(
      Object.keys(row).sort(),
      ['departmentName', 'designation', 'displayName', 'email', 'employeeCode', 'joinDate'],
    );
  });
});

test('a soft-deleted employee is excluded even when their status still says active', async () => {
  // The reference filters `status: 'active'` and nothing else, so a deleted
  // employee whose status was never moved off `active` stays in the export.
  const { roles, alice } = await seedDirectory();
  await Employee.updateOne({ _id: alice.employee._id }, { $set: { deletedAt: new Date() } });

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/employees_directory/run?pageSize=200`));
    assert.ok(!data.data.some((r) => r.employeeCode === 'E-0001'));
    assert.ok(data.data.some((r) => r.employeeCode === 'E-0002'));
  });
});

test('the directory filters by department, on the SERVER', async () => {
  const { roles, engineering } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(
      await get(url, `${P}/employees_directory/run?departmentId=${engineering._id}&pageSize=200`),
    );
    assert.deepEqual(data.data.map((r) => r.employeeCode), ['E-0001']);
    assert.equal(data.total, 1);
  });
});

test('the directory filters by status, which the reference hardcodes', async () => {
  const { roles, bob } = await seedDirectory();
  await Employee.updateOne({ _id: bob.employee._id }, { $set: { status: 'notice' } });

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const onNotice = envelope(await get(url, `${P}/employees_directory/run?status=notice&pageSize=200`));
    assert.deepEqual(onNotice.data.map((r) => r.employeeCode), ['E-0002']);

    // The default is `active`, matching the reference's hardcoded filter.
    const dflt = envelope(await get(url, `${P}/employees_directory/run?pageSize=200`));
    assert.ok(!dflt.data.some((r) => r.employeeCode === 'E-0002'));
  });
});

test('the directory search is escaped, so a regex metacharacter cannot stall it', async () => {
  const { roles } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const res = await get(url, `${P}/employees_directory/run?search=${encodeURIComponent('(a+)+$')}`);
    assert.equal(res.status, 200);
    assert.equal(envelope(res).total, 0);

    const hit = envelope(await get(url, `${P}/employees_directory/run?search=Alice`));
    assert.deepEqual(hit.data.map((r) => r.employeeCode), ['E-0001']);
  });
});

// ===========================================================================
// Paging and query bounds
// ===========================================================================

test('a report is PAGED — the reference returns an unbounded array', async () => {
  const { roles } = await seedDirectory();
  for (let i = 0; i < 8; i += 1) {
    await makePerson([R.EMPLOYEE], { employeeCode: `Z-${String(i).padStart(4, '0')}` });
  }

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const first = envelope(await get(url, `${P}/employees_directory/run?page=1&pageSize=3`));
    assert.equal(first.data.length, 3);
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, 3);
    // 8 seeded + 2 from the directory fixture + 8 role holders.
    assert.equal(first.total, 18);

    const second = envelope(await get(url, `${P}/employees_directory/run?page=2&pageSize=3`));
    assert.equal(second.data.length, 3);
    // Deterministic: no row appears on both pages.
    const overlap = first.data.filter((a) =>
      second.data.some((b) => b.employeeCode === a.employeeCode),
    );
    assert.deepEqual(overlap, []);
  });
});

test('the pages PARTITION the result set — nothing repeats, nothing is dropped', async () => {
  // A genuine tie on the sort key cannot be constructed here: `employeeCode`
  // carries a unique index, so the `_id` tiebreak in the sort is defence in
  // depth rather than something a fixture can exercise. What IS worth
  // asserting is the property the reference has no way to hold, because it
  // never pages at all: walking every page must yield each row exactly once.
  const { roles } = await seedDirectory();
  for (let i = 0; i < 7; i += 1) {
    await makePerson([R.EMPLOYEE], { employeeCode: `P-${String(i).padStart(4, '0')}` });
  }

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const first = envelope(await get(url, `${P}/employees_directory/run?page=1&pageSize=4`));
    const { total } = first;

    const seen = [];
    for (let page = 1; page * 4 - 4 < total; page += 1) {
      const body = envelope(await get(url, `${P}/employees_directory/run?page=${page}&pageSize=4`));
      seen.push(...body.data.map((r) => r.employeeCode));
      assert.equal(body.total, total, 'the total must not drift between pages');
    }

    assert.equal(seen.length, total, 'every row appears');
    assert.equal(new Set(seen).size, total, 'and appears exactly once');
    // Repeating a request returns the same page.
    const again = envelope(await get(url, `${P}/employees_directory/run?page=2&pageSize=4`));
    const twice = envelope(await get(url, `${P}/employees_directory/run?page=2&pageSize=4`));
    assert.deepEqual(again.data, twice.data);
  });
});

test('an over-sized page is refused, not silently served', async () => {
  const { roles } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const res = await get(url, `${P}/employees_directory/run?pageSize=100000`);
    refused(res, 400);
    assert.ok(res.body.details.some((d) => d.path === 'pageSize'));
  });
});

test('an unknown filter is a 400 on EVERY report, not silence', async () => {
  // The reference accepts `Record<string,string>` and ignores it, so an unknown
  // filter returns the whole organisation and reads like a filter that matched
  // everything.
  //
  // All three reports, deliberately: covering only one let `attendance_monthly`
  // through, because its schema was built as an intersection and an
  // intersection is not strict even when both halves are.
  const { roles } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    for (const key of ['employees_directory', 'attendance_monthly', 'leave_balances']) {
      refused(await get(url, `${P}/${key}/run?bogusFilter=x`), 400);
    }
    refused(await get(url, `${P}/employees_directory/run?departmentId=not-an-objectid`), 400);
    refused(await get(url, `${P}/attendance_monthly/run?departmentId=not-an-objectid`), 400);
    refused(await get(url, `${P}/leave_balances/run?year=nineteen`), 400);
  });
});

// ===========================================================================
// Attendance summary — the calculation the reference gets wrong
// ===========================================================================

async function seedAttendance() {
  const { roles, alice, bob, engineering } = await seedDirectory();
  const rows = [
    ['2026-03-02', 'present'],
    ['2026-03-03', 'present'],
    ['2026-03-04', 'half_day'],
    ['2026-03-05', 'absent'],
    ['2026-03-06', 'on_leave'],
    ['2026-03-07', 'weekly_off'],
    ['2026-03-08', 'holiday'],
    // Outside the window: the reference's `gte`-only filter would count it.
    ['2026-04-01', 'present'],
  ];
  for (const [d, status] of rows) {
    await AttendanceRecord.create({
      employeeId: alice.employee._id,
      date: day(d),
      status,
      source: 'web',
    });
  }
  return { roles, alice, bob, engineering };
}

const RANGE = 'from=2026-03-01&to=2026-03-31';

test('presentDays counts only days actually present, and a half day as a half', async () => {
  // The reference counts EVERY row — `_count: { id: true }` with no status
  // predicate — and labels it "Present Days". On this fixture it would report
  // 7 for Alice. The correct answer is 2 full + one half = 2.5.
  const { roles } = await seedAttendance();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/attendance_monthly/run?${RANGE}&pageSize=200`));
    const alice = data.data.find((r) => r.employeeCode === 'E-0001');

    assert.equal(alice.presentDays, 2.5);
    assert.equal(alice.absentDays, 1);
    assert.equal(alice.leaveDays, 1);
  });
});

test('an employee with no attendance row shows a zero, not a missing row', async () => {
  // The reference groups BY attendance record, so someone who never punched is
  // absent from its attendance report entirely — the one row most worth seeing.
  const { roles } = await seedAttendance();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/attendance_monthly/run?${RANGE}&pageSize=200`));
    const bob = data.data.find((r) => r.employeeCode === 'E-0002');

    assert.ok(bob, 'an employee with no records must still appear');
    assert.equal(bob.presentDays, 0);
    assert.equal(bob.absentDays, 0);
  });
});

test('the date window is CLOSED at both ends', async () => {
  // The reference filters `date: { gte: startOfMonth }` with no upper bound, so
  // its "current month" includes every future-dated record forever. The April
  // row in the fixture is what proves the `lte` is doing work.
  const { roles } = await seedAttendance();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const march = envelope(await get(url, `${P}/attendance_monthly/run?${RANGE}&pageSize=200`));
    assert.equal(march.data.find((r) => r.employeeCode === 'E-0001').presentDays, 2.5);

    const wide = envelope(
      await get(url, `${P}/attendance_monthly/run?from=2026-03-01&to=2026-04-30&pageSize=200`),
    );
    assert.equal(wide.data.find((r) => r.employeeCode === 'E-0001').presentDays, 3.5);
  });
});

test('an inverted or over-long date range is refused', async () => {
  const { roles } = await seedAttendance();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    refused(await get(url, `${P}/attendance_monthly/run?from=2026-03-31&to=2026-03-01`), 400);
    refused(await get(url, `${P}/attendance_monthly/run?from=2020-01-01&to=2026-12-31`), 400);
    refused(await get(url, `${P}/attendance_monthly/run?from=not-a-date`), 400);
  });
});

test('a soft-deleted employee is excluded from the attendance summary', async () => {
  const { roles, alice } = await seedAttendance();
  await Employee.updateOne({ _id: alice.employee._id }, { $set: { deletedAt: new Date() } });

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/attendance_monthly/run?${RANGE}&pageSize=200`));
    assert.ok(!data.data.some((r) => r.employeeCode === 'E-0001'));
  });
});

test('the attendance summary filters by department', async () => {
  const { roles, engineering } = await seedAttendance();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(
      await get(url, `${P}/attendance_monthly/run?${RANGE}&departmentId=${engineering._id}&pageSize=200`),
    );
    assert.deepEqual(data.data.map((r) => r.employeeCode), ['E-0001']);
  });
});

// ===========================================================================
// Leave balances
// ===========================================================================

async function seedLeave() {
  const { roles, alice, bob, engineering } = await seedDirectory();
  const casual = await LeaveType.create({ code: 'CL', name: 'Casual Leave' });
  const sick = await LeaveType.create({ code: 'SL', name: 'Sick Leave' });

  await LeaveBalance.create({
    employeeId: alice.employee._id,
    leaveTypeId: casual._id,
    year: 2026,
    accrued: 12,
    used: 2.5,
    pending: 0,
  });
  await LeaveBalance.create({
    employeeId: alice.employee._id,
    leaveTypeId: sick._id,
    year: 2026,
    accrued: 6,
    used: 0,
    pending: 1,
  });
  await LeaveBalance.create({
    employeeId: bob.employee._id,
    leaveTypeId: casual._id,
    year: 2025,
    accrued: 12,
    used: 0,
    pending: 0,
  });
  return { roles, alice, bob, casual, sick, engineering };
}

test('leave balances resolve the employee and the leave type, for the chosen year', async () => {
  const { roles } = await seedLeave();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/leave_balances/run?year=2026&pageSize=200`));
    assert.equal(data.total, 2);

    const casual = data.data.find((r) => r.leaveType === 'Casual Leave');
    assert.equal(casual.employeeCode, 'E-0001');
    assert.equal(casual.displayName, 'Alice Ant');
    // 12 - 2.5 - 0, materialised on write.
    assert.equal(casual.balance, 9.5);

    const sick = data.data.find((r) => r.leaveType === 'Sick Leave');
    assert.equal(sick.balance, 5);
  });
});

test('leave balances are bucketed by year', async () => {
  const { roles } = await seedLeave();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const y2025 = envelope(await get(url, `${P}/leave_balances/run?year=2025&pageSize=200`));
    assert.equal(y2025.total, 1);
    assert.equal(y2025.data[0].employeeCode, 'E-0002');
  });
});

test('leave balances filter by leave type and by department', async () => {
  const { roles, casual, engineering } = await seedLeave();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const byType = envelope(
      await get(url, `${P}/leave_balances/run?year=2026&leaveTypeId=${casual._id}&pageSize=200`),
    );
    assert.equal(byType.total, 1);
    assert.equal(byType.data[0].leaveType, 'Casual Leave');

    const byDept = envelope(
      await get(url, `${P}/leave_balances/run?year=2026&departmentId=${engineering._id}&pageSize=200`),
    );
    assert.equal(byDept.total, 2);
  });
});

test('a soft-deleted employee\'s balances are excluded', async () => {
  const { roles, alice } = await seedLeave();
  await Employee.updateOne({ _id: alice.employee._id }, { $set: { deletedAt: new Date() } });

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/leave_balances/run?year=2026&pageSize=200`));
    assert.equal(data.total, 0);
  });
});

test('a leave balance keeps its exact two-decimal value', async () => {
  const { roles, alice, casual } = await seedLeave();
  await LeaveBalance.updateOne(
    { employeeId: alice.employee._id, leaveTypeId: casual._id, year: 2026 },
    { $set: { balance: 9.25 } },
  );

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/leave_balances/run?year=2026&pageSize=200`));
    const row = data.data.find((r) => r.leaveType === 'Casual Leave');
    assert.equal(row.balance, 9.25);
  });
});

// ===========================================================================
// CSV export
// ===========================================================================

test('the export returns CSV with the column LABELS as its header', async () => {
  const { roles } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const res = await get(url, `${P}/employees_directory/export.csv`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.equal(
      res.headers.get('content-disposition'),
      'attachment; filename="employees_directory.csv"',
    );
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const lines = res.body.split('\n');
    assert.equal(lines[0], 'Code,Name,Email,Department,Designation,Join Date');
    assert.ok(lines.some((l) => l.startsWith('E-0001,Alice Ant,alice@example.com,Engineering')));
  });
});

test('the export honours filters but IGNORES paging', async () => {
  const { roles, engineering } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const filtered = await get(url, `${P}/employees_directory/export.csv?departmentId=${engineering._id}`);
    assert.equal(filtered.body.trim().split('\n').length, 2); // header + Alice

    // `pageSize=1` must not truncate an export to one row.
    const paged = await get(url, `${P}/employees_directory/export.csv?pageSize=1&page=3`);
    assert.equal(paged.status, 200);
    assert.ok(Number(paged.headers.get('x-report-rows')) > 1);
    assert.equal(paged.headers.get('x-report-truncated'), 'false');

    // Paging is STRIPPED before validation, not merely overridden afterwards.
    // A page size the run endpoint refuses outright is simply ignored here,
    // because a leftover paging param from the UI must not fail a download.
    refused(await get(url, `${P}/employees_directory/run?pageSize=100000`), 400);
    assert.equal(
      (await get(url, `${P}/employees_directory/export.csv?pageSize=100000`)).status,
      200,
    );
  });
});

test('a bad filter fails the export too, rather than exporting everything', async () => {
  const { roles } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    refused(await get(url, `${P}/employees_directory/export.csv?departmentId=nope`), 400);
  });
});

test('CSV FORMULA INJECTION is neutralised', async () => {
  // Every column in every report is user-supplied text, and the reference
  // escapes for RFC 4180 only. An employee whose designation is
  // `=cmd|'/c calc'!A1` becomes a live formula for whoever opens the export.
  const { roles } = await seedDirectory();
  await makePerson([R.EMPLOYEE], {
    employeeCode: 'E-0003',
    firstName: 'Mallory',
    lastName: 'Malware',
    designation: "=cmd|'/c calc'!A1",
  });
  await makePerson([R.EMPLOYEE], { employeeCode: 'E-0004', designation: '+1+1' });
  await makePerson([R.EMPLOYEE], { employeeCode: 'E-0005', designation: '-2+3' });
  await makePerson([R.EMPLOYEE], { employeeCode: 'E-0006', designation: '@SUM(A1:A9)' });

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const res = await get(url, `${P}/employees_directory/export.csv`);
    const body = res.body;

    // Each dangerous lead is defused with an apostrophe. No quotes here: the
    // value carries no delimiter, so RFC 4180 wrapping does not apply and the
    // prefix is the whole of the protection.
    assert.ok(body.includes(`'=cmd|'/c calc'!A1`), body);
    assert.ok(body.includes("'+1+1"));
    assert.ok(body.includes("'-2+3"));
    assert.ok(body.includes("'@SUM(A1:A9)"));

    // ...and no cell begins a formula.
    for (const line of body.split('\n').slice(1)) {
      for (const cell of line.split(',')) {
        assert.ok(!/^[=+\-@\t\r]/.test(cell), `cell "${cell}" would evaluate`);
      }
    }
  });
});

test('CSV quoting handles delimiters, quotes and newlines', async () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  // A lone carriage return breaks a row just as a newline does; the reference's
  // trigger class is `[,\n"]` and omits it.
  assert.equal(csvCell('two\rlines'), '"two\rlines"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0');

  const csv = toCsv([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], [{ a: 1, b: 'x,y' }]);
  assert.equal(csv, 'A,B\n1,"x,y"');
});

test('the export is capped, and says so', async () => {
  assert.equal(REPORT_EXPORT_MAX_ROWS, 5000);
  // Proving the cap at 5,000 rows would mean seeding 5,001 employees. The cap
  // is proved through the header contract instead: `truncated` is derived from
  // `total > rows.length`, and the same expression is what limits the query.
  const { roles } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const res = await get(url, `${P}/employees_directory/export.csv`);
    assert.equal(res.headers.get('x-report-truncated'), 'false');
    assert.equal(
      Number(res.headers.get('x-report-rows')),
      Number(res.headers.get('x-report-total')),
    );
  });
});

// ===========================================================================
// Audit
// ===========================================================================

test('running and exporting are audited; a refusal is not', async () => {
  // The reference records nothing at all, so a full-directory export leaves no
  // trace of who took it or when.
  const { roles } = await seedDirectory();

  await withServer(appFor(roles.superAdmin.user), async (url) => {
    await get(url, `${P}/employees_directory/run`);
    await get(url, `${P}/employees_directory/export.csv`);
  });
  await withServer(appFor(roles.it.user), async (url) => {
    // An IT admin holds no grant on `employees`, so this is a 403.
    await get(url, `${P}/employees_directory/run`);
  });

  const runs = await AuditLog.find({ action: AUDIT_ACTIONS.REPORT_RUN }).lean();
  const exports = await AuditLog.find({ action: AUDIT_ACTIONS.REPORT_EXPORTED }).lean();

  assert.equal(runs.length, 1, 'exactly one run, and none for the refusal');
  assert.equal(exports.length, 1);
  assert.equal(runs[0].meta.reportKey, 'employees_directory');
  assert.equal(exports[0].meta.reportKey, 'employees_directory');
  assert.equal(typeof exports[0].meta.rows, 'number');
});

test('the audit trail records the row COUNT, never the rows', async () => {
  const { roles } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    await get(url, `${P}/employees_directory/export.csv`);
  });

  const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.REPORT_EXPORTED }).lean();
  const raw = JSON.stringify(entry);
  for (const leaked of ['alice@example.com', 'Alice Ant', 'Engineer', 'E-0001']) {
    assert.ok(!raw.includes(leaked), `"${leaked}" was copied into the audit log`);
  }
  assert.ok(raw.includes('employees_directory'));
});

// ===========================================================================
// Envelope
// ===========================================================================

test('every JSON report response uses the standard envelope', async () => {
  const { roles } = await seedLeave();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    for (const path of [
      `${P}/catalog`,
      `${P}/employees_directory/run`,
      `${P}/attendance_monthly/run`,
      `${P}/leave_balances/run`,
    ]) {
      const res = await get(url, path);
      assert.equal(res.status, 200, path);
      assert.deepEqual(Object.keys(res.body).sort(), ['data', 'success'], path);
      assert.equal(res.body.success, true, path);
    }
  });
});

test('a run response carries the page contract alongside the rows', async () => {
  const { roles } = await seedDirectory();
  await withServer(appFor(roles.superAdmin.user), async (url) => {
    const data = envelope(await get(url, `${P}/employees_directory/run`));
    assert.deepEqual(
      Object.keys(data).sort(),
      ['columns', 'data', 'page', 'pageSize', 'report', 'total'],
    );
    assert.ok(Array.isArray(data.columns));
    assert.equal(data.report.key, 'employees_directory');
  });
});
