/**
 * Onboarding checklists — a template stamped onto one new hire.
 *
 * Ported from the reference's `onboarding-checklist.service.ts`, which is the
 * heart of the module. Instantiation, assignee resolution, the task lifecycle
 * and the auto-close are all reproduced; the corrections below are marked.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. LIST AND READ AGREE. The reference's `buildScopeFilter` gives a
 *    `view:team` manager their reports' checklists, but `assertCanView` allows
 *    only `view:org` or self — so a manager sees a row in the list and gets a
 *    403 opening it. One filter is built here and BOTH paths use it.
 *
 * 2. TASK TRANSITIONS ARE ENFORCED, and the checklist follows its tasks back
 *    out of `completed`. The reference writes any status it is given and
 *    latches the checklist closed the first time nothing is outstanding, so
 *    reopening a task leaves a "completed" checklist with live work in it.
 *
 * 3. REASSIGNMENT IS VALIDATED. The reference writes whatever `assigneeUserId`
 *    it is handed, with no check that the user exists.
 *
 * 4. ONE ACTIVE CHECKLIST PER EMPLOYEE is a unique index, not a read-then-write.
 *
 * 5. `cancelled` IS REACHABLE. The reference has it in the enum with no
 *    endpoint and no transition that sets it.
 *
 * 6. THE ASSIGNEE IS AN EMPLOYEE, not a user account — a new hire on day zero
 *    very often has no login yet, and every scope check in this codebase is
 *    employee-based.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { OnboardingChecklist, OnboardingTemplate } from '../../../models/hrms/OnboardingModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import {
  TASK_TRANSITIONS,
  CLOSED_TASK_STATUSES,
  OPEN_TASK_STATUSES,
} from '../../../shared/constants/onboarding.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
  HRMS_ROLES as R,
} from '../../../shared/permissions/constants.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const toDay = (date) => new Date(date).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const taskDto = (t) => ({
  id: idStr(t._id),
  taskTemplateId: idStr(t.taskTemplateId),
  title: t.title,
  description: t.description ?? null,
  assigneeEmployeeId: idStr(t.assigneeEmployeeId),
  assigneeName: t.assigneeName ?? null,
  assignTo: t.assignTo,
  dueDate: t.dueDate ?? null,
  status: t.status,
  notes: t.notes ?? null,
  order: t.order,
  completedAt: t.completedAt ? new Date(t.completedAt).toISOString() : null,
});

const toDto = (row) => {
  const tasks = [...(row.tasks ?? [])].sort((a, b) => a.order - b.order).map(taskDto);
  /** `skipped` counts as done, exactly as the reference counts it. */
  const completed = tasks.filter((t) => CLOSED_TASK_STATUSES.includes(t.status)).length;
  return {
    id: idStr(row._id),
    employeeId: idStr(row.employeeId),
    employeeName: row.employeeName ?? null,
    templateId: idStr(row.templateId),
    templateName: row.templateName ?? null,
    status: row.status,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null,
    cancellationReason: row.cancellationReason ?? null,
    tasks,
    progress: { total: tasks.length, completed },
  };
};

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The one scope filter, used by BOTH the list and the single read.
 *
 * Org sees everything. Team sees their own plus anyone whose `managerChain`
 * contains them — a skip-level manager included, matching how Exits and Hiring
 * read team scope here. Everyone else sees only their own.
 *
 * Returns `null` when the actor can see nothing at all, which the callers treat
 * as an empty result rather than an error.
 */
async function scopeFilter(actor) {
  if (hasHrmsPermission(actor, M.ONBOARDING, A.VIEW, S.ORG)) return {};

  const self = actor?.employeeId ? oid(actor.employeeId) : null;

  if (hasHrmsPermission(actor, M.ONBOARDING, A.VIEW, S.TEAM) && self) {
    const reports = await Employee.find({ managerChain: self, deletedAt: null })
      .select('_id')
      .lean();
    return { employeeId: { $in: [self, ...reports.map((r) => r._id)] } };
  }

  if (hasHrmsPermission(actor, M.ONBOARDING, A.VIEW, S.SELF) && self) {
    return { employeeId: self };
  }

  return null;
}

export async function listChecklists(query = {}, actor) {
  const scope = await scopeFilter(actor);
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, status, employeeId } = query;

  if (scope === null) return { data: [], total: 0, page, pageSize };

  const filter = {
    ...scope,
    ...(status ? { status } : {}),
    ...(employeeId ? { employeeId: oid(employeeId) } : {}),
  };

  const [rows, total] = await Promise.all([
    OnboardingChecklist.find(filter)
      // Active first, then most recently started — the reference's ordering.
      .sort({ status: 1, startedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    OnboardingChecklist.countDocuments(filter),
  ]);

  return { data: rows.map(toDto), total, page, pageSize };
}

/** Reads one checklist through the SAME filter the list uses — see note 1. */
export async function getChecklist(id, actor) {
  const row = await loadChecklistScoped(id, actor);
  return toDto(row);
}

/** The signed-in employee's own checklist, for the new-hire portal. */
export async function myChecklist(actor) {
  if (!actor?.employeeId) return null;
  const row = await OnboardingChecklist.findOne({ employeeId: oid(actor.employeeId) })
    .sort({ status: 1, startedAt: -1 })
    .lean();
  return row ? toDto(row) : null;
}

// ---------------------------------------------------------------------------
// Instantiation
// ---------------------------------------------------------------------------

/**
 * Stamp a template onto a new hire.
 *
 * Every reference is resolved BEFORE the write (AD-2: Mongo has no foreign
 * keys), the template's name and each task are COPIED so later edits to the
 * template never rewrite work in progress, and the unique index is what
 * actually prevents a second active checklist.
 */
export async function startChecklist(input, context = {}) {
  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null })
    .select('_id firstName lastName userId reportingManagerId status')
    .lean()
    .catch(() => null);
  if (!employee) {
    throw new HrmsValidationError('Unknown employee.', [
      { path: 'employeeId', message: 'That employee does not exist.' },
    ]);
  }
  if (employee.status === 'exited' || employee.status === 'inactive') {
    throw new HrmsConflictError(
      'That employee has left, so onboarding cannot be started for them.',
      { code: 'EMPLOYEE_NOT_ONBOARDABLE' },
    );
  }

  const template = await OnboardingTemplate.findOne({
    _id: input.templateId,
    deletedAt: null,
  })
    .lean()
    .catch(() => null);
  if (!template) {
    throw new HrmsValidationError('Unknown template.', [
      { path: 'templateId', message: 'That template does not exist.' },
    ]);
  }
  if (!template.active) {
    throw new HrmsValidationError('That template is inactive.', [
      { path: 'templateId', message: 'Only an active template can start onboarding.' },
    ]);
  }

  // Pre-checked only to produce a better message than a duplicate-key error;
  // the unique partial index is the guarantee.
  const existing = await OnboardingChecklist.findOne({
    employeeId: oid(input.employeeId),
    status: 'active',
  })
    .select('_id')
    .lean();
  if (existing) {
    throw new HrmsConflictError(
      `${nameOf(employee)} already has an active onboarding checklist.`,
      { code: 'CHECKLIST_EXISTS' },
    );
  }

  const assignees = await resolveAssignees(employee);
  const startedAt = new Date();

  const tasks = [...(template.tasks ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((tt, i) => {
      const due = new Date(startedAt);
      due.setUTCDate(due.getUTCDate() + tt.dueDays);
      const assignee = assignees[tt.assignTo] ?? null;
      return {
        taskTemplateId: tt._id,
        title: tt.title,
        description: tt.description ?? null,
        assigneeEmployeeId: assignee?.id ?? null,
        assigneeName: assignee?.name ?? null,
        assignTo: tt.assignTo,
        dueDate: toDay(due),
        status: 'pending',
        order: Number.isInteger(tt.order) ? tt.order : i,
      };
    });

  let row;
  try {
    row = await OnboardingChecklist.create({
      employeeId: oid(input.employeeId),
      employeeName: nameOf(employee),
      templateId: template._id,
      templateName: template.name,
      status: 'active',
      startedAt,
      tasks,
      createdByUserId: context.user?._id ?? null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(
        `${nameOf(employee)} already has an active onboarding checklist.`,
        { code: 'CHECKLIST_EXISTS' },
      );
    }
    throw error;
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ONBOARDING_CHECKLIST_STARTED,
    `Started onboarding for ${nameOf(employee)} from "${template.name}" (${tasks.length} task(s))`,
    context.req,
    {
      meta: {
        checklistId: idStr(row._id),
        employeeId: idStr(employee._id),
        templateId: idStr(template._id),
        taskCount: tasks.length,
        unassigned: tasks.filter((t) => !t.assigneeEmployeeId).map((t) => t.assignTo),
      },
    },
  );

  /**
   * One item per assigned task — the reference's `onboarding.task`.
   *
   * Assignees come from the checklist's OWN resolved slots (manager, HR, IT,
   * the new hire), not from the request. An unassigned task notifies nobody:
   * the reference's `if (!task.assigneeUserId) continue`, kept.
   *
   * One notification per TASK, not per person, because each is a separate
   * thing to do — which is also why they are actionable.
   */
  for (const task of row.tasks ?? []) {
    if (!task.assigneeEmployeeId) continue;
    await notify({
      to: idStr(task.assigneeEmployeeId),
      type: INBOX_TYPES.ONBOARDING_TASK_ASSIGNED,
      title: task.title,
      body: `Onboarding for ${nameOf(employee)}.`,
      entity: 'onboarding_task',
      entityId: idStr(row._id),
    });
  }

  return toDto(row.toObject());
}

/**
 * Who each `assignTo` resolves to.
 *
 * The reference resolves these to USER ids: `new_hire` → the employee's user,
 * `manager` → the reporting manager's user, `hr`/`it` → the first user holding
 * that role key, `buddy` → null for HR to fill in later. Here they resolve to
 * EMPLOYEES, following the same choice Exits made for clearance areas.
 *
 * A role nobody holds leaves the task UNASSIGNED rather than falling back to
 * HR: an unassigned task is visible as a gap on the checklist, a misassigned
 * one is not. The audit entry above records which roles came back empty.
 */
async function resolveAssignees(employee) {
  const byRole = async (roles) => {
    const User = (await import('../../../models/User.js')).default;
    const user = await User.findOne({ roles: { $in: roles }, status: 'Active' })
      .select('_id')
      .lean();
    if (!user) return null;
    const row = await Employee.findOne({ userId: user._id, deletedAt: null })
      .select('_id firstName lastName')
      .lean();
    return row ? { id: row._id, name: nameOf(row) } : null;
  };

  const [hr, it, manager] = await Promise.all([
    byRole([R.HR_ADMIN, R.SUPER_ADMIN]),
    byRole([R.IT_ADMIN]),
    employee.reportingManagerId
      ? Employee.findOne({ _id: employee.reportingManagerId, deletedAt: null })
          .select('_id firstName lastName')
          .lean()
          .then((m) => (m ? { id: m._id, name: nameOf(m) } : null))
      : Promise.resolve(null),
  ]);

  return {
    new_hire: { id: employee._id, name: nameOf(employee) },
    manager,
    hr,
    it,
    // Left for HR to assign, exactly as the reference leaves it.
    buddy: null,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function assertTaskTransition(from, to) {
  if (from === to) return;
  const allowed = TASK_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HrmsConflictError(
      allowed.length === 0
        ? `This task is ${from} and is final.`
        : `A ${from.replace('_', ' ')} task can only become: ${allowed.join(', ')}.`,
      { code: 'TASK_INVALID_TRANSITION' },
    );
  }
}

/**
 * Update one task.
 *
 * Authorised as the reference authorises it — the assignee or somebody with
 * `onboarding:edit:org` — but the assignee is matched on the EMPLOYEE, and
 * reassignment is checked rather than trusted.
 */
export async function updateTask(checklistId, taskId, input, context = {}) {
  const actor = context.actor;
  const checklist = await loadChecklist(checklistId);

  if (checklist.status === 'cancelled') {
    throw new HrmsConflictError('This onboarding was cancelled; its tasks are closed.', {
      code: 'CHECKLIST_CANCELLED',
    });
  }

  const task = (checklist.tasks ?? []).find((t) => idStr(t._id) === String(taskId));
  if (!task) throw new HrmsNotFoundError('Task');

  const isAdmin = hasHrmsPermission(actor, M.ONBOARDING, A.EDIT, S.ORG);
  const isAssignee =
    Boolean(actor?.employeeId) && idStr(task.assigneeEmployeeId) === idStr(actor.employeeId);
  if (!isAdmin && !isAssignee) {
    throw new HrmsForbiddenError('Only the assignee or HR can update this task.');
  }

  const $set = {};

  if (input.status !== undefined) {
    assertTaskTransition(task.status, input.status);
    $set['tasks.$[t].status'] = input.status;
    if (input.status === 'completed') {
      $set['tasks.$[t].completedAt'] = new Date();
      $set['tasks.$[t].completedByUserId'] = context.user?._id ?? null;
    } else {
      // Reopening clears the completion stamp; leaving it would date a task
      // to a completion that has been undone.
      $set['tasks.$[t].completedAt'] = null;
      $set['tasks.$[t].completedByUserId'] = null;
    }
  }

  if (input.notes !== undefined) $set['tasks.$[t].notes'] = input.notes;

  let reassignedTo = null;
  if (input.assigneeEmployeeId !== undefined) {
    /**
     * Reassignment is HR's call, not the current assignee's — otherwise a task
     * can be handed away by whoever happens to hold it.
     */
    if (!isAdmin) {
      throw new HrmsForbiddenError('Only HR can reassign an onboarding task.');
    }
    if (input.assigneeEmployeeId === null) {
      $set['tasks.$[t].assigneeEmployeeId'] = null;
      $set['tasks.$[t].assigneeName'] = null;
    } else {
      const next = await Employee.findOne({
        _id: input.assigneeEmployeeId,
        deletedAt: null,
      })
        .select('_id firstName lastName status')
        .lean()
        .catch(() => null);
      if (!next) {
        throw new HrmsValidationError('Unknown employee.', [
          { path: 'assigneeEmployeeId', message: 'That employee does not exist.' },
        ]);
      }
      $set['tasks.$[t].assigneeEmployeeId'] = next._id;
      $set['tasks.$[t].assigneeName'] = nameOf(next);
      reassignedTo = nameOf(next);
    }
  }

  await OnboardingChecklist.updateOne({ _id: checklist._id }, { $set }, {
    arrayFilters: [{ 't._id': oid(taskId) }],
  });

  await recordAudit(
    context.user,
    reassignedTo ? AUDIT_ACTIONS.ONBOARDING_TASK_REASSIGNED : AUDIT_ACTIONS.ONBOARDING_TASK_UPDATED,
    reassignedTo
      ? `Reassigned "${task.title}" to ${reassignedTo}`
      : `Updated "${task.title}"${input.status ? ` to ${input.status}` : ''}`,
    context.req,
    {
      meta: {
        checklistId: idStr(checklist._id),
        taskId: idStr(taskId),
        from: task.status,
        to: input.status ?? task.status,
      },
    },
  );

  await settleChecklist(checklist._id, context);
  return getChecklist(checklist._id, actor);
}

/**
 * Recompute whether the checklist is finished, from its tasks.
 *
 * 🔴 The reference latches: the first time nothing is outstanding it writes
 * `completed` and never looks again, so reopening a task leaves a "completed"
 * checklist with live work in it. Recomputing means the status can never
 * disagree with the tasks under it — in either direction.
 */
async function settleChecklist(checklistId, context = {}) {
  const row = await OnboardingChecklist.findById(checklistId).lean();
  if (!row || row.status === 'cancelled') return;

  const open = (row.tasks ?? []).filter((t) => OPEN_TASK_STATUSES.includes(t.status)).length;
  const shouldBe = open === 0 && (row.tasks ?? []).length > 0 ? 'completed' : 'active';
  if (shouldBe === row.status) return;

  await OnboardingChecklist.updateOne(
    { _id: checklistId },
    {
      $set: {
        status: shouldBe,
        completedAt: shouldBe === 'completed' ? new Date() : null,
      },
    },
  );

  await recordAudit(
    context.user,
    shouldBe === 'completed'
      ? AUDIT_ACTIONS.ONBOARDING_CHECKLIST_COMPLETED
      : AUDIT_ACTIONS.ONBOARDING_CHECKLIST_REOPENED,
    shouldBe === 'completed'
      ? `Onboarding for ${row.employeeName} is complete`
      : `Onboarding for ${row.employeeName} reopened — a task was reopened`,
    context.req,
    { meta: { checklistId: idStr(checklistId), from: row.status, to: shouldBe } },
  );
}

/**
 * Cancel an onboarding.
 *
 * 🔴 The reference has `cancelled` in its enum and nothing that can ever write
 * it. A hire that falls through has to be closable, or the employee keeps an
 * active checklist forever and cannot be onboarded again — the unique index
 * would refuse the second start.
 */
export async function cancelChecklist(id, input, context = {}) {
  const checklist = await loadChecklist(id);

  if (checklist.status === 'cancelled') {
    throw new HrmsConflictError('This onboarding is already cancelled.', {
      code: 'CHECKLIST_INVALID_TRANSITION',
    });
  }

  const updated = await OnboardingChecklist.findOneAndUpdate(
    { _id: checklist._id, status: { $ne: 'cancelled' } },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: input.reason,
        completedAt: null,
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This onboarding changed before your update was saved.', {
      code: 'CHECKLIST_INVALID_TRANSITION',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ONBOARDING_CHECKLIST_CANCELLED,
    `Cancelled onboarding for ${checklist.employeeName}: ${input.reason}`,
    context.req,
    { meta: { checklistId: idStr(checklist._id), reason: input.reason } },
  );

  return toDto(updated.toObject());
}

// ---------------------------------------------------------------------------
// "Assigned to me"
// ---------------------------------------------------------------------------

/**
 * Every onboarding task assigned to the caller, across checklists.
 *
 * No id is accepted — the employee comes from the session, so there is nothing
 * to tamper with and no permission beyond having an employee record. This is
 * how an IT admin, a buddy or a manager reaches the one task they own without
 * being given `view:org` over everybody's onboarding.
 *
 * Served by the `(tasks.assigneeEmployeeId, tasks.status)` index.
 */
export async function listMyTasks(actor, query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, status } = query;
  if (!actor?.employeeId) return { data: [], total: 0, page, pageSize };

  const self = oid(actor.employeeId);
  const rows = await OnboardingChecklist.find({
    status: { $ne: 'cancelled' },
    'tasks.assigneeEmployeeId': self,
  })
    .sort({ startedAt: -1 })
    .lean();

  // The document matched because SOME task is mine; the rest are not.
  const mine = [];
  for (const row of rows) {
    for (const t of row.tasks ?? []) {
      if (idStr(t.assigneeEmployeeId) !== idStr(self)) continue;
      if (status && t.status !== status) continue;
      mine.push({
        ...taskDto(t),
        checklistId: idStr(row._id),
        checklistStatus: row.status,
        employeeId: idStr(row.employeeId),
        employeeName: row.employeeName ?? null,
      });
    }
  }

  // Soonest due first, undated last.
  mine.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));

  const start = (page - 1) * pageSize;
  return { data: mine.slice(start, start + pageSize), total: mine.length, page, pageSize };
}

// ---------------------------------------------------------------------------

const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

export async function loadChecklist(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Checklist');
  const row = await OnboardingChecklist.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Checklist');
  return row;
}

/** Load one checklist through the list's scope filter — see note 1. */
async function loadChecklistScoped(id, actor) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Checklist');
  const scope = await scopeFilter(actor);
  if (scope === null) throw new HrmsNotFoundError('Checklist');
  const row = await OnboardingChecklist.findOne({ _id: id, ...scope }).lean();
  // A 404 rather than a 403: whether a checklist exists for somebody out of
  // scope is not the caller's business.
  if (!row) throw new HrmsNotFoundError('Checklist');
  return row;
}

export { toDto as checklistDto, scopeFilter, assertTaskTransition, settleChecklist };

export default {
  listChecklists,
  getChecklist,
  myChecklist,
  startChecklist,
  updateTask,
  cancelChecklist,
  listMyTasks,
};
