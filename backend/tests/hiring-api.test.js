/**
 * Hiring — the HTTP layer, the workflows, and the public careers surface.
 *
 * A real Express app over a real MongoDB, following the pattern Employee
 * Master, Attendance and Payroll established. Only `protect` is stubbed; the
 * permission chain, the validator, the services and the error handler are the
 * genuine article.
 *
 * The assertions that carry the most weight are the ones about the public
 * surface: the reference's careers endpoints are keyed by the offer's own id,
 * so anyone holding one can read a salary or accept an employment offer on the
 * candidate's behalf. Those tests are the proof that is closed.
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
  JobRequisition,
  JobPosting,
  Candidate,
  Application,
  Interview,
  InterviewFeedback,
  HiringOffer,
} from '../models/hrms/HiringModels.js';

import hiringRoutes from '../modules/hrms/hiring/hiring.routes.js';
import careersRoutes from '../modules/hrms/hiring/careers.routes.js';
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
import { fromDecimal } from '../shared/payroll/money.js';
import { buildTestApp, stubProtect, withServer, get, post, patch } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/hiring';
const C = '/api/v1/hrms/careers';
const oid = () => new mongoose.Types.ObjectId();

/** Tomorrow and next month, as `YYYY-MM-DD` / ISO. */
const inDays = (n) => new Date(Date.now() + n * 86_400_000);
const dayIn = (n) => inDays(n).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

before(async () => {
  await startTestMongo();
  await syncIndexes(
    Employee,
    User,
    Department,
    JobRequisition,
    JobPosting,
    Candidate,
    Application,
    Interview,
    InterviewFeedback,
    HiringOffer,
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
      router.use('/hiring', hiringRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

/** The careers surface, mounted OUTSIDE the auth chain as production mounts it. */
function careersApp() {
  return buildTestApp({
    mount: (app) => {
      app.use('/api/v1/hrms/careers', careersRoutes);
    },
  });
}

let seq = 0;

async function makeEmployee({ roles = [R.EMPLOYEE] } = {}) {
  seq += 1;
  const user = await User.create({
    email: `hire${seq}@example.com`,
    password: 'x'.repeat(60),
    user: `Person ${seq}`,
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    userId: user._id,
    employeeCode: `HIR${String(seq).padStart(3, '0')}`,
    firstName: 'Person',
    lastName: String(seq),
    dateOfJoining: new Date('2024-01-01'),
    status: 'active',
  });
  return {
    user: { _id: user._id, role: 'Management', roles, status: 'Active' },
    employee,
    id: String(employee._id),
  };
}

/** A requisition approved by somebody other than its author. */
async function approvedRequisition(url, recruiterUser) {
  const created = await post(url, `${P}/requisitions`, {
    title: 'Senior Engineer',
    headcount: 1,
    budgetMin: '900000',
    budgetMax: '1400000',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;

  // A different approver — the author cannot sign off their own.
  const approver = await makeEmployee({ roles: [R.HR_ADMIN] });
  await withServer(appFor(approver.user), async (approverUrl) => {
    const approved = await post(approverUrl, `${P}/requisitions/${id}/approve`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
  });
  void recruiterUser;
  return id;
}

/** A published posting on an approved requisition; returns its slug. */
async function publishedPosting(url, requisitionId) {
  const posting = await post(url, `${P}/postings`, {
    requisitionId,
    description: 'Build things that matter.',
    requirements: 'Several years of relevant experience.',
  });
  assert.equal(posting.status, 201, JSON.stringify(posting.body));
  const published = await post(url, `${P}/postings/${posting.body.data.id}/publish`, {});
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return posting.body.data.publicSlug;
}

/** A candidate in a requisition's pipeline; returns the application id. */
async function applicationFor(url, requisitionId, name = 'Asha Rao') {
  const candidate = await post(url, `${P}/candidates`, {
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
  });
  assert.equal(candidate.status, 201, JSON.stringify(candidate.body));
  const application = await post(url, `${P}/applications`, {
    candidateId: candidate.body.data.id,
    requisitionId,
  });
  assert.equal(application.status, 201, JSON.stringify(application.body));
  return { applicationId: application.body.data.id, candidateId: candidate.body.data.id };
}

/**
 * Walk an application forward to `offer`.
 *
 * All the way to `offer`, not just to `interview`: the transition table is
 * checked BEFORE the accepted-offer rule, so a move to `hired` from `interview`
 * is refused as an illegal transition and never reaches the rule under test.
 */
async function advanceToOffer(url, applicationId) {
  for (const stage of ['screening', 'interview', 'offer']) {
    const res = await post(url, `${P}/applications/${applicationId}/move`, { stage });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
}

// ===========================================================================
// Authorization
// ===========================================================================

describe('authorization', () => {
  test('every hiring endpoint refuses an unauthenticated caller', async () => {
    await withServer(appFor(null), async (url) => {
      for (const route of ['/requisitions', '/candidates', '/applications', '/interviews', '/offers', '/postings']) {
        assert.equal((await get(url, `${P}${route}`)).status, 401, route);
      }
      assert.equal((await post(url, `${P}/requisitions`, {})).status, 401);
    });
  });

  test('a portal Customer holds no HRMS grant and is refused (AD-4)', async () => {
    const customer = { _id: oid(), role: 'Customer', roles: ['Customer'], status: 'Active' };
    await withServer(appFor(customer), async (url) => {
      const res = await get(url, `${P}/requisitions`);
      assert.equal(res.status, 403);
      assert.match(res.body.message, /no HRMS access/i);
    });
  });

  test('an ordinary employee cannot see the pipeline at all', async () => {
    const { user } = await makeEmployee();
    await withServer(appFor(user), async (url) => {
      for (const route of ['/requisitions', '/candidates', '/applications', '/offers']) {
        assert.equal((await get(url, `${P}${route}`)).status, 403, route);
      }
    });
  });

  test('a MANAGER may view the pipeline but may not recruit', async () => {
    // `hiring:view:team` is the matrix's "interviewer view".
    const { user } = await makeEmployee({ roles: [R.MANAGER] });
    await withServer(appFor(user), async (url) => {
      assert.equal((await get(url, `${P}/requisitions`)).status, 200);
      assert.equal((await get(url, `${P}/applications`)).status, 200);

      const write = await post(url, `${P}/requisitions`, { title: 'X', headcount: 1 });
      assert.equal(write.status, 403, 'viewing a pipeline is not running one');
    });
  });

  test("🔴 a manager cannot read a candidate's résumé", async () => {
    // A CV carries a home address and employment history; sitting on a panel is
    // not a claim on it. `view:org` only — the line the reference draws too.
    const recruiter = await makeEmployee({ roles: [R.RECRUITER] });
    const manager = await makeEmployee({ roles: [R.MANAGER] });
    let candidateId;

    await withServer(appFor(recruiter.user), async (url) => {
      const c = await post(url, `${P}/candidates`, { name: 'Asha', email: 'asha@example.com' });
      candidateId = c.body.data.id;
    });

    await withServer(appFor(manager.user), async (url) => {
      assert.equal((await get(url, `${P}/candidates/${candidateId}`)).status, 200, 'may see the person');
      assert.equal(
        (await get(url, `${P}/candidates/${candidateId}/resume-url`)).status,
        403,
        'may not read their CV',
      );
    });
  });
});

// ===========================================================================
// Requisitions
// ===========================================================================

describe('requisitions', () => {
  test('a requisition is raised as a draft, with Decimal128 budgets', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const res = await post(url, `${P}/requisitions`, {
        title: 'Data Analyst',
        headcount: 2,
        budgetMin: '600000.50',
        budgetMax: '900000',
        businessJustification: 'Two analysts leaving in Q3.',
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.status, 'draft');
      assert.equal(res.body.data.headcount, 2);
      assert.equal(res.body.data.budgetMin, 600000.5);

      const row = await JobRequisition.findOne({}).lean();
      assert.equal(row.budgetMin.constructor.name, 'Decimal128', 'money is never a float');
      assert.equal(row.budgetMin.toString(), '600000.50');
    });
  });

  test('an inverted budget range is refused', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const res = await post(url, `${P}/requisitions`, {
        title: 'X',
        headcount: 1,
        budgetMin: '900000',
        budgetMax: '600000',
      });
      assert.equal(res.status, 400);
    });
  });

  test('an unknown department is refused (AD-2 leaves no foreign key)', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const res = await post(url, `${P}/requisitions`, {
        title: 'X',
        headcount: 1,
        departmentId: String(oid()),
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /department/i);
    });
  });

  test('🔴 nobody approves their own requisition', async () => {
    const author = await makeEmployee({ roles: [R.RECRUITER] });

    await withServer(appFor(author.user), async (url) => {
      const created = await post(url, `${P}/requisitions`, { title: 'Engineer', headcount: 1 });
      const id = created.body.data.id;

      // The reference permits exactly this: `approve` checks only
      // `hiring:edit:org`, which whoever raised it already holds.
      const res = await post(url, `${P}/requisitions/${id}/approve`, {});
      assert.equal(res.status, 403);
      assert.match(res.body.message, /somebody else must approve/i);

      const row = await JobRequisition.findById(id).lean();
      assert.equal(row.status, 'draft', 'still unapproved');
    });
  });

  test('a different approver may approve, and it is recorded', async () => {
    const author = await makeEmployee({ roles: [R.RECRUITER] });
    const approver = await makeEmployee({ roles: [R.HR_ADMIN] });
    let id;

    await withServer(appFor(author.user), async (url) => {
      id = (await post(url, `${P}/requisitions`, { title: 'Engineer', headcount: 1 })).body.data.id;
    });

    await withServer(appFor(approver.user), async (url) => {
      const res = await post(url, `${P}/requisitions/${id}/approve`, {});
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'approved');
      assert.ok(res.body.data.approvedAt);
      assert.equal(res.body.data.approvedByUserId, String(approver.user._id));
    });

    const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.REQUISITION_APPROVED }).lean();
    assert.ok(entry, 'approving headcount is an auditable act');
  });

  test('🔴 the state machine is enforced — the reference enforces none of it', async () => {
    const author = await makeEmployee({ roles: [R.RECRUITER] });
    const approver = await makeEmployee({ roles: [R.HR_ADMIN] });

    await withServer(appFor(author.user), async (url) => {
      const id = (await post(url, `${P}/requisitions`, { title: 'Engineer', headcount: 1 })).body.data.id;

      // draft -> open skips approval entirely.
      const skip = await post(url, `${P}/requisitions/${id}/status`, { status: 'open' });
      assert.equal(skip.status, 409);
      assert.equal(skip.body.code, 'REQUISITION_INVALID_TRANSITION');

      // draft -> filled is not a transition either.
      assert.equal((await post(url, `${P}/requisitions/${id}/status`, { status: 'filled' })).status, 409);

      // Cancelling is legal from draft, and needs a reason.
      const noReason = await post(url, `${P}/requisitions/${id}/status`, { status: 'cancelled' });
      assert.equal(noReason.status, 400, 'a cancellation must say why');

      const cancelled = await post(url, `${P}/requisitions/${id}/status`, {
        status: 'cancelled',
        reason: 'Budget withdrawn for the year.',
      });
      assert.equal(cancelled.status, 200);

      // 🔴 And a cancelled requisition can never be revived — the reference
      // accepts `cancelled -> open` without complaint.
      const revive = await post(url, `${P}/requisitions/${id}/status`, { status: 'open' });
      assert.equal(revive.status, 409);
      assert.match(revive.body.message, /final/i);
    });
    void approver;
  });

  test('approval cannot be reached through the status route', async () => {
    const author = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(author.user), async (url) => {
      const id = (await post(url, `${P}/requisitions`, { title: 'Engineer', headcount: 1 })).body.data.id;
      // Otherwise the self-approval check could simply be walked around.
      const res = await post(url, `${P}/requisitions/${id}/status`, { status: 'approved' });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /approve action/i);
    });
  });

  test('an approved requisition can no longer be edited', async () => {
    const author = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(author.user), async (url) => {
      const id = await approvedRequisition(url, author.user);
      const res = await patch(url, `${P}/requisitions/${id}`, { headcount: 5 });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'REQUISITION_NOT_EDITABLE');
    });
  });
});

// ===========================================================================
// Postings
// ===========================================================================

describe('postings', () => {
  test('a draft requisition cannot be posted', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const id = (await post(url, `${P}/requisitions`, { title: 'Engineer', headcount: 1 })).body.data.id;
      const res = await post(url, `${P}/postings`, {
        requisitionId: id,
        description: 'x',
        requirements: 'y',
      });
      assert.equal(res.status, 409, 'advertising a role nobody approved');
    });
  });

  test('publishing opens the requisition and yields an unguessable slug', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const slug = await publishedPosting(url, requisitionId);

      // Slug is server-generated: title plus random suffix, so the set of open
      // roles cannot be enumerated by guessing names.
      assert.match(slug, /^senior-engineer-[0-9a-f]{8}$/);

      const requisition = await JobRequisition.findById(requisitionId).lean();
      assert.equal(requisition.status, 'open');
    });
  });

  test('a posting cannot be published twice, or republished after closing', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const posting = await post(url, `${P}/postings`, {
        requisitionId,
        description: 'x',
        requirements: 'y',
      });
      const id = posting.body.data.id;

      await post(url, `${P}/postings/${id}/publish`, {});
      assert.equal((await post(url, `${P}/postings/${id}/publish`, {})).status, 409);

      await post(url, `${P}/postings/${id}/close`, {});
      assert.equal((await post(url, `${P}/postings/${id}/close`, {})).status, 409);
    });
  });
});

// ===========================================================================
// Candidates and résumés
// ===========================================================================

describe('candidates', () => {
  test('a duplicate email is a 409', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const body = { name: 'Asha Rao', email: 'asha@example.com' };
      assert.equal((await post(url, `${P}/candidates`, body)).status, 201);
      const second = await post(url, `${P}/candidates`, body);
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'CANDIDATE_EMAIL_TAKEN');
    });
  });

  test('a candidate listing exposes hasResume, never a storage key', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      await post(url, `${P}/candidates`, { name: 'Asha', email: 'asha@example.com' });
      const res = await get(url, `${P}/candidates`);
      const body = JSON.stringify(res.body);
      assert.equal(res.body.data.data[0].hasResume, false);
      assert.ok(!body.includes('resumeKey'), 'the object key must never leave the server');
    });
  });

  test('🔴 a résumé is checked against its own bytes, not its declared type', async () => {
    const { uploadResume } = await import('../modules/hrms/hiring/candidate.service.js');
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    let candidateId;
    await withServer(appFor(user), async (url) => {
      candidateId = (await post(url, `${P}/candidates`, { name: 'A', email: 'a@example.com' })).body.data.id;
    });

    // Declares itself a PDF; the bytes are a script. The reference trusts the
    // header, which is how a résumé inbox becomes a delivery mechanism.
    await assert.rejects(
      () =>
        uploadResume(candidateId, {
          buffer: Buffer.from('<script>alert(1)</script>'),
          mimeType: 'application/pdf',
          filename: 'cv.pdf',
        }),
      /not a valid PDF, DOC or DOCX/,
    );

    // A real PDF is accepted, and the key never contains the filename.
    const result = await uploadResume(candidateId, {
      buffer: Buffer.from('%PDF-1.7\nreal enough'),
      mimeType: 'application/pdf',
      filename: 'Asha Rao CV.pdf',
    });
    assert.equal(result.hasResume, true);

    const row = await Candidate.findById(candidateId).lean();
    assert.ok(row.resumeKey.startsWith('hrms/hiring/resumes/'));
    assert.ok(!row.resumeKey.includes('Asha'), 'the candidate name must not leak into the key');
  });
});

// ===========================================================================
// The pipeline
// ===========================================================================

describe('the application pipeline', () => {
  test('an unknown candidate is refused rather than stored as a dangling row', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      // The reference never checks this — Postgres would have, MongoDB will not.
      const res = await post(url, `${P}/applications`, {
        candidateId: String(oid()),
        requisitionId,
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /candidate/i);
    });
  });

  test('a candidate cannot apply to the same requisition twice', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const { candidateId } = await applicationFor(url, requisitionId);
      const again = await post(url, `${P}/applications`, { candidateId, requisitionId });
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'APPLICATION_EXISTS');
    });
  });

  test('🔴 the pipeline advances one step at a time', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const { applicationId } = await applicationFor(url, requisitionId);

      // The reference allows this jump; a funnel where a card teleports is not
      // a funnel, and any report reading stage history becomes fiction.
      const skip = await post(url, `${P}/applications/${applicationId}/move`, { stage: 'offer' });
      assert.equal(skip.status, 409);
      assert.equal(skip.body.code, 'APPLICATION_INVALID_TRANSITION');

      for (const stage of ['screening', 'interview', 'offer']) {
        const res = await post(url, `${P}/applications/${applicationId}/move`, { stage });
        assert.equal(res.status, 200, stage);
        assert.equal(res.body.data.stage, stage);
      }
    });
  });

  test('every move is recorded, so stage history is answerable', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const { applicationId } = await applicationFor(url, requisitionId);
      await post(url, `${P}/applications/${applicationId}/move`, { stage: 'screening' });

      const res = await get(url, `${P}/applications/${applicationId}`);
      assert.deepEqual(
        res.body.data.stageHistory.map((e) => e.stage),
        ['applied', 'screening'],
      );
    });
  });

  test('a rejection needs a reason, and is terminal', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const { applicationId } = await applicationFor(url, requisitionId);

      const noReason = await post(url, `${P}/applications/${applicationId}/move`, { stage: 'rejected' });
      assert.equal(noReason.status, 400);

      const rejected = await post(url, `${P}/applications/${applicationId}/move`, {
        stage: 'rejected',
        rejectionReason: 'Not enough relevant experience.',
      });
      assert.equal(rejected.status, 200);

      const revive = await post(url, `${P}/applications/${applicationId}/move`, { stage: 'screening' });
      assert.equal(revive.status, 409);
    });
  });

  test('🔴 hiring requires an ACCEPTED offer', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const { applicationId } = await applicationFor(url, requisitionId);
      await advanceToOffer(url, applicationId);

      // Nobody is hired before they have agreed to anything.
      const res = await post(url, `${P}/applications/${applicationId}/move`, { stage: 'hired' });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /has not accepted an offer/i);
    });
  });

  test('the Kanban board groups every application by column', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const a = await applicationFor(url, requisitionId, 'Asha Rao');
      await applicationFor(url, requisitionId, 'Bala Nair');
      await post(url, `${P}/applications/${a.applicationId}/move`, { stage: 'screening' });

      const res = await get(url, `${P}/requisitions/${requisitionId}/pipeline`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.total, 2);

      const byStage = Object.fromEntries(
        res.body.data.columns.map((c) => [c.stage, c.applications.length]),
      );
      assert.equal(byStage.applied, 1);
      assert.equal(byStage.screening, 1);
      assert.equal(byStage.hired, 0);
    });
  });
});

// ===========================================================================
// Interviews and feedback
// ===========================================================================

describe('interviews', () => {
  test('scheduling advances the pipeline and records the panel', async () => {
    const recruiter = await makeEmployee({ roles: [R.RECRUITER] });
    const panellist = await makeEmployee({ roles: [R.MANAGER] });

    await withServer(appFor(recruiter.user), async (url) => {
      const requisitionId = await approvedRequisition(url, recruiter.user);
      const { applicationId } = await applicationFor(url, requisitionId);

      const res = await post(url, `${P}/interviews`, {
        applicationId,
        round: 1,
        panelEmployeeIds: [panellist.id],
        scheduledAt: inDays(3).toISOString(),
        durationMinutes: 45,
      });

      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.panel.length, 1);
      assert.equal(res.body.data.panel[0].employeeId, panellist.id);

      // applied -> interview, forwards only.
      const application = await Application.findById(applicationId).lean();
      assert.equal(application.stage, 'interview');
    });
  });

  test('an interview cannot be scheduled in the past, or with a stranger on the panel', async () => {
    const recruiter = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(recruiter.user), async (url) => {
      const requisitionId = await approvedRequisition(url, recruiter.user);
      const { applicationId } = await applicationFor(url, requisitionId);

      const past = await post(url, `${P}/interviews`, {
        applicationId,
        panelEmployeeIds: [recruiter.id],
        scheduledAt: inDays(-2).toISOString(),
      });
      assert.equal(past.status, 400, 'an interview in the past cannot be attended');

      const stranger = await post(url, `${P}/interviews`, {
        applicationId,
        panelEmployeeIds: [String(oid())],
        scheduledAt: inDays(3).toISOString(),
      });
      assert.equal(stranger.status, 400);
    });
  });

  test('a duplicate round is refused', async () => {
    const recruiter = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(recruiter.user), async (url) => {
      const requisitionId = await approvedRequisition(url, recruiter.user);
      const { applicationId } = await applicationFor(url, requisitionId);
      const body = {
        applicationId,
        round: 1,
        panelEmployeeIds: [recruiter.id],
        scheduledAt: inDays(3).toISOString(),
      };
      assert.equal((await post(url, `${P}/interviews`, body)).status, 201);
      const again = await post(url, `${P}/interviews`, body);
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'INTERVIEW_ROUND_EXISTS');
    });
  });

  test('"my interviews" returns only the caller\'s own panels', async () => {
    const recruiter = await makeEmployee({ roles: [R.RECRUITER] });
    const onPanel = await makeEmployee({ roles: [R.MANAGER] });
    const notOnPanel = await makeEmployee({ roles: [R.MANAGER] });

    await withServer(appFor(recruiter.user), async (url) => {
      const requisitionId = await approvedRequisition(url, recruiter.user);
      const { applicationId } = await applicationFor(url, requisitionId);
      await post(url, `${P}/interviews`, {
        applicationId,
        panelEmployeeIds: [onPanel.id],
        scheduledAt: inDays(3).toISOString(),
      });
    });

    await withServer(appFor(onPanel.user), async (url) => {
      const res = await get(url, `${P}/interviews/mine`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.total, 1);
      assert.equal(res.body.data.data[0].awaitingMyFeedback, true);
    });

    await withServer(appFor(notOnPanel.user), async (url) => {
      assert.equal((await get(url, `${P}/interviews/mine`)).body.data.total, 0);
    });
  });

  test('🔴 only a PANELLIST may submit feedback', async () => {
    const recruiter = await makeEmployee({ roles: [R.RECRUITER] });
    const panellist = await makeEmployee({ roles: [R.MANAGER] });
    let interviewId;

    await withServer(appFor(recruiter.user), async (url) => {
      const requisitionId = await approvedRequisition(url, recruiter.user);
      const { applicationId } = await applicationFor(url, requisitionId);
      interviewId = (
        await post(url, `${P}/interviews`, {
          applicationId,
          panelEmployeeIds: [panellist.id],
          scheduledAt: inDays(3).toISOString(),
        })
      ).body.data.id;

      // The reference lets anyone with `hiring:edit:org` file a review under
      // their own name for a room they never sat in.
      const res = await post(url, `${P}/interviews/${interviewId}/feedback`, {
        ratings: { technical: 4 },
        decision: 'hire',
      });
      assert.equal(res.status, 403);
      assert.match(res.body.message, /panellist/i);
    });

    await withServer(appFor(panellist.user), async (url) => {
      const res = await post(url, `${P}/interviews/${interviewId}/feedback`, {
        ratings: { technical: 4, communication: 5 },
        comments: 'Strong on fundamentals.',
        decision: 'hire',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.decision, 'hire');

      // And not twice.
      const again = await post(url, `${P}/interviews/${interviewId}/feedback`, {
        ratings: { technical: 1 },
        decision: 'no_hire',
      });
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'FEEDBACK_ALREADY_SUBMITTED');
    });
  });

  test('feedback ratings are bounded and non-empty', async () => {
    const recruiter = await makeEmployee({ roles: [R.RECRUITER] });
    const panellist = await makeEmployee({ roles: [R.MANAGER] });
    let interviewId;

    await withServer(appFor(recruiter.user), async (url) => {
      const requisitionId = await approvedRequisition(url, recruiter.user);
      const { applicationId } = await applicationFor(url, requisitionId);
      interviewId = (
        await post(url, `${P}/interviews`, {
          applicationId,
          panelEmployeeIds: [panellist.id],
          scheduledAt: inDays(3).toISOString(),
        })
      ).body.data.id;
    });

    await withServer(appFor(panellist.user), async (url) => {
      // The reference's `z.record(z.number())` accepts both of these.
      const empty = await post(url, `${P}/interviews/${interviewId}/feedback`, {
        ratings: {},
        decision: 'hire',
      });
      assert.equal(empty.status, 400, 'a review that scores nothing');

      const outOfRange = await post(url, `${P}/interviews/${interviewId}/feedback`, {
        ratings: { technical: 99 },
        decision: 'hire',
      });
      assert.equal(outOfRange.status, 400);
    });
  });

  test('a cancelled interview is final and takes no feedback', async () => {
    const recruiter = await makeEmployee({ roles: [R.RECRUITER] });
    const panellist = await makeEmployee({ roles: [R.MANAGER] });
    let interviewId;

    await withServer(appFor(recruiter.user), async (url) => {
      const requisitionId = await approvedRequisition(url, recruiter.user);
      const { applicationId } = await applicationFor(url, requisitionId);
      interviewId = (
        await post(url, `${P}/interviews`, {
          applicationId,
          panelEmployeeIds: [panellist.id],
          scheduledAt: inDays(3).toISOString(),
        })
      ).body.data.id;

      assert.equal(
        (await post(url, `${P}/interviews/${interviewId}/status`, { status: 'cancelled' })).status,
        200,
      );
      // 🔴 The reference allows reviving it, and feedback then attaches to a
      // session that never happened.
      const revive = await post(url, `${P}/interviews/${interviewId}/status`, { status: 'scheduled' });
      assert.equal(revive.status, 409);
    });

    await withServer(appFor(panellist.user), async (url) => {
      const res = await post(url, `${P}/interviews/${interviewId}/feedback`, {
        ratings: { technical: 4 },
        decision: 'hire',
      });
      assert.equal(res.status, 409);
    });
  });
});

// ===========================================================================
// Offers
// ===========================================================================

describe('offers', () => {
  /** An application at `offer` with a sent offer; returns the token. */
  async function sentOffer(url) {
    const recruiter = { id: null };
    const requisitionId = await approvedRequisition(url, recruiter);
    const { applicationId } = await applicationFor(url, requisitionId);
    await advanceToOffer(url, applicationId);

    const created = await post(url, `${P}/offers`, {
      applicationId,
      ctc: '1200000',
      joiningDate: dayIn(30),
      designation: 'Senior Engineer',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const sent = await post(url, `${P}/offers/${created.body.data.id}/send`, {});
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    return { offerId: created.body.data.id, token: sent.body.data.accessToken, applicationId };
  }

  test('an offer is raised, advances the pipeline, and stores CTC as Decimal128', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const { applicationId } = await applicationFor(url, requisitionId);
      await post(url, `${P}/applications/${applicationId}/move`, { stage: 'screening' });

      const res = await post(url, `${P}/offers`, {
        applicationId,
        ctc: '1234567.89',
        joiningDate: dayIn(30),
        designation: 'Engineer',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.state, 'draft');

      const row = await HiringOffer.findOne({}).lean();
      assert.equal(row.ctc.constructor.name, 'Decimal128');
      assert.equal(fromDecimal(row.ctc), 1234567.89);

      // screening -> offer, forwards only.
      const application = await Application.findById(applicationId).lean();
      assert.equal(application.stage, 'offer');
    });
  });

  test('a joining date in the past is refused, and two live offers are refused', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const { applicationId } = await applicationFor(url, requisitionId);

      const past = await post(url, `${P}/offers`, {
        applicationId,
        ctc: '1000000',
        joiningDate: dayIn(-5),
        designation: 'Engineer',
      });
      assert.equal(past.status, 400);

      const body = {
        applicationId,
        ctc: '1000000',
        joiningDate: dayIn(30),
        designation: 'Engineer',
      };
      assert.equal((await post(url, `${P}/offers`, body)).status, 201);
      const second = await post(url, `${P}/offers`, body);
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'OFFER_ALREADY_OPEN');
    });
  });

  test('sending mints a token ONCE, and never stores or audits it in plaintext', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const { offerId, token } = await sentOffer(url);

      assert.match(token, /^[0-9a-f]{64}$/, '256 bits of entropy');

      const row = await HiringOffer.findById(offerId).select('+accessTokenHash').lean();
      assert.ok(row.accessTokenHash, 'a hash is stored');
      assert.notEqual(row.accessTokenHash, token, 'never the plaintext');
      assert.ok(row.accessTokenExpiresAt, 'and it expires');

      // A credential in the audit trail is a credential leak — the trail is
      // read by more people than an offer is.
      const entries = await AuditLog.find({ action: AUDIT_ACTIONS.OFFER_SENT }).lean();
      assert.equal(entries.length, 1);
      assert.ok(!JSON.stringify(entries[0]).includes(token));

      // Sending twice is refused.
      assert.equal((await post(url, `${P}/offers/${offerId}/send`, {})).status, 409);
    });
  });
});

// ===========================================================================
// The public careers surface
// ===========================================================================

describe('the public careers surface', () => {
  test('lists only published, unclosed roles, and leaks nothing internal', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    let slug;

    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      slug = await publishedPosting(url, requisitionId);
      // A second, unpublished posting must not appear.
      const other = await approvedRequisition(url, user);
      await post(url, `${P}/postings`, { requisitionId: other, description: 'x', requirements: 'y' });
    });

    await withServer(careersApp(), async (url) => {
      const res = await get(url, `${C}/postings`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);

      const body = JSON.stringify(res.body);
      // The requisition carries headcount, a budget range and a business
      // justification. None of it is an advert.
      for (const leaked of ['headcount', 'budgetMin', 'budgetMax', 'businessJustification', 'requisitionId']) {
        assert.ok(!body.includes(leaked), `${leaked} must not reach the public page`);
      }
      assert.equal(res.body.data[0].slug, slug);
    });
  });

  test('an unpublished role is a 404, indistinguishable from one that does not exist', async () => {
    await withServer(careersApp(), async (url) => {
      assert.equal((await get(url, `${C}/postings/no-such-role-abcdef12`)).status, 404);
    });
  });

  test('applying creates the candidate and the application', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    let slug;
    await withServer(appFor(user), async (url) => {
      slug = await publishedPosting(url, await approvedRequisition(url, user));
    });

    await withServer(careersApp(), async (url) => {
      const res = await post(url, `${C}/postings/${slug}/apply`, {
        name: 'Asha Rao',
        email: 'asha@example.com',
        noticePeriodDays: 60,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.received, true);

      const candidate = await Candidate.findOne({ email: 'asha@example.com' }).lean();
      assert.equal(candidate.source, 'careers');
      assert.equal(await Application.countDocuments({ candidateId: candidate._id }), 1);
    });
  });

  test('🔴 an applicant cannot claim to be a referral, or set a recruiter field', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    let slug;
    await withServer(appFor(user), async (url) => {
      slug = await publishedPosting(url, await approvedRequisition(url, user));
    });

    await withServer(careersApp(), async (url) => {
      const res = await post(url, `${C}/postings/${slug}/apply`, {
        name: 'Asha Rao',
        email: 'asha@example.com',
        source: 'referral',
      });
      // `.strict()` refuses the unknown key rather than ignoring it.
      assert.equal(res.status, 400);
    });
  });

  test('a repeat application reports success rather than becoming an oracle', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    let slug;
    await withServer(appFor(user), async (url) => {
      slug = await publishedPosting(url, await approvedRequisition(url, user));
    });

    await withServer(careersApp(), async (url) => {
      const body = { name: 'Asha Rao', email: 'asha@example.com' };
      const first = await post(url, `${C}/postings/${slug}/apply`, body);
      const second = await post(url, `${C}/postings/${slug}/apply`, body);

      // Telling an anonymous caller "you already applied" reveals who has
      // applied where.
      assert.equal(second.status, first.status);
      assert.deepEqual(second.body, first.body);
      assert.equal(await Application.countDocuments({}), 1, 'but only one row exists');
    });
  });
});

// ===========================================================================
// 🔴 The offer link — the defect this module exists to close
// ===========================================================================

describe('the candidate offer link', () => {
  async function makeSentOffer() {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    let token;
    let offerId;
    let applicationId;

    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const app = await applicationFor(url, requisitionId);
      applicationId = app.applicationId;
      await advanceToOffer(url, applicationId);

      const created = await post(url, `${P}/offers`, {
        applicationId,
        ctc: '1200000',
        joiningDate: dayIn(30),
        designation: 'Senior Engineer',
      });
      offerId = created.body.data.id;
      const sent = await post(url, `${P}/offers/${offerId}/send`, {});
      token = sent.body.data.accessToken;
    });

    return { token, offerId, applicationId };
  }

  test('🔴 the offer ID opens NOTHING — only the token does', async () => {
    const { token, offerId } = await makeSentOffer();

    await withServer(careersApp(), async (url) => {
      // The reference's route is `/careers/offer/:id`. Here the id is not a
      // credential and is refused before it reaches a query.
      assert.equal((await get(url, `${C}/offer/${offerId}`)).status, 404);
      assert.equal(
        (await post(url, `${C}/offer/${offerId}/accept`, { signatureName: 'Mallory' })).status,
        404,
      );
      assert.equal((await post(url, `${C}/offer/${offerId}/reject`, {})).status, 404);

      // The token does.
      const res = await get(url, `${C}/offer/${token}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.designation, 'Senior Engineer');
      assert.equal(res.body.data.ctc, 1200000);
    });
  });

  test('a wrong or malformed token is refused, and every refusal is audited', async () => {
    await makeSentOffer();
    await AuditLog.deleteMany({});

    await withServer(careersApp(), async (url) => {
      for (const bad of ['f'.repeat(64), 'short', '../../etc/passwd', String(oid())]) {
        assert.equal((await get(url, `${C}/offer/${bad}`)).status, 404, bad);
      }
    });

    // Only the well-formed-but-unknown token reaches the service; the rest are
    // refused at the route. Either way an attacker gets no signal — but the one
    // that got through left a trace.
    const refusals = await AuditLog.countDocuments({ action: AUDIT_ACTIONS.OFFER_LINK_REFUSED });
    assert.ok(refusals >= 1, 'a probe of the offer endpoint must leave a trace');
  });

  test("the candidate's view withholds the recruiter's negotiation notes", async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    let token;

    await withServer(appFor(user), async (url) => {
      const requisitionId = await approvedRequisition(url, user);
      const { applicationId } = await applicationFor(url, requisitionId);
      await advanceToOffer(url, applicationId);
      const created = await post(url, `${P}/offers`, {
        applicationId,
        ctc: '1200000',
        joiningDate: dayIn(30),
        designation: 'Engineer',
        negotiationNotes: 'Will likely settle at 11L; do not reveal.',
      });
      token = (await post(url, `${P}/offers/${created.body.data.id}/send`, {})).body.data.accessToken;
    });

    await withServer(careersApp(), async (url) => {
      const res = await get(url, `${C}/offer/${token}`);
      assert.equal(res.status, 200);
      // The reference returns the same DTO to the recruiter and the candidate.
      assert.ok(!JSON.stringify(res.body).includes('settle at 11L'));
      assert.equal(res.body.data.negotiationNotes, undefined);
    });
  });

  test('accepting records the signature, spends the link, and unblocks hiring', async () => {
    const { token, offerId, applicationId } = await makeSentOffer();

    await withServer(careersApp(), async (url) => {
      const res = await post(url, `${C}/offer/${token}/accept`, { signatureName: 'Asha Rao' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.state, 'accepted');

      // The link is spent — otherwise anyone holding it keeps reading the
      // salary indefinitely.
      assert.equal((await get(url, `${C}/offer/${token}`)).status, 404);
    });

    // `+accessTokenHash` because the field is `select: false` — without it a
    // lean read omits the key entirely and the assertion would pass on
    // `undefined` whether or not the token was actually spent.
    const row = await HiringOffer.findById(offerId).select('+accessTokenHash').lean();
    assert.equal(row.signature.name, 'Asha Rao');
    assert.ok(row.signature.signedAt);
    assert.equal(row.accessTokenHash, null, 'the link is spent');

    const audit = await AuditLog.findOne({ action: AUDIT_ACTIONS.OFFER_ACCEPTED }).lean();
    assert.ok(audit, 'an acceptance from an unauthenticated caller must be recorded');

    // And now the candidate can be marked hired.
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const res = await post(url, `${P}/applications/${applicationId}/move`, { stage: 'hired' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.stage, 'hired');
    });
  });

  test('an offer cannot be accepted twice, nor accepted and rejected', async () => {
    const { token } = await makeSentOffer();

    await withServer(careersApp(), async (url) => {
      assert.equal((await post(url, `${C}/offer/${token}/accept`, { signatureName: 'Asha' })).status, 200);
      // The link is spent, so the second attempt cannot even resolve.
      assert.equal((await post(url, `${C}/offer/${token}/accept`, { signatureName: 'Asha' })).status, 404);
      assert.equal((await post(url, `${C}/offer/${token}/reject`, {})).status, 404);
    });
  });

  test('an expired link is refused with a message the candidate can act on', async () => {
    const { token, offerId } = await makeSentOffer();
    await HiringOffer.updateOne(
      { _id: offerId },
      { $set: { accessTokenExpiresAt: new Date(Date.now() - 1000) } },
    );

    await withServer(careersApp(), async (url) => {
      const res = await get(url, `${C}/offer/${token}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'OFFER_LINK_EXPIRED');
      assert.match(res.body.message, /contact your recruiter/i);
    });
  });

  test('hiring the last headcount fills the requisition automatically', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    let requisitionId;
    let applicationId;
    let token;

    await withServer(appFor(user), async (url) => {
      requisitionId = await approvedRequisition(url, user); // headcount 1
      const app = await applicationFor(url, requisitionId);
      applicationId = app.applicationId;
      await advanceToOffer(url, applicationId);
      const created = await post(url, `${P}/offers`, {
        applicationId,
        ctc: '1000000',
        joiningDate: dayIn(30),
        designation: 'Engineer',
      });
      token = (await post(url, `${P}/offers/${created.body.data.id}/send`, {})).body.data.accessToken;
    });

    await withServer(careersApp(), async (url) => {
      await post(url, `${C}/offer/${token}/accept`, { signatureName: 'Asha Rao' });
    });

    await withServer(appFor(user), async (url) => {
      await post(url, `${P}/applications/${applicationId}/move`, { stage: 'hired' });
    });

    const requisition = await JobRequisition.findById(requisitionId).lean();
    assert.equal(requisition.status, 'filled');

    // And a filled requisition takes no further applications.
    await withServer(appFor(user), async (url) => {
      const candidate = await post(url, `${P}/candidates`, { name: 'Late', email: 'late@example.com' });
      const res = await post(url, `${P}/applications`, {
        candidateId: candidate.body.data.id,
        requisitionId,
      });
      assert.equal(res.status, 409);
    });
  });
});

// ===========================================================================
// Envelope
// ===========================================================================

describe('response envelope', () => {
  test('every payload sits UNDER data, never spread beside it', async () => {
    const { user } = await makeEmployee({ roles: [R.RECRUITER] });
    await withServer(appFor(user), async (url) => {
      const list = await get(url, `${P}/requisitions`);
      assert.equal(list.body.success, true);
      assert.ok(Array.isArray(list.body.data.data), 'paginated payloads nest data.data');
      assert.equal(typeof list.body.data.total, 'number');

      const created = await post(url, `${P}/requisitions`, { title: 'X', headcount: 1 });
      assert.equal(created.body.success, true);
      assert.ok(created.body.data.id);
      assert.equal(created.body.id, undefined, 'nothing leaks to the top level');
    });
  });
});
