/**
 * Employee lifecycle / exits — the HTTP layer, over a real MongoDB.
 *
 * Only `protect` is stubbed, exactly as the Employee Master, Leave and Expenses
 * route tests do it. The permission chain, the validator, the services and the
 * error handler are all the genuine article.
 *
 * The tests that matter most are the state-machine and authorization ones. An
 * exit is the one workflow that changes a person's employment status and pays
 * them money, so "who may move this forward, and from where" is the whole game.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';

// The relieving letter goes through the real storage layer onto a scratch dir.
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_PATH =
  process.env.STORAGE_LOCAL_PATH || (await fs.mkdtemp(path.join(os.tmpdir(), 'hrms-exits-')));

import Employee from '../models/hrms/Employee.js';
import ExitRequest from '../models/hrms/ExitRequest.js';
import LeaveType from '../models/hrms/LeaveType.js';
import LeaveBalance from '../models/hrms/LeaveBalance.js';
import { EmployeeCompensation } from '../models/hrms/PayrollModels.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import exitRoutes from '../modules/hrms/exits/exit.routes.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import { registerFileAccessRule, __resetFileAccessRules } from '../modules/hrms/storage/storage.service.js';
import { resolveLetterAccess } from '../modules/hrms/exits/exit.service.js';
import { __resetStorage } from '../utils/hrms/storage/index.js';
import { AUDIT_ACTIONS, STORAGE_CATEGORIES } from '../shared/constants/hrms.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { buildTestApp, stubProtect, withServer, get, post, patch } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/exits';
const oid = () => new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, ExitRequest, LeaveType, LeaveBalance, EmployeeCompensation);
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  __resetReferenceProviders();
  __resetFileAccessRules();
  __resetStorage();
  registerReferenceProvider('employee', employeeReferenceProvider);
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
  registerFileAccessRule(STORAGE_CATEGORIES.LETTER, {
    resolve: resolveLetterAccess,
    auditAction: AUDIT_ACTIONS.EXIT_LETTER_VIEWED,
  });
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/exits', exitRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;

/** A user row plus the employee linked to it. */
async function makePerson(roles, over = {}) {
  seq += 1;
  const userId = oid();
  await User.create({
    _id: userId,
    name: over.firstName ? `${over.firstName} Person` : `Person ${seq}`,
    email: `person${seq}@example.com`,
    password: 'hashed-not-used',
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    employeeCode: `SI-${String(seq).padStart(4, '0')}`,
    userId,
    firstName: over.firstName ?? 'Test',
    lastName: over.lastName ?? `Person${seq}`,
    dateOfJoining: over.dateOfJoining ?? new Date('2019-01-01'),
    status: over.status ?? 'active',
    ...over,
  });
  return {
    user: { _id: userId, role: 'Management', roles, status: 'Active' },
    employee,
  };
}

/** `YYYY-MM-DD`, `days` from today. */
const dayFromNow = (days) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const envelope = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  return res.body.data;
};

const errorBody = (res, status, code) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  if (code) assert.equal(res.body.code, code);
  return res.body;
};

/**
 * The cast every workflow test needs: a leaver, their manager, HR, IT and
 * finance — the five clearance owners.
 */
async function seedOrg() {
  const hr = await makePerson([R.HR_ADMIN], { firstName: 'Hana' });
  const it = await makePerson([R.IT_ADMIN], { firstName: 'Ivan' });
  const finance = await makePerson([R.PAYROLL_ADMIN], { firstName: 'Fiona' });
  const manager = await makePerson([R.MANAGER], { firstName: 'Mira' });
  const staff = await makePerson([R.EMPLOYEE], {
    firstName: 'Sam',
    reportingManagerId: manager.employee._id,
    managerChain: [manager.employee._id],
  });
  return { hr, it, finance, manager, staff };
}

const validExit = (over = {}) => ({
  reason: 'Moving to another city.',
  reasonCategory: 'resignation',
  requestedLastDay: dayFromNow(30),
  ...over,
});

/**
 * Drive an exit from nothing to `cleared`. Returns the request id.
 *
 * `url` is an HR server, so the exit is filed FOR the leaver by naming them —
 * every request on that server is made as HR.
 */
async function driveToCleared(org, url) {
  const created = envelope(
    await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
    201,
  );

  envelope(await post(url, `${P}/${created.id}/manager-approve`, {}));
  envelope(await post(url, `${P}/${created.id}/hr-approve`, {}));
  const opened = envelope(await post(url, `${P}/${created.id}/open-clearances`, {}));

  // HR can sign off every area.
  for (const clearance of opened.clearances) {
    envelope(
      await patch(url, `${P}/${created.id}/clearances/${clearance.id}`, {
        status: 'completed',
      }),
    );
  }
  return created.id;
}

// ===========================================================================
// Initiating
// ===========================================================================

test('an employee files their own exit without naming themselves', async () => {
  const { staff } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    const created = envelope(await post(url, P, validExit()), 201);

    assert.equal(created.employeeId, String(staff.employee._id));
    assert.equal(created.status, 'initiated');
    assert.equal(created.isOwnExit, true);
    assert.equal(created.clearances.length, 0);
    assert.equal(created.fullAndFinal, null);
  });
});

test('an employee cannot file an exit for somebody else', async () => {
  const { staff, manager } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    errorBody(
      await post(url, P, validExit({ employeeId: String(manager.employee._id) })),
      403,
    );
  });
});

test('HR files an exit on behalf of an employee', async () => {
  const { hr, staff } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(staff.employee._id) })),
      201,
    );
    assert.equal(created.employeeId, String(staff.employee._id));
    assert.equal(created.isOwnExit, false);
  });
});

test('an employee cannot file their own exit as a termination', async () => {
  // The reference's schema accepts any category from anyone and merely hides
  // this one in the picker.
  const { staff } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    errorBody(await post(url, P, validExit({ reasonCategory: 'termination' })), 403);
  });
});

test('HR may record a termination', async () => {
  const { hr, staff } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    const created = envelope(
      await post(
        url,
        P,
        validExit({ employeeId: String(staff.employee._id), reasonCategory: 'termination' }),
      ),
      201,
    );
    assert.equal(created.reasonCategory, 'termination');
  });
});

test('a second live exit for the same employee is refused', async () => {
  const { staff } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    envelope(await post(url, P, validExit()), 201);
    const body = errorBody(await post(url, P, validExit()), 409, 'EXIT_ALREADY_IN_PROGRESS');
    assert.match(body.message, /already has an exit in progress/i);
  });
});

test('two SIMULTANEOUS initiations still leave exactly one live exit', async () => {
  // The application check is a read followed by a write; under concurrency both
  // reads can pass. The partial unique index is what actually holds the line.
  const { staff } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    const results = await Promise.all([
      post(url, P, validExit()),
      post(url, P, validExit()),
      post(url, P, validExit()),
    ]);

    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    assert.equal(created.length, 1, 'exactly one should be created');
    assert.equal(refused.length, 2);
    assert.equal(await ExitRequest.countDocuments({ deletedAt: null }), 1);
  });
});

test('a new exit is allowed once the previous one is cancelled', async () => {
  const { staff } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    const first = envelope(await post(url, P, validExit()), 201);
    envelope(await post(url, `${P}/${first.id}/cancel`, {}));
    envelope(await post(url, P, validExit()), 201);
  });
});

test('an exit cannot be filed for someone who has already left', async () => {
  const { hr } = await seedOrg();
  const gone = await makePerson([R.EMPLOYEE], { firstName: 'Gone', status: 'exited' });

  await withServer(appFor(hr.user), async (url) => {
    errorBody(
      await post(url, P, validExit({ employeeId: String(gone.employee._id) })),
      409,
      'EMPLOYEE_ALREADY_EXITED',
    );
  });
});

test('a backdated last working day is refused', async () => {
  // The reference disables past dates in the picker and accepts them in the API.
  //
  // -2 days, not -1: the bound carries one day of timezone tolerance on
  // purpose, because a viewer west of Greenwich has a "today" that UTC already
  // calls yesterday. -1 is inside that envelope and must be accepted; -2 is
  // genuinely past wherever the caller is standing. See `isNotPastDay`.
  const { staff } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    errorBody(await post(url, P, validExit({ requestedLastDay: dayFromNow(-2) })), 400);
  });
});

test('an impossible calendar date is a 400, not a 500', async () => {
  const { staff } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    errorBody(await post(url, P, validExit({ requestedLastDay: '2027-02-31' })), 400);
  });
});

test('a reason is required and bounded', async () => {
  const { staff } = await seedOrg();

  await withServer(appFor(staff.user), async (url) => {
    errorBody(await post(url, P, validExit({ reason: '' })), 400);
    errorBody(await post(url, P, validExit({ reason: 'x'.repeat(2001) })), 400);
  });
});

// ===========================================================================
// The state machine
// ===========================================================================

test('the full happy path walks initiated -> closed', async () => {
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id, { elDays: 4 });

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);

    let row = envelope(await get(url, `${P}/${id}`));
    assert.equal(row.status, 'cleared');

    row = envelope(await post(url, `${P}/${id}/fnf`, {}), 201);
    assert.equal(row.status, 'f_and_f_pending');
    assert.ok(row.fullAndFinal, 'a settlement should exist');

    row = envelope(await post(url, `${P}/${id}/fnf/disburse`, {}));
    assert.equal(row.status, 'closed');
    assert.ok(row.closedAt);

    // The one lifecycle transition the exit workflow owns.
    const employee = await Employee.findById(org.staff.employee._id).lean();
    assert.equal(employee.status, 'exited');
  });
});

test('HR approval moves the EMPLOYEE onto notice', async () => {
  // The reference has a `notice` employee status and an `in_notice` exit status
  // and never connects the two.
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    envelope(await post(url, `${P}/${created.id}/manager-approve`, {}));

    let employee = await Employee.findById(org.staff.employee._id).lean();
    assert.equal(employee.status, 'active', 'still active before HR approves');

    envelope(await post(url, `${P}/${created.id}/hr-approve`, {}));

    employee = await Employee.findById(org.staff.employee._id).lean();
    assert.equal(employee.status, 'notice');
    assert.ok(employee.noticeStartDate);
  });
});

test('cancelling an approved exit puts the employee back to active', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    envelope(await post(url, `${P}/${created.id}/manager-approve`, {}));
    envelope(await post(url, `${P}/${created.id}/hr-approve`, {}));
    envelope(await post(url, `${P}/${created.id}/cancel`, {}));

    const employee = await Employee.findById(org.staff.employee._id).lean();
    assert.equal(employee.status, 'active');
    assert.equal(employee.noticeStartDate, null);
  });
});

test('every transition refuses to run out of order', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );

    // HR approval before the manager has approved.
    errorBody(await post(url, `${P}/${created.id}/hr-approve`, {}), 409, 'EXIT_BAD_STATE');
    // Clearances before the notice period.
    errorBody(
      await post(url, `${P}/${created.id}/open-clearances`, {}),
      409,
      'EXIT_BAD_STATE',
    );
    // A settlement before anything is cleared.
    errorBody(await post(url, `${P}/${created.id}/fnf`, {}), 409, 'EXIT_BAD_STATE');
    // Disbursing before a settlement exists.
    errorBody(await post(url, `${P}/${created.id}/fnf/disburse`, {}), 409, 'EXIT_BAD_STATE');
    // A letter before the exit is closed.
    errorBody(
      await post(url, `${P}/${created.id}/relieving-letter`, {}),
      409,
      'EXIT_BAD_STATE',
    );
  });
});

test('HR approval CANNOT be skipped by opening clearances early', async () => {
  // The reference's openClearances accepts `manager_approved` as well as
  // `in_notice`, so its own happy path walks past the gate it just defined.
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    envelope(await post(url, `${P}/${created.id}/manager-approve`, {}));

    const row = envelope(await get(url, `${P}/${created.id}`));
    assert.equal(row.status, 'manager_approved');

    errorBody(
      await post(url, `${P}/${created.id}/open-clearances`, {}),
      409,
      'EXIT_BAD_STATE',
    );
  });
});

test('clearances cannot be opened twice', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    envelope(await post(url, `${P}/${created.id}/manager-approve`, {}));
    envelope(await post(url, `${P}/${created.id}/hr-approve`, {}));
    envelope(await post(url, `${P}/${created.id}/open-clearances`, {}));

    // The status guard fires first — the request is `clearance_pending` by now,
    // not `in_notice`. The "already open" check behind it is defence in depth
    // against an inconsistent row, not the path a second click takes.
    errorBody(
      await post(url, `${P}/${created.id}/open-clearances`, {}),
      409,
      'EXIT_BAD_STATE',
    );
  });
});

// ===========================================================================
// Authorization
// ===========================================================================

test('NOBODY approves their own exit, however senior', async () => {
  const { hr } = await seedOrg();

  await withServer(appFor(hr.user), async (url) => {
    // HR files their own exit — they hold every grant the action needs.
    const created = envelope(await post(url, P, validExit()), 201);
    const body = errorBody(await post(url, `${P}/${created.id}/manager-approve`, {}), 403);
    assert.match(body.message, /your own exit/i);

    // And cannot HR-approve it either.
    await ExitRequest.updateOne({ _id: created.id }, { $set: { status: 'manager_approved' } });
    errorBody(await post(url, `${P}/${created.id}/hr-approve`, {}), 403);
  });
});

test('only the leaver’s own manager may manager-approve', async () => {
  const org = await seedOrg();
  const stranger = await makePerson([R.MANAGER], { firstName: 'Stranger' });

  await withServer(appFor(org.staff.user), async (url) => {
    envelope(await post(url, P, validExit()), 201);
  });
  const created = await ExitRequest.findOne({ employeeId: org.staff.employee._id }).lean();

  // A manager of somebody else cannot even see it, let alone approve it.
  await withServer(appFor(stranger.user), async (url) => {
    errorBody(await post(url, `${P}/${created._id}/manager-approve`, {}), 404);
  });

  await withServer(appFor(org.manager.user), async (url) => {
    envelope(await post(url, `${P}/${created._id}/manager-approve`, {}));
  });
});

test('a manager can OPEN every exit their list shows them', async () => {
  // The reference's assertCanView carries `// TODO: manager scope check`, so it
  // lists a manager's team and then 403s when they open one of those rows.
  const org = await seedOrg();

  await withServer(appFor(org.staff.user), async (url) => {
    envelope(await post(url, P, validExit()), 201);
  });

  await withServer(appFor(org.manager.user), async (url) => {
    const page = envelope(await get(url, P));
    assert.ok(page.data.length >= 1, 'the manager should see their report’s exit');

    for (const row of page.data) {
      const one = envelope(await get(url, `${P}/${row.id}`));
      assert.equal(one.id, row.id);
    }
  });
});

test('an employee sees only their own exit', async () => {
  const org = await seedOrg();
  const other = await makePerson([R.EMPLOYEE], { firstName: 'Other' });

  await withServer(appFor(org.staff.user), async (url) => {
    envelope(await post(url, P, validExit()), 201);
  });

  await withServer(appFor(other.user), async (url) => {
    const page = envelope(await get(url, P));
    assert.equal(page.data.length, 0);
    assert.equal(envelope(await get(url, `${P}/me`)), null);
  });

  await withServer(appFor(org.staff.user), async (url) => {
    const mine = envelope(await get(url, `${P}/me`));
    assert.equal(mine.employeeId, String(org.staff.employee._id));
  });
});

test('a stranger cannot read another exit by id', async () => {
  const org = await seedOrg();
  const other = await makePerson([R.EMPLOYEE], { firstName: 'Nosy' });

  await withServer(appFor(org.staff.user), async (url) => {
    envelope(await post(url, P, validExit()), 201);
  });
  const created = await ExitRequest.findOne({ employeeId: org.staff.employee._id }).lean();

  await withServer(appFor(other.user), async (url) => {
    // 404 rather than 403: existence is not confirmed to someone with no claim.
    errorBody(await get(url, `${P}/${created._id}`), 404);
  });
});

test('an employee cannot HR-approve, open clearances, or touch the settlement', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.staff.user), async (url) => {
    const created = envelope(await post(url, P, validExit()), 201);

    errorBody(await post(url, `${P}/${created.id}/hr-approve`, {}), 403);
    errorBody(await post(url, `${P}/${created.id}/open-clearances`, {}), 403);
    errorBody(await post(url, `${P}/${created.id}/fnf`, {}), 403);
    errorBody(await get(url, `${P}/${created.id}/fnf/preview`), 403);
    errorBody(await patch(url, `${P}/${created.id}`, { transferNotes: 'x' }), 403);
  });
});

test('an employee may cancel their own exit but not once it is cleared', async () => {
  const org = await seedOrg();
  let id;

  await withServer(appFor(org.hr.user), async (url) => {
    id = await driveToCleared(org, url);
  });

  await withServer(appFor(org.staff.user), async (url) => {
    const body = errorBody(await post(url, `${P}/${id}/cancel`, {}), 403);
    assert.match(body.message, /ask HR/i);
  });

  // HR still can.
  await withServer(appFor(org.hr.user), async (url) => {
    const row = envelope(await post(url, `${P}/${id}/cancel`, {}));
    assert.equal(row.status, 'cancelled');
  });
});

test('a closed exit can no longer be cancelled or edited', async () => {
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);
    envelope(await post(url, `${P}/${id}/fnf`, {}), 201);
    envelope(await post(url, `${P}/${id}/fnf/disburse`, {}));

    errorBody(await post(url, `${P}/${id}/cancel`, {}), 409, 'EXIT_TERMINAL');
    // The reference has no status guard here, so it rewrites the last day on a
    // closed exit after the letter has already stated it.
    errorBody(
      await patch(url, `${P}/${id}`, { actualLastDay: dayFromNow(90) }),
      409,
      'EXIT_TERMINAL',
    );
  });
});

// ===========================================================================
// Clearances
// ===========================================================================

test('opening clearances creates the five areas, assigned to their owners', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    envelope(await post(url, `${P}/${created.id}/manager-approve`, {}));
    envelope(await post(url, `${P}/${created.id}/hr-approve`, {}));
    const opened = envelope(await post(url, `${P}/${created.id}/open-clearances`, {}));

    assert.equal(opened.status, 'clearance_pending');
    assert.deepEqual(
      opened.clearances.map((c) => c.area).sort(),
      ['admin', 'finance', 'hr', 'it', 'manager'],
    );
    assert.ok(opened.clearances.every((c) => c.status === 'pending'));

    const byArea = Object.fromEntries(opened.clearances.map((c) => [c.area, c]));
    assert.equal(byArea.it.assigneeEmployeeId, String(org.it.employee._id));
    // The reference assigns finance to the HR admin with the comment "fallback
    // until payroll admin resolver"; a payroll admin exists here.
    assert.equal(byArea.finance.assigneeEmployeeId, String(org.finance.employee._id));
    assert.equal(byArea.manager.assigneeEmployeeId, String(org.manager.employee._id));
    assert.equal(byArea.hr.assigneeEmployeeId, String(org.hr.employee._id));
  });
});

test('the assignee can work their own clearance, and a stranger cannot', async () => {
  const org = await seedOrg();
  const stranger = await makePerson([R.EMPLOYEE], { firstName: 'Nobody' });
  let id;
  let itClearance;

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    id = created.id;
    envelope(await post(url, `${P}/${id}/manager-approve`, {}));
    envelope(await post(url, `${P}/${id}/hr-approve`, {}));
    const opened = envelope(await post(url, `${P}/${id}/open-clearances`, {}));
    itClearance = opened.clearances.find((c) => c.area === 'it');
  });

  await withServer(appFor(stranger.user), async (url) => {
    errorBody(await patch(url, `${P}/${id}/clearances/${itClearance.id}`, {
      status: 'completed',
    }), 404);
  });

  await withServer(appFor(org.it.user), async (url) => {
    const row = envelope(
      await patch(url, `${P}/${id}/clearances/${itClearance.id}`, {
        status: 'completed',
        notes: 'Laptop and access card returned.',
      }),
    );
    const updated = row.clearances.find((c) => c.area === 'it');
    assert.equal(updated.status, 'completed');
    assert.ok(updated.completedAt);
    assert.equal(updated.notes, 'Laptop and access card returned.');
    assert.equal(row.status, 'clearance_pending', 'four areas still outstanding');
  });
});

test('the leaver cannot sign off a clearance on their own exit', async () => {
  // The IT admin owns the `it` clearance on every exit — including their own
  // asset return. Being the area owner is exactly what would otherwise let a
  // leaver clear themselves.
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.it.employee._id) })),
      201,
    );
    await ExitRequest.updateOne(
      { _id: created.id },
      { $set: { status: 'manager_approved' } },
    );
    envelope(await post(url, `${P}/${created.id}/hr-approve`, {}));
    const opened = envelope(await post(url, `${P}/${created.id}/open-clearances`, {}));

    const ownArea = opened.clearances.find(
      (c) => c.assigneeEmployeeId === String(org.it.employee._id),
    );
    assert.ok(ownArea, 'the departing IT admin owns their own IT clearance');

    await withServer(appFor(org.it.user), async (itUrl) => {
      const body = errorBody(
        await patch(itUrl, `${P}/${created.id}/clearances/${ownArea.id}`, {
          status: 'completed',
        }),
        403,
      );
      assert.match(body.message, /your own exit/i);
    });

    // Somebody else can still sign it off.
    envelope(
      await patch(url, `${P}/${created.id}/clearances/${ownArea.id}`, { status: 'completed' }),
    );
  });
});

test('the request auto-advances to cleared when the last clearance lands', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    envelope(await post(url, `${P}/${created.id}/manager-approve`, {}));
    envelope(await post(url, `${P}/${created.id}/hr-approve`, {}));
    const opened = envelope(await post(url, `${P}/${created.id}/open-clearances`, {}));

    let row;
    for (const [index, clearance] of opened.clearances.entries()) {
      // A mix of completed and waived — both count as finished.
      row = envelope(
        await patch(url, `${P}/${created.id}/clearances/${clearance.id}`, {
          status: index % 2 === 0 ? 'completed' : 'waived',
        }),
      );
      const expected = index === opened.clearances.length - 1 ? 'cleared' : 'clearance_pending';
      assert.equal(row.status, expected, `after ${index + 1} clearances`);
    }
  });
});

test('marking a clearance back to in_progress clears its completion stamp', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    envelope(await post(url, `${P}/${created.id}/manager-approve`, {}));
    envelope(await post(url, `${P}/${created.id}/hr-approve`, {}));
    const opened = envelope(await post(url, `${P}/${created.id}/open-clearances`, {}));
    const target = opened.clearances[0];

    let row = envelope(
      await patch(url, `${P}/${created.id}/clearances/${target.id}`, { status: 'completed' }),
    );
    assert.ok(row.clearances.find((c) => c.id === target.id).completedAt);

    row = envelope(
      await patch(url, `${P}/${created.id}/clearances/${target.id}`, { status: 'in_progress' }),
    );
    assert.equal(row.clearances.find((c) => c.id === target.id).completedAt, null);
  });
});

// ===========================================================================
// Handover — the architecture boundary
// ===========================================================================

test('HR records the replacement and transfer notes', async () => {
  const org = await seedOrg();
  const successor = await makePerson([R.EMPLOYEE], { firstName: 'Successor' });

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );

    const row = envelope(
      await patch(url, `${P}/${created.id}`, {
        replacementEmployeeId: String(successor.employee._id),
        transferNotes: 'Handing over the Indore accounts and the vendor list.',
        actualLastDay: dayFromNow(45),
      }),
    );

    assert.equal(row.replacementEmployeeId, String(successor.employee._id));
    assert.equal(row.replacementEmployeeName, `Successor ${successor.employee.lastName}`);
    assert.match(row.transferNotes, /Indore accounts/);
    assert.equal(row.actualLastDay, dayFromNow(45));
  });
});

test('the leaver cannot be their own replacement', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    errorBody(
      await patch(url, `${P}/${created.id}`, {
        replacementEmployeeId: String(org.staff.employee._id),
      }),
      400,
    );
  });
});

test('an unknown replacement is refused', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    errorBody(
      await patch(url, `${P}/${created.id}`, { replacementEmployeeId: String(oid()) }),
      400,
    );
  });
});

// ===========================================================================
// Full and final
// ===========================================================================

/** Give the leaver a CTC and a leave balance so a settlement can be computed. */
async function seedCompensation(employeeId, { ctc = '1200000.00', elDays = 0 } = {}) {
  await EmployeeCompensation.create({
    employeeId,
    payGroupId: oid(),
    structureId: oid(),
    ctc: mongoose.Types.Decimal128.fromString(ctc),
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
  });

  if (elDays > 0) {
    const type = await LeaveType.create({
      code: 'EL',
      name: 'Earned Leave',
      annualQuota: 18,
    });
    await LeaveBalance.create({
      employeeId,
      leaveTypeId: type._id,
      year: Number(new Date().toISOString().slice(0, 4)),
      balance: elDays,
    });
  }
}

test('the settlement preview READS ONLY — nothing is written', async () => {
  // The reference's preview shares compute() with create(), and compute()
  // zeroes loan balances. Its own drawer fires that GET automatically.
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id, { elDays: 5 });

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);

    const before = await ExitRequest.findById(id).lean();
    const compBefore = await EmployeeCompensation.find({
      employeeId: org.staff.employee._id,
    }).lean();
    const balanceBefore = await LeaveBalance.find({
      employeeId: org.staff.employee._id,
    }).lean();

    const preview = envelope(await get(url, `${P}/${id}/fnf/preview`));
    assert.ok(Number(preview.gross) > 0);

    const after = await ExitRequest.findById(id).lean();
    assert.equal(after.status, before.status, 'preview must not advance the state');
    assert.equal(after.fullAndFinal, null, 'preview must not persist a settlement');
    assert.deepEqual(
      (await EmployeeCompensation.find({ employeeId: org.staff.employee._id }).lean()).map(
        (r) => String(r.ctc),
      ),
      compBefore.map((r) => String(r.ctc)),
    );
    assert.deepEqual(
      (await LeaveBalance.find({ employeeId: org.staff.employee._id }).lean()).map(
        (r) => r.balance,
      ),
      balanceBefore.map((r) => r.balance),
    );
  });
});

test('settlement money is exact, and every figure carries two decimal places', async () => {
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id, { ctc: '1200000.00', elDays: 5 });

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);
    const row = envelope(await post(url, `${P}/${id}/fnf`, {}), 201);
    const fnf = row.fullAndFinal;

    for (const value of [fnf.gross, fnf.deductions, fnf.netPayable]) {
      assert.match(value, /^-?\d+\.\d{2}$/, `${value} should be a 2dp decimal string`);
    }
    for (const line of [...fnf.earnings, ...fnf.deductionLines]) {
      assert.match(line.amount, /^-?\d+\.\d{2}$/);
    }

    // net = gross - deductions, exactly.
    const paise = (v) => Math.round(Number(v) * 100);
    assert.equal(paise(fnf.netPayable), paise(fnf.gross) - paise(fnf.deductions));

    // Stored as Decimal128, never as a float.
    const stored = await ExitRequest.findById(id).lean();
    assert.equal(stored.fullAndFinal.netPayable.constructor.name, 'Decimal128');
  });
});

test('a long-serving employee is paid gratuity on COMPLETED years', async () => {
  // The reference's comment says "completed years" and its code multiplies by
  // the raw fraction.
  const org = await seedOrg();
  const veteran = await makePerson([R.EMPLOYEE], {
    firstName: 'Vet',
    dateOfJoining: new Date('2012-01-01'),
    reportingManagerId: org.manager.employee._id,
    managerChain: [org.manager.employee._id],
  });
  await seedCompensation(veteran.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(veteran.employee._id) })),
      201,
    );
    await ExitRequest.updateOne({ _id: created.id }, { $set: { status: 'cleared' } });

    const preview = envelope(await get(url, `${P}/${created.id}/fnf/preview`));
    const gratuity = preview.earnings.find((l) => l.code === 'GRATUITY');
    assert.ok(gratuity, 'a 13-year tenure should attract gratuity');
    assert.match(gratuity.label, /completed years/);
  });
});

test('an employee under five years gets no gratuity line', async () => {
  const org = await seedOrg();
  const recent = await makePerson([R.EMPLOYEE], {
    firstName: 'New',
    dateOfJoining: new Date(Date.now() - 2 * 365 * 86400000),
  });
  await seedCompensation(recent.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(recent.employee._id) })),
      201,
    );
    await ExitRequest.updateOne({ _id: created.id }, { $set: { status: 'cleared' } });

    const preview = envelope(await get(url, `${P}/${created.id}/fnf/preview`));
    assert.equal(preview.earnings.find((l) => l.code === 'GRATUITY'), undefined);
  });
});

test('an employee with no compensation record cannot be settled', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);

    const preview = envelope(await get(url, `${P}/${id}/fnf/preview`));
    assert.equal(preview.computable, false);
    assert.match(preview.notes[0], /no active compensation/i);

    errorBody(await post(url, `${P}/${id}/fnf`, {}), 400);
  });
});

test('a settlement cannot be computed or disbursed twice', async () => {
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);
    envelope(await post(url, `${P}/${id}/fnf`, {}), 201);
    errorBody(await post(url, `${P}/${id}/fnf`, {}), 409, 'EXIT_BAD_STATE');

    envelope(await post(url, `${P}/${id}/fnf/disburse`, {}));
    errorBody(await post(url, `${P}/${id}/fnf/disburse`, {}), 409, 'EXIT_BAD_STATE');
  });
});

test('the notice shortfall uses the employee’s OWN notice term', async () => {
  // The reference hardcodes `const noticeDue = 30; // TODO`.
  const org = await seedOrg();
  const longNotice = await makePerson([R.EMPLOYEE], {
    firstName: 'Long',
    noticeMonths: 3,
  });
  await seedCompensation(longNotice.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(
        url,
        P,
        validExit({ employeeId: String(longNotice.employee._id), requestedLastDay: dayFromNow(30) }),
      ),
      201,
    );
    await ExitRequest.updateOne({ _id: created.id }, { $set: { status: 'cleared' } });

    const preview = envelope(await get(url, `${P}/${created.id}/fnf/preview`));
    const shortfall = preview.deductionLines.find((l) => l.code === 'NOTICE_SHORTFALL');
    assert.ok(shortfall, 'serving 30 of 90 days is a shortfall');
    assert.match(shortfall.label, /of 90 days/);
  });
});

test('serving the full notice attracts no shortfall', async () => {
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(
        url,
        P,
        validExit({ employeeId: String(org.staff.employee._id), requestedLastDay: dayFromNow(60) }),
      ),
      201,
    );
    await ExitRequest.updateOne({ _id: created.id }, { $set: { status: 'cleared' } });

    const preview = envelope(await get(url, `${P}/${created.id}/fnf/preview`));
    assert.equal(
      preview.deductionLines.find((l) => l.code === 'NOTICE_SHORTFALL'),
      undefined,
    );
  });
});

// ===========================================================================
// Relieving letter
// ===========================================================================

test('a relieving letter is stored, not echoed, and read through a short-lived URL', async () => {
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);
    envelope(await post(url, `${P}/${id}/fnf`, {}), 201);
    envelope(await post(url, `${P}/${id}/fnf/disburse`, {}));

    const row = envelope(await post(url, `${P}/${id}/relieving-letter`, {}), 201);
    assert.ok(row.relievingLetter?.generatedAt);
    // The storage key never reaches a browser.
    assert.equal(row.relievingLetter.storageKey, undefined);
    assert.ok(!JSON.stringify(row).includes('letter/'), 'no storage path in the payload');

    const link = envelope(await get(url, `${P}/${id}/relieving-letter/url`));
    assert.ok(link.url, 'a URL should be issued');
    assert.ok(link.expiresInSeconds > 0, 'and it should expire');

    // Generated once only.
    errorBody(await post(url, `${P}/${id}/relieving-letter`, {}), 409, 'EXIT_LETTER_EXISTS');
  });
});

test('the generated letter really is a PDF, and names the right person', async () => {
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);
    envelope(await post(url, `${P}/${id}/fnf`, {}), 201);
    envelope(await post(url, `${P}/${id}/fnf/disburse`, {}));
    envelope(await post(url, `${P}/${id}/relieving-letter`, {}), 201);

    const stored = await ExitRequest.findById(id).lean();
    const { getObjectStream } = await import('../utils/hrms/storage/index.js');
    const stream = await getObjectStream(stored.relievingLetter.storageKey);

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);

    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'a real PDF header');
    assert.ok(bytes.includes(Buffer.from('%%EOF')), 'and a trailer');
    const text = bytes.toString('latin1');
    assert.ok(text.includes('RELIEVING'), 'the letter title');
    assert.ok(text.includes(org.staff.employee.firstName), 'the leaver’s name');
  });
});

test('the leaver can read their own letter; a stranger cannot', async () => {
  const org = await seedOrg();
  const stranger = await makePerson([R.EMPLOYEE], { firstName: 'Nosy' });
  await seedCompensation(org.staff.employee._id);
  let id;

  await withServer(appFor(org.hr.user), async (url) => {
    id = await driveToCleared(org, url);
    envelope(await post(url, `${P}/${id}/fnf`, {}), 201);
    envelope(await post(url, `${P}/${id}/fnf/disburse`, {}));
    envelope(await post(url, `${P}/${id}/relieving-letter`, {}), 201);
  });

  await withServer(appFor(org.staff.user), async (url) => {
    const link = envelope(await get(url, `${P}/${id}/relieving-letter/url`));
    assert.ok(link.url);
  });

  await withServer(appFor(stranger.user), async (url) => {
    errorBody(await get(url, `${P}/${id}/relieving-letter/url`), 404);
  });
});

test('asking for a letter that was never generated is a 404', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    errorBody(await get(url, `${P}/${created.id}/relieving-letter/url`), 404);
  });
});

// ===========================================================================
// Audit
// ===========================================================================

test('every transition is audited, and a refused one is not', async () => {
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);
    envelope(await post(url, `${P}/${id}/fnf`, {}), 201);
    envelope(await post(url, `${P}/${id}/fnf/disburse`, {}));

    const actions = (await AuditLog.find({}).lean()).map((row) => row.action);
    for (const expected of [
      AUDIT_ACTIONS.EXIT_INITIATED,
      AUDIT_ACTIONS.EXIT_MANAGER_APPROVED,
      AUDIT_ACTIONS.EXIT_HR_APPROVED,
      AUDIT_ACTIONS.EXIT_CLEARANCES_OPENED,
      AUDIT_ACTIONS.EXIT_CLEARANCE_UPDATED,
      AUDIT_ACTIONS.EXIT_FNF_CREATED,
      AUDIT_ACTIONS.EXIT_FNF_DISBURSED,
    ]) {
      assert.ok(actions.includes(expected), `${expected} should be audited`);
    }
  });
});

test('a refused transition writes no audit entry', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.staff.user), async (url) => {
    const created = envelope(await post(url, P, validExit()), 201);
    await AuditLog.deleteMany({});

    errorBody(await post(url, `${P}/${created.id}/hr-approve`, {}), 403);
    assert.equal(await AuditLog.countDocuments({}), 0);
  });
});

test('no reason text or settlement figure leaks into an audit description', async () => {
  const org = await seedOrg();
  const secret = 'CONFIDENTIAL-GRIEVANCE-DETAIL';

  await withServer(appFor(org.staff.user), async (url) => {
    envelope(await post(url, P, validExit({ reason: secret })), 201);
  });

  const entries = await AuditLog.find({}).lean();
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(!JSON.stringify(entry).includes(secret), 'the reason must not be logged');
  }
});

// ===========================================================================
// Envelope and shape
// ===========================================================================

test('every exit response uses the standard envelope', async () => {
  const org = await seedOrg();
  await seedCompensation(org.staff.employee._id);

  await withServer(appFor(org.hr.user), async (url) => {
    const id = await driveToCleared(org, url);

    for (const res of [
      await get(url, P),
      await get(url, `${P}/me`),
      await get(url, `${P}/${id}`),
      await get(url, `${P}/${id}/fnf/preview`),
      await patch(url, `${P}/${id}`, { transferNotes: 'ok' }),
      await post(url, `${P}/${id}/fnf`, {}),
    ]) {
      assert.equal(res.body.success, true, JSON.stringify(res.body));
      assert.ok('data' in res.body, 'the payload must sit under `data`');
    }
  });
});

test('the exit list returns the whole page object under `data`', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    envelope(await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })), 201);

    const page = envelope(await get(url, P));
    assert.ok(Array.isArray(page.data));
    assert.equal(typeof page.total, 'number');
    assert.equal(page.page, 1);
    assert.equal(typeof page.pageSize, 'number');
  });
});

test('the list filters by status and hides terminal rows on request', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    envelope(await post(url, `${P}/${created.id}/cancel`, {}));

    assert.equal(envelope(await get(url, `${P}?status=cancelled`)).total, 1);
    assert.equal(envelope(await get(url, `${P}?status=initiated`)).total, 0);
    assert.equal(envelope(await get(url, `${P}?activeOnly=true`)).total, 0);
  });
});

test('a soft-deleted employee’s exit is still readable by HR', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.hr.user), async (url) => {
    const created = envelope(
      await post(url, P, validExit({ employeeId: String(org.staff.employee._id) })),
      201,
    );
    await Employee.updateOne(
      { _id: org.staff.employee._id },
      { $set: { deletedAt: new Date() } },
    );

    // The name is snapshotted, so the row still reads correctly.
    const row = envelope(await get(url, `${P}/${created.id}`));
    assert.match(row.employeeName, /Sam/);
  });
});

test('AD-4: a Customer reaches no exit endpoint', async () => {
  const customer = {
    _id: oid(),
    role: 'Customer',
    roles: [],
    status: 'Active',
  };

  await withServer(appFor(customer), async (url) => {
    for (const res of [await get(url, P), await get(url, `${P}/me`), await post(url, P, validExit())]) {
      assert.ok(res.status === 403 || res.status === 401, `got ${res.status}`);
    }
  });
});
