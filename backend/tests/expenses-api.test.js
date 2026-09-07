/**
 * Expenses — the HTTP layer, over a real MongoDB.
 *
 * Only `protect` is stubbed, as every other HRMS route test does it. The
 * permission chain, the validator, the services, the storage layer and the
 * error handler are all the genuine article.
 *
 * The tests that matter most are the ones where the reference is unsafe:
 * self-approval, client-supplied receipt keys, and money summed as floats.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';

// Receipts are written through the real storage layer, onto a scratch
// directory. Set before the module graph loads, as the attendance test does.
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_PATH =
  process.env.STORAGE_LOCAL_PATH ||
  (await fs.mkdtemp(path.join(os.tmpdir(), 'hrms-expenses-')));

import Employee from '../models/hrms/Employee.js';
import ExpenseCategory from '../models/hrms/ExpenseCategory.js';
import ExpensePolicy from '../models/hrms/ExpensePolicy.js';
import ExpenseClaim, { sumMoney } from '../models/hrms/ExpenseClaim.js';
import AuditLog from '../models/AuditLog.js';
import expenseRoutes from '../modules/hrms/expenses/expense.routes.js';
import { sniffReceipt, resolveReceiptAccess } from '../modules/hrms/expenses/claim.service.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import {
  registerFileAccessRule,
  __resetFileAccessRules,
} from '../modules/hrms/storage/storage.service.js';
import { __resetStorage } from '../utils/hrms/storage/index.js';
import { AUDIT_ACTIONS, STORAGE_CATEGORIES } from '../shared/constants/hrms.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { buildTestApp, stubProtect, withServer, get, post, patch, del } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/expenses';
const oid = () => new mongoose.Types.ObjectId();

/** A minimal, genuinely-valid PDF and PNG, by their real signatures. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0),
]);

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, ExpenseCategory, ExpensePolicy, ExpenseClaim);
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  __resetReferenceProviders();
  __resetFileAccessRules();
  __resetStorage();
  process.env.STORAGE_DRIVER = 'local';

  registerReferenceProvider('employee', employeeReferenceProvider);
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
  registerFileAccessRule(STORAGE_CATEGORIES.EXPENSE_RECEIPT, {
    resolve: resolveReceiptAccess,
    auditAction: AUDIT_ACTIONS.EXPENSE_RECEIPT_VIEWED,
  });
});

function appFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/expenses', expenseRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

const userWith = (roles, over = {}) => ({
  _id: oid(),
  role: 'Management',
  roles,
  status: 'Active',
  ...over,
});

let seq = 0;
const makeEmployee = (over = {}) => {
  seq += 1;
  return Employee.create({
    employeeCode: `SI-${String(seq).padStart(4, '0')}`,
    userId: over.userId ?? oid(),
    firstName: over.firstName ?? 'Test',
    lastName: over.lastName ?? `Person${seq}`,
    dateOfJoining: new Date(),
    ...over,
  });
};

const makeCategory = (over = {}) =>
  ExpenseCategory.create({ code: 'TRAVEL', name: 'Travel', ...over });

function envelope(res, status = 200) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.deepEqual(Object.keys(res.body).sort(), ['data', 'success'], 'nothing beside `data`');
  return res.body.data;
}

function errorBody(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0);
  if (code) assert.equal(res.body.code, code);
  return res.body;
}

/** A staff member under a manager, plus a finance user and a category. */
async function seedOrg() {
  const managerUser = userWith([R.MANAGER]);
  const staffUser = userWith([R.EMPLOYEE]);
  const financeUser = userWith([R.PAYROLL_ADMIN]); // holds expenses:approve:org

  const manager = await makeEmployee({ firstName: 'Mgr', userId: managerUser._id });
  const staff = await makeEmployee({
    firstName: 'Staff',
    userId: staffUser._id,
    reportingManagerId: manager._id,
    managerChain: [manager._id],
  });
  const finance = await makeEmployee({ firstName: 'Fin', userId: financeUser._id });
  const category = await makeCategory();

  return { managerUser, staffUser, financeUser, manager, staff, finance, category };
}

const validClaim = (category, over = {}) => ({
  title: 'Client visit',
  lineItems: [
    {
      categoryId: String(category._id),
      date: '2026-01-05',
      amount: '250.50',
      description: 'Taxi to the client office',
    },
  ],
  ...over,
});

/** File a claim as the given user and return its DTO. */
async function fileClaim(user, category, over = {}) {
  let created;
  await withServer(appFor(user), async (url) => {
    created = envelope(await post(url, `${P}/claims`, validClaim(category, over)), 201);
  });
  return created;
}

/** File and submit, so it is sitting at the manager step. */
async function submittedClaim(user, category, over = {}) {
  const claim = await fileClaim(user, category, over);
  let submitted;
  await withServer(appFor(user), async (url) => {
    submitted = envelope(await post(url, `${P}/claims/${claim.id}/submit`));
  });
  return submitted;
}

// ===========================================================================
// Categories and policies
// ===========================================================================

test('anyone who can file an expense can read the categories', async () => {
  const { staffUser } = await seedOrg();
  await withServer(appFor(staffUser), async (url) => {
    const data = envelope(await get(url, `${P}/categories`));
    assert.equal(data.length, 1);
    assert.equal(data[0].code, 'TRAVEL');
    assert.equal(data[0].policy, null, 'no policy configured yet');
  });
});

test('only an administrator can change the catalogue', async () => {
  const { staffUser, category } = await seedOrg();
  await withServer(appFor(staffUser), async (url) => {
    assert.equal((await post(url, `${P}/categories`, { code: 'FOOD', name: 'Meals' })).status, 403);
    assert.equal((await patch(url, `${P}/categories/${category._id}`, { name: 'X' })).status, 403);
    assert.equal((await del(url, `${P}/categories/${category._id}`)).status, 403);
    assert.equal((await post(url, `${P}/policies`, { categoryId: String(category._id) })).status, 403);
  });
});

test('a category is created, normalised, and its code is unique', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    const created = envelope(await post(url, `${P}/categories`, { code: 'food', name: 'Meals' }), 201);
    assert.equal(created.code, 'FOOD', 'normalised');
    assert.equal(created.active, true);

    errorBody(
      await post(url, `${P}/categories`, { code: 'FOOD', name: 'Dup' }),
      409,
      'EXPENSE_CATEGORY_CODE_TAKEN',
    );
  });
});

test('an inactive category is hidden from claimants but visible to an administrator', async () => {
  const { staffUser, category } = await seedOrg();
  await ExpenseCategory.updateOne({ _id: category._id }, { $set: { active: false } });

  await withServer(appFor(staffUser), async (url) => {
    assert.deepEqual(envelope(await get(url, `${P}/categories`)), []);
  });
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    assert.equal(envelope(await get(url, `${P}/categories?includeInactive=true`)).length, 1);
  });
});

test('a policy is stored and returned with its category', async () => {
  const { category } = await seedOrg();
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    envelope(
      await post(url, `${P}/policies`, {
        categoryId: String(category._id),
        dailyLimit: '1500.00',
        requiresReceipt: true,
        requiresApproval: true,
      }),
    );

    const [read] = envelope(await get(url, `${P}/categories`));
    assert.equal(read.policy.dailyLimit, '1500.00');
    assert.equal(read.policy.requiresReceipt, true);
  });
});

test('a policy limit is GUIDANCE — it never refuses a claim', async () => {
  // The reference stores every policy field and reads none of them. Refusing on
  // a rule it does not enforce would change what the product does.
  const { staffUser, category } = await seedOrg();
  await ExpensePolicy.create({
    categoryId: category._id,
    dailyLimit: mongoose.Types.Decimal128.fromString('10.00'),
  });

  const claim = await fileClaim(staffUser, category); // 250.50, way over the limit
  assert.equal(claim.total, '250.50');
  assert.equal(claim.status, 'draft');
});

test('a category still used by a claim cannot be deleted, only deactivated', async () => {
  const { staffUser, category } = await seedOrg();
  await fileClaim(staffUser, category);

  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    const res = await del(url, `${P}/categories/${category._id}`);
    errorBody(res, 409, 'EXPENSE_CATEGORY_IN_USE');
    assert.equal(res.body.details.claimCount, 1);

    // Deactivating is the supported move, and it works.
    envelope(await patch(url, `${P}/categories/${category._id}`, { active: false }));
  });
});

test('an unused category is soft-deleted, and its code frees up', async () => {
  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    const created = envelope(await post(url, `${P}/categories`, { code: 'FOOD', name: 'Meals' }), 201);
    envelope(await del(url, `${P}/categories/${created.id}`));
    assert.deepEqual(envelope(await get(url, `${P}/categories`)), []);

    const again = envelope(await post(url, `${P}/categories`, { code: 'FOOD', name: 'Meals' }), 201);
    assert.notEqual(again.id, created.id);
  });

  assert.equal(await ExpenseCategory.countDocuments({}), 2, 'the retired row is kept');
});

// ===========================================================================
// Filing
// ===========================================================================

test('an employee files a claim for themselves and it starts as a draft', async () => {
  const { staffUser, staff, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);

  assert.equal(claim.status, 'draft');
  assert.equal(claim.employeeId, String(staff._id));
  assert.equal(claim.total, '250.50');
  assert.equal(claim.currency, 'INR');
  assert.equal(claim.lineItems.length, 1);
  assert.equal(claim.lineItems[0].categoryName, 'Travel');
  assert.deepEqual(claim.approvalChain, [], 'no chain until it is submitted');
});

test('the claimant is taken from the SESSION, never from the payload', async () => {
  const { staffUser, manager, category } = await seedOrg();

  await withServer(appFor(staffUser), async (url) => {
    // `.strict()` refuses the unknown key outright rather than ignoring it.
    errorBody(
      await post(url, `${P}/claims`, { ...validClaim(category), employeeId: String(manager._id) }),
      400,
    );
    assert.equal(await ExpenseClaim.countDocuments({}), 0);
  });
});

test('a receipt key cannot be smuggled in on create', async () => {
  // The reference accepts `receiptKey` here and later resolves it against its
  // uploads directory, so `../../.env` reads whatever the process can.
  const { staffUser, category } = await seedOrg();

  await withServer(appFor(staffUser), async (url) => {
    const payload = validClaim(category);
    payload.lineItems[0].receiptKey = '../../.env';
    errorBody(await post(url, `${P}/claims`, payload), 400);
  });
});

test('money is exact — a float sum would not be', async () => {
  const { staffUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category, {
    lineItems: [
      { categoryId: String(category._id), date: '2026-01-05', amount: '0.10', description: 'a' },
      { categoryId: String(category._id), date: '2026-01-05', amount: '0.20', description: 'b' },
    ],
  });

  assert.equal(claim.total, '0.30');
  assert.notEqual(claim.total, String(0.1 + 0.2));
  assert.equal(sumMoney(['0.10', '0.20']), '0.30');
});

test('a JSON number is accepted only when it is exact money', async () => {
  // The shared `money()` validator takes a number OR a string, and this is why
  // that is safe: it stringifies and re-matches, so an imprecise float has too
  // many decimal places to pass. Nothing lossy reaches Decimal128 — the value
  // is either exact or refused.
  const { staffUser, category } = await seedOrg();
  const line = (amount) => ({
    ...validClaim(category),
    lineItems: [{ ...validClaim(category).lineItems[0], amount }],
  });

  await withServer(appFor(staffUser), async (url) => {
    // 0.1 + 0.2 computed in a browser arrives as 0.30000000000000004.
    errorBody(await post(url, `${P}/claims`, line(0.1 + 0.2)), 400);
    errorBody(await post(url, `${P}/claims`, line(250.555)), 400);

    const ok = envelope(await post(url, `${P}/claims`, line(250.5)), 201);
    assert.equal(ok.lineItems[0].amount, '250.50', 'normalised to two places');
    assert.equal(ok.total, '250.50');
  });
});

test('every money field in a response carries two decimal places', async () => {
  const { staffUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category, {
    lineItems: [
      { categoryId: String(category._id), date: '2026-01-05', amount: '250.5', description: 'a' },
      { categoryId: String(category._id), date: '2026-01-05', amount: '9', description: 'b' },
    ],
  });

  assert.equal(claim.lineItems[0].amount, '250.50');
  assert.equal(claim.lineItems[1].amount, '9.00');
  assert.equal(claim.total, '259.50');
});

test('the total is DERIVED — a client cannot state it', async () => {
  const { staffUser, category } = await seedOrg();
  await withServer(appFor(staffUser), async (url) => {
    errorBody(await post(url, `${P}/claims`, { ...validClaim(category), total: '999999.00' }), 400);
  });
});

test('an amount must be money, and a category must exist', async () => {
  const { staffUser, category } = await seedOrg();

  await withServer(appFor(staffUser), async (url) => {
    const bad = (over) => ({ ...validClaim(category), lineItems: [{ ...validClaim(category).lineItems[0], ...over }] });

    errorBody(await post(url, `${P}/claims`, bad({ amount: '-5.00' })), 400);
    errorBody(await post(url, `${P}/claims`, bad({ amount: '1.234' })), 400); // 3 dp
    errorBody(await post(url, `${P}/claims`, bad({ categoryId: String(oid()) })), 400);
    errorBody(await post(url, `${P}/claims`, { ...validClaim(category), lineItems: [] }), 400);
  });
});

test('an expense date must be real, and cannot be in the future', async () => {
  const { staffUser, category } = await seedOrg();
  // +2 days, not +1: the bound carries one day of timezone tolerance on
  // purpose, because the claim drawer dates each line to the VIEWER's today,
  // which is already tomorrow in UTC for part of every day. +1 is inside that
  // envelope and must be accepted; +2 is future everywhere. See
  // `isNotFutureDay` — the bound that made claims unfileable overnight.
  const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

  await withServer(appFor(staffUser), async (url) => {
    const withDate = (date) => ({
      ...validClaim(category),
      lineItems: [{ ...validClaim(category).lineItems[0], date }],
    });

    errorBody(await post(url, `${P}/claims`, withDate('2026-02-31')), 400);
    errorBody(await post(url, `${P}/claims`, withDate(future)), 400);
    envelope(await post(url, `${P}/claims`, withDate('2026-01-05')), 201);
  });
});

test('an inactive category cannot be used on a new claim', async () => {
  const { staffUser, category } = await seedOrg();
  await ExpenseCategory.updateOne({ _id: category._id }, { $set: { active: false } });

  await withServer(appFor(staffUser), async (url) => {
    const res = await post(url, `${P}/claims`, validClaim(category));
    errorBody(res, 400);
    assert.match(res.body.message, /no longer available/i);
  });
});

test('an account with no employee record cannot file, and a deleted one cannot either', async () => {
  const { staffUser, staff, category } = await seedOrg();

  await withServer(appFor(userWith([R.EMPLOYEE])), async (url) => {
    errorBody(await post(url, `${P}/claims`, validClaim(category)), 403);
  });

  await Employee.updateOne({ _id: staff._id }, { $set: { deletedAt: new Date() } });
  await withServer(appFor(staffUser), async (url) => {
    errorBody(await post(url, `${P}/claims`, validClaim(category)), 403);
  });
});

// ===========================================================================
// Editing a draft
// ===========================================================================

test('the owner edits their own draft, and the total follows', async () => {
  const { staffUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);

  await withServer(appFor(staffUser), async (url) => {
    const updated = envelope(
      await patch(url, `${P}/claims/${claim.id}`, {
        title: 'Client visit (revised)',
        lineItems: [
          { categoryId: String(category._id), date: '2026-01-05', amount: '100.00', description: 'Taxi' },
          { categoryId: String(category._id), date: '2026-01-06', amount: '75.25', description: 'Lunch' },
        ],
      }),
    );
    assert.equal(updated.title, 'Client visit (revised)');
    assert.equal(updated.total, '175.25');
    assert.equal(updated.lineItems.length, 2);
  });
});

test('nobody else can edit it, and it cannot be edited once submitted', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    errorBody(await patch(url, `${P}/claims/${claim.id}`, { title: 'Theirs' }), 403);
  });

  await withServer(appFor(staffUser), async (url) => {
    envelope(await post(url, `${P}/claims/${claim.id}/submit`));
    errorBody(
      await patch(url, `${P}/claims/${claim.id}`, { title: 'Too late' }),
      409,
      'EXPENSE_CLAIM_NOT_DRAFT',
    );
  });
});

// ===========================================================================
// Submitting
// ===========================================================================

test('submitting builds the two-level chain: manager then finance', async () => {
  const { staffUser, manager, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  assert.equal(claim.status, 'submitted');
  assert.ok(claim.submittedAt);
  assert.equal(claim.approvalChain.length, 2);

  assert.deepEqual(
    claim.approvalChain.map((s) => [s.level, s.role, s.decision]),
    [[1, 'manager', 'pending'], [2, 'finance', 'pending']],
  );
  assert.equal(claim.approvalChain[0].approverEmployeeId, String(manager._id));
});

test('an employee with no manager has the manager level auto-skipped', async () => {
  const bossUser = userWith([R.EMPLOYEE]);
  await makeEmployee({ firstName: 'Boss', userId: bossUser._id });
  const category = await makeCategory();

  const claim = await submittedClaim(bossUser, category);

  assert.equal(claim.status, 'submitted', 'still needs finance');
  assert.equal(claim.approvalChain[0].decision, 'approved');
  assert.equal(claim.approvalChain[0].approverEmployeeId, null);
  assert.equal(claim.approvalChain[1].decision, 'pending');
});

test('only the owner can submit, and only once', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    errorBody(await post(url, `${P}/claims/${claim.id}/submit`), 403);
  });

  await withServer(appFor(staffUser), async (url) => {
    envelope(await post(url, `${P}/claims/${claim.id}/submit`));
    errorBody(await post(url, `${P}/claims/${claim.id}/submit`), 409, 'EXPENSE_CLAIM_NOT_DRAFT');
  });
});

// ===========================================================================
// Deciding — the security core
// ===========================================================================

test('the manager approves, then finance, and the claim is fully approved', async () => {
  const { staffUser, managerUser, financeUser, manager, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    const decided = envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }));
    assert.equal(decided.status, 'manager_approved');
    assert.equal(decided.approvalChain[0].decision, 'approved');
    assert.equal(decided.approvalChain[0].approverEmployeeId, String(manager._id));
    assert.equal(decided.approvalChain[1].decision, 'pending');
  });

  await withServer(appFor(financeUser), async (url) => {
    const decided = envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }));
    assert.equal(decided.status, 'finance_approved');
    assert.equal(decided.approvalChain[1].decision, 'approved');
  });
});

test('NOBODY approves their own claim, however senior', async () => {
  // The reference authorises the finance step on org scope alone, so a finance
  // user can approve their own reimbursement — the single control an expense
  // system exists to provide.
  const financeUser = userWith([R.PAYROLL_ADMIN]);
  await makeEmployee({ firstName: 'Fin', userId: financeUser._id });
  const category = await makeCategory();

  const claim = await submittedClaim(financeUser, category);

  await withServer(appFor(financeUser), async (url) => {
    const res = await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' });
    errorBody(res, 403);
    assert.match(res.body.message, /your own/i);
  });

  assert.equal((await ExpenseClaim.findById(claim.id).lean()).status, 'submitted', 'untouched');
});

test('an unrelated manager cannot decide someone else’s report', async () => {
  const { staffUser, category } = await seedOrg();
  const otherUser = userWith([R.MANAGER]);
  await makeEmployee({ firstName: 'Other', userId: otherUser._id });

  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(otherUser), async (url) => {
    const res = await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' });
    errorBody(res, 403);
    assert.match(res.body.message, /assigned reporting manager/i);
  });
});

test('a manager cannot decide the FINANCE step', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }));
    // Now at the finance level; team scope is not enough.
    const res = await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' });
    errorBody(res, 403);
    assert.match(res.body.message, /finance/i);
  });
});

test('an ordinary employee cannot reach the decide endpoint at all', async () => {
  const { staffUser, category } = await seedOrg();
  const peerUser = userWith([R.EMPLOYEE]);
  await makeEmployee({ firstName: 'Peer', userId: peerUser._id });

  const claim = await submittedClaim(staffUser, category);
  await withServer(appFor(peerUser), async (url) => {
    // Refused by the route guard, before the service is reached.
    assert.equal((await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' })).status, 403);
  });
});

test('finance may override the manager level directly', async () => {
  const { staffUser, financeUser, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(financeUser), async (url) => {
    const decided = envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }));
    assert.equal(decided.status, 'manager_approved', 'the manager level was the pending one');
  });
});

test('one rejection ends it, at either level', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    const decided = envelope(
      await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'reject', comment: 'No receipt' }),
    );
    assert.equal(decided.status, 'rejected');
    assert.equal(decided.approvalChain[0].comment, 'No receipt');

    errorBody(
      await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }),
      409,
      'EXPENSE_CLAIM_NOT_PENDING',
    );
  });
});

test('a draft cannot be decided', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    errorBody(
      await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }),
      409,
      'EXPENSE_CLAIM_NOT_PENDING',
    );
  });
});

test('an unknown decision value is refused', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    errorBody(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'maybe' }), 400);
    errorBody(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve', extra: 1 }), 400);
  });
});

// ===========================================================================
// Reimbursement
// ===========================================================================

test('only a finance-approved claim can be marked reimbursed', async () => {
  const { staffUser, managerUser, financeUser, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(financeUser), async (url) => {
    errorBody(
      await post(url, `${P}/claims/${claim.id}/reimburse`),
      409,
      'EXPENSE_CLAIM_NOT_APPROVED',
    );
  });

  await withServer(appFor(managerUser), async (url) => {
    envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }));
  });
  await withServer(appFor(financeUser), async (url) => {
    envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }));
    const paid = envelope(await post(url, `${P}/claims/${claim.id}/reimburse`));
    assert.equal(paid.status, 'reimbursed');
    assert.ok(paid.reimbursedAt);
  });
});

test('reimbursing needs org scope, and never one own claim', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    assert.equal((await post(url, `${P}/claims/${claim.id}/reimburse`)).status, 403);
  });
  await withServer(appFor(staffUser), async (url) => {
    assert.equal((await post(url, `${P}/claims/${claim.id}/reimburse`)).status, 403);
  });
});

// ===========================================================================
// Scope
// ===========================================================================

test('an employee sees only their own claims', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  await fileClaim(staffUser, category);
  await fileClaim(managerUser, category, { title: 'Theirs' });

  await withServer(appFor(staffUser), async (url) => {
    const page = envelope(await get(url, `${P}/claims`));
    assert.equal(page.total, 1);
    assert.equal(page.data[0].title, 'Client visit');
  });
});

test('a manager sees their own and everyone beneath them', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  await fileClaim(staffUser, category);
  await fileClaim(managerUser, category, { title: 'Mine' });

  const strangerUser = userWith([R.EMPLOYEE]);
  await makeEmployee({ firstName: 'Stranger', userId: strangerUser._id });
  await fileClaim(strangerUser, category, { title: 'Unrelated' });

  await withServer(appFor(managerUser), async (url) => {
    const titles = envelope(await get(url, `${P}/claims`)).data.map((c) => c.title).sort();
    assert.deepEqual(titles, ['Client visit', 'Mine']);
  });
});

test('an org-wide reader sees everything, and paging is honest', async () => {
  const { staffUser, category } = await seedOrg();
  for (let i = 0; i < 3; i += 1) await fileClaim(staffUser, category, { title: `Claim ${i}` });

  await withServer(appFor(userWith([R.HR_ADMIN])), async (url) => {
    const page = envelope(await get(url, `${P}/claims?page=1&pageSize=2`));
    assert.equal(page.total, 3, 'the count is of everything that matches');
    assert.equal(page.data.length, 2);
    assert.equal(page.pageSize, 2);
  });
});

test('reading one claim is refused to a stranger', async () => {
  const { staffUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);

  const strangerUser = userWith([R.EMPLOYEE]);
  await makeEmployee({ firstName: 'Stranger', userId: strangerUser._id });

  await withServer(appFor(strangerUser), async (url) => {
    errorBody(await get(url, `${P}/claims/${claim.id}`), 403);
  });
});

test('narrowing by employeeId cannot widen the scope', async () => {
  const { staffUser, managerUser, manager, category } = await seedOrg();
  await fileClaim(managerUser, category, { title: 'Mine' });

  await withServer(appFor(staffUser), async (url) => {
    errorBody(await get(url, `${P}/claims?employeeId=${manager._id}`), 403);
  });
});

test('AD-4: a Customer reaches no expense endpoint', async () => {
  const customer = { _id: oid(), role: 'Customer', roles: [], status: 'Active' };
  await withServer(appFor(customer), async (url) => {
    for (const path of [`${P}/claims`, `${P}/categories`]) {
      assert.equal((await get(url, path)).status, 403, path);
    }
  });
});

// ===========================================================================
// Receipts
// ===========================================================================

test('a receipt is sniffed by its MAGIC BYTES, not its Content-Type', () => {
  assert.equal(sniffReceipt(PDF).type, 'application/pdf');
  assert.equal(sniffReceipt(PNG).type, 'image/png');

  // An executable renamed to .pdf and declared as application/pdf.
  assert.throws(() => sniffReceipt(Buffer.from('MZ\x90\x00executable')), /does not match/i);
  assert.throws(() => sniffReceipt(Buffer.alloc(0)), /empty/i);
  assert.throws(() => sniffReceipt(Buffer.from('<html>hi</html>')), /does not match/i);
});

test('the owner attaches a receipt and it is stored, not echoed', async () => {
  const { staffUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);
  const lineId = claim.lineItems[0].id;

  await withServer(appFor(staffUser), async (url) => {
    const form = new FormData();
    form.append('receipt', new Blob([PDF], { type: 'application/pdf' }), 'bill.pdf');
    const res = await fetch(`${url}${P}/claims/${claim.id}/lines/${lineId}/receipt`, {
      method: 'POST',
      body: form,
    });
    const body = await res.json();

    assert.equal(res.status, 201, JSON.stringify(body));
    const line = body.data.lineItems[0];
    assert.equal(line.hasReceipt, true);
    assert.equal(line.receiptContentType, 'application/pdf');
    // The storage KEY never reaches the browser.
    assert.equal('receiptKey' in line, false);
    assert.doesNotMatch(JSON.stringify(body), /expense-receipt\//);
  });
});

test('a file whose bytes are not a receipt is refused', async () => {
  const { staffUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);
  const lineId = claim.lineItems[0].id;

  await withServer(appFor(staffUser), async (url) => {
    const form = new FormData();
    // Declared as a PDF, actually an executable.
    form.append('receipt', new Blob([Buffer.from('MZ\x90\x00')], { type: 'application/pdf' }), 'x.pdf');
    const res = await fetch(`${url}${P}/claims/${claim.id}/lines/${lineId}/receipt`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 400);
  });
});

test('only the owner attaches receipts, and not once the claim is decided', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);
  const lineId = claim.lineItems[0].id;

  const upload = async (user) =>
    withServer(appFor(user), async (url) => {
      const form = new FormData();
      form.append('receipt', new Blob([PDF], { type: 'application/pdf' }), 'bill.pdf');
      return (
        await fetch(`${url}${P}/claims/${claim.id}/lines/${lineId}/receipt`, {
          method: 'POST',
          body: form,
        })
      ).status;
    });

  assert.equal(await upload(managerUser), 403, 'not their claim');

  await withServer(appFor(managerUser), async (url) => {
    envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'reject' }));
  });
  assert.equal(await upload(staffUser), 409, 'a rejected claim is locked');
});

test('a receipt read returns a short-lived URL, and is refused to a stranger', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);
  const lineId = claim.lineItems[0].id;

  await withServer(appFor(staffUser), async (url) => {
    const form = new FormData();
    form.append('receipt', new Blob([PDF], { type: 'application/pdf' }), 'bill.pdf');
    await fetch(`${url}${P}/claims/${claim.id}/lines/${lineId}/receipt`, { method: 'POST', body: form });

    const data = envelope(await get(url, `${P}/claims/${claim.id}/lines/${lineId}/receipt`));
    assert.ok(typeof data.url === 'string' && data.url.length > 0);
    assert.ok(data.expiresInSeconds > 0, 'it expires');
  });

  // The manager is above the claimant, so they may read it.
  await withServer(appFor(managerUser), async (url) => {
    envelope(await get(url, `${P}/claims/${claim.id}/lines/${lineId}/receipt`));
  });

  const strangerUser = userWith([R.EMPLOYEE]);
  await makeEmployee({ firstName: 'Stranger', userId: strangerUser._id });
  await withServer(appFor(strangerUser), async (url) => {
    errorBody(await get(url, `${P}/claims/${claim.id}/lines/${lineId}/receipt`), 403);
  });
});

test('reading a receipt that does not exist is a 404, not a 403', async () => {
  const { staffUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);

  await withServer(appFor(staffUser), async (url) => {
    errorBody(await get(url, `${P}/claims/${claim.id}/lines/${claim.lineItems[0].id}/receipt`), 404);
    errorBody(await get(url, `${P}/claims/${claim.id}/lines/${oid()}/receipt`), 404);
  });
});

// ===========================================================================
// Audit
// ===========================================================================

test('creating, submitting, deciding and reimbursing are each audited', async () => {
  const { staffUser, managerUser, financeUser, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }));
  });
  await withServer(appFor(financeUser), async (url) => {
    envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }));
    envelope(await post(url, `${P}/claims/${claim.id}/reimburse`));
  });

  const actions = (await AuditLog.find({}).lean()).map((a) => a.action);
  for (const wanted of [
    AUDIT_ACTIONS.EXPENSE_CLAIM_CREATED,
    AUDIT_ACTIONS.EXPENSE_CLAIM_SUBMITTED,
    AUDIT_ACTIONS.EXPENSE_CLAIM_DECIDED,
    AUDIT_ACTIONS.EXPENSE_CLAIM_REIMBURSED,
  ]) {
    assert.ok(actions.includes(wanted), wanted);
  }
});

test('a refused decision writes no audit entry', async () => {
  const { staffUser, category } = await seedOrg();
  const otherUser = userWith([R.MANAGER]);
  await makeEmployee({ firstName: 'Other', userId: otherUser._id });
  const claim = await submittedClaim(staffUser, category);

  await AuditLog.deleteMany({});
  await withServer(appFor(otherUser), async (url) => {
    errorBody(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }), 403);
  });
  assert.equal(await AuditLog.countDocuments({}), 0, 'nothing happened, so nothing is recorded');
});

test('no receipt bytes or filename reach the audit trail', async () => {
  const { staffUser, category } = await seedOrg();
  const claim = await fileClaim(staffUser, category);
  const lineId = claim.lineItems[0].id;

  await withServer(appFor(staffUser), async (url) => {
    const form = new FormData();
    form.append('receipt', new Blob([PDF], { type: 'application/pdf' }), 'my-private-bill.pdf');
    await fetch(`${url}${P}/claims/${claim.id}/lines/${lineId}/receipt`, { method: 'POST', body: form });
  });

  const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.EXPENSE_RECEIPT_UPLOADED }).lean();
  assert.ok(entry, 'the upload is recorded');
  const serialised = JSON.stringify(entry);
  assert.doesNotMatch(serialised, /my-private-bill/, 'the filename is not recorded');
  assert.doesNotMatch(serialised, /%PDF/, 'nor are the bytes');
});

// ===========================================================================
// Envelope
// ===========================================================================

test('every expense response uses the standard envelope', async () => {
  const { staffUser, managerUser, category } = await seedOrg();
  const claim = await submittedClaim(staffUser, category);

  await withServer(appFor(managerUser), async (url) => {
    envelope(await get(url, `${P}/categories`));
    envelope(await get(url, `${P}/categories/${category._id}`));
    envelope(await get(url, `${P}/claims`));
    envelope(await get(url, `${P}/claims/${claim.id}`));
    envelope(await post(url, `${P}/claims/${claim.id}/decide`, { decision: 'approve' }));
  });
});

test('the claim list returns the whole page object under `data`', async () => {
  const { staffUser, category } = await seedOrg();
  await fileClaim(staffUser, category);

  await withServer(appFor(staffUser), async (url) => {
    const page = envelope(await get(url, `${P}/claims`));
    for (const key of ['data', 'total', 'page', 'pageSize']) {
      assert.ok(key in page, `the page object must carry ${key}`);
    }
    assert.ok(Array.isArray(page.data));
  });
});
