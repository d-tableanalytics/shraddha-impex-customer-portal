/**
 * Onboarding — the HTTP layer, the workflows, and the document surface.
 *
 * A real Express app over a real MongoDB, following the pattern Employee
 * Master, Attendance, Payroll and Hiring established. Only `protect` is
 * stubbed; the permission chain, the validator, the services and the error
 * handler are the genuine article.
 *
 * The assertions that carry the most weight are the ones about the reference's
 * defects: a manager who can list a checklist can also open it, a reopened task
 * reopens its checklist, a second active checklist is impossible, and an offer
 * letter can only be signed by the person it is addressed to.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import User from '../models/User.js';
import Department from '../models/hrms/Department.js';
import AuditLog from '../models/AuditLog.js';
import {
  OnboardingTemplate,
  OnboardingChecklist,
  OfferLetter,
} from '../models/hrms/OnboardingModels.js';

import onboardingRoutes from '../modules/hrms/onboarding/onboarding.routes.js';
import { resolveOfferLetterAccess } from '../modules/hrms/onboarding/offerLetter.service.js';
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
import {
  registerFileAccessRule,
  __resetFileAccessRules,
  issueReadUrl,
} from '../modules/hrms/storage/storage.service.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { AUDIT_ACTIONS, STORAGE_CATEGORIES } from '../shared/constants/hrms.js';
import { buildHrmsActor } from '../shared/permissions/has-permission.js';
import { fromDecimal } from '../shared/payroll/money.js';
import { buildTestApp, stubProtect, withServer, get, post, patch, del } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/onboarding';

const dayIn = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

before(async () => {
  await startTestMongo();
  await syncIndexes(
    Employee,
    User,
    Department,
    OnboardingTemplate,
    OnboardingChecklist,
    OfferLetter,
  );
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

  __resetFileAccessRules();
  registerFileAccessRule(STORAGE_CATEGORIES.OFFER_LETTER, {
    resolve: resolveOfferLetterAccess,
    auditAction: AUDIT_ACTIONS.OFFER_LETTER_VIEWED,
  });
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/onboarding', onboardingRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;

async function makeEmployee({ roles = [R.EMPLOYEE], reportingManagerId = null, managerChain = [], status = 'active' } = {}) {
  seq += 1;
  const user = await User.create({
    email: `onb${seq}@example.com`,
    password: 'x'.repeat(60),
    user: `Person ${seq}`,
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    userId: user._id,
    employeeCode: `ONB${String(seq).padStart(3, '0')}`,
    firstName: 'Person',
    lastName: String(seq),
    dateOfJoining: new Date('2024-01-01'),
    status,
    ...(reportingManagerId ? { reportingManagerId } : {}),
    ...(managerChain.length ? { managerChain } : {}),
  });
  return {
    user: { _id: user._id, role: 'Management', roles, status: 'Active' },
    employee,
    id: String(employee._id),
  };
}

const TEMPLATE = {
  name: 'Engineering onboarding',
  active: true,
  tasks: [
    { title: 'Collect ID proof', description: 'Aadhaar and PAN', dueDays: 1, assignTo: 'hr', order: 0 },
    { title: 'Issue laptop', dueDays: 2, assignTo: 'it', order: 1 },
    { title: 'Read the handbook', dueDays: 3, assignTo: 'new_hire', order: 2 },
  ],
};

async function makeTemplate(url, overrides = {}) {
  const res = await post(url, `${P}/templates`, { ...TEMPLATE, ...overrides });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

/** A started checklist for `employeeId`, returning the checklist DTO. */
async function startFor(url, employeeId, templateId) {
  const res = await post(url, `${P}/checklists`, { employeeId, templateId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

// ===========================================================================
// Templates
// ===========================================================================

describe('onboarding templates', () => {
  test('HR creates a template and its tasks come back ordered', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const created = await makeTemplate(url, {
        tasks: [
          { title: 'Third', dueDays: 3, assignTo: 'hr', order: 5 },
          { title: 'First', dueDays: 1, assignTo: 'it', order: 1 },
        ],
      });
      assert.deepEqual(
        created.tasks.map((t) => t.title),
        ['First', 'Third'],
      );
      assert.equal(created.taskCount, 2);
      assert.equal(created.checklistCount, 0);
    });
  });

  test('🔴 a template with no tasks is refused — the reference allows one, and it auto-completes on day zero', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/templates`, { name: 'Empty', tasks: [] });
      assert.equal(res.status, 400);
      assert.match(JSON.stringify(res.body), /at least one task/i);
    });
  });

  test('two tasks in one template cannot share a title', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/templates`, {
        name: 'Dupes',
        tasks: [
          { title: 'Same', dueDays: 1, assignTo: 'hr' },
          { title: 'same', dueDays: 2, assignTo: 'it' },
        ],
      });
      assert.equal(res.status, 400);
      assert.match(JSON.stringify(res.body), /cannot share a title/i);
    });
  });

  test('the list is paginated and ordered active-first', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      await makeTemplate(url, { name: 'Zeta active', active: true });
      await makeTemplate(url, { name: 'Alpha inactive', active: false });

      const res = await get(url, `${P}/templates?page=1&pageSize=1`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.total, 2);
      assert.equal(res.body.data.data.length, 1);
      assert.equal(res.body.data.data[0].name, 'Zeta active');
    });
  });

  test('an ordinary employee cannot read or write templates', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      await makeTemplate(url);
    });
    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await get(url, `${P}/templates`)).status, 403);
      assert.equal((await post(url, `${P}/templates`, TEMPLATE)).status, 403);
    });
  });

  test('🔴 a template that has been used cannot be deleted — the reference orphans its checklists', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      await startFor(url, hire.id, template.id);

      const res = await del(url, `${P}/templates/${template.id}`);
      assert.equal(res.status, 409);
      assert.match(res.body.message, /cannot be deleted/i);

      // And the checklist still knows where it came from.
      const list = await get(url, `${P}/checklists`);
      assert.equal(list.body.data.data[0].templateName, 'Engineering onboarding');
    });
  });

  test('an unused template is retired, and disappears from the list', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      assert.equal((await del(url, `${P}/templates/${template.id}`)).status, 204);
      assert.equal((await get(url, `${P}/templates`)).body.data.total, 0);
      assert.equal((await get(url, `${P}/templates/${template.id}`)).status, 404);
    });
  });

  test('editing a template does NOT rewrite checklists already running from it', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      const checklist = await startFor(url, hire.id, template.id);
      assert.equal(checklist.tasks.length, 3);

      const edited = await patch(url, `${P}/templates/${template.id}`, {
        name: 'Renamed',
        tasks: [{ title: 'Only one now', dueDays: 1, assignTo: 'hr' }],
      });
      assert.equal(edited.status, 200);

      const after = await get(url, `${P}/checklists/${checklist.id}`);
      assert.equal(after.body.data.tasks.length, 3, 'work in progress is untouched');
      assert.equal(after.body.data.templateName, 'Engineering onboarding', 'the name at start is kept');
    });
  });
});

// ===========================================================================
// Checklists — instantiation
// ===========================================================================

describe('starting an onboarding', () => {
  test('stamps the template onto the hire, with due dates and resolved assignees', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const it = await makeEmployee({ roles: [R.IT_ADMIN] });
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const hire = await makeEmployee({ reportingManagerId: manager.employee._id });

    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url, {
        tasks: [
          { title: 'HR task', dueDays: 1, assignTo: 'hr', order: 0 },
          { title: 'IT task', dueDays: 2, assignTo: 'it', order: 1 },
          { title: 'Hire task', dueDays: 3, assignTo: 'new_hire', order: 2 },
          { title: 'Manager task', dueDays: 4, assignTo: 'manager', order: 3 },
          { title: 'Buddy task', dueDays: 5, assignTo: 'buddy', order: 4 },
        ],
      });
      const checklist = await startFor(url, hire.id, template.id);

      const by = Object.fromEntries(checklist.tasks.map((t) => [t.assignTo, t]));
      assert.equal(by.hr.assigneeEmployeeId, hr.id);
      assert.equal(by.it.assigneeEmployeeId, it.id);
      assert.equal(by.new_hire.assigneeEmployeeId, hire.id);
      assert.equal(by.manager.assigneeEmployeeId, manager.id);
      // Left for HR to fill in, exactly as the reference leaves it.
      assert.equal(by.buddy.assigneeEmployeeId, null);

      assert.equal(by.hr.dueDate, dayIn(1));
      assert.equal(by.manager.dueDate, dayIn(4));
      assert.equal(checklist.status, 'active');
      assert.deepEqual(checklist.progress, { total: 5, completed: 0 });
    });
  });

  test('🔴 a second active checklist is impossible — the reference races on a findFirst', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      await startFor(url, hire.id, template.id);

      const second = await post(url, `${P}/checklists`, {
        employeeId: hire.id,
        templateId: template.id,
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'CHECKLIST_EXISTS');
    });
  });

  test('concurrent starts cannot both succeed', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      const results = await Promise.all([
        post(url, `${P}/checklists`, { employeeId: hire.id, templateId: template.id }),
        post(url, `${P}/checklists`, { employeeId: hire.id, templateId: template.id }),
      ]);
      const created = results.filter((r) => r.status === 201);
      assert.equal(created.length, 1, 'the unique index is what guarantees this');
      assert.equal(await OnboardingChecklist.countDocuments({ status: 'active' }), 1);
    });
  });

  test('an unknown employee or template is a validation error, not a 500', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      const ghost = String(new mongoose.Types.ObjectId());

      const badEmployee = await post(url, `${P}/checklists`, {
        employeeId: ghost,
        templateId: template.id,
      });
      assert.equal(badEmployee.status, 400);

      const badTemplate = await post(url, `${P}/checklists`, {
        employeeId: hire.id,
        templateId: ghost,
      });
      assert.equal(badTemplate.status, 400);
    });
  });

  test('an inactive template cannot start an onboarding', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url, { active: false });
      const res = await post(url, `${P}/checklists`, {
        employeeId: hire.id,
        templateId: template.id,
      });
      assert.equal(res.status, 400);
    });
  });

  test('an employee who has left cannot be onboarded', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const gone = await makeEmployee({ status: 'exited' });
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      const res = await post(url, `${P}/checklists`, {
        employeeId: gone.id,
        templateId: template.id,
      });
      assert.equal(res.status, 409);
    });
  });

  test('an ordinary employee cannot start an onboarding', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let templateId;
    await withServer(appFor(hr.user), async (url) => {
      templateId = (await makeTemplate(url)).id;
    });
    await withServer(appFor(staff.user), async (url) => {
      const res = await post(url, `${P}/checklists`, { employeeId: staff.id, templateId });
      assert.equal(res.status, 403);
    });
  });

  test('starting is audited, and records which roles came back unassigned', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      await startFor(url, hire.id, template.id);

      const entry = await AuditLog.findOne({
        action: AUDIT_ACTIONS.ONBOARDING_CHECKLIST_STARTED,
      }).lean();
      assert.ok(entry, 'the start is audited');
      assert.equal(entry.meta.taskCount, 3);
      // No IT admin exists in this test, so that task is a visible gap.
      assert.ok(entry.meta.unassigned.includes('it'));
    });
  });
});

// ===========================================================================
// Scope
// ===========================================================================

describe('who can see a checklist', () => {
  test('🔴 a manager who can LIST a report can also OPEN it — the reference 403s on the read', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({
      reportingManagerId: manager.employee._id,
      managerChain: [manager.employee._id],
    });

    let checklistId;
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      checklistId = (await startFor(url, report.id, template.id)).id;
    });

    await withServer(appFor(manager.user), async (url) => {
      const list = await get(url, `${P}/checklists`);
      assert.equal(list.status, 200);
      assert.equal(list.body.data.total, 1, 'the manager sees the row');

      const one = await get(url, `${P}/checklists/${checklistId}`);
      assert.equal(one.status, 200, 'and can open exactly what they were shown');
    });
  });

  test('an ordinary employee sees only their own', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const mine = await makeEmployee();
    const theirs = await makeEmployee();

    let theirChecklistId;
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      await startFor(url, mine.id, template.id);
      theirChecklistId = (await startFor(url, theirs.id, template.id)).id;
    });

    await withServer(appFor(mine.user), async (url) => {
      const list = await get(url, `${P}/checklists`);
      assert.equal(list.body.data.total, 1);
      assert.equal(list.body.data.data[0].employeeId, mine.id);

      // Somebody else's is a 404, not a 403 — its existence is not their business.
      assert.equal((await get(url, `${P}/checklists/${theirChecklistId}`)).status, 404);
    });
  });

  test('/checklists/mine takes no id and reads it from the session', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      await startFor(url, hire.id, template.id);
    });
    await withServer(appFor(hire.user), async (url) => {
      const res = await get(url, `${P}/checklists/mine`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.employeeId, hire.id);
    });
  });
});

// ===========================================================================
// Tasks
// ===========================================================================

describe('working through the tasks', () => {
  test('the assignee can move their own task forward', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    let checklist;
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      checklist = await startFor(url, hire.id, template.id);
    });

    const mine = checklist.tasks.find((t) => t.assignTo === 'new_hire');
    await withServer(appFor(hire.user), async (url) => {
      const res = await patch(url, `${P}/checklists/${checklist.id}/tasks/${mine.id}`, {
        status: 'completed',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const updated = res.body.data.tasks.find((t) => t.id === mine.id);
      assert.equal(updated.status, 'completed');
      assert.ok(updated.completedAt);
      assert.equal(res.body.data.progress.completed, 1);
    });
  });

  test('somebody who is neither the assignee nor HR is refused', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    const stranger = await makeEmployee();
    let checklist;
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      checklist = await startFor(url, hire.id, template.id);
    });

    const task = checklist.tasks.find((t) => t.assignTo === 'new_hire');
    await withServer(appFor(stranger.user), async (url) => {
      const res = await patch(url, `${P}/checklists/${checklist.id}/tasks/${task.id}`, {
        status: 'completed',
      });
      assert.equal(res.status, 403);
    });
  });

  test('🔴 an illegal transition is refused — the reference writes any status it is given', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    let checklist;
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      checklist = await startFor(url, hire.id, template.id);
      const task = checklist.tasks[0];

      await patch(url, `${P}/checklists/${checklist.id}/tasks/${task.id}`, { status: 'completed' });
      // completed -> in_progress is not a legal move; only -> pending is.
      const sideways = await patch(url, `${P}/checklists/${checklist.id}/tasks/${task.id}`, {
        status: 'in_progress',
      });
      assert.equal(sideways.status, 409);
      assert.equal(sideways.body.code, 'TASK_INVALID_TRANSITION');
    });
  });

  test('the checklist auto-closes when nothing is outstanding, counting skipped as done', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      const checklist = await startFor(url, hire.id, template.id);

      let last;
      for (const [i, task] of checklist.tasks.entries()) {
        last = await patch(url, `${P}/checklists/${checklist.id}/tasks/${task.id}`, {
          status: i === 0 ? 'skipped' : 'completed',
        });
        assert.equal(last.status, 200, JSON.stringify(last.body));
      }
      assert.equal(last.body.data.status, 'completed');
      assert.ok(last.body.data.completedAt);
      assert.deepEqual(last.body.data.progress, { total: 3, completed: 3 });
    });
  });

  test('🔴 reopening a task REOPENS the checklist — the reference latches it closed forever', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      const checklist = await startFor(url, hire.id, template.id);

      for (const task of checklist.tasks) {
        await patch(url, `${P}/checklists/${checklist.id}/tasks/${task.id}`, {
          status: 'completed',
        });
      }
      assert.equal((await get(url, `${P}/checklists/${checklist.id}`)).body.data.status, 'completed');

      const reopened = await patch(
        url,
        `${P}/checklists/${checklist.id}/tasks/${checklist.tasks[0].id}`,
        { status: 'pending' },
      );
      assert.equal(reopened.status, 200);
      assert.equal(reopened.body.data.status, 'active', 'the checklist follows its tasks back out');
      assert.equal(reopened.body.data.completedAt, null);
      // And the reopened task no longer claims a completion date.
      const task = reopened.body.data.tasks.find((t) => t.id === checklist.tasks[0].id);
      assert.equal(task.completedAt, null);
    });
  });

  test('🔴 reassignment is validated and is HR-only — the reference writes any id it is handed', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    const buddy = await makeEmployee();
    let checklist;
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url, {
        tasks: [{ title: 'Buddy task', dueDays: 1, assignTo: 'buddy' }],
      });
      checklist = await startFor(url, hire.id, template.id);
      const task = checklist.tasks[0];

      const ghost = await patch(url, `${P}/checklists/${checklist.id}/tasks/${task.id}`, {
        assigneeEmployeeId: String(new mongoose.Types.ObjectId()),
      });
      assert.equal(ghost.status, 400, 'an unknown employee is refused');

      const good = await patch(url, `${P}/checklists/${checklist.id}/tasks/${task.id}`, {
        assigneeEmployeeId: buddy.id,
      });
      assert.equal(good.status, 200);
      assert.equal(good.body.data.tasks[0].assigneeEmployeeId, buddy.id);
      assert.ok(good.body.data.tasks[0].assigneeName);
    });

    // The new assignee may work the task, but may not hand it on again.
    await withServer(appFor(buddy.user), async (url) => {
      const task = (await get(url, `${P}/tasks/mine`)).body.data.data[0];
      assert.equal(task.title, 'Buddy task');

      const handOff = await patch(url, `${P}/checklists/${checklist.id}/tasks/${task.id}`, {
        assigneeEmployeeId: hire.id,
      });
      assert.equal(handOff.status, 403, 'reassignment is HR’s call');
    });
  });

  test('/tasks/mine lists only the caller’s own tasks, across checklists', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const a = await makeEmployee();
    const b = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      await startFor(url, a.id, template.id);
      await startFor(url, b.id, template.id);
    });

    await withServer(appFor(a.user), async (url) => {
      const res = await get(url, `${P}/tasks/mine`);
      assert.equal(res.status, 200);
      // One `new_hire` task from their own checklist, and nothing from B's.
      assert.equal(res.body.data.total, 1);
      assert.equal(res.body.data.data[0].employeeId, a.id);
    });

    // HR owns one task in each of the two checklists.
    await withServer(appFor(hr.user), async (url) => {
      const res = await get(url, `${P}/tasks/mine`);
      assert.equal(res.body.data.total, 2);
    });
  });

  test('a cancelled checklist closes its tasks to further edits', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      const checklist = await startFor(url, hire.id, template.id);

      const cancelled = await post(url, `${P}/checklists/${checklist.id}/cancel`, {
        reason: 'The hire fell through.',
      });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.data.status, 'cancelled');
      assert.equal(cancelled.body.data.cancellationReason, 'The hire fell through.');

      const res = await patch(url, `${P}/checklists/${checklist.id}/tasks/${checklist.tasks[0].id}`, {
        status: 'completed',
      });
      assert.equal(res.status, 409);
    });
  });

  test('cancelling needs a reason, and frees the employee for a fresh start', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const template = await makeTemplate(url);
      const first = await startFor(url, hire.id, template.id);

      assert.equal((await post(url, `${P}/checklists/${first.id}/cancel`, {})).status, 400);
      assert.equal(
        (await post(url, `${P}/checklists/${first.id}/cancel`, { reason: 'Withdrew.' })).status,
        200,
      );

      // 🔴 The reference cannot reach `cancelled` at all, so the employee would
      // be stuck with an active checklist and could never be onboarded again.
      const second = await post(url, `${P}/checklists`, {
        employeeId: hire.id,
        templateId: template.id,
      });
      assert.equal(second.status, 201);
    });
  });
});

// ===========================================================================
// Offer letters
// ===========================================================================

describe('offer letters', () => {
  async function draftOffer(url, employeeId, overrides = {}) {
    const res = await post(url, `${P}/offers`, {
      employeeId,
      ctc: '1800000',
      joiningDate: dayIn(30),
      designation: 'Senior Engineer',
      ...overrides,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }

  test('🔴 the document is generated at CREATE, so a draft is reviewable and Send is reachable', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const offer = await draftOffer(url, hire.id);
      assert.equal(offer.state, 'draft');
      // The reference sets pdfKey only inside `send`, and its Send button then
      // requires `!sentAt && pdfKey` — a condition no row can ever satisfy.
      assert.equal(offer.hasDocument, true, 'a draft already has its letter');

      const sent = await post(url, `${P}/offers/${offer.id}/send`, {});
      assert.equal(sent.status, 200);
      assert.equal(sent.body.data.state, 'sent');
      assert.ok(sent.body.data.sentAt);
    });
  });

  test('money round-trips as a decimal string, never a float', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const offer = await draftOffer(url, hire.id, { ctc: '1234567.89' });
      // Decimal at REST, a number only on the wire — the same contract Payroll
      // set and Hiring follows, so the two offer DTOs have one shape.
      const row = await OfferLetter.findById(offer.id).lean();
      assert.equal(row.ctc.constructor.name, 'Decimal128');
      assert.equal(row.ctc.toString(), '1234567.89', 'no float ever touches storage');
      assert.equal(offer.ctc, 1234567.89);
      assert.equal(fromDecimal(row.ctc), 1234567.89);
    });
  });

  test('an offer cannot be sent twice', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const offer = await draftOffer(url, hire.id);
      await post(url, `${P}/offers/${offer.id}/send`, {});
      const again = await post(url, `${P}/offers/${offer.id}/send`, {});
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'OFFER_LETTER_NOT_SENDABLE');
    });
  });

  test('a second outstanding offer for the same person is refused', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      await draftOffer(url, hire.id);
      const second = await post(url, `${P}/offers`, {
        employeeId: hire.id,
        ctc: '1900000',
        joiningDate: dayIn(30),
        designation: 'Staff Engineer',
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'OFFER_LETTER_PENDING');
    });
  });

  test('an unsent offer cannot be signed', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    let offer;
    await withServer(appFor(hr.user), async (url) => {
      offer = await draftOffer(url, hire.id);
    });
    await withServer(appFor(hire.user), async (url) => {
      const res = await post(url, `${P}/offers/${offer.id}/sign`, { signatureName: 'Person' });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'OFFER_LETTER_NOT_SENT');
    });
  });

  test('only the person the offer is addressed to may sign it', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    const stranger = await makeEmployee();
    let offer;
    await withServer(appFor(hr.user), async (url) => {
      offer = await draftOffer(url, hire.id);
      await post(url, `${P}/offers/${offer.id}/send`, {});
    });

    await withServer(appFor(stranger.user), async (url) => {
      const res = await post(url, `${P}/offers/${offer.id}/sign`, { signatureName: 'Not me' });
      assert.equal(res.status, 403);
    });
    // HR raised it, but HR is not the subject and cannot sign for them either.
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/offers/${offer.id}/sign`, { signatureName: 'HR' });
      assert.equal(res.status, 403);
    });
  });

  test('signing records the name, time and address, and is final', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    let offer;
    await withServer(appFor(hr.user), async (url) => {
      offer = await draftOffer(url, hire.id);
      await post(url, `${P}/offers/${offer.id}/send`, {});
    });

    await withServer(appFor(hire.user), async (url) => {
      const signed = await post(url, `${P}/offers/${offer.id}/sign`, {
        signatureName: 'Person Two',
      });
      assert.equal(signed.status, 200);
      assert.equal(signed.body.data.state, 'accepted');
      assert.equal(signed.body.data.signature.name, 'Person Two');
      assert.ok(signed.body.data.signature.signedAt);

      const row = await OfferLetter.findById(offer.id).lean();
      assert.ok(row.signature.ipAddress, 'the address is recorded as evidence');
      // 🔴 And no half-megabyte base64 image is stored beside it.
      assert.equal(row.signature.image, undefined);

      const again = await post(url, `${P}/offers/${offer.id}/sign`, { signatureName: 'Again' });
      assert.equal(again.status, 409);
      const reject = await post(url, `${P}/offers/${offer.id}/reject`, {});
      assert.equal(reject.status, 409, 'an accepted offer cannot then be declined');
    });
  });

  test('accepting and declining cannot race each other', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    let offer;
    await withServer(appFor(hr.user), async (url) => {
      offer = await draftOffer(url, hire.id);
      await post(url, `${P}/offers/${offer.id}/send`, {});
    });

    await withServer(appFor(hire.user), async (url) => {
      const [a, b] = await Promise.all([
        post(url, `${P}/offers/${offer.id}/sign`, { signatureName: 'Person' }),
        post(url, `${P}/offers/${offer.id}/reject`, { reason: 'Changed my mind' }),
      ]);
      const ok = [a, b].filter((r) => r.status === 200);
      assert.equal(ok.length, 1, 'exactly one decision lands');
    });
  });

  test('an ordinary employee cannot list everybody’s offers, but can read their own', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    const stranger = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      await draftOffer(url, hire.id);
    });

    await withServer(appFor(hire.user), async (url) => {
      assert.equal((await get(url, `${P}/offers`)).status, 403, 'the org-wide list is HR’s');
      const mine = await get(url, `${P}/offers/mine`);
      assert.equal(mine.status, 200);
      assert.equal(mine.body.data.length, 1);

      const byId = await get(url, `${P}/offers/employee/${hire.id}`);
      assert.equal(byId.status, 200);
      const someoneElse = await get(url, `${P}/offers/employee/${stranger.id}`);
      assert.equal(someoneElse.status, 403, 'the path id is checked against the session');
    });
  });

  test('every offer action is audited', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    let offer;
    await withServer(appFor(hr.user), async (url) => {
      offer = await draftOffer(url, hire.id);
      await post(url, `${P}/offers/${offer.id}/send`, {});
    });
    await withServer(appFor(hire.user), async (url) => {
      await post(url, `${P}/offers/${offer.id}/sign`, { signatureName: 'Person Two' });
    });

    for (const action of [
      AUDIT_ACTIONS.OFFER_LETTER_CREATED,
      AUDIT_ACTIONS.OFFER_LETTER_SENT,
      AUDIT_ACTIONS.OFFER_LETTER_ACCEPTED,
    ]) {
      assert.ok(await AuditLog.findOne({ action }).lean(), `${action} is recorded`);
    }
  });
});

// ===========================================================================
// The document
// ===========================================================================

describe('the offer letter document', () => {
  test('the listing exposes a flag, never the storage key', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      await post(url, `${P}/offers`, {
        employeeId: hire.id,
        ctc: '1800000',
        joiningDate: dayIn(30),
        designation: 'Senior Engineer',
      });
      const list = await get(url, `${P}/offers`);
      const row = list.body.data.data[0];
      assert.equal(row.hasDocument, true);
      assert.equal(row.documentKey, undefined, 'a listing must not mint access to anything');
    });
  });

  test('the subject may read their own letter; a stranger may not', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    const stranger = await makeEmployee();
    let offer;
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/offers`, {
        employeeId: hire.id,
        ctc: '1800000',
        joiningDate: dayIn(30),
        designation: 'Senior Engineer',
      });
      offer = res.body.data;
    });

    await withServer(appFor(hire.user), async (url) => {
      const res = await get(url, `${P}/offers/${offer.id}/document-url`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.data.url);
      assert.ok(res.body.data.expiresInSeconds > 0, 'the link expires');
    });

    await withServer(appFor(stranger.user), async (url) => {
      const res = await get(url, `${P}/offers/${offer.id}/document-url`);
      assert.equal(res.status, 403);
    });
  });

  test('issuing a read URL is audited as an offer-letter view', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const hire = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/offers`, {
        employeeId: hire.id,
        ctc: '1800000',
        joiningDate: dayIn(30),
        designation: 'Senior Engineer',
      });
      await get(url, `${P}/offers/${res.body.data.id}/document-url`);
    });
    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.OFFER_LETTER_VIEWED }).lean();
    assert.ok(entry, 'the issuance is the sensitive act, and it is recorded');
  });

  test('🔴 the offer-letter rule does NOT collide with the relieving-letter category', async () => {
    // `registerFileAccessRule` is a Map.set: registering `letter` twice would
    // silently replace Exits' rule. Onboarding uses its own category, so a key
    // under `letter` is not resolvable by this module's rule.
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const actor = buildHrmsActor({
      userId: String(hr.user._id),
      roles: [R.HR_ADMIN],
      employee: { id: hr.id },
    });
    await assert.rejects(
      () => issueReadUrl({ category: STORAGE_CATEGORIES.LETTER, key: 'hrms/letters/x', actor, req: {} }),
      /No access rule is registered/,
      'the exits category is untouched by this module',
    );
  });

  test('an unknown document key resolves to nothing rather than to somebody else’s offer', async () => {
    assert.equal(await resolveOfferLetterAccess('hrms/onboarding/offer-letters/nope'), null);
  });
});

// ===========================================================================
// Envelope
// ===========================================================================

describe('response envelope', () => {
  test('every payload sits UNDER data, never spread beside it', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      await makeTemplate(url);
      const res = await get(url, `${P}/templates`);
      assert.deepEqual(Object.keys(res.body).sort(), ['data', 'success']);
      assert.deepEqual(Object.keys(res.body.data).sort(), ['data', 'page', 'pageSize', 'total']);
    });
  });
});
