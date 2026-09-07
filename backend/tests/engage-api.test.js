/**
 * Engage — announcements, polls, recognition and the eNPS pulse.
 *
 * A real Express app over a real MongoDB, following the pattern every other
 * HRMS module established. Only `protect` is stubbed; the permission chain,
 * the validator, the services and the error handler are the genuine article.
 *
 * The assertions that carry the most weight are the ones about anonymity: an
 * anonymous poll or eNPS answer must not be attributable from the audit trail,
 * which is exactly what the reference's `@Audited` decorator makes it.
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
  Announcement,
  Poll,
  PollResponse,
  RecognitionBadge,
  Recognition,
  ENpsSurvey,
  ENpsResponse,
} from '../models/hrms/EngageModels.js';

import engageRoutes from '../modules/hrms/engage/engage.routes.js';
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
import { buildTestApp, stubProtect, withServer, get, post, del } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/engage';

const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

before(async () => {
  await startTestMongo();
  await syncIndexes(
    Employee,
    User,
    Department,
    Announcement,
    Poll,
    PollResponse,
    RecognitionBadge,
    Recognition,
    ENpsSurvey,
    ENpsResponse,
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
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/engage', engageRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;

async function makeEmployee({ roles = [R.EMPLOYEE], departmentId = null, status = 'active' } = {}) {
  seq += 1;
  const user = await User.create({
    email: `eng${seq}@example.com`,
    password: 'x'.repeat(60),
    user: `Person ${seq}`,
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    userId: user._id,
    employeeCode: `ENG${String(seq).padStart(3, '0')}`,
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

// ===========================================================================
// Announcements
// ===========================================================================

describe('announcements', () => {
  test('HR drafts one, publishes it, and everybody then sees it', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();

    let id;
    await withServer(appFor(hr.user), async (url) => {
      const created = await post(url, `${P}/announcements`, {
        title: 'Office closed Friday',
        body: 'The building is shut for maintenance.',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.state, 'draft');
      assert.equal(created.body.data.orgWide, true);
      id = created.body.data.id;
    });

    // A draft is HR's alone.
    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await get(url, `${P}/announcements`)).body.data.total, 0);
      assert.equal((await get(url, `${P}/announcements/${id}`)).status, 404);
    });

    await withServer(appFor(hr.user), async (url) => {
      const published = await post(url, `${P}/announcements/${id}/publish`, {});
      assert.equal(published.status, 200);
      assert.equal(published.body.data.state, 'published');
    });

    await withServer(appFor(staff.user), async (url) => {
      const list = await get(url, `${P}/announcements`);
      assert.equal(list.body.data.total, 1);
      assert.equal(list.body.data.data[0].title, 'Office closed Friday');
    });
  });

  test('🔴 targeting is applied IN the query — the reference filters after a take(100)', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const engineering = await makeDepartment('ENG');
    const sales = await makeDepartment('SLS');
    const engineer = await makeEmployee({ departmentId: engineering._id });

    await withServer(appFor(hr.user), async (url) => {
      // 30 announcements aimed at a department this reader is not in. The
      // reference would fetch the newest 100 and filter afterwards; with
      // enough of these the one addressed to them falls off the page.
      for (let i = 0; i < 30; i += 1) {
        await post(url, `${P}/announcements`, {
          title: `Sales notice ${i}`,
          body: 'Not for engineering.',
          publishNow: true,
          targetDepartmentIds: [String(sales._id)],
        });
      }
      const mine = await post(url, `${P}/announcements`, {
        title: 'Engineering all-hands',
        body: 'For engineering.',
        publishNow: true,
        targetDepartmentIds: [String(engineering._id)],
      });
      assert.equal(mine.status, 201, JSON.stringify(mine.body));
    });

    await withServer(appFor(engineer.user), async (url) => {
      const list = await get(url, `${P}/announcements?page=1&pageSize=25`);
      assert.equal(list.body.data.total, 1, 'only what is addressed to them counts');
      assert.equal(list.body.data.data[0].title, 'Engineering all-hands');
    });
  });

  test('role targeting reaches the right roles and nobody else', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const staff = await makeEmployee();

    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/announcements`, {
        title: 'Managers only',
        body: 'Headcount planning opens Monday.',
        publishNow: true,
        targetRoleKeys: [R.MANAGER],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    });

    await withServer(appFor(manager.user), async (url) => {
      assert.equal((await get(url, `${P}/announcements`)).body.data.total, 1);
    });
    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await get(url, `${P}/announcements`)).body.data.total, 0);
    });
  });

  test('an expired announcement drops out of the feed but stays visible to HR', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();

    // Expiry must be in the future at creation; wind it back directly to
    // simulate the passage of time rather than sleeping.
    let id;
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/announcements`, {
        title: 'Lunch today',
        body: 'Pizza in the kitchen.',
        publishNow: true,
        expiresAt: inDays(1),
      });
      id = res.body.data.id;
    });
    await Announcement.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await get(url, `${P}/announcements`)).body.data.total, 0);
    });
    await withServer(appFor(hr.user), async (url) => {
      const list = await get(url, `${P}/announcements?state=expired`);
      assert.equal(list.body.data.total, 1);
      assert.equal(list.body.data.data[0].state, 'expired');
    });
  });

  test('an ordinary employee cannot create, publish or delete', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let id;
    await withServer(appFor(hr.user), async (url) => {
      id = (
        await post(url, `${P}/announcements`, { title: 'T', body: 'B', publishNow: true })
      ).body.data.id;
    });
    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await post(url, `${P}/announcements`, { title: 'X', body: 'Y' })).status, 403);
      assert.equal((await post(url, `${P}/announcements/${id}/publish`, {})).status, 403);
      assert.equal((await del(url, `${P}/announcements/${id}`)).status, 403);
    });
  });

  test('🔴 deleting an unknown announcement is a 404, not a driver error', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const res = await del(url, `${P}/announcements/${new mongoose.Types.ObjectId()}`);
      assert.equal(res.status, 404);
    });
  });

  test('a bad role key or unknown department is refused', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const badRole = await post(url, `${P}/announcements`, {
        title: 'T',
        body: 'B',
        targetRoleKeys: ['employee'],
      });
      assert.equal(badRole.status, 400, 'the reference accepts any string here');

      const badDept = await post(url, `${P}/announcements`, {
        title: 'T',
        body: 'B',
        targetDepartmentIds: [String(new mongoose.Types.ObjectId())],
      });
      assert.equal(badDept.status, 400);
    });
  });

  test('publishing is audited with the audience it went to', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      await post(url, `${P}/announcements`, { title: 'T', body: 'B', publishNow: true });
    });
    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.ANNOUNCEMENT_PUBLISHED }).lean();
    assert.ok(entry, 'the fan-out point is preserved as an audit entry');
    assert.equal(entry.meta.orgWide, true);
  });
});

// ===========================================================================
// Polls
// ===========================================================================

describe('polls', () => {
  async function makePoll(url, overrides = {}) {
    const res = await post(url, `${P}/polls`, {
      question: 'Which day suits the offsite?',
      kind: 'single',
      options: [
        { key: 'fri', label: 'Friday' },
        { key: 'sat', label: 'Saturday' },
      ],
      ...overrides,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }

  test('a choice poll needs at least two options', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/polls`, {
        question: 'Q?',
        kind: 'single',
        options: [{ key: 'a', label: 'A' }],
      });
      assert.equal(res.status, 400);
      assert.match(JSON.stringify(res.body), /at least 2 options/i);
    });
  });

  test('a single-choice answer must be exactly one KNOWN option', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let poll;
    await withServer(appFor(hr.user), async (url) => {
      poll = await makePoll(url);
    });

    await withServer(appFor(staff.user), async (url) => {
      assert.equal(
        (await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['fri', 'sat'] })).status,
        400,
        'two answers to a single-choice poll',
      );
      assert.equal(
        (await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['sun'] })).status,
        400,
        'an option this poll does not have',
      );
      const ok = await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['fri'] });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.hasResponded, true);
      assert.equal(ok.body.data.responseCount, 1);
    });
  });

  test('🔴 a scale answer is a NUMBER — the reference validates text and its UI sends keys', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let poll;
    await withServer(appFor(hr.user), async (url) => {
      poll = await makePoll(url, { kind: 'scale', options: [] });
    });

    await withServer(appFor(staff.user), async (url) => {
      // The reference's own form would send this, and its validator would then
      // read `Number(undefined)` and store nothing usable.
      assert.equal(
        (await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['scale_7'] })).status,
        400,
      );
      assert.equal(
        (await post(url, `${P}/polls/${poll.id}/respond`, { scale: 42 })).status,
        400,
        'out of range',
      );
      assert.equal((await post(url, `${P}/polls/${poll.id}/respond`, { scale: 7 })).status, 201);
    });

    await withServer(appFor(hr.user), async (url) => {
      const results = await get(url, `${P}/polls/${poll.id}/results`);
      assert.equal(results.body.data.scaleAverage, 7, 'and the average is actually computable');
    });
  });

  test('an open-ended poll needs text', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let poll;
    await withServer(appFor(hr.user), async (url) => {
      poll = await makePoll(url, { kind: 'open_ended', options: [] });
    });
    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await post(url, `${P}/polls/${poll.id}/respond`, {})).status, 400);
      assert.equal(
        (await post(url, `${P}/polls/${poll.id}/respond`, { text: 'More natural light.' })).status,
        201,
      );
    });
    await withServer(appFor(hr.user), async (url) => {
      const results = await get(url, `${P}/polls/${poll.id}/results`);
      assert.deepEqual(results.body.data.openTexts, ['More natural light.']);
    });
  });

  test('nobody answers twice, even concurrently', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let poll;
    await withServer(appFor(hr.user), async (url) => {
      poll = await makePoll(url);
    });

    await withServer(appFor(staff.user), async (url) => {
      const results = await Promise.all([
        post(url, `${P}/polls/${poll.id}/respond`, { keys: ['fri'] }),
        post(url, `${P}/polls/${poll.id}/respond`, { keys: ['sat'] }),
      ]);
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(await PollResponse.countDocuments({}), 1);
    });
  });

  test('🔴 a draft poll can be LAUNCHED — the reference has no endpoint, so drafts are dead', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let poll;
    await withServer(appFor(hr.user), async (url) => {
      poll = await makePoll(url, { launchNow: false });
      assert.equal(poll.open, false);
    });

    await withServer(appFor(staff.user), async (url) => {
      const early = await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['fri'] });
      assert.equal(early.status, 409);
      assert.equal(early.body.code, 'POLL_NOT_LAUNCHED');
    });

    await withServer(appFor(hr.user), async (url) => {
      const launched = await post(url, `${P}/polls/${poll.id}/launch`, {});
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      assert.equal(launched.body.data.open, true);
      assert.equal((await post(url, `${P}/polls/${poll.id}/launch`, {})).status, 409);
    });

    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['fri'] })).status, 201);
    });
  });

  test('a closed poll refuses answers', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let poll;
    await withServer(appFor(hr.user), async (url) => {
      poll = await makePoll(url, { closesAt: inDays(1) });
    });
    await Poll.updateOne({ _id: poll.id }, { $set: { closesAt: new Date(Date.now() - 1000) } });

    await withServer(appFor(staff.user), async (url) => {
      const res = await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['fri'] });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'POLL_CLOSED');
    });
  });

  test('results are HR-only, and every declared option is counted even at zero', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let poll;
    await withServer(appFor(hr.user), async (url) => {
      poll = await makePoll(url);
    });
    await withServer(appFor(staff.user), async (url) => {
      await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['fri'] });
      assert.equal((await get(url, `${P}/polls/${poll.id}/results`)).status, 403);
    });
    await withServer(appFor(hr.user), async (url) => {
      const results = await get(url, `${P}/polls/${poll.id}/results`);
      assert.equal(results.status, 200);
      assert.equal(results.body.data.totalResponses, 1);
      // The reference omits a zero-vote option entirely, so a bar chart drops it.
      assert.deepEqual(results.body.data.optionCounts, { fri: 1, sat: 0 });
    });
  });

  test('🔴 an ANONYMOUS poll response leaves no attributable audit trail', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let anon;
    let named;
    await withServer(appFor(hr.user), async (url) => {
      anon = await makePoll(url, { question: 'Anonymous one?', anonymous: true });
      named = await makePoll(url, { question: 'Named one?', anonymous: false });
    });

    await withServer(appFor(staff.user), async (url) => {
      await post(url, `${P}/polls/${anon.id}/respond`, { keys: ['fri'] });
      await post(url, `${P}/polls/${named.id}/respond`, { keys: ['fri'] });
    });

    const entries = await AuditLog.find({ action: AUDIT_ACTIONS.POLL_RESPONDED }).lean();
    assert.equal(entries.length, 2);

    const anonEntry = entries.find((e) => e.meta?.anonymous === true);
    const namedEntry = entries.find((e) => e.meta?.anonymous === false);

    // 🔴 The reference attaches the acting user to BOTH.
    assert.ok(!anonEntry.user, 'no actor on the anonymous one');
    assert.equal(anonEntry.method, 'SYSTEM_JOB');
    assert.doesNotMatch(JSON.stringify(anonEntry), new RegExp(staff.id));

    assert.ok(namedEntry.user, 'a named poll still records who answered');
  });

  test('the respondent IS stored, so a second answer can be refused', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let poll;
    await withServer(appFor(hr.user), async (url) => {
      poll = await makePoll(url, { anonymous: true });
    });
    await withServer(appFor(staff.user), async (url) => {
      await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['fri'] });
      const again = await post(url, `${P}/polls/${poll.id}/respond`, { keys: ['sat'] });
      assert.equal(again.status, 409);
    });
    // Anonymity is a presentation and audit rule, never a storage one.
    const stored = await PollResponse.findOne({}).lean();
    assert.equal(String(stored.respondentEmployeeId), staff.id);
  });

  test('an ordinary employee cannot create or launch a poll', async () => {
    const staff = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      const res = await post(url, `${P}/polls`, {
        question: 'Q?',
        kind: 'open_ended',
        options: [],
      });
      assert.equal(res.status, 403);
    });
  });
});

// ===========================================================================
// Recognition
// ===========================================================================

describe('recognition', () => {
  test('kudos reach the recipient and appear on the wall', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();

    await withServer(appFor(a.user), async (url) => {
      const res = await post(url, `${P}/recognitions`, {
        toEmployeeId: b.id,
        message: 'Carried the migration single-handed.',
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.teamVisible, true);

      const given = await get(url, `${P}/recognitions/given`);
      assert.equal(given.body.data.total, 1);
    });

    await withServer(appFor(b.user), async (url) => {
      const received = await get(url, `${P}/recognitions/received`);
      assert.equal(received.body.data.total, 1);
      assert.equal(received.body.data.data[0].fromEmployeeId, a.id);

      const wall = await get(url, `${P}/recognitions/wall`);
      assert.equal(wall.body.data.total, 1);
    });
  });

  test('a private recognition never reaches the wall', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    const stranger = await makeEmployee();

    await withServer(appFor(a.user), async (url) => {
      await post(url, `${P}/recognitions`, {
        toEmployeeId: b.id,
        message: 'Between us.',
        teamVisible: false,
      });
    });

    await withServer(appFor(stranger.user), async (url) => {
      assert.equal((await get(url, `${P}/recognitions/wall`)).body.data.total, 0);
    });
    await withServer(appFor(b.user), async (url) => {
      assert.equal((await get(url, `${P}/recognitions/received`)).body.data.total, 1);
    });
  });

  test('🔴 anonymous kudos hide the sender with ABSENCE, not a zero-UUID sentinel', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();

    await withServer(appFor(a.user), async (url) => {
      await post(url, `${P}/recognitions`, {
        toEmployeeId: b.id,
        message: 'Quietly excellent.',
        anonymous: true,
      });
      // The sender always sees their own.
      const given = await get(url, `${P}/recognitions/given`);
      assert.equal(given.body.data.data[0].fromEmployeeId, a.id);
    });

    await withServer(appFor(b.user), async (url) => {
      const row = (await get(url, `${P}/recognitions/received`)).body.data.data[0];
      assert.equal(row.fromEmployeeId, null, 'absent, not 00000000-...');
      assert.equal(row.fromName, 'Anonymous');
      assert.equal(row.anonymous, true);
    });

    // At rest the sender is always recorded — that is what makes moderation possible.
    const stored = await Recognition.findOne({}).lean();
    assert.equal(String(stored.fromEmployeeId), a.id);
  });

  test('self-recognition is refused, and a departed colleague cannot be recognised', async () => {
    const a = await makeEmployee();
    const gone = await makeEmployee({ status: 'exited' });

    await withServer(appFor(a.user), async (url) => {
      const self = await post(url, `${P}/recognitions`, {
        toEmployeeId: a.id,
        message: 'Well done me',
      });
      assert.equal(self.status, 403);

      const left = await post(url, `${P}/recognitions`, {
        toEmployeeId: gone.id,
        message: 'Thanks for everything',
      });
      assert.equal(left.status, 400, 'the reference checks existence only');
    });
  });

  test('a badge is copied onto the recognition, so renaming it never rewrites history', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const b = await makeEmployee();

    let badgeId;
    await withServer(appFor(hr.user), async (url) => {
      const badge = await post(url, `${P}/badges`, { name: 'Team Player', iconKey: '🤝' });
      assert.equal(badge.status, 201, JSON.stringify(badge.body));
      badgeId = badge.body.data.id;

      const dupe = await post(url, `${P}/badges`, { name: 'Team Player', iconKey: '⭐' });
      assert.equal(dupe.status, 409, 'badge names are unique');

      const rec = await post(url, `${P}/recognitions`, {
        toEmployeeId: b.id,
        badgeId,
        message: 'Always helping.',
      });
      assert.equal(rec.body.data.badgeName, 'Team Player');
      assert.equal(rec.body.data.badgeIconKey, '🤝');

      const badges = await get(url, `${P}/badges`);
      assert.equal(badges.body.data[0].awardedCount, 1);
    });

    await RecognitionBadge.updateOne({ _id: badgeId }, { $set: { name: 'Renamed' } });
    const stored = await Recognition.findOne({}).lean();
    assert.equal(stored.badgeName, 'Team Player', 'the history keeps the name it was given under');
  });

  test('an unknown badge is refused, and only HR may create one', async () => {
    const staff = await makeEmployee();
    const other = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      assert.equal((await post(url, `${P}/badges`, { name: 'X', iconKey: '⭐' })).status, 403);
      const res = await post(url, `${P}/recognitions`, {
        toEmployeeId: other.id,
        badgeId: String(new mongoose.Types.ObjectId()),
        message: 'Hi',
      });
      assert.equal(res.status, 400);
    });
  });

  test('the audit trail names an anonymous sender, but never the message', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    await withServer(appFor(a.user), async (url) => {
      await post(url, `${P}/recognitions`, {
        toEmployeeId: b.id,
        message: 'A private detail nobody else should read.',
        anonymous: true,
      });
    });
    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.RECOGNITION_GIVEN }).lean();
    assert.ok(entry.user, 'moderation needs the sender');
    assert.doesNotMatch(JSON.stringify(entry), /private detail/i, 'the body is not copied');
  });
});

// ===========================================================================
// eNPS
// ===========================================================================

describe('eNPS', () => {
  test('HR launches a survey and everybody answers once', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();

    let survey;
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/enps`, { name: 'Q3 pulse', closesAt: inDays(14) });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.open, true);
      assert.match(res.body.data.question, /recommend us as a great place to work/i);
      survey = res.body.data;
    });

    await withServer(appFor(staff.user), async (url) => {
      const ok = await post(url, `${P}/enps/${survey.id}/respond`, { score: 9, comment: 'Good.' });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.hasResponded, true);

      const again = await post(url, `${P}/enps/${survey.id}/respond`, { score: 2 });
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'ENPS_ALREADY_ANSWERED');
    });
  });

  test('the score is promoters% − detractors%, at the band boundaries', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    // 9 and 10 promote, 7 and 8 are passive, 6 and below detract.
    //
    // Serially, not in parallel: `makeEmployee` reads and writes a shared
    // sequence counter across an await, so four concurrent calls collide on
    // `employeeCode`.
    const voters = [];
    for (let i = 0; i < 4; i += 1) voters.push(await makeEmployee());

    let survey;
    await withServer(appFor(hr.user), async (url) => {
      survey = (await post(url, `${P}/enps`, { name: 'Pulse', closesAt: inDays(7) })).body.data;
    });

    for (const [i, score] of [9, 8, 7, 6].entries()) {
      await withServer(appFor(voters[i].user), async (url) => {
        const res = await post(url, `${P}/enps/${survey.id}/respond`, { score });
        assert.equal(res.status, 201, JSON.stringify(res.body));
      });
    }

    await withServer(appFor(hr.user), async (url) => {
      const results = await get(url, `${P}/enps/${survey.id}/results`);
      assert.equal(results.status, 200);
      const d = results.body.data;
      assert.equal(d.promoters, 1, '9 promotes');
      assert.equal(d.passives, 2, '7 and 8 are passive');
      assert.equal(d.detractors, 1, '6 detracts');
      assert.equal(d.totalResponses, 4);
      // (1 - 1) / 4 = 0
      assert.equal(d.score, 0);
      assert.deepEqual(d.bandBoundaries, { promoterMin: 9, passiveMin: 7 });
    });
  });

  test('an empty survey scores 0 rather than dividing by zero', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const survey = (await post(url, `${P}/enps`, { name: 'Empty', closesAt: inDays(7) })).body
        .data;
      const results = await get(url, `${P}/enps/${survey.id}/results`);
      assert.equal(results.body.data.score, 0);
      assert.equal(results.body.data.totalResponses, 0);
    });
  });

  test('🔴 an eNPS response leaves NO attributable audit trail', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let survey;
    await withServer(appFor(hr.user), async (url) => {
      survey = (await post(url, `${P}/enps`, { name: 'Pulse', closesAt: inDays(7) })).body.data;
    });
    await withServer(appFor(staff.user), async (url) => {
      await post(url, `${P}/enps/${survey.id}/respond`, { score: 10, comment: 'Loving it.' });
    });

    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.ENPS_RESPONDED }).lean();
    assert.ok(entry, 'the act is still recorded');
    // 🔴 The reference attaches the acting user, making every answer attributable.
    assert.ok(!entry.user, 'but not who sent it');
    assert.equal(entry.method, 'SYSTEM_JOB');
    const serialised = JSON.stringify(entry);
    assert.doesNotMatch(serialised, new RegExp(staff.id), 'nor their employee id');
    assert.doesNotMatch(serialised, /Loving it/, 'nor what they said');
  });

  test('🔴 a survey cannot be launched already closed — the reference accepts a past date', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      const res = await post(url, `${P}/enps`, { name: 'Stale', closesAt: inDays(-1) });
      assert.equal(res.status, 400);
    });
  });

  test('a closed survey refuses answers, and results stay HR-only', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let survey;
    await withServer(appFor(hr.user), async (url) => {
      survey = (await post(url, `${P}/enps`, { name: 'Pulse', closesAt: inDays(1) })).body.data;
    });
    await ENpsSurvey.updateOne(
      { _id: survey.id },
      { $set: { closesAt: new Date(Date.now() - 1000) } },
    );

    await withServer(appFor(staff.user), async (url) => {
      const res = await post(url, `${P}/enps/${survey.id}/respond`, { score: 5 });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'ENPS_CLOSED');
      assert.equal((await get(url, `${P}/enps/${survey.id}/results`)).status, 403);
    });
  });

  test('an ordinary employee cannot launch a survey', async () => {
    const staff = await makeEmployee();
    await withServer(appFor(staff.user), async (url) => {
      assert.equal(
        (await post(url, `${P}/enps`, { name: 'Mine', closesAt: inDays(7) })).status,
        403,
      );
    });
  });

  test('🔴 comments are readable — the reference collects them and shows them to nobody', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();
    let survey;
    await withServer(appFor(hr.user), async (url) => {
      survey = (await post(url, `${P}/enps`, { name: 'Pulse', closesAt: inDays(7) })).body.data;
    });
    await withServer(appFor(staff.user), async (url) => {
      await post(url, `${P}/enps/${survey.id}/respond`, { score: 4, comment: 'Too many meetings.' });
    });
    await withServer(appFor(hr.user), async (url) => {
      const results = await get(url, `${P}/enps/${survey.id}/results`);
      assert.deepEqual(results.body.data.comments, [
        { comment: 'Too many meetings.', score: 4 },
      ]);
      // And no respondent travels with them.
      assert.doesNotMatch(JSON.stringify(results.body.data), new RegExp(staff.id));
    });
  });
});

// ===========================================================================
// Access isolation and envelope
// ===========================================================================

describe('access and envelope', () => {
  test('a portal Customer reaches no engage endpoint', async () => {
    const customer = {
      _id: new mongoose.Types.ObjectId(),
      role: 'Customer',
      roles: [],
      status: 'Active',
    };
    await withServer(appFor(customer), async (url) => {
      for (const path of ['/announcements', '/polls', '/recognitions/wall', '/badges', '/enps']) {
        const res = await get(url, `${P}${path}`);
        assert.equal(res.status, 403, `${path} is not reachable without an HRMS grant`);
      }
    });
  });

  test('every payload sits UNDER data, never spread beside it', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    await withServer(appFor(hr.user), async (url) => {
      await post(url, `${P}/announcements`, { title: 'T', body: 'B', publishNow: true });
      const res = await get(url, `${P}/announcements`);
      assert.deepEqual(Object.keys(res.body).sort(), ['data', 'success']);
      assert.deepEqual(Object.keys(res.body.data).sort(), ['data', 'page', 'pageSize', 'total']);
    });
  });
});
