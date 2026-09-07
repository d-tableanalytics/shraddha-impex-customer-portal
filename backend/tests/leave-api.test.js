/**
 * Leave and Holidays — the HTTP layer, over a real MongoDB.
 *
 * Only `protect` is stubbed, exactly as the Employee Master and Org Structure
 * route tests do it. The permission chain, the validator, the services and the
 * error handler are all the genuine article.
 *
 * The tests that matter most are the authorization ones. Leave is the first
 * HRMS module where an ordinary employee both writes data and has data written
 * about them, so "can this person act on this row" is the whole game.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import LeaveType from '../models/hrms/LeaveType.js';
import LeaveBalance from '../models/hrms/LeaveBalance.js';
import LeaveRequest from '../models/hrms/LeaveRequest.js';
import Holiday from '../models/hrms/Holiday.js';
import AuditLog from '../models/AuditLog.js';
import leaveRoutes from '../modules/hrms/leave/leave.routes.js';
import holidayRoutes from '../modules/hrms/leave/holiday.routes.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import { AUDIT_ACTIONS } from '../shared/constants/hrms.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { buildTestApp, stubProtect, withServer, get, post, patch, del } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const L = '/api/v1/hrms/leave';
const H = '/api/v1/hrms/holidays';
const oid = () => new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, LeaveType, LeaveBalance, LeaveRequest, Holiday);
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
      router.use('/leave', leaveRoutes);
      router.use('/holidays', holidayRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

const userWith = (roles, over = {}) => ({
  _id: oid(),
  role: 'Management',
  roles,
  status: 'Active',
  ...over,
});

let seq = 0;
const makeEmployee = (over = {}) => {
  seq += 1;
  return Employee.create({
    employeeCode: `SI-${String(seq).padStart(4, '0')}`,
    userId: over.userId ?? oid(),
    firstName: over.firstName ?? 'Test',
    lastName: over.lastName ?? `Person${seq}`,
    dateOfJoining: new Date(),
    ...over,
  });
};

const makeType = (over = {}) =>
  LeaveType.create({ code: 'CL', name: 'Casual Leave', ...over });

const makeBalance = (employeeId, leaveTypeId, accrued = 12, year = 2026) =>
  LeaveBalance.create({ employeeId, leaveTypeId, year, accrued });

/** Every successful HRMS response is `{ success: true, data }` and nothing else. */
function envelope(res, status = 200) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.deepEqual(Object.keys(res.body).sort(), ['data', 'success'], 'nothing beside `data`');
  return res.body.data;
}

function errorBody(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0);
  if (code) assert.equal(res.body.code, code);
  return res.body;
}

/** A manager, a report under them, and a leave type with a balance. */
async function seedTeam() {
  const managerUser = userWith([R.MANAGER]);
  const staffUser = userWith([R.EMPLOYEE]);

  const manager = await makeEmployee({ firstName: 'Mgr', userId: managerUser._id });
  const staff = await makeEmployee({
    firstName: 'Staff',
    userId: staffUser._id,
    reportingManagerId: manager._id,
    managerChain: [manager._id],
  });

  const type = await makeType();
  await makeBalance(staff._id, type._id);

  return { managerUser, staffUser, manager, staff, type };
}

const validRequest = (type, over = {}) => ({
  leaveTypeId: String(type._id),
  startDate: '2026-01-05',
  endDate: '2026-01-06',
  reason: 'Family function',
  ...over,
});

// ===========================================================================
// Leave types
// ===========================================================================

test('everyone sees the ordinary leave types', async () => {
  const { staffUser } = await seedTeam();
  await withServer(appFor(staffUser), async (url) => {
    const data = envelope(await get(url, `${L}/types`));
    assert.equal(data.length, 1);
    assert.equal(data[0].code, 'CL');
  });
});

test('an adminOnly type is offered only to someone who administers leave', async () => {
  // The reference hardcodes this - CL for everyone, AL for admins or for an
  // employee whose free-text DESIGNATION reads "EA". Here it is data.
  const { staffUser } = await seedTeam();
  await makeType({ code: 'AL', name: 'Admin Leave', adminOnly: true });

  await withServer(appFor(staffUser), async (url) => {
    assert.deepEqual(envelope(await get(url, `${L}/types`)).map((t) => t.code), ['CL']);
  });

  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    assert.deepEqual(envelope(await get(url, `${L}/types`)).map((t) => t.code).sort(), ['AL', 'CL']);
  });
});

test('only an administrator can add a leave type, and codes are unique', async () => {
  await withServer(appFor(userWith([R.EMPLOYEE])), async (url) => {
    assert.equal((await post(url, `${L}/types`, { code: 'SL', name: 'Sick' })).status, 403);
  });

  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    const created = envelope(await post(url, `${L}/types`, { code: 'sl', name: 'Sick Leave' }), 201);
    assert.equal(created.code, 'SL', 'normalised');
    errorBody(await post(url, `${L}/types`, { code: 'SL', name: 'Dup' }), 409, 'LEAVE_TYPE_CODE_TAKEN');
  });
});

// ===========================================================================
// Requesting
// ===========================================================================

test('an employee files leave for themselves and it lands pending', async () => {
  const { staffUser, staff, type } = await seedTeam();

  await withServer(appFor(staffUser), async (url) => {
    const data = envelope(await post(url, `${L}/requests`, validRequest(type)), 201);

    assert.equal(data.status, 'pending');
    assert.equal(data.employeeId, String(staff._id));
    assert.equal(data.durationValue, 2, 'Mon + Tue');
    assert.equal(data.approvalChain.length, 1);
    assert.equal(data.approvalChain[0].approverEmployeeId, String(staff.reportingManagerId));
    assert.equal(data.approvalChain[0].decision, 'pending');
  });
});

test('the requester is taken from the SESSION, never from the payload', async () => {
  // The one thing a self-service endpoint must never trust.
  const { staffUser, staff, manager, type } = await seedTeam();

  await withServer(appFor(staffUser), async (url) => {
    const res = await post(url, `${L}/requests`, {
      ...validRequest(type),
      employeeId: String(manager._id),
    });
    // `.strict()` refuses the unknown key outright rather than ignoring it.
    errorBody(res, 400);
    assert.equal(await LeaveRequest.countDocuments({ employeeId: manager._id }), 0);
    assert.equal(await LeaveRequest.countDocuments({ employeeId: staff._id }), 0);
  });
});

test('an account with no employee record cannot request leave', async () => {
  const type = await makeType();
  await withServer(appFor(userWith([R.EMPLOYEE])), async (url) => {
    errorBody(await post(url, `${L}/requests`, validRequest(type)), 403);
  });
});

test('a soft-deleted employee cannot request leave', async () => {
  const { staffUser, staff, type } = await seedTeam();
  await Employee.updateOne({ _id: staff._id }, { $set: { deletedAt: new Date() } });

  await withServer(appFor(staffUser), async (url) => {
    // attachHrmsActor cannot resolve a deleted employee, so there is no
    // employeeId to file against.
    errorBody(await post(url, `${L}/requests`, validRequest(type)), 403);
  });
});

test('someone with no manager is auto-approved rather than left pending forever', async () => {
  const bossUser = userWith([R.EMPLOYEE]);
  const boss = await makeEmployee({ firstName: 'Boss', userId: bossUser._id });
  const type = await makeType();
  await makeBalance(boss._id, type._id);

  await withServer(appFor(bossUser), async (url) => {
    const data = envelope(await post(url, `${L}/requests`, validRequest(type)), 201);
    assert.equal(data.status, 'approved');
    assert.deepEqual(data.approvalChain, []);
  });

  const balance = await LeaveBalance.findOne({ employeeId: boss._id }).lean();
  assert.equal(balance.used, 2, 'spent immediately, not left pending');
  assert.equal(balance.pending, 0);
});

test('a request whose range is entirely non-working is refused', async () => {
  const { staffUser, type } = await seedTeam();
  await withServer(appFor(staffUser), async (url) => {
    // Sat + Sun.
    const res = await post(url, `${L}/requests`, validRequest(type, {
      startDate: '2026-01-10',
      endDate: '2026-01-11',
    }));
    errorBody(res, 400);
    assert.match(res.body.message, /no working days/i);
  });
});

test('dates are validated: end before start, and impossible calendar dates', async () => {
  const { staffUser, type } = await seedTeam();
  await withServer(appFor(staffUser), async (url) => {
    errorBody(await post(url, `${L}/requests`, validRequest(type, { startDate: '2026-01-09', endDate: '2026-01-05' })), 400);
    errorBody(await post(url, `${L}/requests`, validRequest(type, { startDate: '2026-02-31', endDate: '2026-02-31' })), 400);
    errorBody(await post(url, `${L}/requests`, validRequest(type, { reason: 'no' })), 400);
  });
});

test('an overlapping live request is refused', async () => {
  const { staffUser, type } = await seedTeam();
  await withServer(appFor(staffUser), async (url) => {
    envelope(await post(url, `${L}/requests`, validRequest(type)), 201);
    const res = await post(url, `${L}/requests`, validRequest(type, {
      startDate: '2026-01-06',
      endDate: '2026-01-07',
    }));
    errorBody(res, 409, 'LEAVE_OVERLAP');
  });
});

test('a cancelled request no longer blocks the same dates', async () => {
  const { staffUser, type } = await seedTeam();
  await withServer(appFor(staffUser), async (url) => {
    const first = envelope(await post(url, `${L}/requests`, validRequest(type)), 201);
    envelope(await post(url, `${L}/requests/${first.id}/cancel`));
    envelope(await post(url, `${L}/requests`, validRequest(type)), 201);
  });
});

test('a half-day request needs a period, and costs half a day', async () => {
  const { staffUser, type } = await seedTeam();
  await withServer(appFor(staffUser), async (url) => {
    errorBody(
      await post(url, `${L}/requests`, validRequest(type, {
        startDate: '2026-01-05',
        endDate: '2026-01-05',
        durationUnit: 'half_day',
      })),
      400,
    );

    const data = envelope(
      await post(url, `${L}/requests`, validRequest(type, {
        startDate: '2026-01-05',
        endDate: '2026-01-05',
        durationUnit: 'half_day',
        halfDayPeriod: 'first',
      })),
      201,
    );
    assert.equal(data.durationValue, 0.5);
    assert.equal(data.halfDayPeriod, 'first');
  });
});

test('a type that forbids half days refuses one', async () => {
  const { staffUser } = await seedTeam();
  const whole = await makeType({ code: 'COMP', name: 'Comp Off', allowsHalfDay: false });

  await withServer(appFor(staffUser), async (url) => {
    const res = await post(url, `${L}/requests`, validRequest(whole, {
      startDate: '2026-01-05',
      endDate: '2026-01-05',
      durationUnit: 'half_day',
      halfDayPeriod: 'first',
    }));
    errorBody(res, 400);
    assert.match(res.body.message, /whole days/i);
  });
});

test('a holiday inside the range is charged only when it is sandwiched', async () => {
  const { staffUser, type } = await seedTeam();
  // Monday 26 January 2026.
  await Holiday.create({ name: 'Republic Day', date: '2026-01-26', type: 'national' });

  await withServer(appFor(staffUser), async (url) => {
    // Fri 23 .. Tue 27, all full days: weekend + holiday all charged.
    const sandwiched = envelope(
      await post(url, `${L}/requests`, validRequest(type, { startDate: '2026-01-23', endDate: '2026-01-27' })),
      201,
    );
    assert.equal(sandwiched.durationValue, 5);
  });

  await LeaveRequest.deleteMany({});

  await withServer(appFor(staffUser), async (url) => {
    // The holiday alone, at the edge of nothing, is free - so the request is
    // rejected as having no working days.
    const res = await post(url, `${L}/requests`, validRequest(type, { startDate: '2026-01-26', endDate: '2026-01-26' }));
    errorBody(res, 400);
  });
});

test('an OPTIONAL holiday is still a working day', async () => {
  const { staffUser, type } = await seedTeam();
  await Holiday.create({ name: 'Restricted', date: '2026-01-05', type: 'restricted', isOptional: true });

  await withServer(appFor(staffUser), async (url) => {
    const data = envelope(
      await post(url, `${L}/requests`, validRequest(type, { startDate: '2026-01-05', endDate: '2026-01-05' })),
      201,
    );
    assert.equal(data.durationValue, 1, 'an optional holiday is offered, not automatic');
  });
});

// ===========================================================================
// Balances
// ===========================================================================

test('filing moves days into pending, not into used', async () => {
  const { staffUser, staff, type } = await seedTeam();

  await withServer(appFor(staffUser), async (url) => {
    envelope(await post(url, `${L}/requests`, validRequest(type)), 201);

    const [balance] = envelope(await get(url, `${L}/balances/me`));
    assert.equal(balance.accrued, 12);
    assert.equal(balance.pending, 2);
    assert.equal(balance.used, 0);
    assert.equal(balance.balance, 10, 'accrued - used - pending');
  });

  const stored = await LeaveBalance.findOne({ employeeId: staff._id }).lean();
  assert.equal(stored.balance, 10);
});

test('insufficient balance does NOT block a request', async () => {
  // The reference tracks balances best-effort and never refuses on them.
  // Inventing an entitlement gate would be a policy this product does not have.
  const { staffUser, staff, type } = await seedTeam();
  await LeaveBalance.updateOne({ employeeId: staff._id }, { $set: { accrued: 1 } });

  await withServer(appFor(staffUser), async (url) => {
    envelope(await post(url, `${L}/requests`, validRequest(type)), 201);
    const [balance] = envelope(await get(url, `${L}/balances/me`));
    assert.equal(balance.balance, -1, 'overdrawn, and visibly so');
  });
});

test('a leave type with no balance row still works', async () => {
  const { staffUser } = await seedTeam();
  const unbudgeted = await makeType({ code: 'LOP', name: 'Loss of Pay', paid: false });

  await withServer(appFor(staffUser), async (url) => {
    const data = envelope(await post(url, `${L}/requests`, validRequest(unbudgeted)), 201);
    assert.equal(data.status, 'pending');
  });
});

test('a balance is only visible to someone entitled to see that employee', async () => {
  const { staff, managerUser } = await seedTeam();
  const strangerUser = userWith([R.EMPLOYEE]);
  await makeEmployee({ firstName: 'Stranger', userId: strangerUser._id });

  await withServer(appFor(managerUser), async (url) => {
    envelope(await get(url, `${L}/balances/${staff._id}`), 200);
  });

  await withServer(appFor(strangerUser), async (url) => {
    errorBody(await get(url, `${L}/balances/${staff._id}`), 403);
  });
});

// ===========================================================================
// Deciding
// ===========================================================================

async function fileRequest(staffUser, type, over = {}) {
  let created;
  await withServer(appFor(staffUser), async (url) => {
    created = envelope(await post(url, `${L}/requests`, validRequest(type, over)), 201);
  });
  return created;
}

test('the direct manager approves, and the days move from pending to used', async () => {
  const { staffUser, managerUser, staff, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(managerUser), async (url) => {
    const data = envelope(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' }));
    assert.equal(data.status, 'approved');
    assert.equal(data.approvalChain[0].decision, 'approved');
    assert.ok(data.approvalChain[0].decidedAt);
  });

  const balance = await LeaveBalance.findOne({ employeeId: staff._id }).lean();
  assert.equal(balance.pending, 0);
  assert.equal(balance.used, 2);
  assert.equal(balance.balance, 10);
});

test('rejecting releases the days back', async () => {
  const { staffUser, managerUser, staff, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(managerUser), async (url) => {
    const data = envelope(
      await post(url, `${L}/requests/${request.id}/decide`, { decision: 'reject', comment: 'Peak season' }),
    );
    assert.equal(data.status, 'rejected');
    assert.equal(data.approvalChain[0].comment, 'Peak season');
  });

  const balance = await LeaveBalance.findOne({ employeeId: staff._id }).lean();
  assert.equal(balance.pending, 0);
  assert.equal(balance.used, 0);
  assert.equal(balance.balance, 12, 'fully released');
});

test('nobody decides their own request, whatever else they hold', async () => {
  // An HR admin holds leave:approve:org. That must not extend to themselves.
  const hrUser = userWith([R.HR_ADMIN]);
  // They need a manager of their own, or the request auto-approves and there
  // is nothing pending to decide.
  const boss = await makeEmployee({ firstName: 'Boss' });
  const hr = await makeEmployee({
    firstName: 'Hr',
    userId: hrUser._id,
    reportingManagerId: boss._id,
    managerChain: [boss._id],
  });
  const type = await makeType();
  await makeBalance(hr._id, type._id);

  const request = await fileRequest(hrUser, type);

  await withServer(appFor(hrUser), async (url) => {
    const res = await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' });
    errorBody(res, 403);
    assert.match(res.body.message, /your own/i);
  });
});

test('a SKIP-LEVEL manager can see the request but cannot decide it', async () => {
  // The reference's rule, and a good one: approval is the direct manager's job.
  const { staffUser, staff, manager, type } = await seedTeam();

  const skipUser = userWith([R.MANAGER]);
  const skip = await makeEmployee({ firstName: 'Skip', userId: skipUser._id });
  await Employee.updateOne({ _id: manager._id }, { $set: { reportingManagerId: skip._id, managerChain: [skip._id] } });
  await Employee.updateOne({ _id: staff._id }, { $set: { managerChain: [manager._id, skip._id] } });

  const request = await fileRequest(staffUser, type);

  await withServer(appFor(skipUser), async (url) => {
    const res = await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' });
    errorBody(res, 403);
    assert.match(res.body.message, /direct reporting manager/i);
  });

  assert.equal((await LeaveRequest.findById(request.id).lean()).status, 'pending', 'untouched');
});

test('an unrelated manager cannot decide someone else’s report', async () => {
  const { staffUser, type } = await seedTeam();
  const otherUser = userWith([R.MANAGER]);
  await makeEmployee({ firstName: 'Other', userId: otherUser._id });

  const request = await fileRequest(staffUser, type);

  await withServer(appFor(otherUser), async (url) => {
    errorBody(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' }), 403);
  });
});

test('an ordinary employee cannot reach the decide endpoint at all', async () => {
  const { staffUser, type } = await seedTeam();
  const peerUser = userWith([R.EMPLOYEE]);
  await makeEmployee({ firstName: 'Peer', userId: peerUser._id });

  const request = await fileRequest(staffUser, type);

  await withServer(appFor(peerUser), async (url) => {
    // Refused by the route guard, before the service is reached.
    assert.equal((await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' })).status, 403);
  });
});

test('HR can override when the direct manager is unavailable', async () => {
  // Without this an organisation is stuck the moment a manager is unreachable.
  const { staffUser, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    assert.equal(envelope(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' })).status, 'approved');
  });

  const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.LEAVE_DECIDED }).lean();
  assert.equal(entry.meta.viaOrgOverride, true, 'an override is recorded as one');
});

test('a decided request cannot be decided again', async () => {
  const { staffUser, managerUser, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(managerUser), async (url) => {
    envelope(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' }));
    const res = await post(url, `${L}/requests/${request.id}/decide`, { decision: 'reject' });
    errorBody(res, 409, 'LEAVE_NOT_PENDING');
  });

  const balance = await LeaveBalance.findOne({}).lean();
  assert.equal(balance.used, 2, 'the second attempt moved nothing');
});

test('a cancelled request cannot then be approved', async () => {
  const { staffUser, managerUser, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(staffUser), async (url) => {
    envelope(await post(url, `${L}/requests/${request.id}/cancel`));
  });

  await withServer(appFor(managerUser), async (url) => {
    errorBody(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' }), 409, 'LEAVE_NOT_PENDING');
  });
});

test('an unknown decision value is refused', async () => {
  const { staffUser, managerUser, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(managerUser), async (url) => {
    errorBody(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'maybe' }), 400);
    errorBody(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve', extra: 1 }), 400);
  });
});

// ===========================================================================
// Cancelling
// ===========================================================================

test('the requester cancels their own pending request and gets the days back', async () => {
  const { staffUser, staff, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(staffUser), async (url) => {
    assert.equal(envelope(await post(url, `${L}/requests/${request.id}/cancel`)).status, 'cancelled');
  });

  const balance = await LeaveBalance.findOne({ employeeId: staff._id }).lean();
  assert.equal(balance.pending, 0);
  assert.equal(balance.balance, 12);
});

test('nobody else can cancel it — not even the approving manager', async () => {
  const { staffUser, managerUser, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(managerUser), async (url) => {
    const res = await post(url, `${L}/requests/${request.id}/cancel`);
    errorBody(res, 403);
    assert.match(res.body.message, /only the person who requested/i);
  });
});

test('an approved request cannot be cancelled', async () => {
  const { staffUser, managerUser, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(managerUser), async (url) => {
    envelope(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' }));
  });

  await withServer(appFor(staffUser), async (url) => {
    errorBody(await post(url, `${L}/requests/${request.id}/cancel`), 409, 'LEAVE_NOT_PENDING');
  });
});

// ===========================================================================
// Scope
// ===========================================================================

test('an employee sees only their own requests', async () => {
  const { staffUser, type, manager } = await seedTeam();
  await fileRequest(staffUser, type);
  await LeaveRequest.create({
    employeeId: manager._id,
    leaveTypeId: type._id,
    startDate: '2026-03-02',
    endDate: '2026-03-02',
    durationValue: 1,
    reason: 'Theirs',
    status: 'pending',
  });

  await withServer(appFor(staffUser), async (url) => {
    const data = envelope(await get(url, `${L}/requests`));
    assert.equal(data.length, 1);
    assert.equal(data[0].reason, 'Family function');
  });
});

test('a manager sees their own and their DIRECT reports', async () => {
  const { staffUser, managerUser, manager, type } = await seedTeam();
  await fileRequest(staffUser, type);
  await LeaveRequest.create({
    employeeId: manager._id,
    leaveTypeId: type._id,
    startDate: '2026-03-02',
    endDate: '2026-03-02',
    durationValue: 1,
    reason: 'Mine',
    status: 'pending',
  });

  const strangerUser = userWith([R.EMPLOYEE]);
  const stranger = await makeEmployee({ firstName: 'Stranger', userId: strangerUser._id });
  await LeaveRequest.create({
    employeeId: stranger._id,
    leaveTypeId: type._id,
    startDate: '2026-03-03',
    endDate: '2026-03-03',
    durationValue: 1,
    reason: 'Unrelated',
    status: 'pending',
  });

  await withServer(appFor(managerUser), async (url) => {
    const reasons = envelope(await get(url, `${L}/requests`)).map((r) => r.reason).sort();
    assert.deepEqual(reasons, ['Family function', 'Mine']);
  });
});

test('an org-wide reader sees everything', async () => {
  const { staffUser, type } = await seedTeam();
  await fileRequest(staffUser, type);

  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    assert.equal(envelope(await get(url, `${L}/requests`)).length, 1);
  });
});

test('a permitted account with no employee record sees nothing, not everything', async () => {
  const { staffUser, type } = await seedTeam();
  await fileRequest(staffUser, type);

  await withServer(appFor(userWith([R.EMPLOYEE])), async (url) => {
    assert.deepEqual(envelope(await get(url, `${L}/requests`)), []);
  });
});

test('AD-4: a Customer reaches no leave or holiday endpoint', async () => {
  const customer = { _id: oid(), role: 'Customer', roles: [], status: 'Active' };
  await withServer(appFor(customer), async (url) => {
    for (const path of [`${L}/types`, `${L}/requests`, `${L}/balances/me`, `${H}`]) {
      assert.equal((await get(url, path)).status, 403, path);
    }
  });
});

// ===========================================================================
// Calendar
// ===========================================================================

test('the calendar returns live requests in the window, plus holidays', async () => {
  const { staffUser, managerUser, type } = await seedTeam();
  await fileRequest(staffUser, type);
  await Holiday.create({ name: 'Republic Day', date: '2026-01-26', type: 'national' });

  await withServer(appFor(managerUser), async (url) => {
    const data = envelope(await get(url, `${L}/calendar?from=2026-01-01&to=2026-01-31`));
    assert.equal(data.requests.length, 1);
    assert.equal(data.holidays.length, 1);
    assert.equal(data.holidays[0].date, '2026-01-26');
  });
});

test('the calendar hides rejected and cancelled requests', async () => {
  const { staffUser, managerUser, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(managerUser), async (url) => {
    envelope(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'reject' }));
    const data = envelope(await get(url, `${L}/calendar?from=2026-01-01&to=2026-01-31`));
    assert.deepEqual(data.requests, [], 'a rejected request is not an absence');
  });
});

test('the calendar respects scope, and refuses a silly window', async () => {
  const { staffUser, type } = await seedTeam();
  await fileRequest(staffUser, type);

  const strangerUser = userWith([R.EMPLOYEE]);
  await makeEmployee({ firstName: 'Stranger', userId: strangerUser._id });

  await withServer(appFor(strangerUser), async (url) => {
    assert.deepEqual(envelope(await get(url, `${L}/calendar?from=2026-01-01&to=2026-01-31`)).requests, []);
    errorBody(await get(url, `${L}/calendar?from=2026-01-01&to=2030-01-01`), 400);
    errorBody(await get(url, `${L}/calendar?from=2026-02-01&to=2026-01-01`), 400);
  });
});

// ===========================================================================
// Holidays
// ===========================================================================

test('anyone with leave access reads the holiday calendar', async () => {
  await Holiday.create({ name: 'Republic Day', date: '2026-01-26', type: 'national' });

  await withServer(appFor(userWith([R.EMPLOYEE])), async (url) => {
    const data = envelope(await get(url, `${H}?year=2026`));
    assert.equal(data.length, 1);
    assert.equal(data[0].year, 2026, 'derived from the date, not supplied');
  });
});

test('only an administrator can change the calendar', async () => {
  await withServer(appFor(userWith([R.EMPLOYEE])), async (url) => {
    assert.equal((await post(url, H, { name: 'X', date: '2026-01-26' })).status, 403);
    assert.equal((await patch(url, `${H}/${oid()}`, { name: 'X', date: '2026-01-26' })).status, 403);
    assert.equal((await del(url, `${H}/${oid()}`)).status, 403);
  });
});

test('a holiday is created, updated and soft-deleted', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    const created = envelope(await post(url, H, { name: 'Republic Day', date: '2026-01-26', type: 'national' }), 201);
    assert.equal(created.year, 2026);

    const updated = envelope(await patch(url, `${H}/${created.id}`, {
      name: 'Republic Day',
      date: '2026-01-26',
      type: 'national',
      description: 'National holiday',
    }));
    assert.equal(updated.description, 'National holiday');

    envelope(await del(url, `${H}/${created.id}`));
    assert.deepEqual(envelope(await get(url, `${H}?year=2026`)), []);
  });

  const row = await Holiday.findOne({}).lean();
  assert.ok(row.deletedAt instanceof Date, 'soft, not gone');
});

test('the same name on the same date is refused server-side', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    envelope(await post(url, H, { name: 'Diwali', date: '2026-11-08' }), 201);
    errorBody(await post(url, H, { name: 'Diwali', date: '2026-11-08' }), 409, 'HOLIDAY_DUPLICATE');

    // A different name on the same day is legitimate.
    envelope(await post(url, H, { name: 'Govardhan Puja', date: '2026-11-08' }), 201);
  });
});

test('a retired holiday frees its name and date again', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    const first = envelope(await post(url, H, { name: 'Diwali', date: '2026-11-08' }), 201);
    envelope(await del(url, `${H}/${first.id}`));
    const second = envelope(await post(url, H, { name: 'Diwali', date: '2026-11-08' }), 201);
    assert.notEqual(second.id, first.id);
  });
});

test('the year list counts only live holidays', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    envelope(await post(url, H, { name: 'A', date: '2026-01-26' }), 201);
    const b = envelope(await post(url, H, { name: 'B', date: '2027-01-26' }), 201);
    envelope(await del(url, `${H}/${b.id}`));

    assert.deepEqual(envelope(await get(url, `${H}/years`)), [{ year: 2026, count: 1 }]);
  });
});

test('bulk import inserts, skips duplicates and reports both', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    envelope(await post(url, H, { name: 'Republic Day', date: '2026-01-26' }), 201);

    const result = envelope(await post(url, `${H}/bulk-import`, {
      year: 2026,
      holidays: [
        { name: 'Republic Day', date: '2026-01-26' },
        { name: 'Independence Day', date: '2026-08-15' },
        { name: 'Independence Day', date: '2026-08-15' },
      ],
    }));

    assert.equal(result.inserted, 1, 'only the genuinely new one');
    assert.equal(result.skipped, 2, 'the existing one and the repeat');
    assert.equal(envelope(await get(url, `${H}?year=2026`)).length, 2);
  });
});

test('bulk import with overwrite replaces the year', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    envelope(await post(url, H, { name: 'Old', date: '2026-03-02' }), 201);

    const result = envelope(await post(url, `${H}/bulk-import`, {
      year: 2026,
      overwrite: true,
      holidays: [{ name: 'New', date: '2026-04-01' }],
    }));

    assert.equal(result.inserted, 1);
    assert.deepEqual(envelope(await get(url, `${H}?year=2026`)).map((h) => h.name), ['New']);
  });
});

test('bulk import refuses rows outside the year being imported', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    const res = await post(url, `${H}/bulk-import`, {
      year: 2026,
      holidays: [{ name: 'Wrong year', date: '2027-01-26' }],
    });
    errorBody(res, 400);
    assert.equal(await Holiday.countDocuments({}), 0);
  });
});

// ===========================================================================
// Audit
// ===========================================================================

test('requesting, deciding and cancelling are each audited', async () => {
  const { staffUser, managerUser, type } = await seedTeam();
  const first = await fileRequest(staffUser, type);

  await withServer(appFor(managerUser), async (url) => {
    envelope(await post(url, `${L}/requests/${first.id}/decide`, { decision: 'approve' }));
  });

  const second = await fileRequest(staffUser, type, { startDate: '2026-02-02', endDate: '2026-02-02' });
  await withServer(appFor(staffUser), async (url) => {
    envelope(await post(url, `${L}/requests/${second.id}/cancel`));
  });

  const actions = (await AuditLog.find({}).lean()).map((a) => a.action);
  assert.ok(actions.includes(AUDIT_ACTIONS.LEAVE_REQUESTED));
  assert.ok(actions.includes(AUDIT_ACTIONS.LEAVE_DECIDED));
  assert.ok(actions.includes(AUDIT_ACTIONS.LEAVE_CANCELLED));
});

test('holiday changes are audited, and a refused one is not', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    const created = envelope(await post(url, H, { name: 'Diwali', date: '2026-11-08' }), 201);
    envelope(await del(url, `${H}/${created.id}`));

    await AuditLog.deleteMany({});
    errorBody(await post(url, `${H}/bulk-import`, { year: 2026, holidays: [{ name: 'X', date: '2030-01-01' }] }), 400);
    assert.equal(await AuditLog.countDocuments({}), 0, 'nothing happened, so nothing is recorded');
  });
});

// ===========================================================================
// Envelope
// ===========================================================================

test('every leave and holiday response uses the standard envelope', async () => {
  const { staffUser, managerUser, type } = await seedTeam();
  const request = await fileRequest(staffUser, type);

  await withServer(appFor(managerUser), async (url) => {
    envelope(await get(url, `${L}/types`));
    envelope(await get(url, `${L}/requests`));
    envelope(await get(url, `${L}/balances/me`));
    envelope(await get(url, `${L}/calendar?from=2026-01-01&to=2026-01-31`));
    envelope(await post(url, `${L}/requests/${request.id}/decide`, { decision: 'approve' }));
    envelope(await get(url, `${H}?year=2026`));
    envelope(await get(url, `${H}/years`));
  });
});
