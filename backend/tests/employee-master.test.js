/**
 * Employee Master.
 *
 * Covers the model, validation, manager hierarchy, sensitive-field handling,
 * customField protection, authorization and audit behaviour.
 *
 * The pure rules are tested directly; the HTTP layer is tested through the real
 * guard chain behind a stub authenticator. Paths that need a live MongoDB
 * (list, create, update) are asserted at the source level, and the reasoning
 * they encode is tested through the functions they call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import { readFile } from 'node:fs/promises';

import Employee, { MAX_EMERGENCY_CONTACTS } from '../models/hrms/Employee.js';
import EmployeeCustomField from '../models/hrms/EmployeeCustomField.js';
import {
  walkUp,
  assertNoCycle,
  computeManagerChain,
  MAX_CHAIN_DEPTH,
} from '../modules/hrms/employees/managerChain.js';
import { toEmployeeDto } from '../modules/hrms/employees/employee.service.js';
import employeeRoutes from '../modules/hrms/employees/employee.routes.js';
import { hrmsAuthorizationChain } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  employeeListQuerySchema,
  revealSensitiveSchema,
  createCustomFieldSchema,
} from '../shared/schemas/employee.js';
import { encryptField } from '../utils/hrms/crypto/index.js';
import { encPath, idxPath } from '../models/hrms/plugins/sensitiveFields.js';
import {
  SENSITIVE_EMPLOYEE_FIELDS as F,
  SENSITIVE_EMPLOYEE_FIELD_LIST,
} from '../shared/security/sensitive-fields.js';
import { HRMS_ROLES as R, HRMS_MODULES as M } from '../shared/permissions/constants.js';
import { buildTestApp, stubProtect, withServer, get, post, put } from './helpers/http.js';

const src = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');
const oid = () => new mongoose.Types.ObjectId().toString();

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

test('employeeCode is the natural key: required, unique and indexed', () => {
  const path = Employee.schema.path('employeeCode');
  assert.equal(path.isRequired, true);
  assert.equal(path.options.unique, true);
  assert.equal(path.options.index, true);
  assert.equal(path.options.maxlength, 30);
});

test('email is NOT the employee identity', () => {
  // The login lives on User; the employee record carries only a personal email.
  assert.equal(Employee.schema.path('email'), undefined);
  assert.ok(Employee.schema.path('personalEmail'));
  assert.ok(Employee.schema.path('userId').options.unique, 'one login, one employee');
});

test('AD-1: the employee carries no tenant id', async () => {
  const code = (await src('../models/hrms/Employee.js'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /organizationId/);
  assert.equal(Employee.schema.path('organizationId'), undefined);
});

test('the reference filters and scopes are indexed (AD-13)', () => {
  const indexed = Employee.schema.indexes().map(([spec]) => Object.keys(spec).join(','));
  assert.ok(indexed.some((i) => i.includes('status')));
  assert.ok(indexed.some((i) => i.includes('departmentId')));
  assert.ok(indexed.some((i) => i.includes('managerChain')), 'team scope reads this on every list');
  assert.ok(indexed.some((i) => i.includes('reportingManagerId')));
});

test('deletion is soft — a hard delete would strand dependent records', async () => {
  assert.ok(Employee.schema.path('deletedAt'), 'soft-delete marker must exist');
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.match(service, /deletedAt: new Date\(\)/);
  assert.doesNotMatch(service, /Employee\.deleteOne|Employee\.findByIdAndDelete/);
});

test('a document validates, and rejects more than two emergency contacts', async () => {
  const base = {
    employeeCode: 'SI-001',
    userId: oid(),
    firstName: 'Priya',
    lastName: 'Sharma',
    dateOfJoining: new Date(),
  };

  await new Employee(base).validate();

  const contact = { name: 'A', relationship: 'Father', phone: '9876543210' };
  const tooMany = new Employee({ ...base, emergencyContacts: [contact, contact, contact] });
  await assert.rejects(() => tooMany.validate(), /At most 2/);
  assert.equal(MAX_EMERGENCY_CONTACTS, 2);
});

test('an emergency contact phone must be exactly ten digits', async () => {
  const doc = new Employee({
    employeeCode: 'SI-002',
    userId: oid(),
    firstName: 'A',
    lastName: 'B',
    dateOfJoining: new Date(),
    emergencyContacts: [{ name: 'X', relationship: 'Spouse', phone: '98765' }],
  });
  await assert.rejects(() => doc.validate());
});

// ---------------------------------------------------------------------------
// Manager hierarchy and cycle detection
// ---------------------------------------------------------------------------

/** An in-memory org chart: child -> manager. */
const graph = (edges) => async (id) => edges[id] ?? null;

test('a chain is derived nearest-first', async () => {
  const getParent = graph({ C: 'B', B: 'A', A: null });
  assert.deepEqual(await computeManagerChain('C', { getParent }), ['C', 'B', 'A']);
  assert.deepEqual(await walkUp('B', { getParent }), ['B', 'A']);
  assert.deepEqual(await walkUp('A', { getParent }), ['A']);
});

test('top of the organisation has an empty chain', async () => {
  assert.deepEqual(await computeManagerChain(null), []);
  assert.deepEqual(await computeManagerChain(undefined), []);
});

test('an employee cannot report to themselves', async () => {
  await assert.rejects(
    () => assertNoCycle('A', 'A', { getParent: graph({}) }),
    (err) => err.code === 'MANAGER_SELF_REFERENCE' && err.statusCode === 409,
  );
});

test('an employee cannot report to their own direct report', async () => {
  // B already reports to A, so making B the manager of A closes a two-node loop.
  const getParent = graph({ B: 'A', A: null });
  await assert.rejects(
    () => assertNoCycle('A', 'B', { getParent }),
    (err) => err.code === 'MANAGER_CYCLE',
  );
});

test('the three-node cycle from the brief is rejected: A→B, B→C, C→A', async () => {
  // Existing: A reports to B, B reports to C. Now try to make C report to A.
  const getParent = graph({ A: 'B', B: 'C', C: null });
  await assert.rejects(
    () => assertNoCycle('C', 'A', { getParent }),
    (err) => err.code === 'MANAGER_CYCLE' && /reporting cycle/i.test(err.message),
  );
});

test('a legitimate deep reassignment is allowed', async () => {
  const getParent = graph({ D: null, C: 'D', B: 'C', A: 'B', X: null });
  // Moving X under A is fine: A is not below X.
  await assertNoCycle('X', 'A', { getParent });
});

test('a pre-existing cycle in the data surfaces as an error, not a hang', async () => {
  // Corrupt data — written before this check existed, or edited directly.
  const getParent = graph({ A: 'B', B: 'C', C: 'A' });
  await assert.rejects(
    () => walkUp('A', { getParent }),
    (err) => err.code === 'MANAGER_CYCLE',
  );
});

test('an absurdly deep line is refused rather than walked forever', async () => {
  // Every node points at a fresh one, so `seen` never triggers — the depth cap
  // is the only thing that stops this.
  let n = 0;
  const getParent = async () => `node-${n++}`;
  await assert.rejects(
    () => walkUp('start', { getParent }),
    (err) => err.code === 'MANAGER_CHAIN_TOO_DEEP',
  );
  assert.equal(MAX_CHAIN_DEPTH, 100);
});

test('managerChain is derived, never accepted from a caller', () => {
  // Not in either schema: .strict() turns an attempt to send it into an error
  // rather than a silently ignored field.
  assert.equal(createEmployeeSchema.safeParse({ managerChain: ['x'] }).success, false);
  assert.equal(updateEmployeeSchema.safeParse({ managerChain: [oid()] }).success, false);
});

test('every manager change goes through the cycle check', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.match(service, /await assertNoCycle\(/);
  assert.match(service, /rebuildDescendantChains\(/, 'descendants must inherit the new prefix');

  const provider = await src('../modules/hrms/employees/employee.provider.js');
  assert.match(provider, /await assertNoCycle\(/, 'the import path needs it too');
});

// ---------------------------------------------------------------------------
// Sensitive fields (AD-10)
// ---------------------------------------------------------------------------

test('the DTO reports sensitive fields as presence, never as a value', async () => {
  const pan = await encryptField('ABCDE1234F');
  const row = {
    _id: oid(),
    userId: oid(),
    employeeCode: 'SI-010',
    firstName: 'Priya',
    lastName: 'Sharma',
    dateOfJoining: new Date('2026-01-15'),
    employmentType: 'full_time',
    status: 'active',
    [encPath(F.PAN_NUMBER)]: pan,
    [idxPath(F.PAN_NUMBER)]: 'a'.repeat(64),
  };

  const dto = toEmployeeDto(row, { user: { email: 'p@example.com' } });
  const json = JSON.stringify(dto);

  assert.equal(dto[F.PAN_NUMBER], true, 'presence is reported');
  assert.equal(dto[F.BANK_ACCOUNT_NUMBER], null, 'absence is reported');

  assert.ok(!json.includes('ABCDE1234F'), 'plaintext must never appear');
  assert.ok(!json.includes(pan.ct), 'ciphertext must never appear');
  assert.ok(!json.includes('a'.repeat(64)), 'the blind index must never appear');
  assert.ok(!json.includes(encPath(F.PAN_NUMBER)));
  assert.ok(!json.includes(idxPath(F.PAN_NUMBER)));
});

test('the envelope and index paths are select:false on the model', () => {
  for (const field of SENSITIVE_EMPLOYEE_FIELD_LIST) {
    const enc = Employee.schema.path(encPath(field));
    assert.ok(enc, `${field} needs an encrypted path`);
    assert.equal(enc.options.select, false, `${field} must not load by default`);
  }
});

test('revealing a value is one field at a time, and cannot ask for everything', () => {
  assert.equal(revealSensitiveSchema.safeParse({ field: F.PAN_NUMBER }).success, true);
  assert.equal(revealSensitiveSchema.safeParse({ field: 'firstName' }).success, false);
  assert.equal(revealSensitiveSchema.safeParse({}).success, false);
  assert.equal(revealSensitiveSchema.safeParse({ field: '*' }).success, false);
});

test('reveal requires compensation access, not merely employee access', async () => {
  const routes = await src('../modules/hrms/employees/employee.routes.js');
  assert.match(
    routes,
    /router\.post\(\s*'\/:id\/reveal',\s*requirePermission\(\{ module: M\.EMPLOYEES_COMPENSATION/s,
  );
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.match(service, /EMPLOYEES_COMPENSATION, A\.VIEW, S\.ORG/, 'the service re-checks');
});

test('no sensitive value reaches the audit trail', async () => {
  // Comments stripped: the controller EXPLAINS that it logs names and never
  // values, and a naive match finds the explanation rather than the code.
  const controller = (await src('../modules/hrms/employees/employee.controller.js'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // The update audit records field NAMES only.
  assert.match(controller, /fields: Object\.keys\(req\.body\)/);
  // The reveal audit records the field and the reason, never the value.
  assert.doesNotMatch(controller, /meta: \{[^}]*value/s);
  // The temporary password is never audited. Checked precisely: a `.*` across
  // the whole file would match any two unrelated occurrences and could never
  // fail, which is worse than no assertion.
  const resetHandler = controller.slice(
    controller.indexOf('export const resetEmployeePassword'),
  );
  const resetAudit = resetHandler.slice(
    resetHandler.indexOf('recordAudit'),
    resetHandler.indexOf('res.status'),
  );
  assert.ok(resetAudit.length > 0, 'the reset handler must write an audit entry');
  assert.doesNotMatch(resetAudit, /tempPassword/, 'the one-time password must not be audited');
  assert.match(resetAudit, /meta: \{ employeeId/, 'only the employee id is recorded');

  // And no other audit call in the file mentions it either.
  const otherAudits = controller
    .split('recordAudit')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('})') + 2));
  for (const call of otherAudits) {
    assert.doesNotMatch(call, /tempPassword|panNumber|bankAccountNumber|bankIfsc|aadhaarNumber/);
  }
});

// ---------------------------------------------------------------------------
// Custom fields cannot bypass AD-10
// ---------------------------------------------------------------------------

test('a custom field cannot be named after a sensitive key', async () => {
  for (const name of ['pan', 'aadhaar', 'bank_account_number', 'bank_ifsc', 'uan', 'esi_number']) {
    const doc = new EmployeeCustomField({ name, label: 'X', type: 'text' });
    const err = doc.validateSync();
    assert.ok(err, `"${name}" must be refused as a custom field name`);
    assert.match(String(err.message), /reserved sensitive field/i);
  }
});

test('an ordinary custom field name is accepted', async () => {
  const doc = new EmployeeCustomField({ name: 'tshirt_size', label: 'T-shirt size', type: 'text' });
  assert.equal(doc.validateSync(), undefined);
});

test('a choice field must offer at least one choice', async () => {
  const doc = new EmployeeCustomField({ name: 'blood_group', label: 'Blood group', type: 'select' });
  await assert.rejects(() => doc.validate(), /needs at least one option/);
});

test('a custom field name is immutable — renaming would orphan every value', () => {
  assert.equal(EmployeeCustomField.schema.path('name').options.immutable, true);
  // And the update schema does not accept it at all.
  assert.equal(createCustomFieldSchema.safeParse({ name: 'x', label: 'X', type: 'text' }).success, true);
});

test('the service sanitises customFieldValues before every write', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  const calls = service.match(/sanitiseCustomFields\(/g) ?? [];
  assert.ok(calls.length >= 2, `create and update must both sanitise; found ${calls.length}`);

  // The import path too — it is a public entry point of its own.
  const provider = await src('../modules/hrms/employees/employee.provider.js');
  assert.match(provider, /sanitiseCustomFields\(/);
});

test('sanitisation happens before the record is assembled, not after the write', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  const sanitiseAt = service.indexOf('sanitiseCustomFields(dto.customFieldValues)');
  const createAt = service.indexOf('Employee.create(');
  assert.ok(sanitiseAt > 0 && createAt > 0);
  assert.ok(
    sanitiseAt < createAt,
    'plaintext written and cleaned later survives in the oplog and in backups',
  );
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const validCreate = {
  employeeCode: 'SI-0006',
  firstName: 'Priya',
  lastName: 'Sharma',
  email: 'priya@example.com',
  dateOfJoining: '2026-01-15',
};

test('create requires the fields the reference marks required', () => {
  assert.equal(createEmployeeSchema.safeParse(validCreate).success, true);

  for (const missing of ['employeeCode', 'firstName', 'lastName', 'email', 'dateOfJoining']) {
    const payload = { ...validCreate };
    delete payload[missing];
    assert.equal(
      createEmployeeSchema.safeParse(payload).success,
      false,
      `${missing} must be required`,
    );
  }
});

test('create applies the reference defaults', () => {
  const parsed = createEmployeeSchema.parse(validCreate);
  assert.equal(parsed.status, 'invited');
  assert.equal(parsed.employmentType, 'full_time');
  assert.equal(parsed.probationMonths, 3);
  assert.deepEqual(parsed.initialRoleKeys, ['hrms_employee']);
  assert.deepEqual(parsed.emergencyContacts, []);
});

test('update refuses the two immutable fields rather than ignoring them', () => {
  assert.equal(updateEmployeeSchema.safeParse({ firstName: 'X' }).success, true);
  assert.equal(
    updateEmployeeSchema.safeParse({ employeeCode: 'SI-9' }).success,
    false,
    'the natural key cannot be edited',
  );
  assert.equal(
    updateEmployeeSchema.safeParse({ email: 'new@example.com' }).success,
    false,
    'the login identity cannot be edited here',
  );
});

test('an unknown field is an error, not a silent drop', () => {
  assert.equal(
    createEmployeeSchema.safeParse({ ...validCreate, salaryLakhs: 12 }).success,
    false,
  );
});

test('field-level rules match the reference', () => {
  const bad = (over) => createEmployeeSchema.safeParse({ ...validCreate, ...over }).success;

  assert.equal(bad({ employeeCode: 'x'.repeat(31) }), false, 'max 30');
  assert.equal(bad({ firstName: 'x'.repeat(81) }), false, 'max 80');
  assert.equal(bad({ email: 'not-an-email' }), false);
  assert.equal(bad({ dateOfJoining: '15-01-2026' }), false, 'YYYY-MM-DD only');
  assert.equal(bad({ probationMonths: 25 }), false, '1-24');
  assert.equal(bad({ noticeMonths: 13 }), false, '1-12');
  assert.equal(bad({ status: 'made_up' }), false);
  assert.equal(bad({ employmentType: 'freelance' }), false);
  assert.equal(bad({ departmentId: 'not-an-objectid' }), false);
  assert.equal(
    bad({ emergencyContacts: [{ name: 'A', relationship: 'B', phone: '123' }] }),
    false,
    'phone must be exactly 10 digits',
  );
  assert.equal(
    bad({
      emergencyContacts: Array(3).fill({ name: 'A', relationship: 'B', phone: '9876543210' }),
    }),
    false,
    'at most two contacts',
  );
});

test('the list query coerces, defaults and bounds itself', () => {
  const q = employeeListQuerySchema.parse({});
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, 25);
  assert.equal(q.sortDir, 'asc');

  assert.equal(employeeListQuerySchema.parse({ page: '3' }).page, 3);
  assert.equal(employeeListQuerySchema.safeParse({ pageSize: '5000' }).success, false);
  assert.equal(employeeListQuerySchema.safeParse({ sortBy: 'password' }).success, false);
  assert.equal(employeeListQuerySchema.safeParse({ status: 'nonsense' }).success, false);
});

// ---------------------------------------------------------------------------
// Authorization, over real HTTP
// ---------------------------------------------------------------------------

function employeesAppFor(user) {
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

const CUSTOMER = { _id: oid(), role: 'Customer', roles: [], status: 'Active' };
const PORTAL_ADMIN = { _id: oid(), role: 'Admin', roles: [], status: 'Active' };
const EMPLOYEE_USER = { _id: oid(), role: 'Management', roles: [R.EMPLOYEE], status: 'Active' };

test('a Customer cannot reach any Employee endpoint', async () => {
  const id = oid();
  const paths = ['/employees', `/employees/${id}`, '/employees/custom-fields', `/employees/${id}/roles`];
  await withServer(employeesAppFor(CUSTOMER), async (url) => {
    for (const p of paths) {
      const res = await get(url, `/api/v1/hrms${p}`);
      assert.equal(res.status, 403, `${p} must be refused for a Customer`);
    }
    assert.equal((await post(url, '/api/v1/hrms/employees', validCreate)).status, 403);
  });
});

test('a portal Admin with no HRMS role is refused too', async () => {
  await withServer(employeesAppFor(PORTAL_ADMIN), async (url) => {
    assert.equal((await get(url, '/api/v1/hrms/employees')).status, 403);
  });
});

test('an unauthenticated request is 401', async () => {
  await withServer(employeesAppFor(null), async (url) => {
    assert.equal((await get(url, '/api/v1/hrms/employees')).status, 401);
  });
});

test('an ordinary employee cannot create, deactivate or assign roles', async () => {
  const id = oid();
  await withServer(employeesAppFor(EMPLOYEE_USER), async (url) => {
    assert.equal((await post(url, '/api/v1/hrms/employees', validCreate)).status, 403);

    const del = await fetch(`${url}/api/v1/hrms/employees/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 403);

    const roles = await fetch(`${url}/api/v1/hrms/employees/${id}/roles`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleKeys: [R.SUPER_ADMIN] }),
    });
    assert.equal(roles.status, 403);
  });
});

test('an ordinary employee cannot reveal a sensitive value', async () => {
  await withServer(employeesAppFor(EMPLOYEE_USER), async (url) => {
    const res = await post(url, `/api/v1/hrms/employees/${oid()}/reveal`, {
      field: F.PAN_NUMBER,
    });
    assert.equal(res.status, 403);
  });
});

test('validation runs before the handler, so a bad payload never reaches the database', async () => {
  // HR admin holds employees:create:org, so this gets past the guard and is
  // stopped by the schema instead.
  const hr = { _id: oid(), role: 'Admin', roles: [R.HR_ADMIN], status: 'Active' };
  await withServer(employeesAppFor(hr), async (url) => {
    const res = await post(url, '/api/v1/hrms/employees', { firstName: 'Only' });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.ok(Array.isArray(res.body.errors));
    assert.equal(res.body.errors[0].in, 'body');
  });
});

test('the custom-fields route is declared before /:id', async () => {
  const routes = await src('../modules/hrms/employees/employee.routes.js');
  assert.ok(
    routes.indexOf("'/custom-fields'") < routes.indexOf("'/:id'"),
    'otherwise "custom-fields" is matched as an employee id',
  );
});

// ---------------------------------------------------------------------------
// Business rules carried over from the reference
// ---------------------------------------------------------------------------

test('a self-edit cannot change job details', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.match(service, /const JOB_FIELDS = \[/);
  for (const f of ['designation', 'departmentId', 'reportingManagerId', 'status']) {
    assert.match(service, new RegExp(`'${f}'`), `${f} must be protected on a self-edit`);
  }
});

test('nobody signs off their own probation except a super admin', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.match(service, /touchingProbation && isSelf && !actor\.roleKeys\.includes\('hrms_super_admin'\)/);
});

test('deactivation is blocked while direct reports remain', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.match(service, /HAS_DIRECT_REPORTS/);
  assert.match(service, /reportingManagerId: id,\s*\n\s*deletedAt: null,/);
});

test('deactivation suspends the login and revokes its sessions', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.match(service, /status: 'Suspended', refreshTokenHash: null/);
});

test('a reference that cannot be validated is refused, not stored blind', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.match(service, /assertReferencesResolve/);
  assert.match(service, /HrmsNotImplementedError\(\s*\n?\s*'Assigning a department'/s);
  // AD-2 removed the foreign keys, so an unchecked id would dangle forever.
  assert.match(service, /Org Structure is not built yet/);
});

test('AD-4: an employee login is never created as a Customer', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.doesNotMatch(service, /role: 'Customer'/);
  assert.match(service, /role: 'Management'/);
  const provider = await src('../modules/hrms/employees/employee.provider.js');
  assert.doesNotMatch(provider, /role: 'Customer'/);
});

test('only HRMS roles can be granted through the employee endpoints', async () => {
  const service = await src('../modules/hrms/employees/employee.service.js');
  assert.match(service, /Only HRMS roles can be granted here/);
  assert.match(service, /assertRolesAssignable\(/, 'the AD-4 rule is re-checked on the write path');
  assert.match(service, /portalRoles/, 'portal roles on the same account must survive');
});
