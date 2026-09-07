/**
 * Payroll — the HTTP layer, the run lifecycle and the integrations.
 *
 * A real Express app over a real MongoDB, following the pattern Employee
 * Master, Org Structure and Attendance established. Only `protect` is stubbed;
 * the permission chain, the validator, the services and the error handler are
 * the genuine article.
 *
 * The assertions that matter most here are the ones the engine tests cannot
 * make: authorization, the state machine under concurrency, duplicate
 * prevention, Decimal128 round-tripping, and that unpaid leave and holidays
 * actually reach a payslip.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import User from '../models/User.js';
import CompanyProfile from '../models/hrms/CompanyProfile.js';
import Holiday from '../models/hrms/Holiday.js';
import LeaveType from '../models/hrms/LeaveType.js';
import LeaveRequest from '../models/hrms/LeaveRequest.js';
import AuditLog from '../models/AuditLog.js';
import {
  PayGroup,
  SalaryComponent,
  SalaryStructure,
  EmployeeCompensation,
  StatutoryConfig,
  PayrollRun,
  Payslip,
  PayrollAdjustment,
} from '../models/hrms/PayrollModels.js';

import payrollRoutes from '../modules/hrms/payroll/payroll.routes.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { AUDIT_ACTIONS } from '../shared/constants/hrms.js';
import { fromDecimal } from '../shared/payroll/money.js';
import { buildTestApp, stubProtect, withServer, get, post, patch, del } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/payroll';
const oid = () => new mongoose.Types.ObjectId();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

before(async () => {
  await startTestMongo();
  await syncIndexes(
    Employee,
    User,
    PayGroup,
    SalaryComponent,
    SalaryStructure,
    EmployeeCompensation,
    StatutoryConfig,
    PayrollRun,
    Payslip,
    PayrollAdjustment,
    LeaveType,
    LeaveRequest,
    Holiday,
  );
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  __resetReferenceProviders();
  registerReferenceProvider('employee', employeeReferenceProvider);
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
  // AD-12: without a company state, payroll blocks. Set here so the happy path
  // works; a dedicated test clears it to prove the block.
  await CompanyProfile.create({ key: 'company-profile', defaultStateCode: 'MP' });
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/payroll', payrollRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;

async function makeEmployee({ roles = [R.EMPLOYEE], status = 'active' } = {}) {
  seq += 1;
  const user = await User.create({
    email: `pay${seq}@example.com`,
    password: 'x'.repeat(60),
    user: `Person ${seq}`,
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    userId: user._id,
    employeeCode: `PAY${String(seq).padStart(3, '0')}`,
    firstName: 'Person',
    lastName: String(seq),
    dateOfJoining: new Date('2024-01-01'),
    status,
  });
  return {
    user: { _id: user._id, role: 'Management', roles, status: 'Active' },
    employee,
    id: String(employee._id),
  };
}

/** A minimal but realistic statutory configuration, as TEST DATA. */
const STATUTORY_PAYLOAD = {
  pf: { employeeRate: 0.12, employerRate: 0.12, wageCeiling: 15000, epsCap: 15000 },
  esi: { employeeRate: 0.0075, employerRate: 0.0325, grossThreshold: 21000 },
  pt: { MP: [{ maxMonthlyWage: 18750, tax: 0 }, { maxMonthlyWage: null, tax: 208 }] },
  lwf: { MP: { periodicity: 'monthly', employee: 10, employer: 30 } },
  tds: {
    regime: 'new',
    old: {
      slabs: [{ min: 0, max: null, rate: 0 }],
      standardDeduction: 50000,
      chapter6AMax: 150000,
      hraExemption: true,
    },
    new: { slabs: [{ min: 0, max: null, rate: 0 }], standardDeduction: 75000 },
    cess: 0.04,
  },
};

/**
 * Build the whole payroll setup an admin would: statutory config, pay group,
 * components, a structure, and compensation for `employees`.
 */
async function seedPayroll(url, employees = [], { ctc = '900000' } = {}) {
  const cfg = await post(url, `${P}/statutory`, {
    effectiveFrom: '2020-01-01',
    config: STATUTORY_PAYLOAD,
  });
  assert.equal(cfg.status, 201, JSON.stringify(cfg.body));

  const group = await post(url, `${P}/pay-groups`, {
    code: 'MAIN',
    name: 'Main Payroll',
    legalEntityName: 'Shraddha Impex Private Limited',
    isDefault: true,
  });
  assert.equal(group.status, 201, JSON.stringify(group.body));

  const mk = (body) => post(url, `${P}/components`, body);
  const basic = await mk({
    code: 'BASIC',
    name: 'Basic',
    type: 'earning',
    calculationType: 'percent_of',
    formula: { pct_of_annual: 'CTC', percent: 40 },
    order: 1,
  });
  const hra = await mk({
    code: 'HRA',
    name: 'House Rent Allowance',
    type: 'earning',
    calculationType: 'percent_of',
    formula: { of: 'BASIC', percent: 40 },
    order: 2,
  });
  const pf = await mk({
    code: 'PF_EE',
    name: 'Provident Fund',
    type: 'deduction',
    calculationType: 'statutory',
    statutoryLink: 'pf',
    taxable: false,
    order: 10,
  });
  for (const r of [basic, hra, pf]) assert.equal(r.status, 201, JSON.stringify(r.body));

  const structure = await post(url, `${P}/structures`, {
    name: 'Standard',
    payGroupId: group.body.data.id,
    isDefault: true,
    components: [
      { componentId: basic.body.data.id, order: 1 },
      { componentId: hra.body.data.id, order: 2 },
      { componentId: pf.body.data.id, order: 10 },
    ],
  });
  assert.equal(structure.status, 201, JSON.stringify(structure.body));

  for (const emp of employees) {
    const comp = await post(url, `${P}/compensation`, {
      employeeId: emp.id,
      payGroupId: group.body.data.id,
      structureId: structure.body.data.id,
      ctc,
      effectiveFrom: '2024-01-01',
      stateCode: 'MP',
    });
    assert.equal(comp.status, 201, JSON.stringify(comp.body));
  }

  return {
    payGroupId: group.body.data.id,
    structureId: structure.body.data.id,
    componentIds: { basic: basic.body.data.id, hra: hra.body.data.id, pf: pf.body.data.id },
  };
}

// ===========================================================================
// Authorization
// ===========================================================================

describe('authorization', () => {
  test('every payroll endpoint refuses an unauthenticated caller', async () => {
    await withServer(appFor(null), async (url) => {
      for (const route of ['/runs', '/pay-groups', '/components', '/structures', '/statutory', '/payslips/mine']) {
        assert.equal((await get(url, `${P}${route}`)).status, 401, route);
      }
      assert.equal((await post(url, `${P}/runs`, {})).status, 401);
    });
  });

  test('a portal Customer holds no HRMS grant and is refused (AD-4)', async () => {
    const customer = { _id: oid(), role: 'Customer', roles: ['Customer'], status: 'Active' };
    await withServer(appFor(customer), async (url) => {
      const res = await get(url, `${P}/runs`);
      assert.equal(res.status, 403);
      assert.match(res.body.message, /no HRMS access/i);
    });
  });

  test('an ordinary employee can reach only their own payslips', async () => {
    const { user } = await makeEmployee();
    await withServer(appFor(user), async (url) => {
      assert.equal((await get(url, `${P}/payslips/mine`)).status, 200);
      // Everything that reveals the company's payroll is refused.
      for (const route of ['/runs', '/pay-groups', '/components', '/structures', '/statutory']) {
        assert.equal((await get(url, `${P}${route}`)).status, 403, route);
      }
    });
  });

  test('an HR admin may view payroll but may NOT run it or edit structures', async () => {
    const { user } = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(user), async (url) => {
      assert.equal((await get(url, `${P}/runs`)).status, 200, 'payroll:view:org');
      assert.equal(
        (await post(url, `${P}/runs`, { payGroupId: String(oid()), month: 6, year: 2026 })).status,
        403,
        'hr_admin holds no payroll:run',
      );
      assert.equal(
        (await post(url, `${P}/pay-groups`, {
          code: 'X',
          name: 'X',
          legalEntityName: 'X',
        })).status,
        403,
        'hr_admin holds no payroll:structure:edit',
      );
    });
  });

  test('🔴 compensation is gated on employees:compensation, not on payroll', async () => {
    const subject = await makeEmployee();

    // hr_admin holds payroll:view:org and payroll:run:org but NO compensation
    // grant — being able to see the company's payroll totals is not being
    // entitled to browse what individuals earn.
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      assert.equal((await get(url, `${P}/runs`)).status, 200, 'hr_admin sees payroll');
      assert.equal(
        (await get(url, `${P}/compensation/${subject.id}`)).status,
        403,
        'seeing payroll is not the same as reading a CTC',
      );
    });

    // payroll_admin holds employees:compensation:VIEW but not EDIT, so it may
    // read a salary and may not set one.
    const payroll = await makeEmployee({ roles: [R.PAYROLL_ADMIN] });
    await withServer(appFor(payroll.user), async (url) => {
      assert.equal((await get(url, `${P}/compensation/${subject.id}`)).status, 200);
      const write = await post(url, `${P}/compensation`, {
        employeeId: subject.id,
        payGroupId: String(oid()),
        structureId: String(oid()),
        ctc: '600000',
        effectiveFrom: '2026-01-01',
      });
      assert.equal(write.status, 403, 'reading a salary is not setting one');
    });

    // super_admin holds both.
    const superAdmin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(superAdmin.user), async (url) => {
      assert.equal((await get(url, `${P}/compensation/${subject.id}`)).status, 200);
    });
  });
});

// ===========================================================================
// Catalogue
// ===========================================================================

describe('catalogue', () => {
  test('a duplicate pay group code is a 409', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const body = { code: 'MAIN', name: 'Main', legalEntityName: 'Entity' };
      assert.equal((await post(url, `${P}/pay-groups`, body)).status, 201);
      const second = await post(url, `${P}/pay-groups`, body);
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'PAY_GROUP_CODE_TAKEN');
    });
  });

  test('exactly one pay group is the default', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      await post(url, `${P}/pay-groups`, { code: 'A', name: 'A', legalEntityName: 'A', isDefault: true });
      await post(url, `${P}/pay-groups`, { code: 'B', name: 'B', legalEntityName: 'B', isDefault: true });

      const list = await get(url, `${P}/pay-groups`);
      const defaults = list.body.data.filter((g) => g.isDefault);
      assert.equal(defaults.length, 1);
      assert.equal(defaults[0].code, 'B');
    });
  });

  test('a malformed formula is refused at the boundary', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const res = await post(url, `${P}/components`, {
        code: 'BAD',
        name: 'Bad',
        type: 'earning',
        calculationType: 'percent_of',
        // The reference stores this happily and pays zero.
        formula: { of: 'BASIC' },
      });
      assert.equal(res.status, 400);
      assert.match(JSON.stringify(res.body), /formula/i);
    });
  });

  test('a statutory component must name its bucket, and only a statutory one may', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const noLink = await post(url, `${P}/components`, {
        code: 'PF_X',
        name: 'PF',
        type: 'deduction',
        calculationType: 'statutory',
      });
      assert.equal(noLink.status, 400, 'statutory with no link would compute zero');

      const strayLink = await post(url, `${P}/components`, {
        code: 'FIXED_X',
        name: 'Fixed',
        type: 'earning',
        calculationType: 'fixed',
        formula: { amount: 100 },
        statutoryLink: 'pf',
      });
      assert.equal(strayLink.status, 400);
    });
  });

  test('🔴 a structure whose formula references a missing component is refused', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const group = await post(url, `${P}/pay-groups`, {
        code: 'G',
        name: 'G',
        legalEntityName: 'G',
      });
      const hra = await post(url, `${P}/components`, {
        code: 'HRA',
        name: 'HRA',
        type: 'earning',
        calculationType: 'percent_of',
        formula: { of: 'BASIC', percent: 40 },
      });

      // HRA depends on BASIC, which this structure does not contain. The
      // reference stores it and silently pays zero house rent allowance.
      const res = await post(url, `${P}/structures`, {
        name: 'Broken',
        payGroupId: group.body.data.id,
        components: [{ componentId: hra.body.data.id, order: 1 }],
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /BASIC/);
    });
  });

  test('the preview runs the REAL engine, so it cannot disagree with payroll', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const { structureId } = await seedPayroll(url, []);
      const res = await post(url, `${P}/structures/${structureId}/preview`, {
        ctc: '900000',
        stateCode: 'MP',
        month: 6,
        year: 2026,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.monthlyGross, 42000, 'BASIC 30000 + HRA 12000');
      assert.equal(res.body.data.monthlyNet, 42000 - 3600);

      const basic = res.body.data.lines.find((l) => l.componentCode === 'BASIC');
      assert.equal(basic.monthly, 30000);
      assert.equal(basic.annual, 360000);
    });
  });

  test('a component still used by a structure cannot be retired', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const { componentIds } = await seedPayroll(url, []);
      const res = await del(url, `${P}/components/${componentIds.basic}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'COMPONENT_IN_USE');
    });
  });
});

// ===========================================================================
// Statutory configuration (AD-12)
// ===========================================================================

describe('statutory configuration', () => {
  test('has NO defaults — a missing rate is a 400, not an assumption', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const res = await post(url, `${P}/statutory`, {
        effectiveFrom: '2026-04-01',
        // The reference defaults this to one particular year's Indian rules.
        config: { ...STATUTORY_PAYLOAD, pf: {} },
      });
      assert.equal(res.status, 400);
    });
  });

  test('adding a version closes the previous one the day before', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      await post(url, `${P}/statutory`, {
        effectiveFrom: '2024-04-01',
        config: STATUTORY_PAYLOAD,
      });
      await post(url, `${P}/statutory`, {
        effectiveFrom: '2025-04-01',
        config: STATUTORY_PAYLOAD,
      });

      const list = await get(url, `${P}/statutory`);
      const rows = list.body.data;
      assert.equal(rows.length, 2);
      const older = rows.find((r) => r.effectiveFrom === '2024-04-01');
      assert.equal(older.effectiveTo, '2025-03-31', 'closed the day before');
    });
  });

  test('resolves the version in force on a date', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      await post(url, `${P}/statutory`, { effectiveFrom: '2024-04-01', config: STATUTORY_PAYLOAD });
      await post(url, `${P}/statutory`, { effectiveFrom: '2025-04-01', config: STATUTORY_PAYLOAD });

      const early = await get(url, `${P}/statutory/effective?on=2024-06-15`);
      assert.equal(early.body.data.effectiveFrom, '2024-04-01');
      const later = await get(url, `${P}/statutory/effective?on=2025-06-15`);
      assert.equal(later.body.data.effectiveFrom, '2025-04-01');
      const before = await get(url, `${P}/statutory/effective?on=2020-01-01`);
      assert.equal(before.body.data, null, 'nothing in force is a null, not a 404');
    });
  });

  test('a configuration already in force cannot be edited or deleted', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const created = await post(url, `${P}/statutory`, {
        effectiveFrom: '2020-01-01',
        config: STATUTORY_PAYLOAD,
      });
      const id = created.body.data.id;

      const edit = await patch(url, `${P}/statutory/${id}`, { note: 'tweak' });
      assert.equal(edit.status, 409);
      assert.equal(edit.body.code, 'STATUTORY_CONFIG_IN_FORCE');

      assert.equal((await del(url, `${P}/statutory/${id}`)).status, 409);
    });
  });

  test('the covered states are reported, so a gap is visible', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      await post(url, `${P}/statutory`, { effectiveFrom: '2020-01-01', config: STATUTORY_PAYLOAD });
      const res = await get(url, `${P}/statutory/effective`);
      assert.deepEqual(res.body.data.coveredStates.pt, ['MP']);
      assert.deepEqual(res.body.data.coveredStates.lwf, ['MP']);
    });
  });
});

// ===========================================================================
// Compensation
// ===========================================================================

describe('compensation', () => {
  test('a revision closes the previous row rather than editing it', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const subject = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId, structureId } = await seedPayroll(url, []);

      const base = {
        employeeId: subject.id,
        payGroupId,
        structureId,
        stateCode: 'MP',
      };
      await post(url, `${P}/compensation`, { ...base, ctc: '600000', effectiveFrom: '2024-01-01' });
      await post(url, `${P}/compensation`, {
        ...base,
        ctc: '900000',
        effectiveFrom: '2026-04-01',
        revisionReason: 'Annual increment',
      });

      const history = await get(url, `${P}/compensation/${subject.id}`);
      assert.equal(history.body.data.total, 2);
      const [current, previous] = history.body.data.data;
      assert.equal(current.ctc, 900000);
      assert.equal(current.effectiveTo, null);
      assert.equal(previous.ctc, 600000);
      assert.equal(previous.effectiveTo, '2026-03-31', 'closed the day before the raise');
    });
  });

  test('CTC survives a Decimal128 round trip exactly', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const subject = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId, structureId } = await seedPayroll(url, []);
      await post(url, `${P}/compensation`, {
        employeeId: subject.id,
        payGroupId,
        structureId,
        ctc: '1234567.89',
        effectiveFrom: '2024-01-01',
        stateCode: 'MP',
      });

      const row = await EmployeeCompensation.findOne({ employeeId: subject.employee._id }).lean();
      assert.equal(row.ctc.constructor.name, 'Decimal128', 'stored as Decimal128, not a double');
      assert.equal(row.ctc.toString(), '1234567.89');
      assert.equal(fromDecimal(row.ctc), 1234567.89);
    });
  });

  test('a compensation crossing pay group and structure is refused', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const subject = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { structureId } = await seedPayroll(url, []);
      const other = await post(url, `${P}/pay-groups`, {
        code: 'OTHER',
        name: 'Other',
        legalEntityName: 'Other',
      });

      const res = await post(url, `${P}/compensation`, {
        employeeId: subject.id,
        payGroupId: other.body.data.id,
        structureId,
        ctc: '600000',
        effectiveFrom: '2024-01-01',
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /different pay group/i);
    });
  });

  test('a compensation change is audited with the before and after', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const subject = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId, structureId } = await seedPayroll(url, []);
      const base = { employeeId: subject.id, payGroupId, structureId, stateCode: 'MP' };
      await post(url, `${P}/compensation`, { ...base, ctc: '600000', effectiveFrom: '2024-01-01' });
      await post(url, `${P}/compensation`, { ...base, ctc: '900000', effectiveFrom: '2026-04-01' });

      const entries = await AuditLog.find({ action: AUDIT_ACTIONS.COMPENSATION_CHANGED })
        .sort({ createdAt: 1 })
        .lean();
      assert.equal(entries.length, 2);
      assert.equal(entries[1].meta.previousCtc, 600000);
      assert.equal(entries[1].meta.newCtc, 900000);
    });
  });
});

// ===========================================================================
// Run lifecycle
// ===========================================================================

describe('run lifecycle', () => {
  test('the happy path: create, compute, lock, disburse', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);

      const created = await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.status, 'draft');
      const runId = created.body.data.id;

      const computed = await post(url, `${P}/runs/${runId}/compute`, {});
      assert.equal(computed.status, 200);
      assert.equal(computed.body.data.payslipsGenerated, 1);
      assert.equal(computed.body.data.run.status, 'review');
      assert.equal(computed.body.data.run.totals.gross, 42000);
      assert.equal(computed.body.data.run.totals.netPay, 42000 - 3600);
      assert.equal(computed.body.data.run.totals.headcount, 1);

      const locked = await post(url, `${P}/runs/${runId}/lock`, {});
      assert.equal(locked.status, 200);
      assert.equal(locked.body.data.status, 'locked');
      assert.ok(locked.body.data.lockedAt);

      const disbursed = await post(url, `${P}/runs/${runId}/disburse`, {});
      assert.equal(disbursed.status, 200);
      assert.equal(disbursed.body.data.status, 'disbursed');
    });
  });

  test('a duplicate run for the same group and month is refused by the index', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, []);
      const body = { payGroupId, month: 6, year: 2026 };
      assert.equal((await post(url, `${P}/runs`, body)).status, 201);

      const second = await post(url, `${P}/runs`, body);
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'PAYROLL_RUN_EXISTS');
    });
  });

  test('concurrent creates produce exactly ONE run', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, []);
      const body = { payGroupId, month: 7, year: 2026 };

      const results = await Promise.all([
        post(url, `${P}/runs`, body),
        post(url, `${P}/runs`, body),
        post(url, `${P}/runs`, body),
      ]);
      assert.equal(results.filter((r) => r.status === 201).length, 1, 'paying twice is the risk');
      assert.equal(await PayrollRun.countDocuments({}), 1);
    });
  });

  test('🔴 a locked run cannot be recomputed, rolled back or adjusted', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});
      await post(url, `${P}/runs/${runId}/lock`, {});

      const recompute = await post(url, `${P}/runs/${runId}/compute`, {});
      assert.equal(recompute.status, 409);
      assert.equal(recompute.body.code, 'PAYROLL_RUN_INVALID_TRANSITION');

      assert.equal((await post(url, `${P}/runs/${runId}/rollback`, {})).status, 409);

      const adjust = await post(url, `${P}/runs/${runId}/adjustments`, {
        employeeId: alice.id,
        componentCode: 'BONUS',
        amount: '1000',
        reason: 'Too late',
      });
      assert.equal(adjust.status, 409);
      assert.equal(adjust.body.code, 'PAYROLL_RUN_IMMUTABLE');

      // The payslips are untouched.
      assert.equal(await Payslip.countDocuments({ runId }), 1);
    });
  });

  test('a disbursed run is fully immutable', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});
      await post(url, `${P}/runs/${runId}/lock`, {});
      await post(url, `${P}/runs/${runId}/disburse`, {});

      for (const action of ['compute', 'lock', 'rollback', 'disburse']) {
        const res = await post(url, `${P}/runs/${runId}/${action}`, {});
        assert.equal(res.status, 409, `${action} on a disbursed run`);
      }
    });
  });

  test('an out-of-order transition is refused', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, []);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;

      // draft -> locked is not a transition.
      const lock = await post(url, `${P}/runs/${runId}/lock`, {});
      assert.equal(lock.status, 409);
      // draft -> disbursed is not either.
      assert.equal((await post(url, `${P}/runs/${runId}/disburse`, {})).status, 409);
    });
  });

  test('locking a run with no payslips is refused', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});
      await post(url, `${P}/runs/${runId}/rollback`, {});

      // Back in draft with no payslips; lock is refused for the transition.
      const res = await post(url, `${P}/runs/${runId}/lock`, {});
      assert.equal(res.status, 409);
    });
  });

  test('a rollback discards the payslips and clears the totals', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});
      assert.equal(await Payslip.countDocuments({ runId }), 1);

      const rolled = await post(url, `${P}/runs/${runId}/rollback`, {});
      assert.equal(rolled.status, 200);
      assert.equal(rolled.body.data.status, 'draft');
      assert.equal(rolled.body.data.totals.gross, 0);
      assert.equal(await Payslip.countDocuments({ runId }), 0);
    });
  });

  test('a recompute replaces payslips rather than duplicating them', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});
      await post(url, `${P}/runs/${runId}/compute`, {});
      assert.equal(await Payslip.countDocuments({ runId }), 1);
    });
  });

  test('🔴 a run with no effective statutory configuration REFUSES', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      // Remove every configuration, so nothing is in force.
      await StatutoryConfig.deleteMany({});

      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      const res = await post(url, `${P}/runs/${runId}/compute`, {});
      assert.equal(res.status, 400);
      assert.match(res.body.message, /statutory configuration/i);
      // AD-12: it blocks rather than computing every statutory line as zero.
      assert.equal(await Payslip.countDocuments({}), 0);
    });
  });

  test('🔴 an employee with no resolvable state is SKIPPED and reported', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId, structureId } = await seedPayroll(url, []);
      // Compensation with no state, and no company default either.
      await post(url, `${P}/compensation`, {
        employeeId: alice.id,
        payGroupId,
        structureId,
        ctc: '900000',
        effectiveFrom: '2024-01-01',
      });
      await CompanyProfile.updateOne({}, { $set: { defaultStateCode: null } });

      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      const res = await post(url, `${P}/runs/${runId}/compute`, {});

      assert.equal(res.status, 200);
      assert.equal(res.body.data.payslipsGenerated, 0);
      assert.equal(res.body.data.skipped.length, 1);
      assert.match(res.body.data.skipped[0].reason, /state/i);
    });
  });

  test('a soft-deleted employee is skipped, not paid', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();
    const bob = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice, bob]);
      await Employee.updateOne({ _id: bob.employee._id }, { $set: { deletedAt: new Date() } });

      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      const res = await post(url, `${P}/runs/${runId}/compute`, {});

      assert.equal(res.body.data.payslipsGenerated, 1);
      assert.equal(res.body.data.skipped.length, 1);
      assert.equal(await Payslip.countDocuments({ employeeId: bob.employee._id }), 0);
    });
  });

  test('every lifecycle action is audited', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});
      await post(url, `${P}/runs/${runId}/lock`, {});
      await post(url, `${P}/runs/${runId}/disburse`, {});

      const actions = (await AuditLog.find({}).lean()).map((a) => a.action);
      for (const expected of [
        AUDIT_ACTIONS.PAYROLL_RUN_CREATED,
        AUDIT_ACTIONS.PAYROLL_RUN_COMPUTED,
        AUDIT_ACTIONS.PAYROLL_RUN_LOCKED,
        AUDIT_ACTIONS.PAYROLL_RUN_DISBURSED,
      ]) {
        assert.ok(actions.includes(expected), expected);
      }
    });
  });
});

// ===========================================================================
// Adjustments
// ===========================================================================

describe('adjustments', () => {
  test('an adjustment reaches the payslip on recompute and SURVIVES it', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});

      const adj = await post(url, `${P}/runs/${runId}/adjustments`, {
        employeeId: alice.id,
        componentCode: 'BONUS',
        amount: '5000',
        reason: 'Diwali bonus',
      });
      assert.equal(adj.status, 201);

      const recomputed = await post(url, `${P}/runs/${runId}/compute`, {});
      assert.equal(recomputed.body.data.run.totals.gross, 47000, '42000 + the 5000 bonus');

      // An adjustment is an intentional instruction, not derived data.
      assert.equal((await get(url, `${P}/runs/${runId}/adjustments`)).body.data.length, 1);
    });
  });

  test('a negative adjustment becomes a deduction', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/adjustments`, {
        employeeId: alice.id,
        componentCode: 'RECOVERY',
        amount: '-1500',
        reason: 'Laptop damage recovery',
      });
      const computed = await post(url, `${P}/runs/${runId}/compute`, {});

      assert.equal(computed.body.data.run.totals.gross, 42000, 'a recovery is not an earning');
      assert.equal(computed.body.data.run.totals.deductions, 3600 + 1500);
    });
  });

  test('a zero adjustment is refused at the boundary', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      const res = await post(url, `${P}/runs/${runId}/adjustments`, {
        employeeId: alice.id,
        componentCode: 'NOTHING',
        amount: '0',
        reason: 'No effect',
      });
      assert.equal(res.status, 400);
    });
  });
});

// ===========================================================================
// Leave and holiday integration
// ===========================================================================

describe('leave and holiday integration', () => {
  /** Approved leave of `paid` type over a range, for one employee. */
  async function grantLeave(employee, { paid, startDate, endDate, code }) {
    const type = await LeaveType.create({ code, name: code, paid });
    await LeaveRequest.create({
      employeeId: employee.employee._id,
      leaveTypeId: type._id,
      startDate,
      endDate,
      durationUnit: 'full_day',
      durationValue: 1,
      reason: 'Test leave for payroll',
      status: 'approved',
    });
  }

  test('🔴 UNPAID approved leave becomes a Loss of Pay line', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      // 15-17 June 2026 are Monday to Wednesday.
      await grantLeave(alice, {
        paid: false,
        code: 'LWP',
        startDate: '2026-06-15',
        endDate: '2026-06-17',
      });

      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});

      const payslip = await Payslip.findOne({ employeeId: alice.employee._id }).lean();
      assert.equal(payslip.lopDays, 3);
      const lop = payslip.lines.find((l) => l.componentCode === 'LOP');
      assert.ok(lop, 'a Loss of Pay line is present');
      // 42000 gross / 30 days = 1400 a day; three days is 4200.
      assert.equal(fromDecimal(lop.amount), 4200);
      assert.equal(fromDecimal(payslip.netPay), 42000 - 3600 - 4200);
    });
  });

  test('🔴 PAID approved leave costs nothing', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      await grantLeave(alice, {
        paid: true,
        code: 'AL',
        startDate: '2026-06-15',
        endDate: '2026-06-17',
      });

      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});

      const payslip = await Payslip.findOne({ employeeId: alice.employee._id }).lean();
      assert.equal(payslip.lopDays, 0);
      assert.equal(payslip.lines.some((l) => l.componentCode === 'LOP'), false);
      assert.equal(fromDecimal(payslip.netPay), 42000 - 3600);
    });
  });

  test('a PENDING unpaid leave is not docked — only approved leave counts', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const type = await LeaveType.create({ code: 'LWP', name: 'LWP', paid: false });
      await LeaveRequest.create({
        employeeId: alice.employee._id,
        leaveTypeId: type._id,
        startDate: '2026-06-15',
        endDate: '2026-06-17',
        durationUnit: 'full_day',
        durationValue: 3,
        reason: 'Not approved yet',
        status: 'pending',
      });

      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});

      const payslip = await Payslip.findOne({ employeeId: alice.employee._id }).lean();
      assert.equal(payslip.lopDays, 0);
    });
  });

  test('🔴 a HOLIDAY inside unpaid leave is not docked', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      await Holiday.create({ name: 'Test Holiday', date: '2026-06-16', year: 2026 });
      await grantLeave(alice, {
        paid: false,
        code: 'LWP',
        startDate: '2026-06-15',
        endDate: '2026-06-17',
      });

      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});

      const payslip = await Payslip.findOne({ employeeId: alice.employee._id }).lean();
      assert.equal(payslip.lopDays, 2, 'the company was closed on the 16th');
    });
  });

  test('a weekend inside unpaid leave is not docked', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      // 13 and 14 June 2026 are a Saturday and Sunday.
      await grantLeave(alice, {
        paid: false,
        code: 'LWP',
        startDate: '2026-06-13',
        endDate: '2026-06-15',
      });

      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});

      const payslip = await Payslip.findOne({ employeeId: alice.employee._id }).lean();
      assert.equal(payslip.lopDays, 1);
    });
  });

  test('attendance does NOT affect payroll — the reference consumes none of it', async () => {
    // Guards the finding rather than the code: if someone later wires
    // Attendance into the engine, this fails and the decision gets revisited
    // deliberately rather than by accident.
    const runService = await import('../modules/hrms/payroll/run.service.js');
    const source = runService.default ? Object.keys(runService.default) : [];
    assert.ok(source.length > 0);

    const { readFile } = await import('node:fs/promises');
    const text = await readFile(
      new URL('../modules/hrms/payroll/run.service.js', import.meta.url),
      'utf8',
    );
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(
      /AttendanceRecord|attendance\.service/i.test(code),
      false,
      'payroll must not read attendance — the reference does not, and inventing it would change pay',
    );
  });
});

// ===========================================================================
// Payslips
// ===========================================================================

describe('payslips', () => {
  /** A locked run with one payslip for `alice`. */
  async function lockedRunFor(url, alice) {
    const { payGroupId } = await seedPayroll(url, [alice]);
    const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
    await post(url, `${P}/runs/${runId}/compute`, {});
    await post(url, `${P}/runs/${runId}/lock`, {});
    return runId;
  }

  test('an employee sees their own locked payslip', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      await lockedRunFor(url, alice);
    });

    await withServer(appFor(alice.user), async (url) => {
      const res = await get(url, `${P}/payslips/mine`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.total, 1);
      assert.equal(res.body.data.data[0].netPay, 42000 - 3600);
    });
  });

  test('🔴 an employee cannot see a payslip before the run is locked', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();
    let payslipId;

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice]);
      const runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});
      payslipId = String((await Payslip.findOne({}).lean())._id);
    });

    await withServer(appFor(alice.user), async (url) => {
      // The figures still move while the run is in review.
      assert.equal((await get(url, `${P}/payslips/mine`)).body.data.total, 0);
      const one = await get(url, `${P}/payslips/${payslipId}`);
      assert.equal(one.status, 403);
      assert.match(one.body.message, /not final/i);
    });
  });

  test("🔴 an employee cannot see a colleague's payslip", async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();
    const bob = await makeEmployee();
    let alicePayslipId;

    await withServer(appFor(admin.user), async (url) => {
      await lockedRunFor(url, alice);
      alicePayslipId = String((await Payslip.findOne({ employeeId: alice.employee._id }).lean())._id);
    });

    await withServer(appFor(bob.user), async (url) => {
      const direct = await get(url, `${P}/payslips/${alicePayslipId}`);
      assert.equal(direct.status, 403);

      // Naming her in the filter is refused rather than silently emptied.
      const filtered = await get(url, `${P}/payslips?employeeId=${alice.id}`);
      assert.equal(filtered.status, 403);
    });
  });

  test('🔴 a MANAGER cannot see a report\'s payslip', async () => {
    // Deliberate: payroll:view exists at self and org, never at team. A manager
    // approves leave and sees attendance; pay is not theirs to see.
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    let payslipId;

    await withServer(appFor(admin.user), async (url) => {
      await lockedRunFor(url, alice);
      payslipId = String((await Payslip.findOne({}).lean())._id);
    });

    await withServer(appFor(manager.user), async (url) => {
      assert.equal((await get(url, `${P}/payslips/${payslipId}`)).status, 403);
    });
  });

  test('viewing a payslip is audited', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();
    let payslipId;

    await withServer(appFor(admin.user), async (url) => {
      await lockedRunFor(url, alice);
      payslipId = String((await Payslip.findOne({}).lean())._id);
      await AuditLog.deleteMany({});
      await get(url, `${P}/payslips/${payslipId}`);
    });

    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.PAYSLIP_VIEWED }).lean();
    assert.ok(entry, 'reading someone else\'s pay leaves a record');
    assert.equal(entry.meta.own, false);
  });

  test('payslip money is stored as Decimal128 and comes back exact', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();

    await withServer(appFor(admin.user), async (url) => {
      await lockedRunFor(url, alice);
    });

    const payslip = await Payslip.findOne({}).lean();
    assert.equal(payslip.gross.constructor.name, 'Decimal128');
    assert.equal(payslip.netPay.constructor.name, 'Decimal128');
    assert.equal(payslip.lines[0].amount.constructor.name, 'Decimal128');
    assert.equal(fromDecimal(payslip.gross), 42000);
  });

  test('the run detail lists every payslip, for an admin only', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const alice = await makeEmployee();
    const bob = await makeEmployee();
    let runId;

    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, [alice, bob]);
      runId = (await post(url, `${P}/runs`, { payGroupId, month: 6, year: 2026 })).body.data.id;
      await post(url, `${P}/runs/${runId}/compute`, {});

      const res = await get(url, `${P}/runs/${runId}/payslips`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.total, 2);
      assert.ok(res.body.data.data[0].employeeName, 'the employee is named for the grid');
    });

    await withServer(appFor(alice.user), async (url) => {
      assert.equal((await get(url, `${P}/runs/${runId}/payslips`)).status, 403);
    });
  });
});

// ===========================================================================
// Envelope
// ===========================================================================

describe('response envelope', () => {
  test('every payload sits UNDER data, never spread beside it', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const { payGroupId } = await seedPayroll(url, []);

      const list = await get(url, `${P}/runs`);
      assert.equal(list.body.success, true);
      assert.ok(Array.isArray(list.body.data.data), 'paginated payloads nest data.data');
      assert.equal(typeof list.body.data.total, 'number');

      const groups = await get(url, `${P}/pay-groups`);
      assert.ok(Array.isArray(groups.body.data));

      const created = await post(url, `${P}/runs`, { payGroupId, month: 9, year: 2026 });
      assert.equal(created.body.success, true);
      assert.ok(created.body.data.id);
      assert.equal(created.body.id, undefined, 'nothing leaks to the top level');
    });
  });
});
