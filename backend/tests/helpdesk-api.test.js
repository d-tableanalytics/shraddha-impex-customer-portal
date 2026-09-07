/**
 * Helpdesk — the HTTP layer, over a real MongoDB.
 *
 * Only `protect` is stubbed, exactly as every other HRMS route test does it.
 * The permission chain, the validator, the service and the error handler are
 * all the genuine article.
 *
 * The tests that matter most are the category-isolation ones. The reference
 * collapses its three per-team resolver grants into one boolean, so an IT admin
 * reads HR grievances and payroll queries — that is the defect this module
 * exists to not reproduce.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import {
  TicketCategory,
  HelpdeskTicket,
  KbArticle,
} from '../models/hrms/HelpdeskModels.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import helpdeskRoutes from '../modules/hrms/helpdesk/helpdesk.routes.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import { AUDIT_ACTIONS } from '../shared/constants/hrms.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { buildTestApp, stubProtect, withServer, get, post, patch, del } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/helpdesk';
const oid = () => new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, TicketCategory, HelpdeskTicket, KbArticle);
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
      router.use('/helpdesk', helpdeskRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;
async function makePerson(roles, over = {}) {
  seq += 1;
  const userId = oid();
  await User.create({
    _id: userId,
    name: `${over.firstName ?? 'Test'} Person`,
    email: `hd${seq}@example.com`,
    password: 'hashed-not-used',
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    employeeCode: `HD-${String(seq).padStart(4, '0')}`,
    userId,
    firstName: over.firstName ?? 'Test',
    lastName: over.lastName ?? `Person${seq}`,
    dateOfJoining: new Date('2020-01-01'),
    status: over.status ?? 'active',
    ...over,
  });
  return { user: { _id: userId, role: 'Management', roles, status: 'Active' }, employee };
}

const envelope = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  return res.body.data;
};

const errorBody = (res, status, code) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  if (code) assert.equal(res.body.code, code);
  return res.body;
};

/** The whole cast: a requester and one resolver per team. */
async function seedOrg() {
  const superAdmin = await makePerson([R.SUPER_ADMIN], { firstName: 'Sue' });
  const hr = await makePerson([R.HR_ADMIN], { firstName: 'Hana' });
  const payroll = await makePerson([R.PAYROLL_ADMIN], { firstName: 'Fiona' });
  const it = await makePerson([R.IT_ADMIN], { firstName: 'Ivan' });
  const staff = await makePerson([R.EMPLOYEE], { firstName: 'Sam' });
  const other = await makePerson([R.EMPLOYEE], { firstName: 'Otto' });
  return { superAdmin, hr, payroll, it, staff, other };
}

/** One category per team, created by the super admin who owns the catalogue. */
async function seedCategories(org) {
  const made = {};
  await withServer(appFor(org.superAdmin.user), async (url) => {
    for (const [key, spec] of Object.entries({
      hr: { name: 'HR', code: 'HR', resolverModule: 'helpdesk:hr', slaHours: 24 },
      payroll: {
        name: 'Payroll',
        code: 'PAYROLL',
        resolverModule: 'helpdesk:payroll',
        slaHours: 48,
      },
      it: { name: 'IT', code: 'IT', resolverModule: 'helpdesk:it', slaHours: 8 },
    })) {
      made[key] = envelope(await post(url, `${P}/categories`, spec), 201);
    }
  });
  return made;
}

/** Raise a ticket as a given person. */
async function raise(person, categoryId, over = {}) {
  let ticket;
  await withServer(appFor(person.user), async (url) => {
    ticket = envelope(
      await post(url, `${P}/tickets`, {
        categoryId,
        subject: 'Something is wrong',
        body: 'Please help with this.',
        priority: 'normal',
        ...over,
      }),
      201,
    );
  });
  return ticket;
}

// ===========================================================================
// Categories
// ===========================================================================

test('a super admin manages the catalogue; a team resolver cannot', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.superAdmin.user), async (url) => {
    const cat = envelope(
      await post(url, `${P}/categories`, {
        name: 'IT',
        code: 'it',
        resolverModule: 'helpdesk:it',
        slaHours: 8,
      }),
      201,
    );
    assert.equal(cat.code, 'IT', 'the code is upper-cased');
    assert.equal(cat.resolverModule, 'helpdesk:it');
    assert.equal(cat.ticketCount, 0);
  });

  // An IT admin resolves IT tickets; they do not decide which team answers for
  // what. The reference has no endpoint at all here.
  await withServer(appFor(org.it.user), async (url) => {
    errorBody(
      await post(url, `${P}/categories`, {
        name: 'Mine',
        code: 'MINE',
        resolverModule: 'helpdesk:it',
        slaHours: 4,
      }),
      403,
    );
  });
});

test('everyone can read the catalogue — a requester has to pick from it', async () => {
  // The reference's own Raise Ticket form hardcodes 'hr-placeholder', which
  // fails its uuid check, because no categories endpoint exists.
  const org = await seedOrg();
  await seedCategories(org);

  await withServer(appFor(org.staff.user), async (url) => {
    const list = envelope(await get(url, `${P}/categories`));
    assert.equal(list.length, 3);
    assert.ok(list.every((c) => c.id && c.name));
  });
});

test('a category code is unique, and the SLA is bounded', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.superAdmin.user), async (url) => {
    envelope(
      await post(url, `${P}/categories`, {
        name: 'IT',
        code: 'IT',
        resolverModule: 'helpdesk:it',
        slaHours: 8,
      }),
      201,
    );
    errorBody(
      await post(url, `${P}/categories`, {
        name: 'IT again',
        code: 'IT',
        resolverModule: 'helpdesk:it',
        slaHours: 8,
      }),
      409,
      'TICKET_CATEGORY_CODE_TAKEN',
    );
    // The reference's own 1-168 bound.
    errorBody(
      await post(url, `${P}/categories`, {
        name: 'Bad',
        code: 'BAD',
        resolverModule: 'helpdesk:it',
        slaHours: 200,
      }),
      400,
    );
    errorBody(
      await post(url, `${P}/categories`, {
        name: 'Bad',
        code: 'BAD',
        resolverModule: 'helpdesk:nobody',
        slaHours: 8,
      }),
      400,
    );
  });
});

test('a category with open tickets cannot be deleted', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  await raise(org.staff, cats.it.id);

  await withServer(appFor(org.superAdmin.user), async (url) => {
    errorBody(await del(url, `${P}/categories/${cats.it.id}`), 409, 'TICKET_CATEGORY_IN_USE');
    // One with none deletes cleanly, and softly.
    envelope(await del(url, `${P}/categories/${cats.payroll.id}`));
    assert.ok(await TicketCategory.findById(cats.payroll.id).lean());
  });
});

// ===========================================================================
// Raising
// ===========================================================================

test('an employee raises a ticket; it is numbered, routed and SLA-stamped', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);

  const ticket = await raise(org.staff, cats.it.id, { priority: 'high' });

  assert.match(ticket.ticketNumber, /^HD-\d{4}-\d{6}$/);
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.priority, 'high');
  assert.equal(ticket.categoryName, 'IT');
  assert.equal(ticket.resolverModule, 'helpdesk:it');
  assert.equal(ticket.requesterEmployeeId, String(org.staff.employee._id));
  // The reference hardcodes `requesterName: ''` with a comment saying the
  // controller will fill it in; the controller does not.
  assert.match(ticket.requesterName, /Sam/);
  assert.equal(ticket.slaHours, 8, 'snapshotted from the category');
  assert.ok(ticket.slaDueAt);
  assert.equal(ticket.slaBreached, false);
  assert.equal(ticket.isMine, true);
});

test('ticket numbers do not collide', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);

  const a = await raise(org.staff, cats.it.id);
  const b = await raise(org.staff, cats.it.id);
  const c = await raise(org.other, cats.it.id);

  assert.equal(new Set([a.ticketNumber, b.ticketNumber, c.ticketNumber]).size, 3);
});

test('the SLA is SNAPSHOTTED, so editing a category never rewrites history', async () => {
  // The reference computes breach from the live category on every read, so
  // shortening an SLA retroactively breaches every historical ticket.
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.superAdmin.user), async (url) => {
    envelope(await patch(url, `${P}/categories/${cats.it.id}`, { slaHours: 1 }));
  });

  await withServer(appFor(org.staff.user), async (url) => {
    const after = envelope(await get(url, `${P}/tickets/${ticket.id}`));
    assert.equal(after.slaHours, 8, 'the hours in force when it was raised');
    assert.equal(after.slaDueAt, ticket.slaDueAt);
  });
});

test('a ticket cannot be raised in an unknown or inactive category', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);

  await withServer(appFor(org.superAdmin.user), async (url) => {
    envelope(await patch(url, `${P}/categories/${cats.payroll.id}`, { active: false }));
  });

  await withServer(appFor(org.staff.user), async (url) => {
    errorBody(
      await post(url, `${P}/tickets`, {
        categoryId: String(oid()),
        subject: 'x',
        body: 'y',
      }),
      400,
    );
    errorBody(
      await post(url, `${P}/tickets`, {
        categoryId: cats.payroll.id,
        subject: 'x',
        body: 'y',
      }),
      400,
    );
  });
});

test('subject and body are required and bounded', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);

  await withServer(appFor(org.staff.user), async (url) => {
    errorBody(
      await post(url, `${P}/tickets`, { categoryId: cats.it.id, subject: '', body: 'y' }),
      400,
    );
    errorBody(
      await post(url, `${P}/tickets`, {
        categoryId: cats.it.id,
        subject: 'x'.repeat(201),
        body: 'y',
      }),
      400,
    );
  });
});

// ===========================================================================
// CATEGORY ISOLATION — the headline defect
// ===========================================================================

test('a resolver sees ONLY the categories they answer for', async () => {
  // The reference ORs its three per-team grants into one `isResolver` boolean,
  // so an IT admin reads HR grievances and payroll queries.
  const org = await seedOrg();
  const cats = await seedCategories(org);

  const hrTicket = await raise(org.staff, cats.hr.id, { subject: 'Grievance about my manager' });
  const payrollTicket = await raise(org.staff, cats.payroll.id, { subject: 'My salary is wrong' });
  const itTicket = await raise(org.staff, cats.it.id, { subject: 'Laptop will not boot' });

  await withServer(appFor(org.it.user), async (url) => {
    const page = envelope(await get(url, `${P}/tickets`));
    const subjects = page.data.map((t) => t.subject);
    assert.deepEqual(subjects, ['Laptop will not boot']);

    // And not by id either.
    errorBody(await get(url, `${P}/tickets/${hrTicket.id}`), 404);
    errorBody(await get(url, `${P}/tickets/${payrollTicket.id}`), 404);
    assert.equal(envelope(await get(url, `${P}/tickets/${itTicket.id}`)).id, itTicket.id);
  });

  await withServer(appFor(org.payroll.user), async (url) => {
    const page = envelope(await get(url, `${P}/tickets`));
    assert.deepEqual(page.data.map((t) => t.subject), ['My salary is wrong']);
    errorBody(await get(url, `${P}/tickets/${hrTicket.id}`), 404);
  });

  await withServer(appFor(org.hr.user), async (url) => {
    const page = envelope(await get(url, `${P}/tickets`));
    assert.deepEqual(page.data.map((t) => t.subject), ['Grievance about my manager']);
  });
});

test('a super admin answers for every category', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  await raise(org.staff, cats.hr.id);
  await raise(org.staff, cats.payroll.id);
  await raise(org.staff, cats.it.id);

  await withServer(appFor(org.superAdmin.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/tickets`)).total, 3);
  });
});

test('a resolver cannot ACT on another team’s ticket', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const hrTicket = await raise(org.staff, cats.hr.id);

  await withServer(appFor(org.it.user), async (url) => {
    // 404 rather than 403 — an IT admin has no business learning it exists.
    errorBody(await post(url, `${P}/tickets/${hrTicket.id}/assign`, {
      assigneeEmployeeId: String(org.it.employee._id),
    }), 404);
    errorBody(
      await post(url, `${P}/tickets/${hrTicket.id}/status`, { status: 'in_progress' }),
      404,
    );
    errorBody(await patch(url, `${P}/tickets/${hrTicket.id}`, { priority: 'urgent' }), 404);
    errorBody(
      await post(url, `${P}/tickets/${hrTicket.id}/comments`, { body: 'me too' }),
      404,
    );
  });
});

test('a requester sees their own ticket in any category, and nobody else’s', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const mine = await raise(org.staff, cats.hr.id);
  const theirs = await raise(org.other, cats.hr.id);

  await withServer(appFor(org.staff.user), async (url) => {
    const page = envelope(await get(url, `${P}/tickets`));
    assert.equal(page.total, 1);
    assert.equal(page.data[0].id, mine.id);
    errorBody(await get(url, `${P}/tickets/${theirs.id}`), 404);
  });
});

// ===========================================================================
// The state machine
// ===========================================================================

test('the happy path runs open -> assigned -> in_progress -> resolved -> closed', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    let t = envelope(
      await post(url, `${P}/tickets/${ticket.id}/assign`, {
        assigneeEmployeeId: String(org.it.employee._id),
      }),
    );
    assert.equal(t.status, 'assigned', 'assigning moves it off open');
    assert.match(t.assigneeName, /Ivan/);

    t = envelope(await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'in_progress' }));
    assert.equal(t.status, 'in_progress');

    t = envelope(
      await post(url, `${P}/tickets/${ticket.id}/status`, {
        status: 'resolved',
        resolutionNotes: 'Replaced the power supply.',
      }),
    );
    assert.equal(t.status, 'resolved');
    assert.ok(t.resolvedAt);
    assert.equal(t.resolutionNotes, 'Replaced the power supply.');
    assert.equal(t.slaBreached, false);
    assert.equal(t.slaHoursRemaining, null, 'a settled ticket has no countdown');

    t = envelope(await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'closed' }));
    assert.equal(t.status, 'closed');
    assert.ok(t.closedAt);
  });
});

test('an ILLEGAL transition is refused', async () => {
  // The reference writes whatever status arrives, from any status.
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    // open -> closed skips the whole process.
    errorBody(
      await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'closed' }),
      409,
      'TICKET_BAD_TRANSITION',
    );
    // Same status is not a move.
    errorBody(
      await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'open' }),
      409,
      'TICKET_STATUS_UNCHANGED',
    );
  });
});

test('resolving demands a resolution note', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    errorBody(await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'resolved' }), 400);
    errorBody(
      await post(url, `${P}/tickets/${ticket.id}/status`, {
        status: 'resolved',
        resolutionNotes: '   ',
      }),
      400,
    );
  });
});

test('a CLOSED ticket is terminal', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    envelope(
      await post(url, `${P}/tickets/${ticket.id}/status`, {
        status: 'resolved',
        resolutionNotes: 'Done.',
      }),
    );
    envelope(await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'closed' }));

    errorBody(
      await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'in_progress' }),
      409,
      'TICKET_BAD_TRANSITION',
    );
    errorBody(await patch(url, `${P}/tickets/${ticket.id}`, { priority: 'urgent' }), 409, 'TICKET_CLOSED');
    errorBody(
      await post(url, `${P}/tickets/${ticket.id}/comments`, { body: 'one more thing' }),
      409,
      'TICKET_CLOSED',
    );
  });
});

test('the REQUESTER may close or reopen their own resolved ticket, and nothing else', async () => {
  // The reference gives the requester nothing — they cannot even close their
  // own ticket, because PATCH requires a resolver grant.
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.staff.user), async (url) => {
    // Not while it is still open.
    errorBody(await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'in_progress' }), 403);
  });

  await withServer(appFor(org.it.user), async (url) => {
    envelope(
      await post(url, `${P}/tickets/${ticket.id}/status`, {
        status: 'resolved',
        resolutionNotes: 'Rebooted it.',
      }),
    );
  });

  await withServer(appFor(org.staff.user), async (url) => {
    const reopened = envelope(
      await post(url, `${P}/tickets/${ticket.id}/status`, {
        status: 'in_progress',
        resolutionNotes: 'It is happening again.',
      }),
    );
    assert.equal(reopened.status, 'in_progress');
    // Reopening CLEARS the resolution — the reference leaves it stamped.
    assert.equal(reopened.resolvedAt, null);
    assert.equal(reopened.resolutionNotes, null);
    assert.ok(reopened.reopenedAt);
    assert.ok(
      reopened.comments.some((c) => c.body.includes('It is happening again')),
      'the reason is kept on the thread',
    );
  });
});

test('a stranger cannot move somebody else’s ticket', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.other.user), async (url) => {
    errorBody(await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'in_progress' }), 404);
  });
});

// ===========================================================================
// Assignment
// ===========================================================================

test('an assignee must be able to resolve the category', async () => {
  // The reference accepts any uuid — a portal Customer, a departed employee, or
  // an id belonging to nothing.
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    // An ordinary employee cannot work an IT queue.
    errorBody(
      await post(url, `${P}/tickets/${ticket.id}/assign`, {
        assigneeEmployeeId: String(org.staff.employee._id),
      }),
      400,
    );
    // Neither can the payroll resolver.
    errorBody(
      await post(url, `${P}/tickets/${ticket.id}/assign`, {
        assigneeEmployeeId: String(org.payroll.employee._id),
      }),
      400,
    );
    // Nor an id belonging to nothing.
    errorBody(
      await post(url, `${P}/tickets/${ticket.id}/assign`, {
        assigneeEmployeeId: String(oid()),
      }),
      400,
    );
    // The IT admin can.
    const ok = envelope(
      await post(url, `${P}/tickets/${ticket.id}/assign`, {
        assigneeEmployeeId: String(org.it.employee._id),
      }),
    );
    assert.equal(ok.assigneeEmployeeId, String(org.it.employee._id));
  });
});

test('a departed employee cannot be assigned a ticket', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);
  await Employee.updateOne({ _id: org.it.employee._id }, { $set: { status: 'exited' } });

  await withServer(appFor(org.it.user), async (url) => {
    errorBody(
      await post(url, `${P}/tickets/${ticket.id}/assign`, {
        assigneeEmployeeId: String(org.it.employee._id),
      }),
      409,
      'EMPLOYEE_NOT_ACTIVE',
    );
  });
});

test('unassigning returns an assigned ticket to the queue', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    envelope(
      await post(url, `${P}/tickets/${ticket.id}/assign`, {
        assigneeEmployeeId: String(org.it.employee._id),
      }),
    );
    const freed = envelope(
      await post(url, `${P}/tickets/${ticket.id}/assign`, { assigneeEmployeeId: null }),
    );
    assert.equal(freed.assigneeEmployeeId, null);
    assert.equal(freed.status, 'open');
  });
});

// ===========================================================================
// Comments and internal notes
// ===========================================================================

test('a stranger cannot comment on a ticket — the reference lets anyone', async () => {
  // `comment.create` in the reference never loads the ticket, so anybody
  // holding helpdesk:view:self — everyone — can comment on any ticket id.
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.other.user), async (url) => {
    errorBody(await post(url, `${P}/tickets/${ticket.id}/comments`, { body: 'hello' }), 404);
  });
  await withServer(appFor(org.payroll.user), async (url) => {
    errorBody(await post(url, `${P}/tickets/${ticket.id}/comments`, { body: 'hello' }), 404);
  });
});

test('the requester and the owning team can both comment', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.staff.user), async (url) => {
    const t = envelope(
      await post(url, `${P}/tickets/${ticket.id}/comments`, { body: 'Any update?' }),
      201,
    );
    assert.equal(t.comments.length, 1);
    // The reference hardcodes authorName to '' with the same "populated by
    // controller" comment it uses for the requester.
    assert.match(t.comments[0].authorName, /Sam/);
  });

  await withServer(appFor(org.it.user), async (url) => {
    const t = envelope(
      await post(url, `${P}/tickets/${ticket.id}/comments`, { body: 'Looking now.' }),
      201,
    );
    assert.equal(t.comments.length, 2);
  });
});

test('only the owning team may WRITE an internal note', async () => {
  // The reference takes `internal` from the body unchecked.
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.staff.user), async (url) => {
    const body = errorBody(
      await post(url, `${P}/tickets/${ticket.id}/comments`, {
        body: 'sneaking into the internal channel',
        internal: true,
      }),
      403,
    );
    assert.match(body.message, /internal note/i);
  });

  await withServer(appFor(org.it.user), async (url) => {
    envelope(
      await post(url, `${P}/tickets/${ticket.id}/comments`, {
        body: 'Requester has done this before.',
        internal: true,
      }),
      201,
    );
  });
});

test('an internal note is invisible to the requester, even on their own ticket', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    envelope(
      await post(url, `${P}/tickets/${ticket.id}/comments`, {
        body: 'PUBLIC: we are on it.',
        internal: false,
      }),
      201,
    );
    envelope(
      await post(url, `${P}/tickets/${ticket.id}/comments`, {
        body: 'SECRET: escalate to the vendor.',
        internal: true,
      }),
      201,
    );
  });

  await withServer(appFor(org.staff.user), async (url) => {
    const t = envelope(await get(url, `${P}/tickets/${ticket.id}`));
    const bodies = t.comments.map((c) => c.body);
    assert.ok(bodies.some((b) => b.includes('PUBLIC')));
    assert.ok(!bodies.some((b) => b.includes('SECRET')), 'the internal note must not leak');
    assert.ok(!JSON.stringify(t).includes('SECRET'));
  });

  await withServer(appFor(org.it.user), async (url) => {
    const t = envelope(await get(url, `${P}/tickets/${ticket.id}`));
    assert.equal(t.comments.length, 2, 'the team sees both');
  });
});

// ===========================================================================
// Filtering, search, paging
// ===========================================================================

test('the queue is filtered, searched and paged by the SERVER', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  await raise(org.staff, cats.it.id, { subject: 'Printer jam', priority: 'low' });
  await raise(org.staff, cats.it.id, { subject: 'VPN down', priority: 'urgent' });
  await raise(org.other, cats.it.id, { subject: 'Monitor flicker', priority: 'normal' });

  await withServer(appFor(org.it.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/tickets`)).total, 3);
    assert.equal(envelope(await get(url, `${P}/tickets?priority=urgent`)).total, 1);
    assert.equal(envelope(await get(url, `${P}/tickets?status=open`)).total, 3);
    assert.equal(envelope(await get(url, `${P}/tickets?search=VPN`)).total, 1);
    assert.equal(envelope(await get(url, `${P}/tickets?categoryId=${cats.it.id}`)).total, 3);

    const paged = envelope(await get(url, `${P}/tickets?pageSize=2`));
    assert.equal(paged.data.length, 2);
    assert.equal(paged.total, 3);
    assert.equal(paged.page, 1);
  });
});

test('`mine=true` narrows without widening', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const mine = await raise(org.it, cats.it.id, { subject: 'My own laptop' });
  await raise(org.staff, cats.it.id, { subject: 'Somebody else' });

  await withServer(appFor(org.it.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/tickets`)).total, 2);
    const own = envelope(await get(url, `${P}/tickets/me`));
    assert.equal(own.total, 1);
    assert.equal(own.data[0].id, mine.id);
  });
});

test('a search term with regex metacharacters is treated as text', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  await raise(org.staff, cats.it.id, { subject: 'A.C unit' });
  await raise(org.staff, cats.it.id, { subject: 'ABC unit' });

  await withServer(appFor(org.it.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/tickets?search=A.C`)).total, 1);
    assert.equal(envelope(await get(url, `${P}/tickets?search=%28%28%28`)).total, 0);
  });
});

test('an excessive page size is refused', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.it.user), async (url) => {
    errorBody(await get(url, `${P}/tickets?pageSize=5000`), 400);
    errorBody(await get(url, `${P}/tickets?page=0`), 400);
  });
});

test('breached tickets can be listed on their own', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);
  // Push it past its due instant.
  await HelpdeskTicket.updateOne(
    { _id: ticket.id },
    { $set: { slaDueAt: new Date(Date.now() - 3_600_000) } },
  );

  await withServer(appFor(org.it.user), async (url) => {
    const breached = envelope(await get(url, `${P}/tickets?breachedOnly=true`));
    assert.equal(breached.total, 1);
    assert.equal(breached.data[0].slaBreached, true);
  });
});

// ===========================================================================
// Knowledge base
// ===========================================================================

test('a resolver writes articles; an employee reads only published ones', async () => {
  const org = await seedOrg();
  let draftId;

  await withServer(appFor(org.it.user), async (url) => {
    const published = envelope(
      await post(url, `${P}/kb`, {
        title: 'How to reset your VPN',
        body: 'Open the client and choose Reset.',
        searchTags: ['vpn', 'network'],
        published: true,
      }),
      201,
    );
    assert.equal(published.published, true);
    assert.ok(published.publishedAt);
    assert.match(published.authorName, /Ivan/);

    const draft = envelope(
      await post(url, `${P}/kb`, { title: 'Draft guide', body: 'Not ready.' }),
      201,
    );
    draftId = draft.id;
    assert.equal(draft.published, false);
  });

  await withServer(appFor(org.staff.user), async (url) => {
    const list = envelope(await get(url, `${P}/kb`));
    assert.equal(list.total, 1, 'a draft is not readable');
    errorBody(await get(url, `${P}/kb/${draftId}`), 404);
    // And they cannot write.
    errorBody(await post(url, `${P}/kb`, { title: 'Mine', body: 'x' }), 403);
  });

  await withServer(appFor(org.it.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/kb?includeDrafts=true`)).total, 2);
  });
});

test('KB search FILTERS before it pages', async () => {
  // The reference takes the newest N and substring-matches those, so a match
  // outside the first page can never be found.
  const org = await seedOrg();

  await withServer(appFor(org.it.user), async (url) => {
    for (let i = 0; i < 25; i += 1) {
      envelope(
        await post(url, `${P}/kb`, {
          title: `Filler article ${i}`,
          body: 'nothing to see',
          published: true,
        }),
        201,
      );
    }
    // The needle is the OLDEST article, well outside the first page.
    const needle = envelope(
      await post(url, `${P}/kb`, {
        title: 'Needle',
        body: 'the unique haystack marker',
        published: true,
      }),
      201,
    );
    await KbArticle.updateOne(
      { _id: needle.id },
      { $set: { publishedAt: new Date('2020-01-01') } },
    );

    const found = envelope(await get(url, `${P}/kb?search=haystack&pageSize=5`));
    assert.equal(found.total, 1, 'found despite being outside the newest page');
    assert.equal(found.data[0].title, 'Needle');
  });
});

test('an article can be published and unpublished', async () => {
  const org = await seedOrg();
  let id;

  await withServer(appFor(org.it.user), async (url) => {
    id = envelope(await post(url, `${P}/kb`, { title: 'Guide', body: 'x' }), 201).id;

    const published = envelope(await patch(url, `${P}/kb/${id}`, { published: true }));
    assert.equal(published.published, true);

    const retracted = envelope(await patch(url, `${P}/kb/${id}`, { published: false }));
    assert.equal(retracted.published, false);
    assert.equal(retracted.publishedAt, null);

    envelope(await del(url, `${P}/kb/${id}`));
    errorBody(await get(url, `${P}/kb/${id}`), 404);
  });
});

// ===========================================================================
// Audit, envelope, access
// ===========================================================================

test('every helpdesk action is audited, and a refused one is not', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    envelope(
      await post(url, `${P}/tickets/${ticket.id}/assign`, {
        assigneeEmployeeId: String(org.it.employee._id),
      }),
    );
    envelope(await post(url, `${P}/tickets/${ticket.id}/status`, { status: 'in_progress' }));
    envelope(await post(url, `${P}/tickets/${ticket.id}/comments`, { body: 'on it' }), 201);

    const actions = (await AuditLog.find({}).lean()).map((r) => r.action);
    for (const expected of [
      AUDIT_ACTIONS.TICKET_CATEGORY_CREATED,
      AUDIT_ACTIONS.TICKET_CREATED,
      AUDIT_ACTIONS.TICKET_ASSIGNED,
      AUDIT_ACTIONS.TICKET_STATUS_CHANGED,
      AUDIT_ACTIONS.TICKET_COMMENT_ADDED,
    ]) {
      assert.ok(actions.includes(expected), `${expected} should be audited`);
    }
  });

  await AuditLog.deleteMany({});
  await withServer(appFor(org.other.user), async (url) => {
    errorBody(await post(url, `${P}/tickets/${ticket.id}/comments`, { body: 'nope' }), 404);
    assert.equal(await AuditLog.countDocuments({}), 0);
  });
});

test('no ticket body or internal note reaches the audit trail', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const secret = 'CONFIDENTIAL-GRIEVANCE-DETAIL';
  const ticket = await raise(org.staff, cats.hr.id, { body: secret });

  await withServer(appFor(org.hr.user), async (url) => {
    envelope(
      await post(url, `${P}/tickets/${ticket.id}/comments`, {
        body: 'INTERNAL-SECRET-NOTE',
        internal: true,
      }),
      201,
    );
  });

  for (const entry of await AuditLog.find({}).lean()) {
    const text = JSON.stringify(entry);
    assert.ok(!text.includes(secret), 'the ticket body must not be logged');
    assert.ok(!text.includes('INTERNAL-SECRET-NOTE'), 'the note must not be logged');
  }
});

test('every helpdesk response uses the standard envelope', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  const ticket = await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    for (const res of [
      await get(url, `${P}/categories`),
      await get(url, `${P}/tickets`),
      await get(url, `${P}/tickets/me`),
      await get(url, `${P}/tickets/${ticket.id}`),
      await get(url, `${P}/kb`),
      await patch(url, `${P}/tickets/${ticket.id}`, { priority: 'high' }),
    ]) {
      assert.equal(res.body.success, true, JSON.stringify(res.body));
      assert.ok('data' in res.body, 'the payload must sit under `data`');
    }
  });
});

test('the ticket and KB lists return a page object under `data`', async () => {
  const org = await seedOrg();
  const cats = await seedCategories(org);
  await raise(org.staff, cats.it.id);

  await withServer(appFor(org.it.user), async (url) => {
    for (const path of [`${P}/tickets`, `${P}/kb`]) {
      const page = envelope(await get(url, path));
      assert.ok(Array.isArray(page.data));
      assert.equal(typeof page.total, 'number');
      assert.equal(page.page, 1);
      assert.equal(typeof page.pageSize, 'number');
    }
  });
});

test('AD-4: a Customer reaches no helpdesk endpoint', async () => {
  const customer = { _id: oid(), role: 'Customer', roles: [], status: 'Active' };

  await withServer(appFor(customer), async (url) => {
    for (const res of [
      await get(url, `${P}/tickets`),
      await get(url, `${P}/tickets/me`),
      await get(url, `${P}/categories`),
      await get(url, `${P}/kb`),
      await post(url, `${P}/tickets`, { categoryId: String(oid()), subject: 'x', body: 'y' }),
    ]) {
      assert.ok(res.status === 403 || res.status === 401, `got ${res.status}`);
    }
  });
});

test('an auditor holds no helpdesk grant at all', async () => {
  const auditor = await makePerson([R.AUDITOR], { firstName: 'Aud' });

  await withServer(appFor(auditor.user), async (url) => {
    errorBody(await get(url, `${P}/tickets`), 403);
    errorBody(await get(url, `${P}/kb`), 403);
  });
});

test('an unknown id is a 404, and a malformed one is not a 500', async () => {
  const org = await seedOrg();

  await withServer(appFor(org.it.user), async (url) => {
    errorBody(await get(url, `${P}/tickets/${oid()}`), 404);
    errorBody(await get(url, `${P}/tickets/not-an-id`), 404);
    errorBody(await get(url, `${P}/kb/not-an-id`), 404);
    errorBody(await post(url, `${P}/tickets/not-an-id/status`, { status: 'closed' }), 404);
  });
});
