/**
 * Expense claims — the draft → submit → manager → finance → reimbursed flow.
 *
 * Ported from the reference's `ExpenseClaimService`. Its six statuses are kept
 * exactly, and its two-level approval chain (direct manager, then finance) is
 * reproduced including the auto-skip when an employee has no manager.
 *
 * ---------------------------------------------------------------------------
 * Corrections to the reference, each deliberate
 * ---------------------------------------------------------------------------
 * 1. SELF-APPROVAL IS REFUSED. The reference authorises the manager step with
 *    `hasPermission(actor,'expenses','approve','org')` and the finance step
 *    with org scope alone — so anyone holding org approval can approve their
 *    OWN claim, and finance approving their own reimbursement is exactly the
 *    control an expense system exists to provide.
 *
 * 2. RECEIPT KEYS ARE NEVER ACCEPTED FROM A CLIENT. The reference takes
 *    `receiptKey` on create and later does
 *    `path.resolve(uploadsRoot, receiptKey)` to read the file, so a claim
 *    created with `../../.env` reads whatever the process can. Here a key is
 *    minted by the storage layer during upload and never parsed from input.
 *
 * 3. MONEY IS EXACT. The reference sums line amounts with `+` over JavaScript
 *    numbers; the model recomputes the total in integer paise (AD-2).
 *
 * 4. A DRAFT IS EDITABLE. The reference has no update endpoint at all, so a
 *    typo in a draft can only be fixed by abandoning it. Editing is confined
 *    to `draft` and to the owner.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import ExpenseClaim from '../../../models/hrms/ExpenseClaim.js';
import ExpensePolicy from '../../../models/hrms/ExpensePolicy.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS, STORAGE_CATEGORIES } from '../../../shared/constants/hrms.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
  createClaimSchema,
  updateClaimSchema,
  claimDecisionSchema,
} from '../../../shared/schemas/expense.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsValidationError,
} from '../hrms.errors.js';
import { putObject } from '../../../utils/hrms/storage/index.js';
import { categoriesByIds } from './category.service.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
/**
 * Money, out to the wire.
 *
 * Always two decimal places. Decimal128 keeps the scale it was given, so an
 * amount entered as `250.5` stringifies to "250.5" while a derived total
 * stringifies to "250.50" — the same money, rendered two ways in one response.
 * Padding here rather than in the browser keeps every consumer consistent.
 */
const dec = (v) => {
  if (v === null || v === undefined) return null;
  const [whole, fraction = ''] = String(v).split('.');
  return `${whole}.${`${fraction}00`.slice(0, 2)}`;
};

function parse(schema, input, what) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new HrmsValidationError(`Invalid ${what}.`, formatZodIssues(result.error));
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

const lineToDto = (line, categoryById) => ({
  id: idStr(line._id),
  categoryId: idStr(line.categoryId),
  categoryName: categoryById?.get(idStr(line.categoryId))?.name ?? null,
  categoryCode: categoryById?.get(idStr(line.categoryId))?.code ?? null,
  date: line.date,
  amount: dec(line.amount),
  description: line.description,
  /**
   * Presence only. The KEY is never sent to a browser: it would let a client
   * ask the file endpoint for an object by naming it, and the read is meant to
   * go through the line item so ownership can be checked.
   */
  hasReceipt: Boolean(line.receiptKey),
  receiptContentType: line.receiptContentType ?? null,
});

const claimToDto = (row, { employee, categoryById, actor } = {}) => ({
  id: idStr(row._id),
  employeeId: idStr(row.employeeId),
  /**
   * Whether this claim belongs to the person reading it.
   *
   * The approver's queue needs it to stop offering an Approve button that the
   * server would refuse anyway — nobody decides their own claim. Computed here
   * rather than compared in the browser, because the browser would have to be
   * told the viewer's employee id to do it, and that is a fact it does not
   * otherwise need.
   */
  isOwnClaim: Boolean(actor?.employeeId) && idStr(row.employeeId) === idStr(actor.employeeId),
  employeeName: employee
    ? `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim()
    : null,
  employeeCode: employee?.employeeCode ?? null,
  title: row.title,
  status: row.status,
  total: dec(row.total),
  currency: row.currency,
  submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : null,
  reimbursedAt: row.reimbursedAt ? new Date(row.reimbursedAt).toISOString() : null,
  lineItems: (row.lineItems ?? []).map((line) => lineToDto(line, categoryById)),
  approvalChain: (row.approvalChain ?? []).map((step) => ({
    level: step.level,
    role: step.role,
    approverEmployeeId: idStr(step.approverEmployeeId),
    approverName: step.approverName,
    decision: step.decision,
    decidedAt: step.decidedAt ? new Date(step.decidedAt).toISOString() : null,
    comment: step.comment ?? null,
  })),
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/** Batch-resolve the employee and category names a page of claims needs. */
async function hydrate(rows, actor) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return [];

  const categoryIds = list.flatMap((r) => (r.lineItems ?? []).map((l) => idStr(l.categoryId)));

  const [employees, categoryById] = await Promise.all([
    Employee.find({ _id: { $in: list.map((r) => r.employeeId) } })
      .select('firstName lastName employeeCode')
      .lean(),
    categoriesByIds([...new Set(categoryIds)]),
  ]);

  const employeeById = new Map(employees.map((e) => [idStr(e._id), e]));

  return list.map((row) =>
    claimToDto(row, { employee: employeeById.get(idStr(row.employeeId)), categoryById, actor }),
  );
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * What this actor may see.
 *
 * Team scope follows the reference and uses the whole `managerChain`, so a
 * skip-level manager can SEE a claim below them. Whether they may DECIDE it is
 * a separate question, answered in `decideClaim`.
 */
function buildScopeFilter(actor) {
  if (hasHrmsPermission(actor, M.EXPENSES, A.VIEW, S.ORG)) return {};

  if (!actor?.employeeId) {
    // Permitted in principle but not linked to an employee record, so there is
    // nothing of their own. An impossible filter beats returning everything.
    return { _id: null };
  }

  if (hasHrmsPermission(actor, M.EXPENSES, A.VIEW, S.TEAM)) {
    return { $or: [{ employeeId: actor.employeeId }, { 'owner.managerChain': actor.employeeId }] };
  }

  if (hasHrmsPermission(actor, M.EXPENSES, A.VIEW, S.SELF)) {
    return { employeeId: actor.employeeId };
  }

  throw new HrmsForbiddenError('You cannot view expense claims.');
}

/**
 * The claim's owner, as a ResourceContext the permission evaluator understands.
 * Read from the Employee rather than from anything the client sent.
 */
async function ownerContextFor(employeeId) {
  const employee = await Employee.findById(employeeId)
    .select('_id userId departmentId managerChain reportingManagerId deletedAt')
    .lean();
  if (!employee) return null;

  return {
    employee,
    owner: {
      ownerUserId: idStr(employee.userId) ?? undefined,
      ownerEmployeeId: idStr(employee._id),
      ownerDepartmentId: idStr(employee.departmentId) ?? undefined,
      ownerManagerChain: (employee.managerChain ?? []).map(idStr),
    },
  };
}

/** May this actor read this claim? Used by the detail read and by receipts. */
export async function assertCanViewClaim(actor, claim) {
  const resolved = await ownerContextFor(claim.employeeId);
  if (!resolved) throw new HrmsNotFoundError('Employee');

  const allowed =
    hasHrmsPermission(actor, M.EXPENSES, A.VIEW, S.ORG) ||
    hasHrmsPermission(actor, M.EXPENSES, A.VIEW, S.TEAM, resolved.owner) ||
    hasHrmsPermission(actor, M.EXPENSES, A.VIEW, S.SELF, resolved.owner);

  if (!allowed) throw new HrmsForbiddenError('You cannot view this expense claim.');
  return resolved;
}

/** The actor's own live employee record, or a refusal. */
async function requireActorEmployee(actor) {
  if (!actor?.employeeId) {
    throw new HrmsForbiddenError('This account has no employee record, so it cannot file expenses.');
  }
  const employee = await Employee.findOne({ _id: actor.employeeId, deletedAt: null })
    .select('_id reportingManagerId')
    .lean();
  if (!employee) throw new HrmsForbiddenError('This employee record is no longer active.');
  return employee;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * A page of claims the actor may see.
 *
 * Team scope needs the claimant's managerChain, which lives on Employee, so it
 * is resolved to a set of employee ids first — one extra indexed query rather
 * than a `$lookup` on every page.
 */
export async function listClaims(actor, query = {}) {
  const { status, employeeId, page = 1, pageSize = 25 } = query;

  let filter;
  if (hasHrmsPermission(actor, M.EXPENSES, A.VIEW, S.ORG)) {
    filter = {};
  } else if (!actor?.employeeId) {
    filter = { _id: null };
  } else if (hasHrmsPermission(actor, M.EXPENSES, A.VIEW, S.TEAM)) {
    const reports = await Employee.find({ managerChain: actor.employeeId, deletedAt: null })
      .select('_id')
      .lean();
    filter = { employeeId: { $in: [actor.employeeId, ...reports.map((r) => r._id)] } };
  } else if (hasHrmsPermission(actor, M.EXPENSES, A.VIEW, S.SELF)) {
    filter = { employeeId: actor.employeeId };
  } else {
    throw new HrmsForbiddenError('You cannot view expense claims.');
  }

  filter.deletedAt = null;
  if (status) filter.status = status;
  if (employeeId) {
    // Narrowing to one person is only allowed within what the scope already
    // permits, so this intersects rather than replaces.
    const permitted = filter.employeeId;
    if (permitted && !matchesEmployeeFilter(permitted, employeeId)) {
      throw new HrmsForbiddenError("You cannot view this employee's expense claims.");
    }
    filter.employeeId = new mongoose.Types.ObjectId(String(employeeId));
  }

  const [rows, total] = await Promise.all([
    ExpenseClaim.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    ExpenseClaim.countDocuments(filter),
  ]);

  return { data: await hydrate(rows, actor), total, page, pageSize };
}

const matchesEmployeeFilter = (permitted, employeeId) => {
  const wanted = String(employeeId);
  if (permitted?.$in) return permitted.$in.some((id) => String(id) === wanted);
  return String(permitted) === wanted;
};

export async function getClaim(id, actor) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Expense claim');

  const row = await ExpenseClaim.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Expense claim');

  await assertCanViewClaim(actor, row);
  const [dto] = await hydrate([row], actor);
  return dto;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Every line must name a live category; the ids are checked in one query. */
async function assertCategoriesResolve(lineItems) {
  const wanted = [...new Set(lineItems.map((line) => String(line.categoryId)))];
  const found = await categoriesByIds(wanted);

  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new HrmsValidationError(
      `${missing.length} expense category id(s) do not exist.`,
      missing.map((id) => ({ path: 'lineItems.categoryId', message: `${id} is not a category` })),
    );
  }

  const inactive = wanted.filter((id) => found.get(id)?.active === false);
  if (inactive.length > 0) {
    throw new HrmsValidationError(
      'One or more categories are no longer available for new claims.',
      inactive.map((id) => ({
        path: 'lineItems.categoryId',
        message: `${found.get(id).name} is inactive`,
      })),
    );
  }

  return found;
}

const toLine = (line) => ({
  categoryId: new mongoose.Types.ObjectId(String(line.categoryId)),
  date: line.date,
  amount: mongoose.Types.Decimal128.fromString(String(line.amount)),
  description: line.description,
});

/** File a claim FOR THE ACTOR. It starts as a draft, as in the reference. */
export async function createClaim(input, actor, context = {}) {
  const dto = parse(createClaimSchema, input, 'expense claim');
  const employee = await requireActorEmployee(actor);

  await assertCategoriesResolve(dto.lineItems);

  const row = await ExpenseClaim.create({
    employeeId: employee._id,
    title: dto.title,
    status: 'draft',
    lineItems: dto.lineItems.map(toLine),
    approvalChain: [],
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_CLAIM_CREATED,
    `Created expense claim "${dto.title}" for ${String(row.total)}`,
    context.req,
    {
      meta: {
        claimId: idStr(row._id),
        employeeId: idStr(employee._id),
        total: String(row.total),
        lineCount: dto.lineItems.length,
      },
    },
  );

  const [claim] = await hydrate([row.toObject()], actor);
  return claim;
}

/** Edit a DRAFT. Anything further along is a record of a decision. */
export async function updateClaim(id, input, actor, context = {}) {
  const dto = parse(updateClaimSchema, input, 'expense claim');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Expense claim');

  const claim = await ExpenseClaim.findOne({ _id: id, deletedAt: null });
  if (!claim) throw new HrmsNotFoundError('Expense claim');

  if (idStr(claim.employeeId) !== idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('Only the person who filed this claim can edit it.');
  }
  if (claim.status !== 'draft') {
    throw new HrmsConflictError(`A ${claim.status} claim can no longer be edited.`, {
      code: 'EXPENSE_CLAIM_NOT_DRAFT',
      details: { status: claim.status },
    });
  }

  if (dto.title !== undefined) claim.title = dto.title;
  if (dto.lineItems !== undefined) {
    await assertCategoriesResolve(dto.lineItems);
    // Replacing the lines drops their receipts with them: a receipt belongs to
    // the line it evidences, and silently carrying it onto a different amount
    // would be worse than losing it.
    claim.lineItems = dto.lineItems.map(toLine);
  }

  await claim.save(); // the pre-validate hook recomputes `total`

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_CLAIM_UPDATED,
    `Updated draft expense claim ${id}`,
    context.req,
    { meta: { claimId: idStr(id), fields: Object.keys(dto) } },
  );

  const [result] = await hydrate([claim.toObject()], actor);
  return result;
}

/**
 * Submit a draft for approval.
 *
 * Builds the reference's two-level chain: the direct manager at level 1, or an
 * auto-approved placeholder when the employee has none, then finance at level
 * 2 with no named approver until someone decides it.
 */
export async function submitClaim(id, actor, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Expense claim');

  const claim = await ExpenseClaim.findOne({ _id: id, deletedAt: null });
  if (!claim) throw new HrmsNotFoundError('Expense claim');

  if (idStr(claim.employeeId) !== idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('Only the person who filed this claim can submit it.');
  }
  if (claim.status !== 'draft') {
    throw new HrmsConflictError(`This claim is already ${claim.status}.`, {
      code: 'EXPENSE_CLAIM_NOT_DRAFT',
      details: { status: claim.status },
    });
  }
  if ((claim.lineItems ?? []).length === 0) {
    throw new HrmsValidationError('A claim needs at least one line before it can be submitted.');
  }

  const employee = await Employee.findById(claim.employeeId)
    // The name is for the approver's notification below; the manager id is the
    // approval chain's own, so neither comes from the request.
    .select('reportingManagerId firstName lastName')
    .lean();
  const claimantName =
    `${employee?.firstName ?? ''} ${employee?.lastName ?? ''}`.trim() || 'A team member';
  const manager = employee?.reportingManagerId
    ? await Employee.findOne({ _id: employee.reportingManagerId, deletedAt: null })
        .select('firstName lastName')
        .lean()
    : null;

  const managerStep = manager
    ? {
        level: 1,
        role: 'manager',
        approverEmployeeId: manager._id,
        approverName: `${manager.firstName ?? ''} ${manager.lastName ?? ''}`.trim(),
        decision: 'pending',
        decidedAt: null,
        comment: null,
      }
    : {
        // No manager on file — the reference skips the level rather than
        // stranding the claim behind an approver who does not exist.
        level: 1,
        role: 'manager',
        approverEmployeeId: null,
        approverName: 'No manager on file',
        decision: 'approved',
        decidedAt: new Date(),
        comment: 'No reporting manager configured',
      };

  claim.approvalChain = [
    managerStep,
    {
      level: 2,
      role: 'finance',
      approverEmployeeId: null,
      approverName: 'Finance team',
      decision: 'pending',
      decidedAt: null,
      comment: null,
    },
  ];
  claim.status = 'submitted';
  claim.submittedAt = new Date();
  await claim.save();

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_CLAIM_SUBMITTED,
    `Submitted expense claim "${claim.title}" for ${String(claim.total)}`,
    context.req,
    {
      meta: {
        claimId: idStr(id),
        employeeId: idStr(claim.employeeId),
        total: String(claim.total),
        managerAutoSkipped: !manager,
      },
    },
  );

  /**
    * The reference's `expense.pending`, to the manager whose step is pending —
    * skipped when there is no manager and the step auto-approved, exactly as
    * the reference skips it.
    *
    * 🔴 NO AMOUNT. The reference puts the claim total in the notification
    * TITLE — "submitted an expense claim of ₹1,23,456.00" — which is then also
    * the subject line of an outbound email. The manager is entitled to the
    * figure; a notification is not the place to publish it.
    */
  if (managerStep.decision === 'pending' && managerStep.approverEmployeeId) {
    await notify({
      to: idStr(managerStep.approverEmployeeId),
      type: INBOX_TYPES.EXPENSE_PENDING,
      title: `${claimantName} submitted an expense claim`,
      body: 'Awaiting your approval.',
      entity: 'expense_claim',
      entityId: idStr(claim._id),
    });
  }

  const [result] = await hydrate([claim.toObject()], actor);
  return result;
}

/**
 * Approve or reject at whichever level is currently pending.
 *
 * The route guard admits any approver; this decides whether THIS actor may act
 * on THIS step:
 *
 *   manager step  the assigned approver with team scope, or org scope
 *   finance step  org scope only
 *
 * and, unlike the reference, nobody may decide their own claim at any level.
 */
export async function decideClaim(id, input, actor, context = {}) {
  const dto = parse(claimDecisionSchema, input, 'decision');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Expense claim');

  const claim = await ExpenseClaim.findOne({ _id: id, deletedAt: null });
  if (!claim) throw new HrmsNotFoundError('Expense claim');

  if (claim.status !== 'submitted' && claim.status !== 'manager_approved') {
    throw new HrmsConflictError(`A ${claim.status} claim cannot be decided.`, {
      code: 'EXPENSE_CLAIM_NOT_PENDING',
      details: { status: claim.status },
    });
  }

  // The control an expense system exists to provide. The reference authorises
  // the finance step on org scope alone, so a finance user can approve their
  // own reimbursement.
  if (idStr(claim.employeeId) === idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('You cannot approve your own expense claim.');
  }

  const chain = claim.approvalChain ?? [];
  const stepIndex = chain.findIndex((step) => step.decision === 'pending');
  if (stepIndex === -1) {
    throw new HrmsConflictError('This claim has no step awaiting a decision.', {
      code: 'EXPENSE_CLAIM_NO_PENDING_STEP',
    });
  }
  const step = chain[stepIndex];

  const canOrg = hasHrmsPermission(actor, M.EXPENSES, A.APPROVE, S.ORG);
  const canDecide =
    step.role === 'finance'
      ? canOrg
      : canOrg ||
        (idStr(step.approverEmployeeId) === idStr(actor?.employeeId) &&
          hasHrmsPermission(actor, M.EXPENSES, A.APPROVE, S.TEAM));

  if (!canDecide) {
    throw new HrmsForbiddenError(
      step.role === 'finance'
        ? 'Only finance can decide this claim at this stage.'
        : 'Only the assigned reporting manager, or finance, can decide this claim.',
    );
  }

  const approving = dto.decision === 'approve';
  step.decision = approving ? 'approved' : 'rejected';
  step.decidedAt = new Date();
  step.comment = dto.comment ?? null;
  // Finance has no named approver until someone acts; record who did.
  if (!step.approverEmployeeId && actor?.employeeId) {
    step.approverEmployeeId = actor.employeeId;
    step.approverName = step.approverName === 'Finance team' ? 'Finance' : step.approverName;
  }

  // One rejection ends it. Otherwise the status follows the level just cleared.
  claim.status = !approving
    ? 'rejected'
    : chain.every((s) => s.decision === 'approved')
      ? 'finance_approved'
      : 'manager_approved';

  claim.approvalChain = chain;
  await claim.save();

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_CLAIM_DECIDED,
    `${approving ? 'Approved' : 'Rejected'} expense claim ${id} at the ${step.role} level`,
    context.req,
    {
      meta: {
        claimId: idStr(id),
        employeeId: idStr(claim.employeeId),
        level: step.role,
        decision: dto.decision,
        status: claim.status,
        total: String(claim.total),
      },
    },
  );

  /**
    * The reference's `expense.decided`, to the claimant — and only once the
    * claim is settled. A claim that has merely cleared the manager is still
    * moving, which is the reference's rule too (it notifies on
    * `finance_approved` or `rejected`, not on `manager_approved`).
    */
  if (claim.status === 'finance_approved' || claim.status === 'rejected') {
    await notify({
      to: idStr(claim.employeeId),
      type: INBOX_TYPES.EXPENSE_DECIDED,
      title: `Your expense claim was ${claim.status === 'rejected' ? 'rejected' : 'approved'}`,
      body: null,
      entity: 'expense_claim',
      entityId: idStr(claim._id),
    });
  }

  const [result] = await hydrate([claim.toObject()], actor);
  return result;
}

/**
 * Mark a fully-approved claim as paid.
 *
 * The reference reaches this state through a reimbursement batch bound to a
 * payroll run. That linkage is not built here — see the module README — so this
 * is the direct equivalent: finance records that a `finance_approved` claim has
 * been paid. No payment is initiated and no bank detail is touched.
 */
export async function reimburseClaim(id, actor, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Expense claim');

  const claim = await ExpenseClaim.findOne({ _id: id, deletedAt: null });
  if (!claim) throw new HrmsNotFoundError('Expense claim');

  if (claim.status !== 'finance_approved') {
    throw new HrmsConflictError(
      `Only a finance-approved claim can be marked reimbursed; this one is ${claim.status}.`,
      { code: 'EXPENSE_CLAIM_NOT_APPROVED', details: { status: claim.status } },
    );
  }
  if (idStr(claim.employeeId) === idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('You cannot mark your own claim as reimbursed.');
  }

  claim.status = 'reimbursed';
  claim.reimbursedAt = new Date();
  await claim.save();

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_CLAIM_REIMBURSED,
    `Marked expense claim ${id} reimbursed for ${String(claim.total)}`,
    context.req,
    {
      meta: {
        claimId: idStr(id),
        employeeId: idStr(claim.employeeId),
        total: String(claim.total),
      },
    },
  );

  const [result] = await hydrate([claim.toObject()], actor);
  return result;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * What a receipt may be.
 *
 * Checked by MAGIC BYTES, not by the Content-Type header, which is whatever the
 * client chose to send. The reference validates neither: it takes the uploaded
 * bytes and the client's filename, and writes them to disk with the client's
 * extension.
 */
const RECEIPT_SIGNATURES = [
  { type: 'application/pdf', ext: 'pdf', match: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { type: 'image/jpeg', ext: 'jpg', match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    ext: 'png',
    match: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: 'image/webp',
    ext: 'webp',
    match: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** @returns {{type: string, ext: string}} @throws {HrmsValidationError} */
export function sniffReceipt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HrmsValidationError('The receipt file is empty.');
  }
  const found = RECEIPT_SIGNATURES.find((sig) => sig.match(buffer));
  if (!found) {
    throw new HrmsValidationError(
      'A receipt must be a PDF, JPEG, PNG or WebP. The file content does not match any of those.',
      [{ path: 'file', message: 'unrecognised file signature' }],
    );
  }
  return found;
}

/**
 * Attach a receipt to one line of one's own claim.
 *
 * The storage key is minted by the storage layer from a UUID; nothing about it
 * comes from the upload's filename.
 */
export async function uploadReceipt(claimId, lineItemId, file, actor, context = {}) {
  if (!mongoose.isValidObjectId(claimId) || !mongoose.isValidObjectId(lineItemId)) {
    throw new HrmsNotFoundError('Expense claim line');
  }

  const claim = await ExpenseClaim.findOne({ _id: claimId, deletedAt: null });
  if (!claim) throw new HrmsNotFoundError('Expense claim');

  if (idStr(claim.employeeId) !== idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('Only the person who filed this claim can attach receipts.');
  }
  if (claim.status !== 'draft' && claim.status !== 'submitted') {
    throw new HrmsConflictError(
      `Receipts can only be attached while a claim is a draft or awaiting a decision; this one is ${claim.status}.`,
      { code: 'EXPENSE_CLAIM_LOCKED', details: { status: claim.status } },
    );
  }

  const line = claim.lineItems.id(lineItemId);
  if (!line) throw new HrmsNotFoundError('Expense claim line');

  const signature = sniffReceipt(file?.buffer);

  const { key } = await putObject({
    category: STORAGE_CATEGORIES.EXPENSE_RECEIPT,
    body: file.buffer,
    contentType: signature.type,
    scope: idStr(claim.employeeId),
    filename: `receipt.${signature.ext}`,
    size: file.buffer.length,
  });

  line.receiptKey = key;
  line.receiptContentType = signature.type;
  line.receiptSize = file.buffer.length;
  await claim.save();

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_RECEIPT_UPLOADED,
    `Attached a ${signature.type} receipt to expense claim ${claimId}`,
    context.req,
    {
      // The key is recorded; the bytes and the file name are not.
      meta: {
        claimId: idStr(claimId),
        lineItemId: idStr(lineItemId),
        contentType: signature.type,
        size: file.buffer.length,
      },
    },
  );

  const [result] = await hydrate([claim.toObject()], actor);
  return result;
}

/** The storage key behind a line, once the actor is allowed to read it. */
export async function receiptKeyFor(claimId, lineItemId, actor) {
  if (!mongoose.isValidObjectId(claimId) || !mongoose.isValidObjectId(lineItemId)) {
    throw new HrmsNotFoundError('Expense claim line');
  }

  const claim = await ExpenseClaim.findOne({ _id: claimId, deletedAt: null }).lean();
  if (!claim) throw new HrmsNotFoundError('Expense claim');

  await assertCanViewClaim(actor, claim);

  const line = (claim.lineItems ?? []).find((l) => idStr(l._id) === idStr(lineItemId));
  if (!line) throw new HrmsNotFoundError('Expense claim line');
  if (!line.receiptKey) throw new HrmsNotFoundError('Receipt');

  return { key: line.receiptKey, claim };
}

/**
 * The access rule the storage layer consults before issuing a read URL.
 *
 * Registered at bootstrap. Resolving by KEY means the rule holds even if a URL
 * is requested through the generic file endpoint rather than through a claim.
 */
export async function resolveReceiptAccess(key) {
  const claim = await ExpenseClaim.findOne({ 'lineItems.receiptKey': key, deletedAt: null })
    .select('employeeId')
    .lean();
  if (!claim) return null;

  const resolved = await ownerContextFor(claim.employeeId);
  if (!resolved) return null;

  return {
    owner: resolved.owner,
    permissions: [
      { module: M.EXPENSES, action: A.VIEW, scope: S.ORG },
      { module: M.EXPENSES, action: A.VIEW, scope: S.TEAM },
      { module: M.EXPENSES, action: A.VIEW, scope: S.SELF },
    ],
  };
}

export default {
  listClaims,
  getClaim,
  createClaim,
  updateClaim,
  submitClaim,
  decideClaim,
  reimburseClaim,
  uploadReceipt,
  receiptKeyFor,
  resolveReceiptAccess,
  sniffReceipt,
};
