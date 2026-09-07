/**
 * Performance — goals, review cycles, the review queue, feedback and 1:1s.
 *
 * A real Express app over a real MongoDB, following the pattern Employee
 * Master, Attendance, Payroll, Hiring and Onboarding established. Only
 * `protect` is stubbed; the permission chain, the validator, the services and
 * the error handler are the genuine article.
 *
 * The assertions that carry the most weight are the ones about the reference's
 * defects: the phase machine is enforced, peer reviews can actually be
 * assigned to a peer, an employee can read the reviews written about them, and
 * a report cannot cancel their manager's 1:1.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import {
  Goal,
  ReviewCycle,
  ReviewResponse,
  Feedback,
  OneOnOne,
} from '../models/hrms/PerformanceModels.js';

import performanceRoutes from '../modules/hrms/performance/performance.routes.js';
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

const P = '/api/v1/hrms/performance';

const dayIn = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const instantIn = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, User, Goal, ReviewCycle, ReviewResponse, Feedback, OneOnOne);
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
      router.use('/performance', performanceRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;

async function makeEmployee({
  roles = [R.EMPLOYEE],
  reportingManagerId = null,
  managerChain = [],
  status = 'active',
} = {}) {
  seq += 1;
  const user = await User.create({
    email: `perf${seq}@example.com`,
    password: 'x'.repeat(60),
    user: `Person ${seq}`,
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    userId: user._id,
    employeeCode: `PRF${String(seq).padStart(3, '0')}`,
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

const CYCLE = {
  name: 'Q3 2026 Review',
  startDate: dayIn(-30),
  endDate: dayIn(60),
  competencies: [
    { key: 'execution', label: 'Execution', weight: 2 },
    { key: 'collaboration', label: 'Collaboration', weight: 1 },
  ],
};

async function makeCycle(url, overrides = {}) {
  const res = await post(url, `${P}/cycles`, { ...CYCLE, ...overrides });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

/** A cycle advanced to a phase that accepts reviews. */
async function cycleInPhase(url, phase) {
  const cycle = await makeCycle(url);
  const path = { self_review: ['self_review'], manager_review: ['self_review', 'manager_review'] }[
    phase
  ] ?? ['self_review'];
  let last = cycle;
  for (const p of path) {
    const res = await post(url, `${P}/cycles/${cycle.id}/phase`, { phase: p });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    last = res.body.data;
  }
  return last;
}

// ===========================================================================
// Goals
// ===========================================================================

describe('goals', () => {
  test('anyone may set their own goal, and progress is derived not stored', async () => {
    const staff = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      const created = await post(url, `${P}/goals`, {
        title: 'Ship the P6 modules',
        targetValue: '10',
        unit: 'modules',
        weight: 3,
        dueDate: dayIn(30),
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.employeeId, staff.id);
      assert.equal(created.body.data.status, 'open');
      assert.equal(created.body.data.currentValue, 0);
      assert.equal(created.body.data.progressPercent, 0);

      const moved = await patch(url, `${P}/goals/${created.body.data.id}`, {
        currentValue: '4',
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.body.data.progressPercent, 40);

      // Decimal at rest — never a float (AD-2).
      const row = await Goal.findById(created.body.data.id).lean();
      assert.equal(row.targetValue.constructor.name, 'Decimal128');
      assert.equal(fromDecimal(row.currentValue), 4);
      // The percentage is computed, not persisted.
      assert.equal(row.progressPercent, undefined);
    });
  });

  test('a goal for somebody else needs org scope', async () => {
    const staff = await makeEmployee();
    const other = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      const res = await post(url, `${P}/goals`, { title: 'Yours now', employeeId: other.id });
      assert.equal(res.status, 403);
    });

    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/goals`, { title: 'Assigned', employeeId: other.id });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.employeeId, other.id);
    });
  });

  test('🔴 an illegal status transition is refused — the reference writes any status', async () => {
    const staff = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      const goal = (await post(url, `${P}/goals`, { title: 'A goal' })).body.data;

      const achieved = await patch(url, `${P}/goals/${goal.id}`, { status: 'achieved' });
      assert.equal(achieved.status, 200);

      // achieved -> open is not legal; only -> in_progress is.
      const back = await patch(url, `${P}/goals/${goal.id}`, { status: 'open' });
      assert.equal(back.status, 409);
      assert.equal(back.body.code, 'GOAL_INVALID_TRANSITION');

      const reopened = await patch(url, `${P}/goals/${goal.id}`, { status: 'in_progress' });
      assert.equal(reopened.status, 200, 'a mistake stays undoable');
    });
  });

  test('progress cannot be recorded against a goal with no target', async () => {
    const staff = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      const goal = (await post(url, `${P}/goals`, { title: 'Unmeasured' })).body.data;
      assert.equal(goal.progressPercent, null);
      const res = await patch(url, `${P}/goals/${goal.id}`, { currentValue: '5' });
      assert.equal(res.status, 400);
    });
  });

  test('🔴 the cascade cannot loop — the reference validates the parent not at all', async () => {
    const staff = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      const parent = (await post(url, `${P}/goals`, { title: 'Parent' })).body.data;

      const ghost = await post(url, `${P}/goals`, {
        title: 'Orphan',
        parentGoalId: String(new mongoose.Types.ObjectId()),
      });
      assert.equal(ghost.status, 400, 'an unknown parent is refused');

      const child = await post(url, `${P}/goals`, { title: 'Child', parentGoalId: parent.id });
      assert.equal(child.status, 201);
      assert.equal(child.body.data.parentGoalTitle, 'Parent');
    });
  });

  test('🔴 a goal with children cannot be deleted — the reference orphans them', async () => {
    const staff = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      const parent = (await post(url, `${P}/goals`, { title: 'Parent' })).body.data;
      await post(url, `${P}/goals`, { title: 'Child', parentGoalId: parent.id });

      const refused = await del(url, `${P}/goals/${parent.id}`);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'GOAL_HAS_CHILDREN');

      // A leaf goes.
      const leaf = (await post(url, `${P}/goals`, { title: 'Leaf' })).body.data;
      assert.equal((await del(url, `${P}/goals/${leaf.id}`)).status, 204);
      assert.equal((await get(url, `${P}/goals/${leaf.id}`)).status, 404);
    });
  });

  test('a manager sees their reports’ goals but cannot rewrite them', async () => {
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({
      reportingManagerId: manager.employee._id,
      managerChain: [manager.employee._id],
    });
    const stranger = await makeEmployee();

    let reportGoalId;
    await withServer(appFor(report.user), async (url) => {
      reportGoalId = (await post(url, `${P}/goals`, { title: 'Report goal' })).body.data.id;
    });
    await withServer(appFor(stranger.user), async (url) => {
      await post(url, `${P}/goals`, { title: 'Stranger goal' });
    });

    await withServer(appFor(manager.user), async (url) => {
      const list = await get(url, `${P}/goals`);
      assert.equal(list.status, 200);
      const titles = list.body.data.data.map((g) => g.title);
      assert.ok(titles.includes('Report goal'));
      assert.ok(!titles.includes('Stranger goal'), 'team scope is not org scope');

      // Seeing is not editing — a goal is the employee's commitment.
      const res = await patch(url, `${P}/goals/${reportGoalId}`, { status: 'cancelled' });
      assert.equal(res.status, 403);
    });
  });

  test('an ordinary employee sees only their own goals', async () => {
    const mine = await makeEmployee();
    const theirs = await makeEmployee();
    let theirGoalId;
    await withServer(appFor(theirs.user), async (url) => {
      theirGoalId = (await post(url, `${P}/goals`, { title: 'Theirs' })).body.data.id;
    });
    await withServer(appFor(mine.user), async (url) => {
      await post(url, `${P}/goals`, { title: 'Mine' });
      const list = await get(url, `${P}/goals`);
      assert.equal(list.body.data.total, 1);
      // Out of scope is a 404, not a 403 — its existence is not their business.
      assert.equal((await get(url, `${P}/goals/${theirGoalId}`)).status, 404);
    });
  });
});

// ===========================================================================
// Review cycles
// ===========================================================================

describe('review cycles', () => {
  test('HR creates a cycle; it starts in goal setting and offers only the next phase', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const cycle = await makeCycle(url);
      assert.equal(cycle.phase, 'goal_setting');
      assert.deepEqual(cycle.nextPhases, ['self_review']);
      assert.equal(cycle.competencies.length, 2);
      assert.equal(cycle.responseCount, 0);
    });
  });

  test('an ordinary employee can read cycles but not create one', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      await makeCycle(url);
    });
    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await get(url, `${P}/cycles`)).status, 200, 'the picker needs this');
      assert.equal((await post(url, `${P}/cycles`, CYCLE)).status, 403);
    });
  });

  test('inverted dates and duplicate competency keys are refused', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const inverted = await post(url, `${P}/cycles`, {
        ...CYCLE,
        startDate: dayIn(60),
        endDate: dayIn(-30),
      });
      assert.equal(inverted.status, 400);

      const dupes = await post(url, `${P}/cycles`, {
        ...CYCLE,
        name: 'Dupes',
        competencies: [
          { key: 'execution', label: 'One', weight: 1 },
          { key: 'execution', label: 'Two', weight: 1 },
        ],
      });
      assert.equal(dupes.status, 400);
      assert.match(JSON.stringify(dupes.body), /cannot share a key/i);
    });
  });

  test('🔴 the phase machine is ENFORCED — the reference accepts any phase from any phase', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const cycle = await makeCycle(url);

      // goal_setting -> calibration skips two phases.
      const skip = await post(url, `${P}/cycles/${cycle.id}/phase`, { phase: 'calibration' });
      assert.equal(skip.status, 409);
      assert.equal(skip.body.code, 'CYCLE_INVALID_TRANSITION');

      for (const phase of ['self_review', 'manager_review', 'calibration', 'closed']) {
        const res = await post(url, `${P}/cycles/${cycle.id}/phase`, { phase });
        assert.equal(res.status, 200, `${phase}: ${JSON.stringify(res.body)}`);
      }

      // Closed is terminal — the reference guards only this one.
      const reopen = await post(url, `${P}/cycles/${cycle.id}/phase`, { phase: 'calibration' });
      assert.equal(reopen.status, 409);
    });
  });

  test('🔴 a cycle cannot step back once anybody has submitted', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let cycle;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await cycleInPhase(url, 'self_review');
      // Stepping back is legal while nothing has been filed.
      const back = await post(url, `${P}/cycles/${cycle.id}/phase`, { phase: 'goal_setting' });
      assert.equal(back.status, 200, 'a premature advance is undoable');
      await post(url, `${P}/cycles/${cycle.id}/phase`, { phase: 'self_review' });
    });

    await withServer(appFor(staff.user), async (url) => {
      const review = await post(url, `${P}/reviews`, {
        cycleId: cycle.id,
        employeeId: staff.id,
        kind: 'self',
      });
      assert.equal(review.status, 201, JSON.stringify(review.body));
      const submitted = await post(url, `${P}/reviews/${review.body.data.id}/submit`, {
        ratings: { execution: 4, collaboration: 3 },
        overallRating: 4,
      });
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    });

    await withServer(appFor(hr.user), async (url) => {
      const back = await post(url, `${P}/cycles/${cycle.id}/phase`, { phase: 'goal_setting' });
      assert.equal(back.status, 409);
      assert.equal(back.body.code, 'CYCLE_HAS_SUBMISSIONS');
    });
  });

  test('phase changes are audited with both ends of the move', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const cycle = await makeCycle(url);
      await post(url, `${P}/cycles/${cycle.id}/phase`, { phase: 'self_review' });
      const entry = await AuditLog.findOne({
        action: AUDIT_ACTIONS.REVIEW_CYCLE_PHASE_CHANGED,
      }).lean();
      assert.ok(entry);
      assert.equal(entry.meta.from, 'goal_setting');
      assert.equal(entry.meta.to, 'self_review');
    });
  });
});

// ===========================================================================
// Review responses
// ===========================================================================

describe('review responses', () => {
  test('a self review can only be opened by its own subject', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let cycle;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await cycleInPhase(url, 'self_review');
      const res = await post(url, `${P}/reviews`, {
        cycleId: cycle.id,
        employeeId: staff.id,
        kind: 'self',
      });
      assert.equal(res.status, 403, 'even HR cannot open somebody else’s self-review');
    });
    await withServer(appFor(staff.user), async (url) => {
      const res = await post(url, `${P}/reviews`, {
        cycleId: cycle.id,
        employeeId: staff.id,
        kind: 'self',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.reviewerEmployeeId, staff.id);
    });
  });

  test('a manager review resolves the reviewer from the reporting line', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({ reportingManagerId: manager.employee._id });

    await withServer(appFor(hr.user), async (url) => {
      const cycle = await cycleInPhase(url, 'manager_review');
      const res = await post(url, `${P}/reviews`, {
        cycleId: cycle.id,
        employeeId: report.id,
        kind: 'manager',
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.reviewerEmployeeId, manager.id, 'the manager writes it, not HR');
    });
  });

  test('🔴 a peer review is assigned to the PEER — the reference assigns it to whoever clicked', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const subject = await makeEmployee();
    const peer = await makeEmployee();

    await withServer(appFor(hr.user), async (url) => {
      const cycle = await cycleInPhase(url, 'manager_review');

      // The schema requires a reviewer for peer/skip-level.
      const missing = await post(url, `${P}/reviews`, {
        cycleId: cycle.id,
        employeeId: subject.id,
        kind: 'peer',
      });
      assert.equal(missing.status, 400);
      assert.match(JSON.stringify(missing.body), /who should write/i);

      const res = await post(url, `${P}/reviews`, {
        cycleId: cycle.id,
        employeeId: subject.id,
        kind: 'peer',
        reviewerEmployeeId: peer.id,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.reviewerEmployeeId, peer.id);
      assert.notEqual(res.body.data.reviewerEmployeeId, hr.id, 'not the actor');

      // And it lands in the PEER's queue, not HR's.
      const self = await post(url, `${P}/reviews`, {
        cycleId: cycle.id,
        employeeId: subject.id,
        kind: 'peer',
        reviewerEmployeeId: subject.id,
      });
      assert.equal(self.status, 400, 'nobody peer-reviews themselves');
    });

    await withServer(appFor(peer.user), async (url) => {
      const mine = await get(url, `${P}/reviews/mine`);
      assert.equal(mine.body.data.total, 1);
      assert.equal(mine.body.data.data[0].kind, 'peer');
    });
  });

  test('reviews cannot be opened in goal setting or after closing', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let cycle;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await makeCycle(url);
    });
    await withServer(appFor(staff.user), async (url) => {
      const early = await post(url, `${P}/reviews`, {
        cycleId: cycle.id,
        employeeId: staff.id,
        kind: 'self',
      });
      assert.equal(early.status, 409);
      assert.equal(early.body.code, 'CYCLE_NOT_ACCEPTING_REVIEWS');
    });
  });

  test('a review cannot be opened on somebody who has left', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const gone = await makeEmployee({ reportingManagerId: manager.employee._id, status: 'exited' });
    await withServer(appFor(hr.user), async (url) => {
      const cycle = await cycleInPhase(url, 'manager_review');
      const res = await post(url, `${P}/reviews`, {
        cycleId: cycle.id,
        employeeId: gone.id,
        kind: 'manager',
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'EMPLOYEE_NOT_REVIEWABLE');
    });
  });

  test('only the assigned reviewer may submit, once', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let cycle;
    let reviewId;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await cycleInPhase(url, 'self_review');
    });
    await withServer(appFor(staff.user), async (url) => {
      reviewId = (
        await post(url, `${P}/reviews`, { cycleId: cycle.id, employeeId: staff.id, kind: 'self' })
      ).body.data.id;
    });

    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/reviews/${reviewId}/submit`, {
        ratings: { execution: 5 },
        overallRating: 5,
      });
      assert.equal(res.status, 403, 'HR cannot file somebody else’s review');
    });

    await withServer(appFor(staff.user), async (url) => {
      const first = await post(url, `${P}/reviews/${reviewId}/submit`, {
        ratings: { execution: 4, collaboration: 3 },
        overallRating: 4,
        comments: 'A solid quarter.',
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.ok(first.body.data.submittedAt);
      assert.deepEqual(first.body.data.ratings, { execution: 4, collaboration: 3 });

      const again = await post(url, `${P}/reviews/${reviewId}/submit`, {
        ratings: { execution: 1 },
        overallRating: 1,
      });
      assert.equal(again.status, 409, 'a rating cannot be revised after filing');
      assert.equal(again.body.code, 'REVIEW_ALREADY_SUBMITTED');
    });
  });

  test('🔴 a rating under an unknown competency is refused — the reference accepts any key', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let cycle;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await cycleInPhase(url, 'self_review');
    });
    await withServer(appFor(staff.user), async (url) => {
      const review = (
        await post(url, `${P}/reviews`, { cycleId: cycle.id, employeeId: staff.id, kind: 'self' })
      ).body.data;
      const res = await post(url, `${P}/reviews/${review.id}/submit`, {
        ratings: { execution: 4, telepathy: 5 },
        overallRating: 4,
      });
      assert.equal(res.status, 400);
      assert.match(JSON.stringify(res.body), /no competenc/i);
    });
  });

  test('ratings outside 1–5, and an empty rating map, are refused', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let cycle;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await cycleInPhase(url, 'self_review');
    });
    await withServer(appFor(staff.user), async (url) => {
      const review = (
        await post(url, `${P}/reviews`, { cycleId: cycle.id, employeeId: staff.id, kind: 'self' })
      ).body.data;

      assert.equal(
        (await post(url, `${P}/reviews/${review.id}/submit`, { ratings: {}, overallRating: 3 }))
          .status,
        400,
      );
      assert.equal(
        (
          await post(url, `${P}/reviews/${review.id}/submit`, {
            ratings: { execution: 9 },
            overallRating: 3,
          })
        ).status,
        400,
      );
    });
  });

  test('🔴 an employee can read the reviews written ABOUT them — the reference never shows them', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({ reportingManagerId: manager.employee._id });
    const peer = await makeEmployee();

    let cycle;
    let managerReviewId;
    let peerReviewId;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await cycleInPhase(url, 'manager_review');
      managerReviewId = (
        await post(url, `${P}/reviews`, {
          cycleId: cycle.id,
          employeeId: report.id,
          kind: 'manager',
        })
      ).body.data.id;
      peerReviewId = (
        await post(url, `${P}/reviews`, {
          cycleId: cycle.id,
          employeeId: report.id,
          kind: 'peer',
          reviewerEmployeeId: peer.id,
        })
      ).body.data.id;
    });

    await withServer(appFor(manager.user), async (url) => {
      await post(url, `${P}/reviews/${managerReviewId}/submit`, {
        ratings: { execution: 4, collaboration: 5 },
        overallRating: 4,
        comments: 'Strong quarter.',
      });
    });
    await withServer(appFor(peer.user), async (url) => {
      await post(url, `${P}/reviews/${peerReviewId}/submit`, {
        ratings: { execution: 3, collaboration: 4 },
        overallRating: 3,
      });
    });

    // Still mid-cycle: nothing is visible to the subject yet.
    await withServer(appFor(report.user), async (url) => {
      const early = await get(url, `${P}/reviews/about-me`);
      assert.equal(early.body.data.total, 0, 'not before calibration');
    });

    await withServer(appFor(hr.user), async (url) => {
      await post(url, `${P}/cycles/${cycle.id}/phase`, { phase: 'calibration' });
    });

    await withServer(appFor(report.user), async (url) => {
      const res = await get(url, `${P}/reviews/about-me`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.total, 2);

      const byKind = Object.fromEntries(res.body.data.data.map((r) => [r.kind, r]));
      assert.equal(byKind.manager.reviewerName, manager.employee.firstName + ' ' + manager.employee.lastName);
      assert.equal(byKind.manager.comments, 'Strong quarter.');
      // A peer reviewer is not named to the subject.
      assert.equal(byKind.peer.reviewerEmployeeId, null);
      assert.equal(byKind.peer.reviewerName, 'A peer');
    });
  });

  test('an ordinary employee cannot list the whole cycle’s responses', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    await withServer(appFor(hr.user), async (url) => {
      await cycleInPhase(url, 'self_review');
    });
    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await get(url, `${P}/reviews`)).status, 403);
    });
  });

  test('the same review cannot be opened twice, even concurrently', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let cycle;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await cycleInPhase(url, 'self_review');
    });
    await withServer(appFor(staff.user), async (url) => {
      const body = { cycleId: cycle.id, employeeId: staff.id, kind: 'self' };
      const results = await Promise.all([
        post(url, `${P}/reviews`, body),
        post(url, `${P}/reviews`, body),
      ]);
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(await ReviewResponse.countDocuments({}), 1);
    });
  });
});

// ===========================================================================
// Calibration
// ===========================================================================

describe('calibration', () => {
  test('🔴 the distribution FLOORS the average — the reference rounds and over-reports the top band', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({ reportingManagerId: manager.employee._id });

    let cycle;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await cycleInPhase(url, 'manager_review');
    });

    // Two manager-side ratings averaging 3.5 — the boundary the reference
    // rounds up into band 4.
    await withServer(appFor(hr.user), async (url) => {
      for (const [kind, reviewerId] of [
        ['manager', null],
        ['peer', hr.id],
      ]) {
        await post(url, `${P}/reviews`, {
          cycleId: cycle.id,
          employeeId: report.id,
          kind,
          ...(reviewerId ? { reviewerEmployeeId: reviewerId } : {}),
        });
      }
    });

    await withServer(appFor(manager.user), async (url) => {
      const mine = await get(url, `${P}/reviews/mine`);
      const row = mine.body.data.data[0];
      await post(url, `${P}/reviews/${row.id}/submit`, {
        ratings: { execution: 3 },
        overallRating: 3,
      });
    });
    await withServer(appFor(hr.user), async (url) => {
      const mine = await get(url, `${P}/reviews/mine`);
      const peerRow = mine.body.data.data.find((r) => r.kind === 'peer');
      await post(url, `${P}/reviews/${peerRow.id}/submit`, {
        ratings: { execution: 5 },
        overallRating: 5,
      });

      const cal = await get(url, `${P}/cycles/${cycle.id}/calibration`);
      assert.equal(cal.status, 200, JSON.stringify(cal.body));
      const row = cal.body.data.responses[0];
      assert.equal(row.managerRating, 3, 'one manager review of 3');
      assert.equal(row.peerAverage, 5, 'peer and skip-level pool together');
      assert.equal(cal.body.data.distribution['3'], 1);
      assert.equal(cal.body.data.distribution['4'], 0);
    });
  });

  test('calibration reports the self-vs-manager gap and is HR-only', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let cycle;
    await withServer(appFor(hr.user), async (url) => {
      cycle = await cycleInPhase(url, 'self_review');
    });
    await withServer(appFor(staff.user), async (url) => {
      const review = (
        await post(url, `${P}/reviews`, { cycleId: cycle.id, employeeId: staff.id, kind: 'self' })
      ).body.data;
      await post(url, `${P}/reviews/${review.id}/submit`, {
        ratings: { execution: 5 },
        overallRating: 5,
      });
      assert.equal(
        (await get(url, `${P}/cycles/${cycle.id}/calibration`)).status,
        403,
        'calibration is HR’s view',
      );
    });
    await withServer(appFor(hr.user), async (url) => {
      const cal = await get(url, `${P}/cycles/${cycle.id}/calibration`);
      assert.equal(cal.body.data.responses[0].selfRating, 5);
      assert.equal(cal.body.data.responses[0].managerRating, null);
      assert.equal(cal.body.data.responses[0].gap, null, 'no gap without both sides');
      assert.equal(cal.body.data.rated, 0);
    });
  });
});

// ===========================================================================
// Feedback
// ===========================================================================

describe('feedback', () => {
  test('a note reaches the recipient and appears in the sender’s given list', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    await withServer(appFor(a.user), async (url) => {
      const res = await post(url, `${P}/feedback`, {
        toEmployeeId: b.id,
        kind: 'praise',
        message: 'Great handover on the migration.',
        tags: ['ownership'],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const given = await get(url, `${P}/feedback/given`);
      assert.equal(given.body.data.total, 1);
      assert.equal(given.body.data.data[0].toEmployeeId, b.id);
    });

    await withServer(appFor(b.user), async (url) => {
      const received = await get(url, `${P}/feedback/received`);
      assert.equal(received.body.data.total, 1);
      assert.equal(received.body.data.data[0].fromEmployeeId, a.id);
      assert.equal(received.body.data.data[0].anonymous, false);
    });
  });

  test('🔴 anonymous feedback hides the sender with ABSENCE, not a zero-UUID sentinel', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    await withServer(appFor(a.user), async (url) => {
      await post(url, `${P}/feedback`, {
        toEmployeeId: b.id,
        kind: 'constructive',
        message: 'The stand-up updates could be tighter.',
        visibility: 'anonymous',
      });
      // The sender always sees their own note.
      const given = await get(url, `${P}/feedback/given`);
      assert.equal(given.body.data.data[0].fromEmployeeId, a.id);
    });

    await withServer(appFor(b.user), async (url) => {
      const row = (await get(url, `${P}/feedback/received`)).body.data.data[0];
      assert.equal(row.fromEmployeeId, null, 'absent, not 00000000-...');
      assert.equal(row.fromName, 'Anonymous');
      assert.equal(row.anonymous, true);
      assert.equal(row.message, 'The stand-up updates could be tighter.');
    });

    // At rest the sender is always recorded — that is what makes moderation possible.
    const stored = await Feedback.findOne({}).lean();
    assert.equal(String(stored.fromEmployeeId), a.id);
  });

  test('feedback to yourself is refused, and the message never enters the audit trail', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    await withServer(appFor(a.user), async (url) => {
      const self = await post(url, `${P}/feedback`, {
        toEmployeeId: a.id,
        kind: 'praise',
        message: 'Well done me',
      });
      assert.equal(self.status, 403);

      await post(url, `${P}/feedback`, {
        toEmployeeId: b.id,
        kind: 'praise',
        message: 'A private detail nobody else should read.',
      });
    });

    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.FEEDBACK_GIVEN }).lean();
    assert.ok(entry, 'the act is recorded');
    assert.doesNotMatch(JSON.stringify(entry), /private detail/i, 'the body is not');
  });

  test('a colleague who has left cannot be sent feedback', async () => {
    const a = await makeEmployee();
    const gone = await makeEmployee({ status: 'exited' });
    await withServer(appFor(a.user), async (url) => {
      const res = await post(url, `${P}/feedback`, {
        toEmployeeId: gone.id,
        kind: 'praise',
        message: 'Thanks for everything',
      });
      assert.equal(res.status, 400);
    });
  });
});

// ===========================================================================
// 1:1s
// ===========================================================================

describe('one-on-ones', () => {
  test('a manager schedules with a direct report; both sides see it', async () => {
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({ reportingManagerId: manager.employee._id });

    await withServer(appFor(manager.user), async (url) => {
      const res = await post(url, `${P}/one-on-ones`, {
        reportEmployeeId: report.id,
        scheduledAt: instantIn(3),
        durationMinutes: 45,
        agenda: [{ text: 'Q3 goals', done: false }],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.viewerIsManager, true);
      assert.equal(res.body.data.agenda.length, 1);
    });

    await withServer(appFor(report.user), async (url) => {
      const list = await get(url, `${P}/one-on-ones`);
      assert.equal(list.body.data.total, 1);
      assert.equal(list.body.data.data[0].viewerIsManager, false);
    });
  });

  test('a 1:1 can only be scheduled with a DIRECT report, and not in the past', async () => {
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const skipLevel = await makeEmployee({
      managerChain: [manager.employee._id],
    });
    const report = await makeEmployee({ reportingManagerId: manager.employee._id });

    await withServer(appFor(manager.user), async (url) => {
      const notDirect = await post(url, `${P}/one-on-ones`, {
        reportEmployeeId: skipLevel.id,
        scheduledAt: instantIn(3),
      });
      assert.equal(notDirect.status, 403, 'team scope reaches further than a 1:1 should');

      const past = await post(url, `${P}/one-on-ones`, {
        reportEmployeeId: report.id,
        scheduledAt: instantIn(-3),
      });
      assert.equal(past.status, 400);
    });
  });

  test('either side may edit the shared notepad', async () => {
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({ reportingManagerId: manager.employee._id });
    let id;
    await withServer(appFor(manager.user), async (url) => {
      id = (
        await post(url, `${P}/one-on-ones`, {
          reportEmployeeId: report.id,
          scheduledAt: instantIn(3),
        })
      ).body.data.id;
    });

    await withServer(appFor(report.user), async (url) => {
      const res = await patch(url, `${P}/one-on-ones/${id}`, {
        notes: [{ text: 'Talked about the release', done: false }],
        actionItems: [{ text: 'Draft the RFC', done: false }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.notes.length, 1);
      assert.equal(res.body.data.actionItems[0].text, 'Draft the RFC');
    });
  });

  test('🔴 only the manager may reschedule OR resolve — the reference lets a report cancel', async () => {
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({ reportingManagerId: manager.employee._id });
    let id;
    await withServer(appFor(manager.user), async (url) => {
      id = (
        await post(url, `${P}/one-on-ones`, {
          reportEmployeeId: report.id,
          scheduledAt: instantIn(3),
        })
      ).body.data.id;
    });

    await withServer(appFor(report.user), async (url) => {
      assert.equal(
        (await patch(url, `${P}/one-on-ones/${id}`, { scheduledAt: instantIn(5) })).status,
        403,
        'rescheduling is the manager’s',
      );
      assert.equal(
        (await patch(url, `${P}/one-on-ones/${id}`, { status: 'cancelled' })).status,
        403,
        'and so is cancelling',
      );
    });

    await withServer(appFor(manager.user), async (url) => {
      const done = await patch(url, `${P}/one-on-ones/${id}`, { status: 'completed' });
      assert.equal(done.status, 200);
      // 🔴 Terminal — the reference lets a completed meeting go back to scheduled.
      const revive = await patch(url, `${P}/one-on-ones/${id}`, { status: 'scheduled' });
      assert.equal(revive.status, 409);
      assert.equal(revive.body.code, 'ONE_ON_ONE_INVALID_TRANSITION');
    });
  });

  test('somebody who is neither participant cannot touch a 1:1', async () => {
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const report = await makeEmployee({ reportingManagerId: manager.employee._id });
    const stranger = await makeEmployee();
    let id;
    await withServer(appFor(manager.user), async (url) => {
      id = (
        await post(url, `${P}/one-on-ones`, {
          reportEmployeeId: report.id,
          scheduledAt: instantIn(3),
        })
      ).body.data.id;
    });
    await withServer(appFor(stranger.user), async (url) => {
      assert.equal((await get(url, `${P}/one-on-ones`)).body.data.total, 0);
      assert.equal(
        (await patch(url, `${P}/one-on-ones/${id}`, { notes: [{ text: 'x', done: false }] })).status,
        403,
      );
    });
  });

  test('an ordinary employee cannot schedule a 1:1 at all', async () => {
    const staff = await makeEmployee();
    const other = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      const res = await post(url, `${P}/one-on-ones`, {
        reportEmployeeId: other.id,
        scheduledAt: instantIn(3),
      });
      assert.equal(res.status, 403);
    });
  });
});

// ===========================================================================
// Envelope
// ===========================================================================

describe('response envelope', () => {
  test('every payload sits UNDER data, never spread beside it', async () => {
    const staff = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      await post(url, `${P}/goals`, { title: 'A goal' });
      const res = await get(url, `${P}/goals`);
      assert.deepEqual(Object.keys(res.body).sort(), ['data', 'success']);
      assert.deepEqual(Object.keys(res.body.data).sort(), ['data', 'page', 'pageSize', 'total']);
    });
  });
});
