/**
 * Employee Master ↔ Org Structure integration (step 4).
 *
 * Real Express over real MongoDB, with only `protect` stubbed. The frontend
 * tests mock the API, so these are the only ones that prove the SERVER resolves
 * reference names and applies the reference filters.
 *
 * The two questions worth asking of this seam:
 *   - does a name come back resolved, so the browser never has to supply one
 *   - does a reference that no longer exists behave differently for DISPLAY
 *     than it does for VALIDATION
 *
 * The second is the whole design: a retired department still renders on the
 * profile of an employee assigned to it, and can never be assigned to anyone
 * new.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import Department from '../models/hrms/Department.js';
import Location from '../models/hrms/Location.js';
import User from '../models/User.js';
import employeeRoutes from '../modules/hrms/employees/employee.routes.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import {
  departmentReferenceProvider,
  locationReferenceProvider,
} from '../modules/hrms/org/org.provider.js';
import { employeeReferenceProvider, employeePersistencePort } from '../modules/hrms/employees/employee.provider.js';
import * as departments from '../modules/hrms/org/department.service.js';
import * as locations from '../modules/hrms/org/location.service.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { buildTestApp, stubProtect, withServer, get, post, patch } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/employees';
const oid = () => new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, Department, Location);
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
      router.use('/employees', employeeRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

const HR_ADMIN = { _id: oid(), role: 'Management', roles: [R.HR_ADMIN], status: 'Active' };

let seq = 0;
async function makeEmployee(over = {}) {
  seq += 1;
  // `userId` is pulled out rather than spread over: the User row is created
  // with this id, and an override arriving through `...rest` would silently
  // decouple the two.
  const { userId: given, ...rest } = over;
  const userId = given ?? oid();

  await User.create({
    _id: userId,
    email: `person${seq}@shraddha.test`,
    password: 'x'.repeat(20),
    user: `Person ${seq}`,
    role: 'Management',
    roles: [R.EMPLOYEE],
    status: 'Active',
  });

  return Employee.create({
    employeeCode: `SI-${String(seq).padStart(4, '0')}`,
    firstName: 'Test',
    lastName: `Person${seq}`,
    dateOfJoining: new Date(),
    ...rest,
    userId,
  });
}

const envelopeData = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.deepEqual(Object.keys(res.body).sort(), ['data', 'success']);
  return res.body.data;
};

// ---------------------------------------------------------------------------
// Names are resolved by the server
// ---------------------------------------------------------------------------

test('the employee DTO carries department and location NAMES, not just ids', async () => {
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  const blr = await locations.createLocation({ code: 'BLR', name: 'Bangalore' });
  const emp = await makeEmployee({ departmentId: eng.id, locationId: blr.id });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const data = envelopeData(await get(url, `${P}/${emp._id}`));

    assert.equal(data.departmentId, eng.id);
    assert.equal(data.departmentName, 'Engineering');
    assert.equal(data.locationId, blr.id);
    assert.equal(data.locationName, 'Bangalore');
  });
});

test('an unassigned employee gets nulls, not missing keys', async () => {
  const emp = await makeEmployee();

  await withServer(appFor(HR_ADMIN), async (url) => {
    const data = envelopeData(await get(url, `${P}/${emp._id}`));
    assert.equal(data.departmentName, null);
    assert.equal(data.locationName, null);
    assert.ok('departmentName' in data, 'a stable shape, so the UI need not guess');
    assert.ok('locationName' in data);
  });
});

test('a RETIRED department still resolves for display', async () => {
  // The employee is genuinely still assigned to it. Blanking the name would
  // read as a bug, and would hide that a reassignment is needed.
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  const emp = await makeEmployee({ departmentId: eng.id });
  await Department.updateOne({ _id: eng.id }, { $set: { deletedAt: new Date() } });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const data = envelopeData(await get(url, `${P}/${emp._id}`));
    assert.equal(data.departmentName, 'Engineering');
  });
});

test('a retired department can never be assigned to anyone NEW', async () => {
  // Display and validation deliberately differ: the provider is live-only, so
  // `assertReferencesResolve` refuses it.
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  await departments.deleteDepartment(eng.id);
  const emp = await makeEmployee();

  await withServer(appFor(HR_ADMIN), async (url) => {
    const res = await patch(url, `${P}/${emp._id}`, { departmentId: eng.id });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /departmentId does not exist/i);
  });
});

test('a departmentId that never existed is refused', async () => {
  const emp = await makeEmployee();
  await withServer(appFor(HR_ADMIN), async (url) => {
    assert.equal((await patch(url, `${P}/${emp._id}`, { departmentId: String(oid()) })).status, 400);
    assert.equal((await patch(url, `${P}/${emp._id}`, { locationId: String(oid()) })).status, 400);
  });
});

test('the list resolves names too, in one batch rather than per row', async () => {
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  for (let i = 0; i < 3; i += 1) await makeEmployee({ departmentId: eng.id });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const page = envelopeData(await get(url, P));
    assert.equal(page.data.length, 3);
    for (const row of page.data) assert.equal(row.departmentName, 'Engineering');
  });
});

// ---------------------------------------------------------------------------
// Directory filters
// ---------------------------------------------------------------------------

async function seedDirectory() {
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  const adm = await departments.createDepartment({ code: 'ADM', name: 'Admin' });
  const blr = await locations.createLocation({ code: 'BLR', name: 'Bangalore' });
  const amd = await locations.createLocation({ code: 'AMD', name: 'Ahmedabad' });

  await makeEmployee({ firstName: 'EngBlr', departmentId: eng.id, locationId: blr.id });
  await makeEmployee({ firstName: 'EngAmd', departmentId: eng.id, locationId: amd.id });
  await makeEmployee({ firstName: 'AdmBlr', departmentId: adm.id, locationId: blr.id });
  await makeEmployee({ firstName: 'Nowhere' });

  return { eng, adm, blr, amd };
}

test('?departmentId= filters the directory', async () => {
  const { eng } = await seedDirectory();

  await withServer(appFor(HR_ADMIN), async (url) => {
    const page = envelopeData(await get(url, `${P}?departmentId=${eng.id}`));
    assert.equal(page.total, 2);
    assert.deepEqual(page.data.map((e) => e.firstName).sort(), ['EngAmd', 'EngBlr']);
  });
});

test('?locationId= filters the directory', async () => {
  const { blr } = await seedDirectory();

  await withServer(appFor(HR_ADMIN), async (url) => {
    const page = envelopeData(await get(url, `${P}?locationId=${blr.id}`));
    assert.equal(page.total, 2);
    assert.deepEqual(page.data.map((e) => e.firstName).sort(), ['AdmBlr', 'EngBlr']);
  });
});

test('both filters together are ANDed, not ORed', async () => {
  const { eng, blr } = await seedDirectory();

  await withServer(appFor(HR_ADMIN), async (url) => {
    const page = envelopeData(await get(url, `${P}?departmentId=${eng.id}&locationId=${blr.id}`));
    assert.equal(page.total, 1);
    assert.equal(page.data[0].firstName, 'EngBlr');
  });
});

test('an omitted filter is not applied', async () => {
  await seedDirectory();
  await withServer(appFor(HR_ADMIN), async (url) => {
    assert.equal(envelopeData(await get(url, P)).total, 4, 'including the unassigned employee');
  });
});

test('the total reflects the filter, so pagination stays correct', async () => {
  const { eng } = await seedDirectory();

  await withServer(appFor(HR_ADMIN), async (url) => {
    const page = envelopeData(await get(url, `${P}?departmentId=${eng.id}&pageSize=1&page=1`));
    // Filtering after the fetch would make `total` a lie and the pager wrong.
    assert.equal(page.total, 2);
    assert.equal(page.data.length, 1);
    assert.equal(page.pageSize, 1);
  });
});

test('sorting composes with the reference filters', async () => {
  const { eng } = await seedDirectory();

  await withServer(appFor(HR_ADMIN), async (url) => {
    const asc = envelopeData(await get(url, `${P}?departmentId=${eng.id}&sortBy=firstName&sortDir=asc`));
    const desc = envelopeData(await get(url, `${P}?departmentId=${eng.id}&sortBy=firstName&sortDir=desc`));

    assert.deepEqual(asc.data.map((e) => e.firstName), ['EngAmd', 'EngBlr']);
    assert.deepEqual(desc.data.map((e) => e.firstName), ['EngBlr', 'EngAmd']);
  });
});

test('a malformed filter id is a 400, not a silent empty list', async () => {
  await seedDirectory();
  await withServer(appFor(HR_ADMIN), async (url) => {
    assert.equal((await get(url, `${P}?departmentId=not-an-id`)).status, 400);
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('assign, change and clear a reference, and the directory follows', async () => {
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  const adm = await departments.createDepartment({ code: 'ADM', name: 'Admin' });
  const emp = await makeEmployee({ firstName: 'Priya' });

  await withServer(appFor(HR_ADMIN), async (url) => {
    // assign
    let data = envelopeData(await patch(url, `${P}/${emp._id}`, { departmentId: eng.id }));
    assert.equal(data.departmentName, 'Engineering');
    assert.equal(envelopeData(await get(url, `${P}?departmentId=${eng.id}`)).total, 1);

    // change
    data = envelopeData(await patch(url, `${P}/${emp._id}`, { departmentId: adm.id }));
    assert.equal(data.departmentName, 'Admin');
    assert.equal(envelopeData(await get(url, `${P}?departmentId=${eng.id}`)).total, 0);
    assert.equal(envelopeData(await get(url, `${P}?departmentId=${adm.id}`)).total, 1);

    // clear - explicit null, because the update schema is `.partial()` and an
    // omitted key would mean "unchanged"
    data = envelopeData(await patch(url, `${P}/${emp._id}`, { departmentId: null }));
    assert.equal(data.departmentId, null);
    assert.equal(data.departmentName, null);
    assert.equal(envelopeData(await get(url, `${P}?departmentId=${adm.id}`)).total, 0);
  });
});

test('a department cannot be retired while an employee it was just assigned to is live', async () => {
  // The two halves of the seam meeting: Employee Master creates the reference,
  // Org Structure refuses to remove it.
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  const emp = await makeEmployee();

  await withServer(appFor(HR_ADMIN), async (url) => {
    envelopeData(await patch(url, `${P}/${emp._id}`, { departmentId: eng.id }));
  });

  await assert.rejects(
    () => departments.deleteDepartment(eng.id),
    (e) => e.statusCode === 409 && e.code === 'DEPARTMENT_IN_USE',
  );
});

// ---------------------------------------------------------------------------
// Import (verification only — step 2 wired this)
// ---------------------------------------------------------------------------

test('the import resolves valid codes, in any case, and rejects the rest', async () => {
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  const blr = await locations.createLocation({ code: 'BLR', name: 'Bangalore' });
  const retired = await departments.createDepartment({ code: 'OLD', name: 'Old' });
  await departments.deleteDepartment(retired.id);

  const depts = await employeePersistencePort.resolveDepartmentCodes(['eng', ' ENG ', 'OLD', 'NOPE']);
  assert.equal(depts.get('ENG'), eng.id, 'lower case and padding both normalise');
  assert.equal(depts.has('OLD'), false, 'a retired code is not importable');
  assert.equal(depts.has('NOPE'), false);
  assert.equal(depts.size, 1);

  const locs = await employeePersistencePort.resolveLocationCodes(['blr']);
  assert.equal(locs.get('BLR'), blr.id);
});

// ---------------------------------------------------------------------------
// Envelope regression
// ---------------------------------------------------------------------------

test('the employee endpoints still answer with the standard envelope', async () => {
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  const emp = await makeEmployee({ departmentId: eng.id });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const page = envelopeData(await get(url, P));
    // The list payload is the whole page object under `data`, not a bare array
    // spread beside it - the regression that took the directory down.
    for (const key of ['data', 'total', 'page', 'pageSize']) {
      assert.ok(key in page, `the page object must carry ${key}`);
    }
    assert.ok(Array.isArray(page.data));

    envelopeData(await get(url, `${P}/${emp._id}`));
    envelopeData(await patch(url, `${P}/${emp._id}`, { designation: 'Lead' }));
  });
});

test('creating an employee with references returns them resolved', async () => {
  const eng = await departments.createDepartment({ code: 'ENG', name: 'Engineering' });
  const blr = await locations.createLocation({ code: 'BLR', name: 'Bangalore' });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const res = await post(url, P, {
      employeeCode: 'SI-9001',
      firstName: 'New',
      lastName: 'Starter',
      email: 'new.starter@shraddha.test',
      dateOfJoining: '2026-01-05',
      departmentId: eng.id,
      locationId: blr.id,
    });

    const data = envelopeData(res, 201);
    assert.equal(data.employee.departmentName, 'Engineering');
    assert.equal(data.employee.locationName, 'Bangalore');
    assert.ok(data.tempPassword, 'unchanged behaviour');
  });
});

// ---------------------------------------------------------------------------
// An employee with no portal login
// ---------------------------------------------------------------------------

/**
 * An employee who has no account at all.
 *
 * Separate from `makeEmployee` on purpose: that helper always creates the User
 * to go with the record, and quietly reusing it with a null would be the very
 * mistake these tests exist to catch.
 */
let noLoginSeq = 0;
async function makeEmployeeWithoutLogin(over = {}) {
  noLoginSeq += 1;
  return Employee.create({
    employeeCode: `NL-${String(noLoginSeq).padStart(4, '0')}`,
    firstName: 'Nologin',
    lastName: `Person${noLoginSeq}`,
    dateOfJoining: new Date(),
    status: 'active',
    ...over,
    userId: null,
  });
}

test('several employees can exist with no login, while two can never share one', async () => {
  await makeEmployeeWithoutLogin();
  await makeEmployeeWithoutLogin();
  await makeEmployeeWithoutLogin();
  assert.equal(await Employee.countDocuments({ userId: null }), 3);

  // And the constraint that matters is still enforced by the database.
  const held = await makeEmployee();
  await assert.rejects(
    Employee.create({
      employeeCode: 'DUPLICATE',
      firstName: 'Second',
      lastName: 'Claimant',
      dateOfJoining: new Date(),
      userId: held.userId,
    }),
    (err) => err.code === 11000,
  );
});

test('actor resolution never lands on an employee who has no login', async () => {
  // The hole an optional userId could open: `findOne({ userId: null })` matches
  // every login-less employee, so a caller passing nothing must not reach one.
  await makeEmployeeWithoutLogin();
  await makeEmployeeWithoutLogin();

  for (const bad of [null, undefined, '', 'not-an-id', {}, []]) {
    assert.equal(
      await employeeReferenceProvider.byUserId(bad),
      null,
      `byUserId(${JSON.stringify(bad)}) must resolve to nobody`,
    );
  }
});

test('a real session still resolves to its OWN employee, with login-less rows present', async () => {
  await makeEmployeeWithoutLogin();
  const mine = await makeEmployee();
  await makeEmployeeWithoutLogin();

  const ref = await employeeReferenceProvider.byUserId(String(mine.userId));
  assert.ok(ref);
  assert.equal(ref.id, String(mine._id));
  assert.equal(ref.employeeCode, mine.employeeCode);
});

test('self scope still means exactly one employee', async () => {
  // `employees:view:self` resolves through the actor's employee id, so an
  // employee with no login can never be anybody's "self".
  const nologin = await makeEmployeeWithoutLogin();
  const mine = await makeEmployee();

  const employeeUser = {
    _id: mine.userId,
    role: 'Management',
    roles: [R.EMPLOYEE],
    status: 'Active',
  };

  await withServer(appFor(employeeUser), async (url) => {
    const list = envelopeData(await get(url, `${P}?pageSize=100`));
    const ids = list.data.map((e) => e.id);
    assert.deepEqual(ids, [String(mine._id)], 'self scope shows exactly one employee');
    assert.ok(!ids.includes(String(nologin._id)));
  });
});

test('a login-less employee is listed, and reports no login rather than breaking', async () => {
  const nologin = await makeEmployeeWithoutLogin({ firstName: 'Meera', lastName: 'Iyer' });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const list = envelopeData(await get(url, `${P}?pageSize=100`));
    const row = list.data.find((e) => e.id === String(nologin._id));
    assert.ok(row, 'they must appear in the directory');
    assert.equal(row.userId, null);
    assert.equal(row.displayName, 'Meera Iyer');

    const one = envelopeData(await get(url, `${P}/${nologin._id}`));
    assert.equal(one.userId, null);
  });
});

test('renaming a login-less employee works, and mints no account', async () => {
  const nologin = await makeEmployeeWithoutLogin();
  const usersBefore = await User.countDocuments({});

  await withServer(appFor(HR_ADMIN), async (url) => {
    const res = await patch(url, `${P}/${nologin._id}`, { firstName: 'Renamed' });
    const body = envelopeData(res);
    assert.equal(body.firstName, 'Renamed');
  });

  assert.equal(await User.countDocuments({}), usersBefore, 'no account may be created');
  assert.equal((await Employee.findById(nologin._id).lean()).userId, null);
});

test('deactivating a login-less employee works, and suspends nobody else', async () => {
  const nologin = await makeEmployeeWithoutLogin();
  const other = await makeEmployee();
  // Only a super admin holds employees:delete:org.
  const superAdmin = { _id: oid(), role: 'Management', roles: [R.SUPER_ADMIN], status: 'Active' };

  await withServer(appFor(superAdmin), async (url) => {
    const res = await fetch(`${url}${P}/${nologin._id}`, { method: 'DELETE' });
    assert.equal(res.status, 200, await res.text());
  });

  const row = await Employee.findById(nologin._id).lean();
  assert.equal(row.status, 'exited');
  assert.ok(row.deletedAt);
  // The one account in play must be untouched.
  assert.equal((await User.findById(other.userId).lean()).status, 'Active');
});

test('roles read as empty for a login-less employee, and cannot be granted', async () => {
  const nologin = await makeEmployeeWithoutLogin();

  await withServer(appFor(HR_ADMIN), async (url) => {
    // Reading is not an error: the screen shows "no roles".
    const roles = envelopeData(await get(url, `${P}/${nologin._id}/roles`));
    assert.deepEqual(roles.roleKeys, []);

    // Granting one is refused with the reason, rather than writing nothing and
    // reporting success.
    const res = await fetch(`${url}${P}/${nologin._id}/roles`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleKeys: [R.HR_ADMIN] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /no portal login/);
  });
});

test('a password cannot be reset for an employee who has none', async () => {
  const nologin = await makeEmployeeWithoutLogin();
  const superAdmin = {
    _id: oid(),
    role: 'Management',
    roles: [R.SUPER_ADMIN],
    status: 'Active',
  };

  await withServer(appFor(superAdmin), async (url) => {
    const res = await fetch(`${url}${P}/${nologin._id}/reset-password`, { method: 'POST' });
    // Without the guard this returned a temporary password for an account that
    // does not exist.
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /no portal login/);
    assert.equal(body.data, undefined);
  });
});

test('a login-less employee can hold org structure, a manager and a chain', async () => {
  const dept = await departments.createDepartment({ code: 'OPS', name: 'Operations' });
  const loc = await locations.createLocation({ code: 'HO', name: 'Head Office' });
  const manager = await makeEmployee();

  const nologin = await makeEmployeeWithoutLogin({
    departmentId: dept.id,
    locationId: loc.id,
    reportingManagerId: manager._id,
    managerChain: [manager._id],
  });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const one = envelopeData(await get(url, `${P}/${nologin._id}`));
    assert.equal(one.departmentName, 'Operations');
    assert.equal(one.locationName, 'Head Office');
    assert.equal(one.reportingManagerId, String(manager._id));
    assert.equal(one.userId, null);
  });

  // And their manager can see them through team scope, which reads managerChain
  // and never touches the login.
  const managerActor = {
    _id: manager.userId,
    role: 'Management',
    roles: [R.MANAGER],
    status: 'Active',
  };
  await withServer(appFor(managerActor), async (url) => {
    const list = envelopeData(await get(url, `${P}?pageSize=100`));
    assert.ok(
      list.data.some((e) => e.id === String(nologin._id)),
      'team scope must include a report who has no login',
    );
  });
});
