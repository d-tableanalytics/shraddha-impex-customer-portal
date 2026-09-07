/**
 * The employee import foundation (AD-11).
 *
 * Covers the whole pipeline without a database: a fake persistence port stands
 * in for the Phase 1 Employee collection, which is exactly the seam the design
 * exists to provide.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAndSanitise,
  checkDependencies,
  previewImport,
  commitImport,
} from '../modules/hrms/import/pipeline.js';
import {
  registerImportAdapter,
  registerEmployeePersistence,
  getEmployeePersistence,
  registeredImportAdapters,
  __resetImportRegistry,
  REQUIRED_PORT_METHODS,
} from '../modules/hrms/import/adapter.js';
import { canonicalEmployeeRecordSchema, FORBIDDEN_IMPORT_FIELDS } from '../modules/hrms/import/canonical.js';
import { SENSITIVE_EMPLOYEE_FIELDS as F } from '../shared/security/sensitive-fields.js';

const base = (over = {}) => ({
  employeeCode: 'E001',
  firstName: 'Priya',
  lastName: 'Sharma',
  email: 'priya@example.com',
  dateOfJoining: '2026-01-15',
  ...over,
});

/** A fake Phase 1 persistence port that records what the pipeline asked for. */
function fakePersistence({ existing = [], departments = ['ENG'], locations = ['HO'] } = {}) {
  const calls = [];
  return {
    calls,
    async findByEmployeeCodes(codes) {
      calls.push(['findByEmployeeCodes', codes]);
      return new Map(codes.filter((c) => existing.includes(c)).map((c) => [c, { employeeCode: c }]));
    },
    async resolveDepartmentCodes(codes) {
      calls.push(['resolveDepartmentCodes', codes]);
      return new Map(codes.filter((c) => departments.includes(c)).map((c) => [c, `dept-${c}`]));
    },
    async resolveLocationCodes(codes) {
      calls.push(['resolveLocationCodes', codes]);
      return new Map(codes.filter((c) => locations.includes(c)).map((c) => [c, `loc-${c}`]));
    },
    async upsertEmployees(records) {
      calls.push(['upsertEmployees', records]);
      return { created: records.length, updated: 0, byCode: new Map() };
    },
    async linkReportingManagers(links) {
      calls.push(['linkReportingManagers', links]);
      return links.length;
    },
    async rebuildManagerChains() {
      calls.push(['rebuildManagerChains']);
      return 1;
    },
    async seedLeaveBalances(codes) {
      calls.push(['seedLeaveBalances', codes]);
      return codes.length;
    },
  };
}

// ---------------------------------------------------------------------------
// The canonical shape
// ---------------------------------------------------------------------------

test('a minimal record validates and gets sane defaults', () => {
  const parsed = canonicalEmployeeRecordSchema.parse(base());
  assert.equal(parsed.employmentType, 'full_time');
  assert.equal(parsed.status, 'invited');
  assert.deepEqual(parsed.emergencyContacts, []);
  assert.deepEqual(parsed.customFieldValues, {});
});

test('an unknown column is an error, not a silent drop', () => {
  // A column the adapter forgot to map is data loss, and must surface in the
  // preview rather than after the commit.
  const r = canonicalEmployeeRecordSchema.safeParse(base({ salaryLakhs: 12 }));
  assert.equal(r.success, false);
});

test('managerChain and ids are refused with a reason', () => {
  const { errors } = validateAndSanitise([
    base({ managerChain: ['E999'] }),
    base({ employeeCode: 'E002', email: 'b@example.com', reportingManagerId: 'abc' }),
    base({ employeeCode: 'E003', email: 'c@example.com', _id: 'xyz' }),
    base({ employeeCode: 'E004', email: 'd@example.com', password: 'hunter2' }),
  ]);

  const fields = errors.map((e) => e.field);
  assert.ok(fields.includes('managerChain'));
  assert.ok(fields.includes('reportingManagerId'));
  assert.ok(fields.includes('_id'));
  assert.ok(fields.includes('password'));

  const chainError = errors.find((e) => e.field === 'managerChain');
  assert.match(chainError.message, /derived/i);
  assert.match(chainError.message, /team-scope/i);
  assert.equal(Object.keys(FORBIDDEN_IMPORT_FIELDS).length, 5);
});

// ---------------------------------------------------------------------------
// Sanitisation before the first write (AD-10 / AD-11)
// ---------------------------------------------------------------------------

test('sensitive values inside customFieldValues are moved out before anything is persisted', () => {
  const { valid, warnings } = validateAndSanitise([
    base({
      customFieldValues: {
        bank_account_number: '123456789012',
        bank_ifsc: 'HDFC0001234',
        bank_name: 'HDFC Bank',
        tshirtSize: 'L',
      },
    }),
  ]);

  assert.equal(valid.length, 1);
  const rec = valid[0].record;

  // Moved into the dedicated fields...
  assert.equal(rec[F.BANK_ACCOUNT_NUMBER], '123456789012');
  assert.equal(rec[F.BANK_IFSC], 'HDFC0001234');

  // ...and GONE from the blob that would be written.
  assert.equal('bank_account_number' in rec.customFieldValues, false);
  assert.equal('bank_ifsc' in rec.customFieldValues, false);
  assert.ok(!JSON.stringify(rec.customFieldValues).includes('123456789012'));

  // Non-sensitive fields survive untouched.
  assert.equal(rec.customFieldValues.bank_name, 'HDFC Bank');
  assert.equal(rec.customFieldValues.tshirtSize, 'L');

  assert.ok(warnings.some((w) => /Moved custom field/.test(w.message)));
});

test('a direct sensitive value wins over a duplicate in the blob, and the conflict is reported', () => {
  const { valid, warnings } = validateAndSanitise([
    base({
      [F.PAN_NUMBER]: 'DIRECT1234',
      customFieldValues: { pan: 'FROMBLOB99' },
    }),
  ]);
  assert.equal(valid[0].record[F.PAN_NUMBER], 'DIRECT1234');
  assert.ok(warnings.some((w) => /supplied both directly and inside customFieldValues/.test(w.message)));
});

// ---------------------------------------------------------------------------
// Dependency checking - AD-2 removed the FKs, so the pipeline must catch these
// ---------------------------------------------------------------------------

test('a duplicate employeeCode is refused - it is the natural key', async () => {
  const { valid } = validateAndSanitise([
    base(),
    base({ email: 'other@example.com' }), // same code
  ]);
  const { errors } = await checkDependencies(valid, { persistence: null });
  const dup = errors.find((e) => e.field === 'employeeCode');
  assert.ok(dup);
  assert.match(dup.message, /natural key/i);
});

test('a duplicate email is refused', async () => {
  const { valid } = validateAndSanitise([base(), base({ employeeCode: 'E002' })]);
  const { errors } = await checkDependencies(valid, { persistence: null });
  assert.ok(errors.some((e) => e.field === 'email'));
});

test('an unresolvable manager code is refused', async () => {
  const { valid } = validateAndSanitise([base({ reportingManagerCode: 'GHOST' })]);
  const { errors } = await checkDependencies(valid, { persistence: fakePersistence() });
  const err = errors.find((e) => e.field === 'reportingManagerCode');
  assert.ok(err);
  assert.match(err.message, /No FK constraint would catch this/);
});

test('a manager defined later in the same file resolves', async () => {
  const { valid } = validateAndSanitise([
    base({ employeeCode: 'E001', reportingManagerCode: 'E002' }),
    base({ employeeCode: 'E002', email: 'mgr@example.com' }),
  ]);
  const { errors } = await checkDependencies(valid, { persistence: fakePersistence() });
  assert.equal(
    errors.filter((e) => e.field === 'reportingManagerCode').length,
    0,
    'ordering within the file must not matter - that is why linking is a second pass',
  );
});

test('a manager who already exists in the database resolves', async () => {
  const { valid } = validateAndSanitise([base({ reportingManagerCode: 'BOSS' })]);
  const { errors } = await checkDependencies(valid, {
    persistence: fakePersistence({ existing: ['BOSS'] }),
  });
  assert.equal(errors.filter((e) => e.field === 'reportingManagerCode').length, 0);
});

test('self-reporting is refused', async () => {
  const { valid } = validateAndSanitise([base({ reportingManagerCode: 'E001' })]);
  const { errors } = await checkDependencies(valid, { persistence: fakePersistence() });
  assert.ok(errors.some((e) => /cannot report to themselves/.test(e.message)));
});

test('a reporting cycle is refused - managerChain could not be derived', async () => {
  const { valid } = validateAndSanitise([
    base({ employeeCode: 'A', email: 'a@example.com', reportingManagerCode: 'B' }),
    base({ employeeCode: 'B', email: 'b@example.com', reportingManagerCode: 'C' }),
    base({ employeeCode: 'C', email: 'c@example.com', reportingManagerCode: 'A' }),
  ]);
  const { errors } = await checkDependencies(valid, { persistence: fakePersistence() });
  const cycle = errors.find((e) => /cycle/i.test(e.message));
  assert.ok(cycle, 'a cycle would make managerChain infinite in pass 3');
});

test('unknown department and location codes are refused', async () => {
  const { valid } = validateAndSanitise([
    base({ departmentCode: 'NOPE', locationCode: 'ALSONOPE' }),
  ]);
  const { errors } = await checkDependencies(valid, { persistence: fakePersistence() });
  assert.ok(errors.some((e) => e.field === 'departmentCode'));
  assert.ok(errors.some((e) => e.field === 'locationCode'));
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('preview reports totals and separates creates from updates, writing nothing', async () => {
  const persistence = fakePersistence({ existing: ['E002'] });
  const report = await previewImport(
    [
      base({ employeeCode: 'E001', departmentCode: 'ENG' }),
      base({ employeeCode: 'E002', email: 'b@example.com', departmentCode: 'ENG' }),
    ],
    { persistence },
  );

  assert.equal(report.totals.received, 2);
  assert.equal(report.totals.importable, 2);
  assert.equal(report.totals.toCreate, 1);
  assert.equal(report.totals.toUpdate, 1);
  assert.equal(report.canCommit, true);

  const wrote = persistence.calls.some(([m]) =>
    ['upsertEmployees', 'linkReportingManagers', 'rebuildManagerChains'].includes(m),
  );
  assert.equal(wrote, false, 'a preview must not write');
});

test('preview never echoes a sensitive value back', async () => {
  const report = await previewImport(
    [base({ [F.PAN_NUMBER]: 'ABCDE1234F', customFieldValues: { bank_ifsc: 'HDFC0001234' } })],
    { persistence: fakePersistence() },
  );
  const json = JSON.stringify(report);
  assert.ok(!json.includes('ABCDE1234F'));
  assert.ok(!json.includes('HDFC0001234'));
  // It says WHICH fields were supplied, not what they contain.
  assert.deepEqual(report.sample[0].sensitiveFieldsSupplied.sort(), [F.BANK_IFSC, F.PAN_NUMBER].sort());
});

test('preview refuses to allow a commit when any row has an error', async () => {
  const report = await previewImport([base(), base()], { persistence: fakePersistence() });
  assert.equal(report.canCommit, false);
  assert.ok(report.totals.errors > 0);
});

// ---------------------------------------------------------------------------
// Commit - the three passes
// ---------------------------------------------------------------------------

test('commit runs the three passes in order, then seeds leave balances', async () => {
  const persistence = fakePersistence();
  const outcome = await commitImport(
    [
      base({ employeeCode: 'E001', reportingManagerCode: 'E002', departmentCode: 'ENG' }),
      base({ employeeCode: 'E002', email: 'mgr@example.com', departmentCode: 'ENG' }),
    ],
    { persistence },
  );

  assert.equal(outcome.committed, true);

  const order = persistence.calls
    .map(([m]) => m)
    .filter((m) =>
      ['upsertEmployees', 'linkReportingManagers', 'rebuildManagerChains', 'seedLeaveBalances'].includes(m),
    );
  assert.deepEqual(order, [
    'upsertEmployees',
    'linkReportingManagers',
    'rebuildManagerChains',
    'seedLeaveBalances',
  ]);

  // Pass 1 must NOT carry the manager reference - the manager may not exist yet.
  const [, upserted] = persistence.calls.find(([m]) => m === 'upsertEmployees');
  for (const rec of upserted) {
    assert.equal('reportingManagerCode' in rec, false);
    assert.equal('managerChain' in rec, false, 'managerChain is derived in pass 3');
  }

  assert.equal(outcome.result.managersLinked, 1);
  assert.equal(outcome.result.leaveBalancesSeeded, 2);
});

test('commit refuses outright when the preview has errors - no partial migration', async () => {
  const persistence = fakePersistence();
  const outcome = await commitImport([base(), base()], { persistence });

  assert.equal(outcome.committed, false);
  assert.match(outcome.reason, /Nothing was written/);
  assert.equal(
    persistence.calls.some(([m]) => m === 'upsertEmployees'),
    false,
  );
});

test('commit without a registered persistence port fails with a clear explanation', async (t) => {
  t.after(() => __resetImportRegistry());
  __resetImportRegistry();
  await assert.rejects(
    () => commitImport([base()], { persistence: null }),
    /No employee persistence port is registered/,
  );
});

// ---------------------------------------------------------------------------
// The adapter boundary
// ---------------------------------------------------------------------------

test('no source adapter is shipped - AD-11 leaves the source undecided', (t) => {
  t.after(() => __resetImportRegistry());
  __resetImportRegistry();
  assert.deepEqual(
    registeredImportAdapters(),
    [],
    'shipping a default adapter would be an assumption about the source',
  );
});

test('an adapter can be registered when a source is chosen', (t) => {
  t.after(() => __resetImportRegistry());
  __resetImportRegistry();

  registerImportAdapter('example', { load: async () => [base()] });
  assert.deepEqual(registeredImportAdapters(), ['example']);
  assert.throws(() => registerImportAdapter('bad', {}), TypeError);
});

test('a half-implemented persistence port is refused at registration', (t) => {
  t.after(() => __resetImportRegistry());
  __resetImportRegistry();

  assert.throws(() => registerEmployeePersistence({}), /missing/);
  assert.throws(
    () => registerEmployeePersistence({ upsertEmployees: async () => {} }),
    /missing/,
  );

  const full = fakePersistence();
  registerEmployeePersistence(full);
  assert.equal(getEmployeePersistence(), full);

  for (const m of REQUIRED_PORT_METHODS) {
    assert.equal(typeof full[m], 'function', `the fake must implement ${m}`);
  }
});
