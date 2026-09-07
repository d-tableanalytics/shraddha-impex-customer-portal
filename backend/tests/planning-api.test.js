/**
 * Planning — headcount plans and the hiring plan calendar.
 *
 * A real Express app over a real MongoDB, following the pattern every other
 * HRMS module established. Only `protect` is stubbed; the permission chain, the
 * validator, the services and the error handler are the genuine article.
 *
 * The assertions that carry the most weight are the ones about the two things
 * the reference gets wrong and cannot test for: an org-wide plan's actual
 * headcount, and the fact that a hiring plan's status can move at all.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import User from '../models/User.js';
import Department from '../models/hrms/Department.js';
import AuditLog from '../models/AuditLog.js';
import { JobRequisition } from '../models/hrms/HiringModels.js';
import { HeadcountPlan, HiringPlan } from '../models/hrms/PlanningModels.js';

import planningRoutes from '../modules/hrms/planning/planning.routes.js';
import { totalBudgetString } from '../modules/hrms/planning/headcountPlan.service.js';
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
import { AUDIT_ACTIONS } from '../shared/constants/hrms.js';
import { financialYearFor } from '../shared/constants/planning.js';
import { buildTestApp, stubProtect, withServer, get, post, patch } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/planning';
const FY = 'FY2026';

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, User, Department, JobRequisition, HeadcountPlan, HiringPlan);
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
      router.use('/planning', planningRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;

/**
 * Created SERIALLY by every caller. `seq` is shared, so building employees
 * concurrently races on it and collides on the unique employee code.
 */
async function makeEmployee({ roles = [R.EMPLOYEE], departmentId = null, status = 'active' } = {}) {
  seq += 1;
  const user = await User.create({
    email: `plan${seq}@example.com`,
    password: 'x'.repeat(60),
    user: `Person ${seq}`,
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    userId: user._id,
    employeeCode: `PLN${String(seq).padStart(3, '0')}`,
    firstName: 'Person',
    lastName: String(seq),
    dateOfJoining: new Date('2024-01-01'),
    status,
    ...(departmentId ? { departmentId } : {}),
  });
  return {
    user: { _id: user._id, role: 'Management', roles, status: 'Active' },
    employee,
    id: String(employee._id),
  };
}

async function makeDepartment(code = 'ENG') {
  return Department.create({ code, name: `${code} Department` });
}

/** Several employees in one department, serially — see the note above. */
async function staffDepartment(departmentId, count, status = 'active') {
  const made = [];
  for (let i = 0; i < count; i += 1) {
    made.push(await makeEmployee({ departmentId, status }));
  }
  return made;
}

// ===========================================================================
// Permissions
// ===========================================================================

describe('permissions', () => {
  test('HR admin can read and write; a plain employee gets neither', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();

    await withServer(appFor(hr.user), async (url) => {
      assert.equal((await get(url, `${P}/headcount`)).status, 200);
      const created = await post(url, `${P}/headcount`, {
        financialYear: FY,
        plannedHeadcount: 10,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    });

    await withServer(appFor(staff.user), async (url) => {
      // Planning is org-wide HR work. An employee holds no grant at all.
      assert.equal((await get(url, `${P}/headcount`)).status, 403);
      assert.equal((await get(url, `${P}/hiring`)).status, 403);
      assert.equal(
        (await post(url, `${P}/headcount`, { financialYear: FY, plannedHeadcount: 1 })).status,
        403,
      );
    });
  });

  test('a manager and a recruiter hold no planning grant either', async () => {
    for (const role of [R.MANAGER, R.RECRUITER, R.PAYROLL_ADMIN, R.AUDITOR]) {
      const actor = await makeEmployee({ roles: [role] });
      await withServer(appFor(actor.user), async (url) => {
        assert.equal(
          (await get(url, `${P}/headcount`)).status,
          403,
          `${role} must not read planning`,
        );
      });
    }
  });

  test('super admin can write', async () => {
    const admin = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    await withServer(appFor(admin.user), async (url) => {
      const created = await post(url, `${P}/hiring`, {
        role: 'Backend Engineer',
        plannedByDate: day(30),
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    });
  });
});

// ===========================================================================
// Headcount plans
// ===========================================================================

describe('headcount plans', () => {
  test('actual headcount is DERIVED from active employees in the department', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const engineering = await makeDepartment('ENG');
    await staffDepartment(engineering._id, 3);

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/headcount`, {
        financialYear: FY,
        departmentId: String(engineering._id),
        plannedHeadcount: 5,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));

      // 🔴 The reference hardcodes `actualHeadcount: 0` and
      // `departmentName: null` into its create response even when a department
      // WAS supplied, so the row it hands back is wrong until a refetch.
      assert.equal(created.body.data.actualHeadcount, 3);
      assert.equal(created.body.data.departmentName, 'ENG Department');
      assert.equal(created.body.data.orgWide, false);

      const list = await get(url, `${P}/headcount?financialYear=${FY}`);
      assert.equal(list.body.data.data[0].actualHeadcount, 3);
    });
  });

  test('🔴 an ORG-WIDE plan counts the whole company — the reference hardcodes it to 0', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const engineering = await makeDepartment('ENG');
    await staffDepartment(engineering._id, 2);
    await staffDepartment(null, 1);

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/headcount`, {
        financialYear: FY,
        plannedHeadcount: 20,
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.orgWide, true);
      // hr + 2 engineers + 1 unassigned = 4 active employees.
      assert.equal(created.body.data.actualHeadcount, 4);
    });
  });

  test('exited, inactive and soft-deleted employees are not counted', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const engineering = await makeDepartment('ENG');
    await staffDepartment(engineering._id, 2);
    await staffDepartment(engineering._id, 1, 'exited');
    await staffDepartment(engineering._id, 1, 'inactive');

    const leaver = (await staffDepartment(engineering._id, 1))[0];
    await Employee.updateOne({ _id: leaver.employee._id }, { $set: { deletedAt: new Date() } });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/headcount`, {
        financialYear: FY,
        departmentId: String(engineering._id),
        plannedHeadcount: 5,
      });
      assert.equal(created.body.data.actualHeadcount, 2);
    });
  });

  test('money survives as Decimal128 and the total is exact', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/headcount`, {
        financialYear: FY,
        plannedHeadcount: 300,
        // 🔴 Multiplied as a JS float in the reference. 83333.33 × 300 is
        // 24999999.00 exactly, and the float route need not agree.
        budgetPerHead: '83333.33',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.budgetPerHead, 83333.33);
      assert.equal(created.body.data.totalBudget, 24999999);
    });

    // Decimal128 at rest, a number on the wire — the shape every module uses.
    const row = await HeadcountPlan.findOne({ financialYear: FY }).lean();
    assert.equal(row.budgetPerHead.constructor.name, 'Decimal128');
    assert.equal(row.budgetPerHead.toString(), '83333.33');
    // 🔴 The derived total is NOT a stored column — the reference stores it AND
    // recomputes it, giving two sources of truth for one number.
    assert.equal(row.totalBudget, undefined);
    assert.equal(row.actualHeadcount, undefined);
  });

  test('the budget multiplication is exact well past the float-safe range', () => {
    assert.equal(totalBudgetString('0.01', 3), '0.03');
    assert.equal(totalBudgetString('83333.33', 300), '24999999.00');
    assert.equal(totalBudgetString('1234567.89', 100000), '123456789000.00');
    assert.equal(totalBudgetString(null, 10), null);
    assert.equal(totalBudgetString('100', 0), '0.00');
  });

  test('🔴 a second plan for the same year and department is a 409, not a 500', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const engineering = await makeDepartment('ENG');

    await withServer(appFor(hr.user), async (url) => {
      const body = { financialYear: FY, departmentId: String(engineering._id), plannedHeadcount: 5 };
      assert.equal((await post(url, `${P}/headcount`, body)).status, 201);

      const duplicate = await post(url, `${P}/headcount`, body);
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.code, 'HRMS_CONFLICT');
    });
  });

  test('one org-wide plan per year, and a different department is still allowed', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const engineering = await makeDepartment('ENG');

    await withServer(appFor(hr.user), async (url) => {
      assert.equal(
        (await post(url, `${P}/headcount`, { financialYear: FY, plannedHeadcount: 5 })).status,
        201,
      );
      assert.equal(
        (await post(url, `${P}/headcount`, { financialYear: FY, plannedHeadcount: 6 })).status,
        409,
      );
      assert.equal(
        (
          await post(url, `${P}/headcount`, {
            financialYear: FY,
            departmentId: String(engineering._id),
            plannedHeadcount: 6,
          })
        ).status,
        201,
      );
    });
  });

  test('🔴 the financial year has a shape — the reference accepts any string', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      for (const bad of ['2026', 'FY 2026', 'fy26', 'next year', 'FY1900']) {
        const res = await post(url, `${P}/headcount`, {
          financialYear: bad,
          plannedHeadcount: 5,
        });
        assert.equal(res.status, 400, `${bad} must be refused`);
      }
      // Lower case is normalised rather than refused — same year, one spelling.
      const ok = await post(url, `${P}/headcount`, { financialYear: 'fy2026', plannedHeadcount: 5 });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.data.financialYear, 'FY2026');
    });
  });

  test('🔴 an unknown department is a 404, not a plan that renders as "Org-wide"', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const ghost = new mongoose.Types.ObjectId();

    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/headcount`, {
        financialYear: FY,
        departmentId: String(ghost),
        plannedHeadcount: 5,
      });
      assert.equal(res.status, 404);
    });
  });

  test('a plan can be corrected, and the correction is audited', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/headcount`, {
        financialYear: FY,
        plannedHeadcount: 5,
        budgetPerHead: '1000.00',
      });

      const updated = await patch(url, `${P}/headcount/${created.body.data.id}`, {
        plannedHeadcount: 8,
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.data.plannedHeadcount, 8);
      // The derived total follows the plan it is derived from.
      assert.equal(updated.body.data.totalBudget, 8000);
    });

    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.HEADCOUNT_PLAN_UPDATED }).lean();
    assert.ok(entry, 'the correction is audited');
    assert.equal(entry.meta.before.plannedHeadcount, 5);
    assert.equal(entry.meta.after.plannedHeadcount, 8);
  });

  test('the summary is computed over the whole year, not the visible page', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const engineering = await makeDepartment('ENG');
    const sales = await makeDepartment('SLS');
    await staffDepartment(engineering._id, 2);
    await staffDepartment(sales._id, 1);

    await withServer(appFor(hr.user), async (url) => {
      await post(url, `${P}/headcount`, {
        financialYear: FY,
        departmentId: String(engineering._id),
        plannedHeadcount: 4,
        budgetPerHead: '1000.00',
      });
      await post(url, `${P}/headcount`, {
        financialYear: FY,
        departmentId: String(sales._id),
        plannedHeadcount: 2,
        budgetPerHead: '500.50',
      });

      // One row per page, so a client-side reduce would see only the first.
      const paged = await get(url, `${P}/headcount?financialYear=${FY}&pageSize=1`);
      assert.equal(paged.body.data.data.length, 1);
      assert.equal(paged.body.data.total, 2);

      const summary = await get(url, `${P}/headcount/summary?financialYear=${FY}`);
      assert.equal(summary.body.data.plannedHeadcount, 6);
      assert.equal(summary.body.data.actualHeadcount, 3);
      assert.equal(summary.body.data.totalBudget, 4000 + 1001);
    });
  });

  test('the year list offers the years that actually have plans', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      await post(url, `${P}/headcount`, { financialYear: 'FY2025', plannedHeadcount: 1 });
      await post(url, `${P}/headcount`, { financialYear: 'FY2026', plannedHeadcount: 1 });

      const years = await get(url, `${P}/headcount/years`);
      assert.deepEqual(years.body.data, ['FY2026', 'FY2025']);
    });
  });

  test('creating a plan is audited', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      await post(url, `${P}/headcount`, { financialYear: FY, plannedHeadcount: 12 });
    });

    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.HEADCOUNT_PLAN_CREATED }).lean();
    assert.ok(entry);
    assert.equal(entry.meta.plannedHeadcount, 12);
    assert.equal(String(entry.user), String(hr.user._id));
  });

  test('a missing plan is a 404, and a malformed id is too', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      assert.equal((await get(url, `${P}/headcount/${new mongoose.Types.ObjectId()}`)).status, 404);
      assert.equal((await get(url, `${P}/headcount/not-an-id`)).status, 404);
    });
  });
});

// ===========================================================================
// Hiring plans
// ===========================================================================

describe('hiring plans', () => {
  test('a plan is created as planned, with no actual date', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const engineering = await makeDepartment('ENG');

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/hiring`, {
        role: 'Senior Backend Engineer',
        plannedByDate: day(45),
        departmentId: String(engineering._id),
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.status, 'planned');
      assert.equal(created.body.data.actualByDate, null);
      assert.equal(created.body.data.departmentName, 'ENG Department');
      assert.deepEqual(created.body.data.allowedTransitions, [
        'in_progress',
        'delayed',
        'cancelled',
      ]);
    });
  });

  test('🔴 the status can move at all — the reference ships no update endpoint', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/hiring`, {
        role: 'Designer',
        plannedByDate: day(10),
      });
      const id = created.body.data.id;

      const started = await patch(url, `${P}/hiring/${id}/status`, { status: 'in_progress' });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(started.body.data.status, 'in_progress');

      const done = await patch(url, `${P}/hiring/${id}/status`, { status: 'completed' });
      assert.equal(done.status, 200);
      assert.equal(done.body.data.status, 'completed');
      // 🔴 The column the reference renders and can never fill.
      assert.equal(done.body.data.actualByDate, new Date().toISOString().slice(0, 10));
      assert.deepEqual(done.body.data.allowedTransitions, []);
    });
  });

  test('an illegal move is refused by the SERVER, with the legal ones named', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/hiring`, { role: 'Analyst', plannedByDate: day(5) });
      const id = created.body.data.id;

      // planned -> completed skips the work.
      const jump = await patch(url, `${P}/hiring/${id}/status`, { status: 'completed' });
      assert.equal(jump.status, 409);
      assert.deepEqual(jump.body.details.allowedTransitions, [
        'in_progress',
        'delayed',
        'cancelled',
      ]);

      // Same status twice is a validation error, not a silent no-op.
      assert.equal(
        (await patch(url, `${P}/hiring/${id}/status`, { status: 'planned' })).status,
        400,
      );

      // A status outside the enum never reaches the service.
      assert.equal(
        (await patch(url, `${P}/hiring/${id}/status`, { status: 'on_hold' })).status,
        400,
      );
    });
  });

  test('a closed plan is terminal — it cannot be moved or edited', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/hiring`, { role: 'Intern', plannedByDate: day(20) });
      const id = created.body.data.id;

      assert.equal(
        (await patch(url, `${P}/hiring/${id}/status`, { status: 'cancelled' })).status,
        200,
      );
      assert.equal(
        (await patch(url, `${P}/hiring/${id}/status`, { status: 'in_progress' })).status,
        409,
      );
      assert.equal((await patch(url, `${P}/hiring/${id}`, { role: 'Something else' })).status, 409);
    });
  });

  test('delayed returns to in_progress and on to completed', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/hiring`, { role: 'SRE', plannedByDate: day(3) });
      const id = created.body.data.id;

      assert.equal((await patch(url, `${P}/hiring/${id}/status`, { status: 'delayed' })).status, 200);
      assert.equal(
        (await patch(url, `${P}/hiring/${id}/status`, { status: 'in_progress' })).status,
        200,
      );

      const done = await patch(url, `${P}/hiring/${id}/status`, {
        status: 'completed',
        actualByDate: day(-1),
      });
      assert.equal(done.status, 200);
      assert.equal(done.body.data.actualByDate, day(-1));
    });
  });

  test('a status change is audited with both ends of the move', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/hiring`, { role: 'QA Lead', plannedByDate: day(15) });
      await patch(url, `${P}/hiring/${created.body.data.id}/status`, { status: 'in_progress' });
    });

    const entry = await AuditLog.findOne({
      action: AUDIT_ACTIONS.HIRING_PLAN_STATUS_CHANGED,
    }).lean();
    assert.ok(entry);
    assert.equal(entry.meta.from, 'planned');
    assert.equal(entry.meta.to, 'in_progress');
  });

  test('🔴 the target date is a DAY and does not shift', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/hiring`, {
        role: 'Accountant',
        plannedByDate: '2026-03-31',
      });
      assert.equal(created.body.data.plannedByDate, '2026-03-31');

      // An ISO datetime is refused outright rather than silently truncated —
      // which is exactly what the reference does with it.
      assert.equal(
        (
          await post(url, `${P}/hiring`, {
            role: 'Accountant 2',
            plannedByDate: '2026-03-31T18:30:00.000Z',
          })
        ).status,
        400,
      );
    });

    const row = await HiringPlan.findOne({ role: 'Accountant' }).lean();
    assert.equal(row.plannedByDate, '2026-03-31');
  });

  test('a plan past its target date is flagged, and a closed one is not', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const late = await post(url, `${P}/hiring`, { role: 'Late role', plannedByDate: day(-10) });
      assert.equal(late.body.data.overdue, true);

      const cancelled = await patch(url, `${P}/hiring/${late.body.data.id}/status`, {
        status: 'cancelled',
      });
      assert.equal(cancelled.body.data.overdue, false);

      const summary = await get(url, `${P}/hiring/summary`);
      assert.equal(summary.body.data.total, 1);
      assert.equal(summary.body.data.overdue, 0);
    });
  });

  test('🔴 an unknown requisition is a 404 — the reference stores any UUID unchecked', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const ghost = new mongoose.Types.ObjectId();

    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/hiring`, {
        role: 'Ghost role',
        plannedByDate: day(30),
        requisitionId: String(ghost),
      });
      assert.equal(res.status, 404);
    });
  });

  test('a real requisition is linked and labelled, and nothing more is read from it', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const requisition = await JobRequisition.create({
      title: 'Backend Engineer (2 roles)',
      status: 'open',
      headcount: 2,
    });

    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/hiring`, {
        role: 'Backend Engineer',
        plannedByDate: day(60),
        requisitionId: String(requisition._id),
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.requisitionTitle, 'Backend Engineer (2 roles)');
      // The plan's own status is its own. The reference reads nothing from the
      // requisition either, and inventing propagation would be a new feature.
      assert.equal(created.body.data.status, 'planned');
    });
  });

  test('the list filters by status and pages', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      for (const role of ['A', 'B', 'C']) {
        await post(url, `${P}/hiring`, { role, plannedByDate: day(10) });
      }
      const first = await get(url, `${P}/hiring?pageSize=2`);
      assert.equal(first.body.data.data.length, 2);
      assert.equal(first.body.data.total, 3);

      await patch(url, `${P}/hiring/${first.body.data.data[0].id}/status`, {
        status: 'in_progress',
      });

      const filtered = await get(url, `${P}/hiring?status=in_progress`);
      assert.equal(filtered.body.data.total, 1);
      assert.equal(filtered.body.data.data[0].status, 'in_progress');
    });
  });
});

// ===========================================================================
// Envelope and shared vocabulary
// ===========================================================================

describe('contract', () => {
  test('every response puts its payload UNDER data', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(hr.user), async (url) => {
      const list = await get(url, `${P}/headcount`);
      assert.equal(list.body.success, true);
      assert.ok(Array.isArray(list.body.data.data));
      assert.equal(typeof list.body.data.total, 'number');
      // Not spread beside `data` — the envelope bug that killed the directory.
      assert.equal(list.body.total, undefined);
    });
  });

  test('the financial year helper follows the April–March convention', () => {
    assert.equal(financialYearFor(new Date('2025-04-01T00:00:00Z')), 'FY2026');
    assert.equal(financialYearFor(new Date('2025-03-31T00:00:00Z')), 'FY2025');
  });
});
