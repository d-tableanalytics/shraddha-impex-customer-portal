/**
 * Inbox — the notification centre, and the twenty producer events behind it.
 *
 * A real Express app over a real MongoDB, following the pattern every other
 * HRMS module established. Only `protect` is stubbed; the permission chain, the
 * validator, the services and the error handler are the genuine article.
 *
 * The assertions that carry the most weight are the security ones. An inbox is
 * a second, denormalised copy of things people are otherwise not allowed to
 * read, addressed by name — so the tests that matter are the ones proving that
 * nobody can read, mark or archive anybody else's, that no request can address
 * a notification to a third party, and that amounts and free text never make it
 * into a notification body.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import { InboxItem } from '../models/hrms/InboxItem.js';

import inboxRoutes from '../modules/hrms/inbox/inbox.routes.js';
import { notify, notifyUsers } from '../modules/hrms/inbox/notifier.service.js';
import { inboxRetentionHandler } from '../modules/hrms/inbox/inbox.service.js';
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
import { buildHrmsActor } from '../shared/permissions/has-permission.js';
import { AUDIT_ACTIONS, HRMS_ROUTE_PREFIX } from '../shared/constants/hrms.js';
import {
  INBOX_TYPES,
  INBOX_TYPE_LIST,
  INBOX_TYPE_META,
  hrefFor,
  categoryOf,
} from '../shared/constants/inbox.js';
import { buildTestApp, stubProtect, withServer, get, post } from './helpers/http.js';
import { hasMailTemplate, renderInboxMail } from '../modules/hrms/inbox/mailTemplates.js';
import { sendInboxMail, mailEnabled } from '../modules/hrms/inbox/mail.service.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/inbox';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, User, InboxItem);
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
      router.use('/inbox', inboxRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;

/** Created SERIALLY by every caller — `seq` is shared and races on it collide. */
async function makeEmployee({ roles = [R.EMPLOYEE], status = 'active' } = {}) {
  seq += 1;
  const user = await User.create({
    email: `inbox${seq}@example.com`,
    password: 'x'.repeat(60),
    user: `Person ${seq}`,
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    userId: user._id,
    employeeCode: `INB${String(seq).padStart(3, '0')}`,
    firstName: 'Person',
    lastName: String(seq),
    dateOfJoining: new Date('2024-01-01'),
    status,
  });
  return {
    user: { _id: user._id, role: 'Management', roles, status: 'Active' },
    userId: user._id,
    employee,
    id: String(employee._id),
    /**
     * Built from the MATRIX, not hand-rolled: a literal `permissions: []`
     * would make every service-level `hasHrmsPermission` check fail and the
     * test would be proving the wrong thing.
     */
    actor: buildHrmsActor({
      userId: user._id,
      roles,
      employee: { id: employee._id },
    }),
  };
}

/** A notification, filed the only way one can be: through the notifier. */
const fileFor = (employeeId, over = {}) =>
  notify({
    to: employeeId,
    type: INBOX_TYPES.LEAVE_PENDING,
    title: 'Something happened',
    entity: 'leave_request',
    entityId: String(new mongoose.Types.ObjectId()),
    ...over,
  });

// ===========================================================================
// The shape of the module
// ===========================================================================

describe('contract', () => {
  test('every type has a label, a category and a derived link', () => {
    for (const type of INBOX_TYPE_LIST) {
      const meta = INBOX_TYPE_META[type];
      assert.ok(meta, `${type} has no metadata`);
      assert.ok(meta.label && meta.label !== type, `${type} renders its raw machine name`);
      assert.ok(meta.path.startsWith('/'), `${type} has no path`);
      assert.equal(hrefFor(type, HRMS_ROUTE_PREFIX), `${HRMS_ROUTE_PREFIX}${meta.path}`);
    }
  });

  test('an unknown type still lands somewhere real rather than nowhere', () => {
    assert.equal(hrefFor('made.up', HRMS_ROUTE_PREFIX), `${HRMS_ROUTE_PREFIX}/dashboard`);
    assert.equal(categoryOf('made.up'), 'update');
  });

  test('the payload goes UNDER data, with a total and a live unread count', async () => {
    const me = await makeEmployee();
    await fileFor(me.id);

    await withServer(appFor(me.user), async (url) => {
      const res = await get(url, P);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data.data));
      assert.equal(res.body.data.total, 1);
      assert.equal(res.body.data.unread, 1);
      // 🔴 The reference returns a bare ARRAY — no envelope, no total, no page.
      assert.equal(res.body.total, undefined);
    });
  });

  test('🔴 there is NO endpoint that creates an inbox item', async () => {
    const me = await makeEmployee();
    const victim = await makeEmployee();

    await withServer(appFor(me.user), async (url) => {
      for (const body of [
        { to: victim.id, type: INBOX_TYPES.LEAVE_PENDING, title: 'Fake' },
        { recipientEmployeeId: victim.id, title: 'Fake' },
      ]) {
        const res = await post(url, P, body);
        // 404 from the router: nothing accepts a POST to the collection.
        assert.equal(res.status, 404, JSON.stringify(res.body));
      }
    });

    assert.equal(await InboxItem.countDocuments({}), 0);
  });
});

// ===========================================================================
// Recipient isolation — the whole point of the module
// ===========================================================================

describe('recipient isolation', () => {
  test('I see only my own items', async () => {
    const me = await makeEmployee();
    const other = await makeEmployee();
    await fileFor(me.id, { title: 'Mine' });
    await fileFor(other.id, { title: 'Theirs' });

    await withServer(appFor(me.user), async (url) => {
      const res = await get(url, P);
      assert.equal(res.body.data.total, 1);
      assert.equal(res.body.data.data[0].title, 'Mine');
    });

    await withServer(appFor(other.user), async (url) => {
      const res = await get(url, P);
      assert.equal(res.body.data.total, 1);
      assert.equal(res.body.data.data[0].title, 'Theirs');
    });
  });

  test("🔴 IDOR: I cannot mark, unmark or archive somebody else's item", async () => {
    const me = await makeEmployee();
    const other = await makeEmployee();
    await fileFor(other.id, { title: 'Theirs' });
    const theirs = await InboxItem.findOne({ recipientEmployeeId: other.employee._id }).lean();

    await withServer(appFor(me.user), async (url) => {
      // A 404, not a 403 — whether another person's notification exists is not
      // this caller's business, and saying so would be an enumeration oracle.
      assert.equal((await post(url, `${P}/${theirs._id}/read`, {})).status, 404);
      assert.equal((await post(url, `${P}/${theirs._id}/unread`, {})).status, 404);

      // Bulk endpoints do not 404; they simply match nothing.
      const marked = await post(url, `${P}/read`, { ids: [String(theirs._id)] });
      assert.equal(marked.status, 200);
      assert.equal(marked.body.data.updated, 0);

      const archived = await post(url, `${P}/archive`, { ids: [String(theirs._id)] });
      assert.equal(archived.body.data.updated, 0);
    });

    const after = await InboxItem.findById(theirs._id).lean();
    assert.equal(after.readAt, null, "another person's item was modified");
    assert.equal(after.archivedAt, null);
  });

  test('mark-all and unread-count never reach past me', async () => {
    const me = await makeEmployee();
    const other = await makeEmployee();
    await fileFor(me.id);
    await fileFor(other.id);
    await fileFor(other.id);

    await withServer(appFor(me.user), async (url) => {
      assert.equal((await get(url, `${P}/unread-count`)).body.data.count, 1);
      const res = await post(url, `${P}/read-all`, {});
      assert.equal(res.body.data.updated, 1);
    });

    assert.equal(
      await InboxItem.countDocuments({ recipientEmployeeId: other.employee._id, readAt: null }),
      2,
      "mark-all reached another person's inbox",
    );
  });

  test('an HRMS account with no employee record has an empty inbox, not an error', async () => {
    seq += 1;
    const user = await User.create({
      email: `orphan${seq}@example.com`,
      password: 'x'.repeat(60),
      user: 'Orphan',
      role: 'Management',
      roles: [R.HR_ADMIN],
      status: 'Active',
    });

    await withServer(
      appFor({ _id: user._id, role: 'Management', roles: [R.HR_ADMIN], status: 'Active' }),
      async (url) => {
        const res = await get(url, P);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.total, 0);
        assert.equal((await get(url, `${P}/unread-count`)).body.data.count, 0);
        assert.equal((await post(url, `${P}/read-all`, {})).body.data.updated, 0);
      },
    );
  });
});

// ===========================================================================
// Read / unread / archive
// ===========================================================================

describe('read, unread and archive', () => {
  test('marking read is idempotent, and reversible', async () => {
    const me = await makeEmployee();
    await fileFor(me.id);
    const item = await InboxItem.findOne({}).lean();

    await withServer(appFor(me.user), async (url) => {
      const first = await post(url, `${P}/${item._id}/read`, {});
      assert.equal(first.status, 200);
      assert.equal(first.body.data.read, true);
      const readAt = first.body.data.readAt;

      // Already read: a no-op, as the reference is — not an error.
      const second = await post(url, `${P}/${item._id}/read`, {});
      assert.equal(second.status, 200);
      assert.equal(second.body.data.readAt, readAt, 'the timestamp moved');

      // 🔴 The reference has no way back: once read, permanently read.
      const back = await post(url, `${P}/${item._id}/unread`, {});
      assert.equal(back.body.data.read, false);
      assert.equal((await get(url, `${P}/unread-count`)).body.data.count, 1);
    });
  });

  test('a malformed or missing id is a 404', async () => {
    const me = await makeEmployee();
    await withServer(appFor(me.user), async (url) => {
      assert.equal((await post(url, `${P}/not-an-id/read`, {})).status, 404);
      assert.equal(
        (await post(url, `${P}/${new mongoose.Types.ObjectId()}/read`, {})).status,
        404,
      );
    });
  });

  test('archiving files an item away and marks it read', async () => {
    const me = await makeEmployee();
    await fileFor(me.id);
    const item = await InboxItem.findOne({}).lean();

    await withServer(appFor(me.user), async (url) => {
      const res = await post(url, `${P}/archive`, { ids: [String(item._id)] });
      assert.equal(res.body.data.updated, 1);

      // Out of the default list, and out of the badge.
      assert.equal((await get(url, P)).body.data.total, 0);
      assert.equal((await get(url, `${P}/unread-count`)).body.data.count, 0);

      // Still findable.
      const archived = await get(url, `${P}?archived=true`);
      assert.equal(archived.body.data.total, 1);
      assert.equal(archived.body.data.data[0].archived, true);
      assert.equal(archived.body.data.data[0].read, true);
    });
  });

  test('a bulk mark is bounded and validated', async () => {
    const me = await makeEmployee();
    await withServer(appFor(me.user), async (url) => {
      assert.equal((await post(url, `${P}/read`, { ids: [] })).status, 400);
      assert.equal((await post(url, `${P}/read`, { ids: ['nope'] })).status, 400);
      assert.equal(
        (await post(url, `${P}/read`, { ids: Array(201).fill(String(me.employee._id)) })).status,
        400,
      );
    });
  });

  test('bulk clears are audited by COUNT, never by content', async () => {
    const me = await makeEmployee();
    await fileFor(me.id, { title: 'Confidential-looking title' });

    await withServer(appFor(me.user), async (url) => {
      await post(url, `${P}/read-all`, {});
    });

    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.INBOX_MARKED_ALL_READ }).lean();
    assert.ok(entry, 'clearing an inbox is audited');
    assert.equal(entry.meta.count, 1);
    // 🔴 An audit row listing what was in somebody's inbox would be a second
    // copy of it, readable by every auditor.
    assert.doesNotMatch(JSON.stringify(entry), /Confidential-looking/);
  });

  test('listing is NOT audited — the badge is polled every fifteen seconds', async () => {
    const me = await makeEmployee();
    await fileFor(me.id);

    await withServer(appFor(me.user), async (url) => {
      await get(url, P);
      await get(url, `${P}/unread-count`);
    });

    assert.equal(await AuditLog.countDocuments({}), 0);
  });
});

// ===========================================================================
// Pagination, ordering and filtering
// ===========================================================================

describe('listing', () => {
  test('🔴 the list pages — the reference caps at 100 with no cursor', async () => {
    const me = await makeEmployee();
    for (let i = 0; i < 5; i += 1) await fileFor(me.id, { title: `Item ${i}` });

    await withServer(appFor(me.user), async (url) => {
      const first = await get(url, `${P}?pageSize=2`);
      assert.equal(first.body.data.data.length, 2);
      assert.equal(first.body.data.total, 5);

      const second = await get(url, `${P}?pageSize=2&page=3`);
      assert.equal(second.body.data.data.length, 1);
    });
  });

  test('newest first, which is the reference’s ordering', async () => {
    const me = await makeEmployee();
    await fileFor(me.id, { title: 'Older' });
    await new Promise((r) => setTimeout(r, 10));
    await fileFor(me.id, { title: 'Newer' });

    await withServer(appFor(me.user), async (url) => {
      const rows = (await get(url, P)).body.data.data;
      assert.equal(rows[0].title, 'Newer');
    });
  });

  test('🔴 filtering by state, type and category — the reference offers none', async () => {
    const me = await makeEmployee();
    await fileFor(me.id, { type: INBOX_TYPES.LEAVE_PENDING, title: 'Approve me' });
    await fileFor(me.id, {
      type: INBOX_TYPES.ANNOUNCEMENT_PUBLISHED,
      entity: 'announcement',
      title: 'News',
    });

    await withServer(appFor(me.user), async (url) => {
      const item = (await get(url, P)).body.data.data.find((r) => r.title === 'News');
      await post(url, `${P}/${item.id}/read`, {});

      assert.equal((await get(url, `${P}?state=unread`)).body.data.total, 1);
      assert.equal((await get(url, `${P}?state=read`)).body.data.total, 1);
      assert.equal(
        (await get(url, `${P}?type=${INBOX_TYPES.LEAVE_PENDING}`)).body.data.total,
        1,
      );
      assert.equal((await get(url, `${P}?category=action`)).body.data.total, 1);
      assert.equal((await get(url, `${P}?category=announcement`)).body.data.total, 1);

      // The badge stays live whatever the list was filtered to.
      assert.equal((await get(url, `${P}?state=read`)).body.data.unread, 1);
    });
  });
});

// ===========================================================================
// The notifier — recipients, sensitivity, and robustness
// ===========================================================================

describe('the notifier', () => {
  test('fans out to many in one write, de-duplicating', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();

    // 🔴 The reference de-duplicates in exactly one of its twenty producers.
    const written = await notify({
      to: [a.id, b.id, a.id],
      type: INBOX_TYPES.ANNOUNCEMENT_PUBLISHED,
      title: 'All hands',
      entity: 'announcement',
      entityId: String(new mongoose.Types.ObjectId()),
    });

    assert.equal(written, 2);
    assert.equal(await InboxItem.countDocuments({ recipientEmployeeId: a.employee._id }), 1);
  });

  test('a soft-deleted employee is never notified', async () => {
    const gone = await makeEmployee();
    await Employee.updateOne({ _id: gone.employee._id }, { $set: { deletedAt: new Date() } });

    assert.equal(await fileFor(gone.id), 0);
    assert.equal(await InboxItem.countDocuments({}), 0);
  });

  test('an unknown recipient writes nothing rather than an orphan row', async () => {
    assert.equal(await fileFor(String(new mongoose.Types.ObjectId())), 0);
    assert.equal(await fileFor(null), 0);
    assert.equal(await fileFor('not-an-id'), 0);
    assert.equal(await InboxItem.countDocuments({}), 0);
  });

  test('a bad type or entity never reaches the database, and never throws', async () => {
    const me = await makeEmployee();

    assert.equal(await fileFor(me.id, { type: 'made.up' }), 0);
    assert.equal(await fileFor(me.id, { entityId: 'not-an-id' }), 0);
    assert.equal(await fileFor(me.id, { entity: '' }), 0);
    assert.equal(await InboxItem.countDocuments({}), 0);
  });

  test('notifying by USER id resolves to the employee', async () => {
    const me = await makeEmployee();

    const written = await notifyUsers({
      toUserIds: String(me.userId),
      type: INBOX_TYPES.REQUISITION_APPROVED,
      title: 'Approved',
      entity: 'job_requisition',
      entityId: String(new mongoose.Types.ObjectId()),
    });

    assert.equal(written, 1);
    const row = await InboxItem.findOne({}).lean();
    assert.equal(String(row.recipientEmployeeId), me.id);
  });

  test('an over-long title is trimmed rather than rejected', async () => {
    const me = await makeEmployee();
    await fileFor(me.id, { title: 'x'.repeat(500) });

    const row = await InboxItem.findOne({}).lean();
    assert.ok(row.title.length <= 200);
    assert.ok(row.title.endsWith('…'));
  });

  test('🔴 no href is stored — the link is derived from the type', async () => {
    const me = await makeEmployee();
    await fileFor(me.id, { type: INBOX_TYPES.EXPENSE_PENDING, entity: 'expense_claim' });

    const row = await InboxItem.findOne({}).lean();
    assert.equal(row.href, undefined, 'a navigation target was stored on the row');

    await withServer(appFor(me.user), async (url) => {
      const dto = (await get(url, P)).body.data.data[0];
      assert.equal(dto.href, `${HRMS_ROUTE_PREFIX}/expenses/queue`);
    });
  });
});

// ===========================================================================
// Producer integration
// ===========================================================================

describe('producers', () => {
  test('leave: the approver is told, and no reason travels with it', async () => {
    const { createRequest, createLeaveType } = await import('../modules/hrms/leave/leave.service.js');
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    const staff = await makeEmployee();
    await Employee.updateOne(
      { _id: staff.employee._id },
      { $set: { reportingManagerId: manager.employee._id } },
    );

    const type = await createLeaveType(
      { code: 'CL', name: 'Casual' },
      { user: hr.user },
    );

    const actor = staff.actor;
    await createRequest(
      {
        leaveTypeId: type.id,
        startDate: '2026-11-02',
        endDate: '2026-11-02',
        durationUnit: 'full_day',
        reason: 'A very private family matter that must not be republished',
      },
      actor,
      { user: staff.user },
    );

    const row = await InboxItem.findOne({ recipientEmployeeId: manager.employee._id }).lean();
    assert.ok(row, 'the approver was not notified');
    assert.equal(row.type, INBOX_TYPES.LEAVE_PENDING);
    // 🔴 The reference copies `dto.reason` into the body AND into an email.
    assert.doesNotMatch(JSON.stringify(row), /private family matter/);

    // The requester is not told about their own request.
    assert.equal(
      await InboxItem.countDocuments({ recipientEmployeeId: staff.employee._id }),
      0,
    );
  });

  test('performance: the reviewer is told; self-assignment is not', async () => {
    const { createReview, createCycle } = await import(
      '../modules/hrms/performance/cycle.service.js'
    ).then(async (cycles) => ({
      createCycle: cycles.createCycle,
      createReview: (await import('../modules/hrms/performance/review.service.js')).createReview,
    }));

    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const reviewer = await makeEmployee({ roles: [R.MANAGER] });
    const subject = await makeEmployee();
    // A `manager` review derives its reviewer from the reporting line rather
    // than trusting the id in the request — see the module's note 2.
    await Employee.updateOne(
      { _id: subject.employee._id },
      { $set: { reportingManagerId: reviewer.employee._id } },
    );

    const hrActor = hr.actor;
    const cycle = await createCycle(
      {
        name: 'H2 2026',
        startDate: '2026-07-01',
        endDate: '2026-12-31',
        competencies: [{ key: 'execution', label: 'Execution', weight: 1 }],
      },
      { user: hr.user, actor: hrActor },
    );

    // Reviews open once the cycle leaves goal setting — the phase machine this
    // module enforces and the reference does not.
    const { advancePhase } = await import('../modules/hrms/performance/cycle.service.js');
    await advancePhase(cycle.id, { phase: 'self_review' }, { user: hr.user, actor: hrActor });

    await createReview(
      {
        cycleId: cycle.id,
        employeeId: subject.id,
        reviewerEmployeeId: reviewer.id,
        kind: 'manager',
      },
      { user: hr.user, actor: hrActor },
    );

    const row = await InboxItem.findOne({ recipientEmployeeId: reviewer.employee._id }).lean();
    assert.ok(row, 'the reviewer was not notified');
    assert.equal(row.type, INBOX_TYPES.REVIEW_ASSIGNED);
    assert.equal(row.entity, 'review_response');
  });

  test('engage: recognition reaches the recipient and keeps its anonymity', async () => {
    const { giveRecognition } = await import('../modules/hrms/engage/recognition.service.js');
    const sender = await makeEmployee();
    const recipient = await makeEmployee();

    await giveRecognition(
      {
        toEmployeeId: recipient.id,
        message: 'Carried the migration single-handed and stayed late every night',
        teamVisible: true,
        anonymous: true,
      },
      { user: sender.user, actor: sender.actor },
    );

    const row = await InboxItem.findOne({ recipientEmployeeId: recipient.employee._id }).lean();
    assert.ok(row);
    assert.equal(row.type, INBOX_TYPES.RECOGNITION_RECEIVED);
    // Anonymous means anonymous in the notification too.
    assert.match(row.title, /^Someone recognised you$/);
    // 🔴 The reference copies 200 characters of the message into the body.
    assert.doesNotMatch(JSON.stringify(row), /single-handed/);
  });

  test('helpdesk: the ASSIGNEE is told — the reference tells the creator instead', async () => {
    const helpdesk = await import('../modules/hrms/helpdesk/helpdesk.service.js');
    // Categories are super-admin only here; the reference lets any HR admin
    // create one.
    const hr = await makeEmployee({ roles: [R.SUPER_ADMIN] });
    const resolver = await makeEmployee({ roles: [R.HR_ADMIN] });
    const requester = await makeEmployee();

    const hrActor = hr.actor;
    const category = await helpdesk.createCategory(
      {
        name: 'Payroll query',
        code: 'PAYQ',
        resolverModule: 'helpdesk:hr',
        slaHours: 24,
        active: true,
      },
      hrActor,
      { user: hr.user },
    );

    const ticket = await helpdesk.createTicket(
      { categoryId: category.id, subject: 'Payslip missing', body: 'My October payslip is absent.' },
      requester.actor,
      { user: requester.user },
    );

    // 🔴 The reference files "Ticket created" to the person who just created it.
    assert.equal(
      await InboxItem.countDocuments({ recipientEmployeeId: requester.employee._id }),
      0,
      'the creator was told what they had just done',
    );

    await helpdesk.assignTicket(ticket.id, { assigneeEmployeeId: resolver.id }, hrActor, {
      user: hr.user,
    });

    const row = await InboxItem.findOne({ recipientEmployeeId: resolver.employee._id }).lean();
    assert.ok(row, 'the assignee was not notified');
    assert.equal(row.type, INBOX_TYPES.TICKET_ASSIGNED);
  });

  test('assets: an assignment reaches the person it was issued to', async () => {
    const assets = await import('../modules/hrms/assets/asset.service.js');
    const it = await makeEmployee({ roles: [R.IT_ADMIN] });
    const holder = await makeEmployee();

    const itActor = it.actor;
    const category = await assets.createCategory(
      { name: 'Laptop', code: 'LAPTOP' },
      itActor,
      { user: it.user },
    );
    const item = await assets.createItem(
      { categoryId: category.id, serialNumber: 'SN-0001' },
      itActor,
      { user: it.user },
    );
    await assets.assignItem({ assetItemId: item.id, employeeId: holder.id }, itActor, {
      user: it.user,
    });

    const row = await InboxItem.findOne({ recipientEmployeeId: holder.employee._id }).lean();
    assert.ok(row, 'the assignee was not notified');
    assert.equal(row.type, INBOX_TYPES.ASSET_ASSIGNED);
  });
});

// ===========================================================================
// Permissions
// ===========================================================================

describe('permissions', () => {
  test('every HRMS role reaches their own inbox — it is in the baseline', async () => {
    for (const role of [
      R.EMPLOYEE,
      R.MANAGER,
      R.HR_ADMIN,
      R.PAYROLL_ADMIN,
      R.RECRUITER,
      R.IT_ADMIN,
      R.AUDITOR,
      R.SUPER_ADMIN,
    ]) {
      const actor = await makeEmployee({ roles: [role] });
      await withServer(appFor(actor.user), async (url) => {
        assert.equal((await get(url, P)).status, 200, `${role} cannot read their own inbox`);
      });
    }
  });

  test('an account with no HRMS grant at all is refused before the module', async () => {
    seq += 1;
    const user = await User.create({
      email: `customer${seq}@example.com`,
      password: 'x'.repeat(60),
      user: 'Customer',
      role: 'Customer',
      roles: [],
      status: 'Active',
    });

    await withServer(
      appFor({ _id: user._id, role: 'Customer', roles: [], status: 'Active' }),
      async (url) => {
        assert.equal((await get(url, P)).status, 403);
      },
    );
  });
});

// ===========================================================================
// Retention (AD-16)
// ===========================================================================

describe('retention', () => {
  const old = new Date(Date.now() - 400 * 86_400_000);

  async function seedAged() {
    const me = await makeEmployee();
    await fileFor(me.id, { title: 'Old read' });
    await fileFor(me.id, { title: 'Old unread' });
    await InboxItem.updateMany({}, { $set: { createdAt: old } });
    await InboxItem.updateOne({ title: 'Old read' }, { $set: { readAt: old } });
    return me;
  }

  test('`retain` is the shipped default and removes nothing', async () => {
    await seedAged();
    const result = await inboxRetentionHandler.sweep({
      cutoff: new Date(),
      action: 'retain',
      dryRun: false,
      batchSize: 100,
    });
    assert.equal(result.affected, 0);
    assert.equal(await InboxItem.countDocuments({}), 2);
  });

  test('an UNREAD item is never swept, however old', async () => {
    await seedAged();
    await inboxRetentionHandler.sweep({
      cutoff: new Date(),
      action: 'delete',
      dryRun: false,
      batchSize: 100,
    });

    const left = await InboxItem.find({}).lean();
    assert.equal(left.length, 1);
    assert.equal(left[0].title, 'Old unread');
  });

  test('a dry run reports without removing', async () => {
    await seedAged();
    const result = await inboxRetentionHandler.sweep({
      cutoff: new Date(),
      action: 'delete',
      dryRun: true,
      batchSize: 100,
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.affected, 0);
    assert.equal(await InboxItem.countDocuments({}), 2);
  });

  test('`archive` files old read items away rather than deleting them', async () => {
    await seedAged();
    await inboxRetentionHandler.sweep({
      cutoff: new Date(),
      action: 'archive',
      dryRun: false,
      batchSize: 100,
    });

    assert.equal(await InboxItem.countDocuments({}), 2);
    assert.equal(await InboxItem.countDocuments({ archivedAt: { $ne: null } }), 1);
  });
});

// ===========================================================================
// Inbox mail (final audit, Audit 5)
// ===========================================================================

describe('inbox mail', () => {
  test('only the seven events the reference mails have a template', () => {
    const withMail = INBOX_TYPE_LIST.filter(hasMailTemplate);
    assert.deepEqual(withMail.sort(), [
      'attendance.correction.decided',
      'attendance.correction.pending',
      'exit.initiated',
      'expense.pending',
      'leave.decided',
      'leave.pending',
      'offer_letter.ready',
    ]);
    // Being an inbox item does not make an event worth an email. Thirteen of
    // the twenty deliberately have none.
    assert.equal(INBOX_TYPE_LIST.length - withMail.length, 13);
  });

  test('🔴 no template carries a reason, an amount or any free text', () => {
    // The four the reference leaks through SMTP, and the values it leaks.
    const forbidden = [
      'reason',
      'Reason:',
      '₹',
      'salary',
      'password',
      'token',
      'secret',
    ];

    for (const type of INBOX_TYPE_LIST.filter(hasMailTemplate)) {
      const mail = renderInboxMail(type, {
        // Deliberately hostile: if a template interpolated a body or a reason,
        // these strings would show up in the output.
        title: 'Priya requested 2 day(s) of CL',
        href: '/hrms/leave/approvals',
      });
      const text = `${mail.subject}\n${mail.html}`.toLowerCase();

      for (const needle of forbidden) {
        assert.ok(
          !text.includes(needle.toLowerCase()),
          `${type} mail must not contain "${needle}"`,
        );
      }
    }
  });

  test('🔴 the expense subject carries no amount — the reference puts it there', () => {
    const mail = renderInboxMail(INBOX_TYPES.EXPENSE_PENDING, {
      title: 'Sunil submitted an expense claim',
      href: '/hrms/expenses/queue',
    });
    assert.equal(mail.subject, 'An expense claim is awaiting your approval');
    assert.doesNotMatch(mail.subject, /\d/, 'no figure of any kind in the subject line');
  });

  test('every rendered mail has a subject, a body and its link', () => {
    for (const type of INBOX_TYPE_LIST.filter(hasMailTemplate)) {
      const mail = renderInboxMail(type, { title: 'Something happened', href: '/hrms/dashboard' });
      assert.ok(mail.subject.length > 0 && mail.subject.length <= 120, type);
      assert.ok(mail.html.includes('/hrms/dashboard'), `${type} must link somewhere`);
    }
  });

  test('an inbox-only event renders no mail at all', () => {
    assert.equal(renderInboxMail(INBOX_TYPES.RECOGNITION_RECEIVED), null);
    assert.equal(renderInboxMail(INBOX_TYPES.ANNOUNCEMENT_PUBLISHED), null);
    assert.equal(renderInboxMail('not.a.type'), null);
  });

  test('interpolated text is HTML-escaped', () => {
    const mail = renderInboxMail(INBOX_TYPES.LEAVE_DECIDED, {
      title: '<script>alert(1)</script>',
      href: '/hrms/leave/me',
    });
    assert.ok(!mail.html.includes('<script>'), 'a name is user-controlled text');
    assert.ok(mail.html.includes('&lt;script&gt;'));
  });

  test('mail is OFF unless explicitly enabled, so no send needs SMTP', async () => {
    const previous = process.env.HRMS_MAIL_ENABLED;
    try {
      delete process.env.HRMS_MAIL_ENABLED;
      assert.equal(mailEnabled(), false, 'outbound mail defaults to off');
      assert.equal(await sendInboxMail({ type: INBOX_TYPES.LEAVE_PENDING, recipients: [1] }), 0);

      process.env.HRMS_MAIL_ENABLED = 'true';
      assert.equal(mailEnabled(), true);
      // Enabled, but an inbox-only event still sends nothing.
      assert.equal(
        await sendInboxMail({ type: INBOX_TYPES.RECOGNITION_RECEIVED, recipients: [1] }),
        0,
      );
    } finally {
      if (previous === undefined) delete process.env.HRMS_MAIL_ENABLED;
      else process.env.HRMS_MAIL_ENABLED = previous;
    }
  });

  test('a notification still lands when mail is disabled', async () => {
    const hr = await makeEmployee({ roles: [R.HR_ADMIN] });
    const staff = await makeEmployee();

    const written = await notify({
      to: staff.id,
      type: INBOX_TYPES.LEAVE_DECIDED,
      title: 'Your leave request was approved',
      entity: 'leave_request',
      entityId: String(hr.employee._id),
    });

    assert.equal(written, 1, 'the inbox is the primary channel; mail is secondary');
    assert.equal(await InboxItem.countDocuments({ recipientEmployeeId: staff.employee._id }), 1);
  });
});
