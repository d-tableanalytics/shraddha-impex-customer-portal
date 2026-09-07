/**
 * Org Structure — step 2: services and providers.
 *
 * These run against a real MongoDB in memory, because what is being tested is
 * database behaviour: a partial unique index, an aggregation, and a delete
 * guard that counts rows. A mock would only prove the mock agrees with itself.
 *
 * The three tests that matter most are the ones where the reference is wrong:
 * the in-use guard it delegates to a foreign key we do not have, the employee
 * count it computes over soft-deleted rows, and the retired code it could never
 * let you reuse.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Department from '../models/hrms/Department.js';
import Location from '../models/hrms/Location.js';
import Employee from '../models/hrms/Employee.js';
import * as departments from '../modules/hrms/org/department.service.js';
import * as locations from '../modules/hrms/org/location.service.js';
import {
  departmentReferenceProvider,
  locationReferenceProvider,
} from '../modules/hrms/org/org.provider.js';
import {
  registerReferenceProvider,
  resolveDepartment,
  resolveLocation,
  listDepartments as listDepartmentRefs,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeePersistencePort } from '../modules/hrms/employees/employee.provider.js';
import { AUDIT_ACTIONS } from '../shared/constants/hrms.js';
import AuditLog from '../models/AuditLog.js';
import {
  startTestMongo,
  stopTestMongo,
  syncIndexes,
  clearCollections,
} from './helpers/mongo.js';

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
  registerReferenceProvider('department', departmentReferenceProvider);
  registerReferenceProvider('location', locationReferenceProvider);
});

const oid = () => new mongoose.Types.ObjectId();

/** A live employee, minimally valid, optionally assigned somewhere. */
const makeEmployee = (overrides = {}) =>
  Employee.create({
    employeeCode: `SI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    userId: oid(),
    firstName: 'Test',
    lastName: 'Person',
    dateOfJoining: new Date(),
    ...overrides,
  });

const dept = (over = {}) => departments.createDepartment({ code: 'ENG', name: 'Engineering', ...over });
const loc = (over = {}) => locations.createLocation({ code: 'BLR', name: 'Bangalore', ...over });

// ===========================================================================
// Department
// ===========================================================================

test('create returns the department and persists it', async () => {
  const created = await dept();
  assert.equal(created.code, 'ENG');
  assert.equal(created.name, 'Engineering');
  assert.ok(created.id);

  assert.equal(await Department.countDocuments({ deletedAt: null }), 1);
});

test('create normalises the code, so casing is not a failure mode', async () => {
  const created = await departments.createDepartment({ code: '  eng-1 ', name: '  Engineering  ' });
  assert.equal(created.code, 'ENG-1');
  assert.equal(created.name, 'Engineering');
});

test('create refuses an invalid code rather than storing it', async () => {
  // The reference enforces this pattern only in the browser, so its API stores
  // whatever a script sends.
  await assert.rejects(
    () => departments.createDepartment({ code: 'eng dept!', name: 'X' }),
    (e) => e.statusCode === 400,
  );
  assert.equal(await Department.countDocuments({}), 0);
});

test('create refuses an unknown field instead of ignoring it', async () => {
  await assert.rejects(
    () => departments.createDepartment({ code: 'ENG', name: 'X', parentId: String(oid()) }),
    (e) => e.statusCode === 400,
  );
});

test('list returns live departments ordered by name, with live employee counts', async () => {
  const eng = await dept();
  await departments.createDepartment({ code: 'ADM', name: 'Admin' });
  await makeEmployee({ departmentId: eng.id });
  await makeEmployee({ departmentId: eng.id });

  const rows = await departments.listDepartments();
  assert.deepEqual(rows.map((r) => r.name), ['Admin', 'Engineering'], 'ordered by name');
  assert.equal(rows.find((r) => r.code === 'ENG').employeeCount, 2);
  assert.equal(rows.find((r) => r.code === 'ADM').employeeCount, 0);
});

test('employeeCount ignores soft-deleted employees', async () => {
  // The reference's `_count` carries no `where`, so a department whose entire
  // staff has been soft-deleted still reports them - and because that same
  // number disables its delete button, the department can never be removed.
  const eng = await dept();
  await makeEmployee({ departmentId: eng.id, deletedAt: new Date() });
  await makeEmployee({ departmentId: eng.id, deletedAt: new Date() });

  const [row] = await departments.listDepartments();
  assert.equal(row.employeeCount, 0, 'the count must match what the delete guard sees');
});

test('get returns one department, and 404s for unknown or retired', async () => {
  const created = await dept();
  assert.equal((await departments.getDepartment(created.id)).code, 'ENG');

  await assert.rejects(() => departments.getDepartment(String(oid())), (e) => e.statusCode === 404);
  await assert.rejects(() => departments.getDepartment('not-an-id'), (e) => e.statusCode === 404);

  await departments.deleteDepartment(created.id);
  await assert.rejects(() => departments.getDepartment(created.id), (e) => e.statusCode === 404);
  assert.equal((await departments.getDepartment(created.id, { includeDeleted: true })).code, 'ENG');
});

test('update changes only what it is given', async () => {
  const created = await dept();
  const updated = await departments.updateDepartment(created.id, { name: 'Engineering & Design' });

  assert.equal(updated.name, 'Engineering & Design');
  assert.equal(updated.code, 'ENG', 'untouched');
});

test('update can change the code, and normalises it', async () => {
  const created = await dept();
  const updated = await departments.updateDepartment(created.id, { code: 'engg' });
  assert.equal(updated.code, 'ENGG');
});

test('update 404s on a retired department', async () => {
  const created = await dept();
  await departments.deleteDepartment(created.id);
  await assert.rejects(
    () => departments.updateDepartment(created.id, { name: 'X' }),
    (e) => e.statusCode === 404,
  );
});

test('two LIVE departments cannot share a code', async () => {
  await dept();
  await assert.rejects(
    () => departments.createDepartment({ code: 'ENG', name: 'Engineering Two' }),
    (e) => e.statusCode === 409 && e.code === 'DEPARTMENT_CODE_TAKEN',
  );
});

test('renaming onto a taken code is refused too', async () => {
  await dept();
  const adm = await departments.createDepartment({ code: 'ADM', name: 'Admin' });
  await assert.rejects(
    () => departments.updateDepartment(adm.id, { code: 'ENG' }),
    (e) => e.statusCode === 409,
  );
});

test('a code is free again once its department is retired', async () => {
  // Retiring ENG and later re-creating it is ordinary housekeeping. A plain
  // unique index would make the code unusable forever.
  const first = await dept();
  await departments.deleteDepartment(first.id);

  const second = await departments.createDepartment({ code: 'ENG', name: 'Engineering (new)' });
  assert.notEqual(second.id, first.id);
  assert.equal(await Department.countDocuments({ code: 'ENG' }), 2, 'the retired row is kept');
  assert.equal(await Department.countDocuments({ code: 'ENG', deletedAt: null }), 1);
});

// ---------------------------------------------------------------------------
// O-3 — deletion protection
// ---------------------------------------------------------------------------

test('O-3: deleting a department with a live employee is REFUSED', async () => {
  const eng = await dept();
  await makeEmployee({ departmentId: eng.id });

  await assert.rejects(
    () => departments.deleteDepartment(eng.id),
    (e) => e.statusCode === 409 && e.code === 'DEPARTMENT_IN_USE' && /Reassign/.test(e.message),
  );

  const still = await Department.findById(eng.id).lean();
  assert.equal(still.deletedAt, null, 'nothing was written');
});

test('O-3: an exited employee still blocks deletion', async () => {
  // Status is where someone is in their employment; deletedAt is whether the
  // record exists. An exited employee still has a profile that renders this
  // department's name.
  const eng = await dept();
  await makeEmployee({ departmentId: eng.id, status: 'exited' });

  await assert.rejects(() => departments.deleteDepartment(eng.id), (e) => e.statusCode === 409);
});

test('O-3: deletion is allowed when only soft-deleted employees reference it', async () => {
  const eng = await dept();
  await makeEmployee({ departmentId: eng.id, deletedAt: new Date() });

  const result = await departments.deleteDepartment(eng.id);
  assert.equal(result.deleted, true);

  const row = await Department.findById(eng.id).lean();
  assert.ok(row, 'soft delete keeps the row');
  assert.ok(row.deletedAt instanceof Date);
});

test('O-3: the guard counts, and says how many', async () => {
  const eng = await dept();
  await makeEmployee({ departmentId: eng.id });
  await makeEmployee({ departmentId: eng.id });
  await makeEmployee({ departmentId: eng.id, deletedAt: new Date() });

  await assert.rejects(
    () => departments.deleteDepartment(eng.id),
    (e) => e.details.employeeCount === 2 && /2 employees/.test(e.message),
  );
});

test('deleting an already-retired department 404s', async () => {
  const eng = await dept();
  await departments.deleteDepartment(eng.id);
  await assert.rejects(() => departments.deleteDepartment(eng.id), (e) => e.statusCode === 404);
});

// ===========================================================================
// Location
// ===========================================================================

test('create stores every field and defaults the timezone', async () => {
  const created = await locations.createLocation({
    code: 'blr',
    name: 'Bangalore',
    city: 'Bengaluru',
    country: 'India',
    address: '123 MG Road',
  });

  assert.equal(created.code, 'BLR');
  assert.equal(created.city, 'Bengaluru');
  assert.equal(created.timezone, 'Asia/Kolkata', "the reference's default");
});

test('create works with only code and name', async () => {
  // The reference's create schema leaves address/city/country .nullable() but
  // not .optional(), so omitting City is a 400 there.
  const created = await loc();
  assert.equal(created.city, null);
  assert.equal(created.address, null);
});

test('an invalid timezone is refused', async () => {
  await assert.rejects(
    () => locations.createLocation({ code: 'X', name: 'X', timezone: 'Mars/Base' }),
    (e) => e.statusCode === 400,
  );
  assert.equal(await Location.countDocuments({}), 0);
});

test('a real timezone the reference did not hardcode is accepted', async () => {
  const created = await locations.createLocation({
    code: 'MAA',
    name: 'Chennai',
    timezone: 'Asia/Calcutta',
  });
  assert.equal(created.timezone, 'Asia/Calcutta');
});

test('list returns live locations ordered by name with live counts', async () => {
  const blr = await loc();
  await locations.createLocation({ code: 'AMD', name: 'Ahmedabad' });
  await makeEmployee({ locationId: blr.id });
  await makeEmployee({ locationId: blr.id, deletedAt: new Date() });

  const rows = await locations.listLocations();
  assert.deepEqual(rows.map((r) => r.name), ['Ahmedabad', 'Bangalore']);
  assert.equal(rows.find((r) => r.code === 'BLR').employeeCount, 1, 'soft-deleted excluded');
});

test('get returns one location and 404s appropriately', async () => {
  const created = await loc();
  assert.equal((await locations.getLocation(created.id)).name, 'Bangalore');
  await assert.rejects(() => locations.getLocation(String(oid())), (e) => e.statusCode === 404);
});

test('update changes only what it is given', async () => {
  const created = await loc({ city: 'Bengaluru' });
  const updated = await locations.updateLocation(created.id, { timezone: 'Europe/London' });

  assert.equal(updated.timezone, 'Europe/London');
  assert.equal(updated.city, 'Bengaluru', 'untouched');
  assert.equal(updated.code, 'BLR');
});

test('update refuses an invalid timezone', async () => {
  const created = await loc();
  await assert.rejects(
    () => locations.updateLocation(created.id, { timezone: 'Nowhere/Fake' }),
    (e) => e.statusCode === 400,
  );
  assert.equal((await locations.getLocation(created.id)).timezone, 'Asia/Kolkata');
});

test('two LIVE locations cannot share a code, and a retired code frees up', async () => {
  const first = await loc();
  await assert.rejects(
    () => locations.createLocation({ code: 'BLR', name: 'Bangalore Two' }),
    (e) => e.statusCode === 409 && e.code === 'LOCATION_CODE_TAKEN',
  );

  await locations.deleteLocation(first.id);
  const second = await locations.createLocation({ code: 'BLR', name: 'Bangalore (new)' });
  assert.notEqual(second.id, first.id);
});

test('O-3: deleting a location with a live employee is REFUSED', async () => {
  const blr = await loc();
  await makeEmployee({ locationId: blr.id });

  await assert.rejects(
    () => locations.deleteLocation(blr.id),
    (e) => e.statusCode === 409 && e.code === 'LOCATION_IN_USE',
  );
  assert.equal((await Location.findById(blr.id).lean()).deletedAt, null);
});

test('O-3: deletion is allowed when only soft-deleted employees reference it', async () => {
  const blr = await loc();
  await makeEmployee({ locationId: blr.id, deletedAt: new Date() });

  await locations.deleteLocation(blr.id);
  assert.ok((await Location.findById(blr.id).lean()).deletedAt instanceof Date);
});

// ===========================================================================
// Providers
// ===========================================================================

test('a live department resolves through the reference service', async () => {
  const eng = await dept();
  const ref = await resolveDepartment(eng.id);
  assert.equal(ref.code, 'ENG');
  assert.equal(ref.name, 'Engineering');
});

test('a live location resolves through the reference service', async () => {
  const blr = await loc();
  const ref = await resolveLocation(blr.id);
  assert.equal(ref.code, 'BLR');
  assert.equal(ref.timezone, 'Asia/Kolkata');
});

test('a retired department does NOT resolve', async () => {
  // This is what stops anyone being newly assigned to a department that has
  // been retired, and what makes the import reject a sheet naming one.
  const eng = await dept();
  await departments.deleteDepartment(eng.id);
  assert.equal(await resolveDepartment(eng.id), null);
});

test('a retired location does NOT resolve', async () => {
  const blr = await loc();
  await locations.deleteLocation(blr.id);
  assert.equal(await resolveLocation(blr.id), null);
});

test('an unknown or malformed id resolves to null, it does not throw', async () => {
  assert.equal(await resolveDepartment(String(oid())), null);
  assert.equal(await resolveDepartment('not-an-id'), null);
  assert.equal(await resolveLocation(String(oid())), null);
  assert.equal(await resolveLocation('not-an-id'), null);
});

test('byCodes is case-insensitive and skips retired rows', async () => {
  await dept();
  const adm = await departments.createDepartment({ code: 'ADM', name: 'Admin' });
  await departments.deleteDepartment(adm.id);

  const found = await departmentReferenceProvider.byCodes(['eng', 'ADM', 'NOPE']);
  assert.deepEqual([...found.keys()], ['ENG']);
  assert.equal(found.get('ENG').name, 'Engineering');
});

test('list() through the registry returns live rows ordered by name', async () => {
  await dept();
  await departments.createDepartment({ code: 'ADM', name: 'Admin' });
  const retired = await departments.createDepartment({ code: 'OPS', name: 'Operations' });
  await departments.deleteDepartment(retired.id);

  const refs = await listDepartmentRefs();
  assert.deepEqual(refs.map((r) => r.code), ['ADM', 'ENG']);
});

test('the location provider mirrors it', async () => {
  await loc();
  const found = await locationReferenceProvider.byCodes([' blr ']);
  assert.equal(found.get('BLR').name, 'Bangalore');
  assert.deepEqual((await locationReferenceProvider.list()).map((r) => r.code), ['BLR']);
});

// ---------------------------------------------------------------------------
// The import port, whose stub's stated reason has now expired
// ---------------------------------------------------------------------------

test('the import port resolves codes to ids', async () => {
  const eng = await dept();
  const blr = await loc();

  const depts = await employeePersistencePort.resolveDepartmentCodes(['ENG', 'MISSING']);
  assert.equal(depts.get('ENG'), eng.id);
  assert.equal(depts.has('MISSING'), false);

  const locs = await employeePersistencePort.resolveLocationCodes(['BLR']);
  assert.equal(locs.get('BLR'), blr.id);
});

test('the import port does not resolve a retired code', async () => {
  const eng = await dept();
  await departments.deleteDepartment(eng.id);
  assert.equal((await employeePersistencePort.resolveDepartmentCodes(['ENG'])).size, 0);
});

// ===========================================================================
// Audit
// ===========================================================================

test('create, update and delete are each audited', async () => {
  const created = await dept();
  await departments.updateDepartment(created.id, { name: 'Eng' });
  await departments.deleteDepartment(created.id);

  const actions = (await AuditLog.find({}).lean()).map((a) => a.action);
  assert.ok(actions.includes(AUDIT_ACTIONS.DEPARTMENT_CREATED));
  assert.ok(actions.includes(AUDIT_ACTIONS.DEPARTMENT_UPDATED));
  assert.ok(actions.includes(AUDIT_ACTIONS.DEPARTMENT_DELETED));
});

test('a refused delete writes no audit entry', async () => {
  const eng = await dept();
  await makeEmployee({ departmentId: eng.id });
  await AuditLog.deleteMany({});

  await assert.rejects(() => departments.deleteDepartment(eng.id));
  assert.equal(await AuditLog.countDocuments({}), 0, 'nothing happened, so nothing is recorded');
});

test('locations are audited too', async () => {
  const created = await loc();
  await locations.updateLocation(created.id, { city: 'Bengaluru' });
  await locations.deleteLocation(created.id);

  const actions = (await AuditLog.find({}).lean()).map((a) => a.action);
  for (const a of [
    AUDIT_ACTIONS.LOCATION_CREATED,
    AUDIT_ACTIONS.LOCATION_UPDATED,
    AUDIT_ACTIONS.LOCATION_DELETED,
  ]) {
    assert.ok(actions.includes(a), a);
  }
});
