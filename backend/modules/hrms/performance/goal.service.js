/**
 * Goals — OKR-style, cascading through `parentGoalId`.
 *
 * Ported from the reference's `goal.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. STATUS TRANSITIONS ARE ENFORCED. The reference writes any status it is
 *    given, so `achieved → open` and a revived `cancelled` goal both succeed.
 *
 * 2. A GOAL WITH CHILDREN CANNOT BE DELETED, and deletion is soft. The
 *    reference hard-deletes and its cascade self-relation has no `onDelete`, so
 *    a deleted parent leaves its children pointing at a row that is gone.
 *
 * 3. THE CASCADE IS CHECKED. A parent must exist, must not be the goal itself,
 *    and must not create a cycle — the reference validates none of this, so
 *    `A → B → A` is reachable and any renderer that walks the tree hangs.
 *
 * 4. THE LIST IS PAGINATED (AD-13) and filterable. The reference returns every
 *    goal in scope, unbounded.
 *
 * 5. MEASURES ARE Decimal128 (AD-2), not floats.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { Goal, ReviewCycle } from '../../../models/hrms/PerformanceModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { GOAL_TRANSITIONS } from '../../../shared/constants/performance.js';
import { toDecimalString, fromDecimal } from '../../../shared/payroll/money.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

const dec = (v) =>
  v === null || v === undefined || v === ''
    ? null
    : mongoose.Types.Decimal128.fromString(toDecimalString(v));

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const toDto = (row, extras = {}) => {
  const target = row.targetValue === null || row.targetValue === undefined ? null : fromDecimal(row.targetValue);
  const current = row.currentValue === null || row.currentValue === undefined ? 0 : fromDecimal(row.currentValue);
  return {
    id: idStr(row._id),
    employeeId: idStr(row.employeeId),
    employeeName: row.employeeName ?? null,
    parentGoalId: idStr(row.parentGoalId),
    parentGoalTitle: extras.parentGoalTitle ?? null,
    cycleId: idStr(row.cycleId),
    cycleName: extras.cycleName ?? null,
    title: row.title,
    description: row.description ?? null,
    targetValue: target,
    currentValue: current,
    unit: row.unit ?? null,
    weight: row.weight,
    status: row.status,
    dueDate: row.dueDate ?? null,
    /**
     * DERIVED, never stored — a stored percentage is a second source of truth
     * that can disagree with the two numbers beside it. Uncapped, as the
     * reference computes it; the UI clamps the bar at 100.
     */
    progressPercent: target && target > 0 ? Math.round((current / target) * 100) : null,
    childCount: extras.childCount ?? 0,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
};

/**
 * Attach parent titles, cycle names and child counts for a page of goals.
 *
 * Three queries for a page rather than three per row — the reference leans on
 * Prisma's `include`, which translated naively is an N+1 on every render.
 */
async function enrich(rows) {
  if (rows.length === 0) return [];

  const parentIds = [...new Set(rows.map((r) => idStr(r.parentGoalId)).filter(Boolean))];
  const cycleIds = [...new Set(rows.map((r) => idStr(r.cycleId)).filter(Boolean))];

  const [parents, cycles, childCounts] = await Promise.all([
    parentIds.length
      ? Goal.find({ _id: { $in: parentIds } }).select('title').lean()
      : [],
    cycleIds.length
      ? ReviewCycle.find({ _id: { $in: cycleIds } }).select('name').lean()
      : [],
    Goal.aggregate([
      { $match: { parentGoalId: { $in: rows.map((r) => r._id) }, deletedAt: null } },
      { $group: { _id: '$parentGoalId', n: { $sum: 1 } } },
    ]),
  ]);

  const parentTitle = new Map(parents.map((p) => [idStr(p._id), p.title]));
  const cycleName = new Map(cycles.map((c) => [idStr(c._id), c.name]));
  const children = new Map(childCounts.map((c) => [idStr(c._id), c.n]));

  return rows.map((r) =>
    toDto(r, {
      parentGoalTitle: parentTitle.get(idStr(r.parentGoalId)) ?? null,
      cycleName: cycleName.get(idStr(r.cycleId)) ?? null,
      childCount: children.get(idStr(r._id)) ?? 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The one scope filter, used by BOTH the list and the single read.
 *
 * Org sees everything, team sees their own plus anyone whose `managerChain`
 * contains them — a skip-level manager included, matching how Exits, Hiring and
 * Onboarding read team scope here. Everyone else sees only their own.
 *
 * `null` means "nothing at all", which the callers treat as an empty result.
 */
export async function goalScopeFilter(actor) {
  if (hasHrmsPermission(actor, M.PERFORMANCE, A.VIEW, S.ORG)) return {};

  const self = actor?.employeeId ? oid(actor.employeeId) : null;
  if (!self) return null;

  const teamScoped =
    hasHrmsPermission(actor, M.PERFORMANCE, A.VIEW, S.TEAM) ||
    hasHrmsPermission(actor, M.PERFORMANCE, A.APPROVE, S.TEAM);

  if (teamScoped) {
    const reports = await Employee.find({ managerChain: self, deletedAt: null })
      .select('_id')
      .lean();
    return { employeeId: { $in: [self, ...reports.map((r) => r._id)] } };
  }

  if (hasHrmsPermission(actor, M.PERFORMANCE, A.VIEW, S.SELF)) return { employeeId: self };
  return null;
}

export async function listGoals(query = {}, actor) {
  const scope = await goalScopeFilter(actor);
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, status, cycleId, employeeId, search } = query;

  if (scope === null) return { data: [], total: 0, page, pageSize };

  const filter = {
    ...scope,
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(cycleId ? { cycleId: oid(cycleId) } : {}),
    ...(employeeId ? { employeeId: oid(employeeId) } : {}),
    ...(search ? { title: { $regex: `^${escapeRegex(search)}`, $options: 'i' } } : {}),
  };

  const [rows, total] = await Promise.all([
    Goal.find(filter)
      // Status then most recent — the reference's ordering exactly.
      .sort({ status: 1, createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Goal.countDocuments(filter),
  ]);

  return { data: await enrich(rows), total, page, pageSize };
}

/** A user-supplied search term is data, not a pattern. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getGoal(id, actor) {
  const row = await loadGoalScoped(id, actor);
  return (await enrich([row]))[0];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createGoal(input, context = {}) {
  const actor = context.actor;
  const employeeId = input.employeeId ?? actor?.employeeId ?? null;
  if (!employeeId) {
    throw new HrmsValidationError('No employee context.', [
      { path: 'employeeId', message: 'You have no employee record, so a goal has no owner.' },
    ]);
  }

  /**
   * Anyone may set their OWN goals; setting one for somebody else needs org
   * scope. The reference's rule, kept exactly.
   */
  const isSelf = idStr(employeeId) === idStr(actor?.employeeId);
  if (!isSelf && !hasHrmsPermission(actor, M.PERFORMANCE, A.APPROVE, S.ORG)) {
    throw new HrmsForbiddenError('You may not set goals for other people.');
  }

  const employee = await Employee.findOne({ _id: employeeId, deletedAt: null })
    .select('_id firstName lastName status')
    .lean()
    .catch(() => null);
  if (!employee) {
    throw new HrmsValidationError('Unknown employee.', [
      { path: 'employeeId', message: 'That employee does not exist.' },
    ]);
  }

  const cycle = input.cycleId ? await assertCycle(input.cycleId) : null;
  if (input.parentGoalId) await assertParent(input.parentGoalId, null);

  const row = await Goal.create({
    employeeId: oid(employeeId),
    employeeName: nameOf(employee),
    parentGoalId: input.parentGoalId ? oid(input.parentGoalId) : null,
    cycleId: input.cycleId ? oid(input.cycleId) : null,
    title: input.title,
    description: input.description ?? null,
    targetValue: dec(input.targetValue),
    currentValue: dec(0),
    unit: input.unit ?? null,
    weight: input.weight,
    status: 'open',
    dueDate: input.dueDate ?? null,
    createdByUserId: context.user?._id ?? null,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.GOAL_CREATED,
    `Set the goal "${row.title}" for ${nameOf(employee)}`,
    context.req,
    {
      meta: {
        goalId: idStr(row._id),
        employeeId: idStr(employee._id),
        cycleId: idStr(cycle?._id),
        forSomebodyElse: !isSelf,
      },
    },
  );

  return getGoal(row._id, actor);
}

function assertGoalTransition(from, to) {
  if (from === to) return;
  const allowed = GOAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HrmsConflictError(
      `A ${from.replace('_', ' ')} goal can only become: ${allowed.join(', ')}.`,
      { code: 'GOAL_INVALID_TRANSITION' },
    );
  }
}

/**
 * Update progress or status.
 *
 * The owner or `approve:org` — the reference's rule. A manager can SEE a
 * report's goals through team scope but cannot rewrite them, which is right:
 * a goal is the employee's commitment, not their manager's to edit.
 */
export async function updateGoal(id, input, context = {}) {
  const actor = context.actor;
  const goal = await loadGoal(id);

  const isOwner = Boolean(actor?.employeeId) && idStr(goal.employeeId) === idStr(actor.employeeId);
  const isAdmin = hasHrmsPermission(actor, M.PERFORMANCE, A.APPROVE, S.ORG);
  if (!isOwner && !isAdmin) {
    throw new HrmsForbiddenError('Only the goal’s owner or HR can update it.');
  }

  const $set = {};

  if (input.currentValue !== undefined) {
    if (goal.targetValue === null || goal.targetValue === undefined) {
      throw new HrmsValidationError('This goal has no target to measure against.', [
        { path: 'currentValue', message: 'Add a target value before recording progress.' },
      ]);
    }
    $set.currentValue = dec(input.currentValue);
  }

  if (input.status !== undefined) {
    assertGoalTransition(goal.status, input.status);
    $set.status = input.status;
  }

  await Goal.updateOne({ _id: goal._id, deletedAt: null }, { $set });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.GOAL_UPDATED,
    input.status
      ? `Moved the goal "${goal.title}" from ${goal.status} to ${input.status}`
      : `Recorded progress on the goal "${goal.title}"`,
    context.req,
    {
      meta: {
        goalId: idStr(goal._id),
        from: goal.status,
        to: input.status ?? goal.status,
        note: input.note ?? null,
      },
    },
  );

  return getGoal(goal._id, actor);
}

/**
 * Retire a goal.
 *
 * 🔴 The reference hard-deletes. Its cascade is a self-relation with no
 * `onDelete`, so a deleted parent leaves its children pointing at nothing —
 * `parentGoalTitle` then renders "—" and the cascade silently breaks. A goal
 * with children is refused outright; one without is soft-deleted.
 */
export async function deleteGoal(id, context = {}) {
  const actor = context.actor;
  const goal = await loadGoal(id);

  const isOwner = Boolean(actor?.employeeId) && idStr(goal.employeeId) === idStr(actor.employeeId);
  const isAdmin = hasHrmsPermission(actor, M.PERFORMANCE, A.APPROVE, S.ORG);
  if (!isOwner && !isAdmin) {
    throw new HrmsForbiddenError('Only the goal’s owner or HR can delete it.');
  }

  const children = await Goal.countDocuments({ parentGoalId: goal._id, deletedAt: null });
  if (children > 0) {
    throw new HrmsConflictError(
      `${children} goal(s) cascade from this one, so it cannot be deleted. Cancel it instead.`,
      { code: 'GOAL_HAS_CHILDREN' },
    );
  }

  await Goal.updateOne({ _id: goal._id, deletedAt: null }, { $set: { deletedAt: new Date() } });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.GOAL_DELETED,
    `Deleted the goal "${goal.title}"`,
    context.req,
    { meta: { goalId: idStr(goal._id), employeeId: idStr(goal.employeeId) } },
  );
}

// ---------------------------------------------------------------------------

async function assertCycle(cycleId) {
  const cycle = await ReviewCycle.findById(cycleId).select('_id name phase').lean().catch(() => null);
  if (!cycle) {
    throw new HrmsValidationError('Unknown cycle.', [
      { path: 'cycleId', message: 'That review cycle does not exist.' },
    ]);
  }
  if (cycle.phase === 'closed') {
    throw new HrmsValidationError('That cycle is closed.', [
      { path: 'cycleId', message: 'A goal cannot be attached to a closed cycle.' },
    ]);
  }
  return cycle;
}

/**
 * The cascade must be a tree.
 *
 * 🔴 The reference checks nothing at all — a parent that does not exist, a goal
 * parented to itself, and a full cycle `A → B → A` are all accepted, and any
 * renderer that walks the tree then hangs.
 */
async function assertParent(parentGoalId, selfId) {
  const parent = await Goal.findOne({ _id: parentGoalId, deletedAt: null })
    .select('_id parentGoalId')
    .lean()
    .catch(() => null);
  if (!parent) {
    throw new HrmsValidationError('Unknown parent goal.', [
      { path: 'parentGoalId', message: 'That goal does not exist.' },
    ]);
  }
  if (selfId && idStr(parent._id) === idStr(selfId)) {
    throw new HrmsValidationError('A goal cannot be its own parent.', [
      { path: 'parentGoalId', message: 'Choose a different goal.' },
    ]);
  }

  // Walk up. The depth cap is a backstop against a cycle that predates this
  // check rather than a business rule.
  let cursor = parent;
  for (let depth = 0; depth < 20 && cursor?.parentGoalId; depth += 1) {
    if (selfId && idStr(cursor.parentGoalId) === idStr(selfId)) {
      throw new HrmsValidationError('That would make the cascade loop back on itself.', [
        { path: 'parentGoalId', message: 'Choose a goal that does not descend from this one.' },
      ]);
    }
    cursor = await Goal.findById(cursor.parentGoalId).select('_id parentGoalId').lean();
  }
  return parent;
}

export async function loadGoal(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Goal');
  const row = await Goal.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Goal');
  return row;
}

/** Load one goal through the list's scope filter, so the two cannot disagree. */
async function loadGoalScoped(id, actor) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Goal');
  const scope = await goalScopeFilter(actor);
  if (scope === null) throw new HrmsNotFoundError('Goal');
  const row = await Goal.findOne({ _id: id, deletedAt: null, ...scope }).lean();
  // A 404 rather than a 403: whether a goal exists out of scope is not the
  // caller's business.
  if (!row) throw new HrmsNotFoundError('Goal');
  return row;
}

export { toDto as goalDto, assertGoalTransition, idStr, oid, nameOf, dec };

export default { listGoals, getGoal, createGoal, updateGoal, deleteGoal };
