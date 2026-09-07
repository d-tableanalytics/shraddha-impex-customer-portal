/**
 * Org Structure — step 3: the HTTP layer.
 *
 * A real Express app over a real MongoDB. Only `protect` is stubbed, exactly as
 * the Employee Master route tests do it — the permission chain, the validator,
 * the services and the error handler are all the genuine article, because those
 * are the parts a route test exists to exercise.
 *
 * The envelope assertions are not ceremony. The employee list shipped with its
 * payload spread beside `data` instead of under it, the client unwrapped one
 * level and got a bare array, and the whole route died on `rows.length`. Every
 * endpoint here asserts its own envelope.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Department from '../models/hrms/Department.js';
import Location from '../models/hrms/Location.js';
import Employee from '../models/hrms/Employee.js';
import orgRoutes from '../modules/hrms/org/org.routes.js';
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
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import {
  buildTestApp,
  stubProtect,
  withServer,
  get,
  post,
  patch,
  del,
} from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/org';
const oid = () => new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Department, Location, Employee);
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
  // The actor's employeeId comes from here; the org chart's team scope needs it.
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/org', orgRoutes);
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

const HR_ADMIN = userWith([R.HR_ADMIN]);
const SUPER_ADMIN = userWith([R.SUPER_ADMIN]);
const EMPLOYEE = userWith([R.EMPLOYEE]);
const AUDITOR = userWith([R.AUDITOR]);
const CUSTOMER = { _id: oid(), role: 'Customer', roles: [], status: 'Active' };

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

/** Every successful HRMS response is `{ success: true, data }` and nothing else. */
function assertEnvelope(res, expectedStatus = 200) {
  assert.equal(res.status, expectedStatus, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.ok('data' in res.body, 'the payload must be under `data`');
  assert.deepEqual(
    Object.keys(res.body).sort(),
    ['data', 'success'],
    'nothing may be spread beside `data`',
  );
  return res.body.data;
}

/** Every HRMS error is `{ success: false, message, code }`. */
function assertError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0);
  if (code) assert.equal(res.body.code, code);
  assert.equal('data' in res.body, false, 'an error carries no data');
}

// ===========================================================================
// Departments
// ===========================================================================

test('POST creates a department and returns 201 with the envelope', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const res = await post(url, `${P}/departments`, { code: 'eng', name: 'Engineering' });
    const data = assertEnvelope(res, 201);

    assert.equal(data.code, 'ENG', 'normalised');
    assert.equal(data.name, 'Engineering');
    assert.ok(data.id);
    assert.equal('parentId' in data, false, 'O-1: not a product field');
    assert.equal('headEmployeeId' in data, false, 'O-2');
  });
});

test('GET lists live departments by name, with live employee counts', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering' });
    const adm = assertEnvelope(await post(url, `${P}/departments`, { code: 'ADM', name: 'Admin' }), 201);

    await makeEmployee({ departmentId: adm.id });
    await makeEmployee({ departmentId: adm.id, deletedAt: new Date() });

    const data = assertEnvelope(await get(url, `${P}/departments`));
    assert.ok(Array.isArray(data), 'the list is an array under `data`');
    assert.deepEqual(data.map((d) => d.name), ['Admin', 'Engineering'], 'name ascending');
    assert.equal(data.find((d) => d.code === 'ADM').employeeCount, 1, 'soft-deleted excluded');
    assert.equal(data.find((d) => d.code === 'ENG').employeeCount, 0);
  });
});

test('GET one department, and 404 for unknown or malformed ids', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering' }), 201);

    assert.equal(assertEnvelope(await get(url, `${P}/departments/${made.id}`)).code, 'ENG');
    assertError(await get(url, `${P}/departments/${oid()}`), 404);
    assertError(await get(url, `${P}/departments/not-an-id`), 404);
  });
});

test('PATCH updates, and 404s on a retired department', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering' }), 201);

    const data = assertEnvelope(await patch(url, `${P}/departments/${made.id}`, { name: 'Eng & Design' }));
    assert.equal(data.name, 'Eng & Design');
    assert.equal(data.code, 'ENG', 'untouched');

    await del(url, `${P}/departments/${made.id}`);
    assertError(await patch(url, `${P}/departments/${made.id}`, { name: 'X' }), 404);
  });
});

test('PATCH rejects an unknown field rather than ignoring it', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'E' }), 201);
    // O-1 / O-2: neither is a writable product field, and the schema is strict.
    assertError(await patch(url, `${P}/departments/${made.id}`, { parentId: String(oid()) }), 400);
    assertError(await patch(url, `${P}/departments/${made.id}`, { headEmployeeId: String(oid()) }), 400);
  });
});

test('POST rejects an invalid code with a 400, not a 500', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    // The reference enforces this pattern only in the browser.
    assertError(await post(url, `${P}/departments`, { code: 'eng dept!', name: 'X' }), 400);
    assertError(await post(url, `${P}/departments`, { name: 'X' }), 400);
    assert.equal(await Department.countDocuments({}), 0);
  });
});

test('a duplicate LIVE code is a 409, and a retired code is reusable', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const first = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering' }), 201);

    assertError(
      await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering Two' }),
      409,
      'DEPARTMENT_CODE_TAKEN',
    );

    assertEnvelope(await del(url, `${P}/departments/${first.id}`));

    const second = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering (new)' }), 201);
    assert.notEqual(second.id, first.id);
  });
});

test('DELETE is refused while a live employee references the department', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering' }), 201);
    await makeEmployee({ departmentId: made.id });

    const res = await del(url, `${P}/departments/${made.id}`);
    assertError(res, 409, 'DEPARTMENT_IN_USE');
    assert.equal(res.body.details.employeeCount, 1, 'the count reaches the client');

    assert.equal((await Department.findById(made.id).lean()).deletedAt, null, 'nothing written');
  });
});

test('DELETE succeeds when only soft-deleted employees reference it', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering' }), 201);
    await makeEmployee({ departmentId: made.id, deletedAt: new Date() });

    const data = assertEnvelope(await del(url, `${P}/departments/${made.id}`));
    assert.equal(data.deleted, true);

    assert.ok((await Department.findById(made.id).lean()).deletedAt instanceof Date, 'soft');
    assertError(await get(url, `${P}/departments/${made.id}`), 404);
    assert.deepEqual(assertEnvelope(await get(url, `${P}/departments`)), []);
  });
});

test('includeDeleted brings retired rows back, and any other query param is a 400', async () => {
  // Soft delete is our change (O-3), so a way to resolve a retired name is a
  // consequence of it rather than an invented filter.
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering' }), 201);
    await del(url, `${P}/departments/${made.id}`);

    assert.equal(assertEnvelope(await get(url, `${P}/departments?includeDeleted=true`)).length, 1);
    assert.equal(assertEnvelope(await get(url, `${P}/departments`)).length, 0);
    assertError(await get(url, `${P}/departments?search=eng`), 400);
  });
});

// ===========================================================================
// Locations
// ===========================================================================

test('POST creates a location with only code and name', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const data = assertEnvelope(await post(url, `${P}/locations`, { code: 'blr', name: 'Bangalore' }), 201);

    assert.equal(data.code, 'BLR');
    assert.equal(data.city, null, 'optional, not required-but-nullable');
    assert.equal(data.address, null);
    assert.equal(data.timezone, 'Asia/Kolkata', "the reference's default");
  });
});

test('an invalid timezone is a 400; a real one the reference omits is accepted', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    assertError(await post(url, `${P}/locations`, { code: 'X', name: 'X', timezone: 'Mars/Base' }), 400);

    const data = assertEnvelope(
      await post(url, `${P}/locations`, { code: 'MAA', name: 'Chennai', timezone: 'Asia/Calcutta' }),
      201,
    );
    assert.equal(data.timezone, 'Asia/Calcutta');
  });
});

test('locations list by name with live counts, and get/404 behave', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const blr = assertEnvelope(await post(url, `${P}/locations`, { code: 'BLR', name: 'Bangalore' }), 201);
    await post(url, `${P}/locations`, { code: 'AMD', name: 'Ahmedabad' });
    await makeEmployee({ locationId: blr.id });
    await makeEmployee({ locationId: blr.id, deletedAt: new Date() });

    const data = assertEnvelope(await get(url, `${P}/locations`));
    assert.deepEqual(data.map((l) => l.name), ['Ahmedabad', 'Bangalore']);
    assert.equal(data.find((l) => l.code === 'BLR').employeeCount, 1);

    assert.equal(assertEnvelope(await get(url, `${P}/locations/${blr.id}`)).name, 'Bangalore');
    assertError(await get(url, `${P}/locations/${oid()}`), 404);
  });
});

test('PATCH a location, including its timezone', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/locations`, { code: 'BLR', name: 'Bangalore', city: 'Bengaluru' }), 201);

    const data = assertEnvelope(await patch(url, `${P}/locations/${made.id}`, { timezone: 'Europe/London' }));
    assert.equal(data.timezone, 'Europe/London');
    assert.equal(data.city, 'Bengaluru', 'untouched');

    assertError(await patch(url, `${P}/locations/${made.id}`, { timezone: 'Nowhere/Fake' }), 400);
  });
});

test('duplicate live location code is a 409; a retired one frees up', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const first = assertEnvelope(await post(url, `${P}/locations`, { code: 'BLR', name: 'Bangalore' }), 201);
    assertError(await post(url, `${P}/locations`, { code: 'BLR', name: 'Two' }), 409, 'LOCATION_CODE_TAKEN');

    await del(url, `${P}/locations/${first.id}`);
    assertEnvelope(await post(url, `${P}/locations`, { code: 'BLR', name: 'Bangalore (new)' }), 201);
  });
});

test('DELETE a location is refused in use, allowed otherwise', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const inUse = assertEnvelope(await post(url, `${P}/locations`, { code: 'BLR', name: 'Bangalore' }), 201);
    await makeEmployee({ locationId: inUse.id });
    assertError(await del(url, `${P}/locations/${inUse.id}`), 409, 'LOCATION_IN_USE');

    const free = assertEnvelope(await post(url, `${P}/locations`, { code: 'AMD', name: 'Ahmedabad' }), 201);
    await makeEmployee({ locationId: free.id, deletedAt: new Date() });
    assertEnvelope(await del(url, `${P}/locations/${free.id}`));
  });
});

// ===========================================================================
// Permissions
// ===========================================================================

test('AD-4: a Customer reaches no Org Structure endpoint', async () => {
  await withServer(appFor(CUSTOMER), async (url) => {
    for (const path of ['/departments', '/locations', '/tree', `/departments/${oid()}`]) {
      assert.equal((await get(url, `${P}${path}`)).status, 403, path);
    }
    assert.equal((await post(url, `${P}/departments`, { code: 'X', name: 'X' })).status, 403);
  });
});

test('an ordinary employee may READ the catalogues but not write them', async () => {
  // view:self is in the baseline - that is what makes the department picker on
  // the employee form work. Writing is edit:org.
  await withServer(appFor(HR_ADMIN), async (url) => {
    await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering' });
  });

  await withServer(appFor(EMPLOYEE), async (url) => {
    assert.equal(assertEnvelope(await get(url, `${P}/departments`)).length, 1);
    assertEnvelope(await get(url, `${P}/locations`));

    assert.equal((await post(url, `${P}/departments`, { code: 'X', name: 'X' })).status, 403);
    assert.equal((await patch(url, `${P}/departments/${oid()}`, { name: 'X' })).status, 403);
    assert.equal((await del(url, `${P}/departments/${oid()}`)).status, 403);
  });
});

test('an auditor holds no org-structure grant at all, so reads are refused', async () => {
  // The reference's auditor list does not spread SELF_BASELINE and omits
  // org-structure entirely. Ours matches; this pins that it stays matched.
  await withServer(appFor(AUDITOR), async (url) => {
    assert.equal((await get(url, `${P}/departments`)).status, 403);
    assert.equal((await get(url, `${P}/locations`)).status, 403);
  });
});

test('super_admin and hr_admin may write', async () => {
  for (const user of [SUPER_ADMIN, HR_ADMIN]) {
    await withServer(appFor(user), async (url) => {
      const code = user === SUPER_ADMIN ? 'SA' : 'HR';
      assertEnvelope(await post(url, `${P}/departments`, { code, name: code }), 201);
    });
  }
});

// ===========================================================================
// Org chart
// ===========================================================================

/** A → B → C, plus an unrelated root D. */
async function buildOrg() {
  const ceo = await makeEmployee({ firstName: 'Ceo', status: 'active' });
  const mgr = await makeEmployee({ firstName: 'Mgr', status: 'active', reportingManagerId: ceo._id, managerChain: [ceo._id] });
  const dev = await makeEmployee({
    firstName: 'Dev',
    status: 'active',
    reportingManagerId: mgr._id,
    managerChain: [mgr._id, ceo._id],
  });
  const solo = await makeEmployee({ firstName: 'Solo', status: 'active' });
  return { ceo, mgr, dev, solo };
}

test('the tree returns every live employee for an org-wide reader', async () => {
  const { ceo, mgr, dev } = await buildOrg();

  await withServer(appFor(HR_ADMIN), async (url) => {
    const data = assertEnvelope(await get(url, `${P}/tree`));
    assert.equal(data.length, 4);

    const byName = new Map(data.map((n) => [n.displayName.split(' ')[0], n]));
    assert.equal(byName.get('Ceo').reportingManagerId, null, 'a genuine root');
    assert.equal(byName.get('Mgr').reportingManagerId, String(ceo._id));
    assert.equal(byName.get('Dev').reportingManagerId, String(mgr._id));
    assert.equal(byName.get('Solo').reportingManagerId, null, 'employee without a manager');

    // Shape, ported from the reference minus avatarUrl - which its own OrgCard
    // selects and never renders.
    assert.deepEqual(Object.keys(byName.get('Dev')).sort(), [
      'departmentName', 'designation', 'displayName', 'id',
      'managerCycleBroken', 'managerOutsideView', 'reportingManagerId', 'status',
    ]);
    assert.equal(String(dev._id).length, 24);
  });
});

test('multiple roots are all returned', async () => {
  await buildOrg();
  await withServer(appFor(HR_ADMIN), async (url) => {
    const data = assertEnvelope(await get(url, `${P}/tree`));
    assert.equal(data.filter((n) => n.reportingManagerId === null).length, 2, 'Ceo and Solo');
  });
});

test('a soft-deleted employee is absent, and their report is not silently made a root', async () => {
  const { mgr, dev } = await buildOrg();
  await Employee.updateOne({ _id: mgr._id }, { $set: { deletedAt: new Date() } });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const data = assertEnvelope(await get(url, `${P}/tree`));
    assert.equal(data.length, 3, 'the deleted manager is gone');

    const node = data.find((n) => n.id === String(dev._id));
    assert.equal(node.reportingManagerId, null, 'the dangling edge is not emitted');
    assert.equal(node.managerOutsideView, true, 'and it is reported, not hidden');

    // The reference would emit the dangling id and its client would render this
    // person as top-level - a claim about the company, not a rendering detail.
    assert.equal(data.find((n) => n.managerOutsideView && n.reportingManagerId), undefined);
  });
});

test('a reporting cycle is broken safely - nobody disappears', async () => {
  // Corrupt data: A reports to B, B reports to A. The reference's client-side
  // buildTree finds no root and renders an empty chart, hiding exactly the
  // people affected.
  const a = await makeEmployee({ firstName: 'Aaa' });
  const b = await makeEmployee({ firstName: 'Bbb', reportingManagerId: a._id });
  await Employee.updateOne({ _id: a._id }, { $set: { reportingManagerId: b._id } });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const data = assertEnvelope(await get(url, `${P}/tree`));
    assert.equal(data.length, 2, 'both are still present');

    const roots = data.filter((n) => n.reportingManagerId === null);
    assert.equal(roots.length, 1, 'exactly one edge was cut');
    assert.equal(roots[0].managerCycleBroken, true, 'and the cut is visible');
  });
});

test('a three-node cycle is also broken', async () => {
  const a = await makeEmployee({ firstName: 'Aaa' });
  const b = await makeEmployee({ firstName: 'Bbb', reportingManagerId: a._id });
  const c = await makeEmployee({ firstName: 'Ccc', reportingManagerId: b._id });
  await Employee.updateOne({ _id: a._id }, { $set: { reportingManagerId: c._id } });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const data = assertEnvelope(await get(url, `${P}/tree`));
    assert.equal(data.length, 3);
    assert.equal(data.filter((n) => n.managerCycleBroken).length, 1);
    assert.equal(data.filter((n) => n.reportingManagerId === null).length, 1);
  });
});

test('the order is deterministic across requests', async () => {
  // Same status and same first name: without the _id tiebreak the storage
  // engine decides, and the chart reshuffles between reloads.
  for (let i = 0; i < 6; i += 1) await makeEmployee({ firstName: 'Same', status: 'active' });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const first = assertEnvelope(await get(url, `${P}/tree`)).map((n) => n.id);
    const second = assertEnvelope(await get(url, `${P}/tree`)).map((n) => n.id);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [...first].sort(), 'ordered by id within the tie');
  });
});

test('a manager sees only their own subtree', async () => {
  const { mgr, dev, ceo, solo } = await buildOrg();
  const managerUser = userWith([R.MANAGER]);
  await Employee.updateOne({ _id: mgr._id }, { $set: { userId: managerUser._id } });

  await withServer(appFor(managerUser), async (url) => {
    const ids = assertEnvelope(await get(url, `${P}/tree`)).map((n) => n.id);
    assert.deepEqual(ids.sort(), [String(mgr._id), String(dev._id)].sort());
    assert.ok(!ids.includes(String(ceo._id)), 'not their own manager');
    assert.ok(!ids.includes(String(solo._id)), 'not an unrelated root');
  });
});

test("a manager's own manager shows as outside the view, not as absent hierarchy", async () => {
  const { mgr } = await buildOrg();
  const managerUser = userWith([R.MANAGER]);
  await Employee.updateOne({ _id: mgr._id }, { $set: { userId: managerUser._id } });

  await withServer(appFor(managerUser), async (url) => {
    const data = assertEnvelope(await get(url, `${P}/tree`));
    const self = data.find((n) => n.id === String(mgr._id));
    assert.equal(self.reportingManagerId, null);
    assert.equal(self.managerOutsideView, true);
  });
});

test('an auditor reads the whole tree; an ordinary employee is refused', async () => {
  await buildOrg();

  // The auditor holds employees:view:org, which satisfies the route's
  // employees:view:team spec by scope ranking and makes the query org-wide.
  await withServer(appFor(AUDITOR), async (url) => {
    assert.equal(assertEnvelope(await get(url, `${P}/tree`)).length, 4);
  });

  // An employee holds neither org-structure:view:org nor employees:view:team.
  // The reference refuses them too; widening it would put the company's whole
  // reporting structure in front of everyone.
  await withServer(appFor(EMPLOYEE), async (url) => {
    assert.equal((await get(url, `${P}/tree`)).status, 403);
  });
});

test('a manager with no employee record gets an empty chart, not an error', async () => {
  await buildOrg();
  await withServer(appFor(userWith([R.MANAGER])), async (url) => {
    assert.deepEqual(assertEnvelope(await get(url, `${P}/tree`)), []);
  });
});

test('the tree resolves department names, including retired ones', async () => {
  let deptId;
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'Engineering' }), 201);
    deptId = made.id;
  });

  await makeEmployee({ firstName: 'Dev', departmentId: deptId });
  await Department.updateOne({ _id: deptId }, { $set: { deletedAt: new Date() } });

  await withServer(appFor(HR_ADMIN), async (url) => {
    const [node] = assertEnvelope(await get(url, `${P}/tree`));
    // Showing a blank where a name used to be reads as a bug; the employee is
    // still assigned to it until someone reassigns them.
    assert.equal(node.departmentName, 'Engineering');
  });
});

// ===========================================================================
// Envelope regression
// ===========================================================================

test('no Org Structure response spreads its payload beside `data`', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'E' }), 201);
    const loc = assertEnvelope(await post(url, `${P}/locations`, { code: 'BLR', name: 'B' }), 201);

    assertEnvelope(await get(url, `${P}/departments`));
    assertEnvelope(await get(url, `${P}/departments/${made.id}`));
    assertEnvelope(await patch(url, `${P}/departments/${made.id}`, { name: 'E2' }));
    assertEnvelope(await del(url, `${P}/departments/${made.id}`));

    assertEnvelope(await get(url, `${P}/locations`));
    assertEnvelope(await get(url, `${P}/locations/${loc.id}`));
    assertEnvelope(await patch(url, `${P}/locations/${loc.id}`, { name: 'B2' }));
    assertEnvelope(await del(url, `${P}/locations/${loc.id}`));

    assertEnvelope(await get(url, `${P}/tree`));
  });
});

test('404, 409, 400 and 403 are each distinguishable', async () => {
  await withServer(appFor(HR_ADMIN), async (url) => {
    const made = assertEnvelope(await post(url, `${P}/departments`, { code: 'ENG', name: 'E' }), 201);
    await makeEmployee({ departmentId: made.id });

    assertError(await get(url, `${P}/departments/${oid()}`), 404);
    assertError(await post(url, `${P}/departments`, { code: 'ENG', name: 'Dup' }), 409, 'DEPARTMENT_CODE_TAKEN');
    assertError(await del(url, `${P}/departments/${made.id}`), 409, 'DEPARTMENT_IN_USE');
    assertError(await post(url, `${P}/departments`, { code: '!!', name: 'X' }), 400);
  });

  await withServer(appFor(EMPLOYEE), async (url) => {
    assertError(await post(url, `${P}/departments`, { code: 'X', name: 'X' }), 403);
  });
});
