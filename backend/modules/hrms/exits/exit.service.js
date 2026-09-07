/**
 * The exit workflow.
 *
 * Ported from the reference's `ExitRequestService` + `RelievingLetterService`.
 * The state machine is its state machine:
 *
 *   initiated → manager_approved → in_notice → clearance_pending → cleared
 *             → f_and_f_pending → closed        (any non-terminal → cancelled)
 *
 * Corrections to the reference, each deliberate and each covered by a test:
 *
 *   1. `hr_approved` IS NOT A STATE. The reference declares it and never
 *      reaches it — `hrApprove()` writes `in_notice`. Reproducing the dead
 *      value is what makes its own progress bar skip a step.
 *
 *   2. HR APPROVAL CANNOT BE SKIPPED. The reference's `openClearances` accepts
 *      `manager_approved` as well as `in_notice`, so the documented happy path
 *      walks straight past the HR gate it just defined. Only `in_notice` opens
 *      clearances here.
 *
 *   3. A MANAGER CAN OPEN WHAT THEY CAN SEE. The reference's `assertCanView`
 *      carries `// TODO: manager scope check`, so a manager is shown their
 *      team's requests in the list and then gets a 403 opening one of them.
 *
 *   4. TERMINAL RECORDS ARE IMMUTABLE. The reference's `PATCH /exits/:id` has
 *      no status guard, so HR can rewrite `actualLastDay` on a closed request
 *      after the relieving letter has already stated that date.
 *
 *   5. DISBURSE IS GUARDED BY STATUS. The reference checks only "not already
 *      disbursed", so any request with an F&F row can jump to `closed`.
 *
 *   6. CANCELLING STOPS ONCE MONEY IS COMPUTED. The reference lets the employee
 *      cancel from `cleared` or `f_and_f_pending`.
 *
 *   7. NOBODY APPROVES THEIR OWN EXIT, and an exit cannot be filed for someone
 *      who has already left.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import ExitRequest from '../../../models/hrms/ExitRequest.js';
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
  createExitRequestSchema,
  updateExitRequestSchema,
  updateClearanceSchema,
  exitListQuerySchema,
  CLEARANCE_AREAS,
  TERMINAL_CLEARANCE_STATUSES,
  SELF_SERVICE_REASON_CATEGORIES,
} from '../../../shared/schemas/exit.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
  HrmsForbiddenError,
} from '../hrms.errors.js';
import { putObject } from '../../../utils/hrms/storage/index.js';
import { computeSettlement, toDecimal } from './fnf.service.js';
import { renderRelievingLetter } from './relievingLetter.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
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

const isHr = (actor) => hasHrmsPermission(actor, M.EXITS, A.EDIT, S.ORG);

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const clearanceToDto = (row) => ({
  id: idStr(row._id),
  area: row.area,
  assigneeEmployeeId: idStr(row.assigneeEmployeeId),
  assigneeName: row.assigneeName || null,
  status: row.status,
  completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
  notes: row.notes ?? null,
});

const fnfToDto = (fnf) =>
  fnf
    ? {
        gross: dec(fnf.gross),
        deductions: dec(fnf.deductions),
        netPayable: dec(fnf.netPayable),
        earnings: (fnf.earnings ?? []).map((l) => ({
          code: l.code,
          label: l.label,
          amount: dec(l.amount),
        })),
        deductionLines: (fnf.deductionLines ?? []).map((l) => ({
          code: l.code,
          label: l.label,
          amount: dec(l.amount),
        })),
        leaveEncashment: dec(fnf.leaveEncashment),
        gratuity: dec(fnf.gratuity),
        noticeAdjustment: dec(fnf.noticeAdjustment),
        computedAt: fnf.computedAt ? new Date(fnf.computedAt).toISOString() : null,
        disbursedAt: fnf.disbursedAt ? new Date(fnf.disbursedAt).toISOString() : null,
        payrollRunId: idStr(fnf.payrollRunId),
      }
    : null;

const toDto = (row, { actor, replacementName } = {}) => ({
  id: idStr(row._id),
  employeeId: idStr(row.employeeId),
  employeeName: row.employeeName,
  /**
   * Whether this exit belongs to the person reading it. The approval screens
   * need it to stop offering an Approve button the server would refuse.
   * Computed here so the browser is never told the viewer's employee id.
   */
  isOwnExit:
    Boolean(actor?.employeeId) && idStr(row.employeeId) === idStr(actor.employeeId),
  initiatedByEmployeeId: idStr(row.initiatedByEmployeeId),
  initiatedAt: row.initiatedAt ? new Date(row.initiatedAt).toISOString() : null,
  reason: row.reason,
  reasonCategory: row.reasonCategory,
  requestedLastDay: row.requestedLastDay,
  actualLastDay: row.actualLastDay ?? null,
  status: row.status,
  managerApprovedAt: row.managerApprovedAt
    ? new Date(row.managerApprovedAt).toISOString()
    : null,
  hrApprovedAt: row.hrApprovedAt ? new Date(row.hrApprovedAt).toISOString() : null,
  closedAt: row.closedAt ? new Date(row.closedAt).toISOString() : null,
  cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null,
  replacementEmployeeId: idStr(row.replacementEmployeeId),
  replacementEmployeeName: replacementName ?? null,
  transferNotes: row.transferNotes ?? null,
  clearances: (row.clearances ?? []).map(clearanceToDto),
  fullAndFinal: fnfToDto(row.fullAndFinal),
  /** Presence only — the storage key never reaches a browser. */
  relievingLetter: row.relievingLetter?.storageKey
    ? {
        generatedAt: row.relievingLetter.generatedAt
          ? new Date(row.relievingLetter.generatedAt).toISOString()
          : null,
      }
    : null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/** Batch-resolve the replacement names a page of requests needs. */
async function hydrate(rows, actor) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return [];

  const ids = list.map((r) => r.replacementEmployeeId).filter(Boolean);
  let nameById = new Map();
  if (ids.length > 0) {
    const people = await Employee.find({ _id: { $in: ids } })
      .select('firstName lastName')
      .lean();
    nameById = new Map(
      people.map((p) => [idStr(p._id), `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()]),
    );
  }

  return list.map((row) =>
    toDto(row, { actor, replacementName: nameById.get(idStr(row.replacementEmployeeId)) }),
  );
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * What this actor may see.
 *
 * Team scope uses the whole `managerChain`, so a skip-level manager can SEE an
 * exit below them. Whether they may DECIDE it is a separate question, answered
 * in `managerApprove`.
 */
function buildScopeFilter(actor) {
  if (hasHrmsPermission(actor, M.EXITS, A.VIEW, S.ORG)) return {};

  if (!actor?.employeeId) return { _id: null };

  const own = { employeeId: actor.employeeId };

  // An assignee must be able to reach the request their clearance hangs off,
  // whatever their scope otherwise is.
  const assigned = { 'clearances.assigneeEmployeeId': actor.employeeId };

  if (hasHrmsPermission(actor, M.EXITS, A.APPROVE, S.TEAM)) {
    return { $or: [own, assigned, { _teamOf: actor.employeeId }] };
  }
  if (hasHrmsPermission(actor, M.EXITS, A.VIEW, S.SELF)) {
    return { $or: [own, assigned] };
  }
  return { _id: null };
}

/**
 * Team scope is a property of the EMPLOYEE, not the request, so it cannot be
 * expressed as one query on this collection. Resolve it to a concrete id list.
 */
async function resolveScopeFilter(actor) {
  const filter = buildScopeFilter(actor);
  const clauses = filter.$or;
  if (!clauses) return filter;

  const teamClause = clauses.find((c) => c._teamOf);
  if (!teamClause) return filter;

  const reports = await Employee.find({ managerChain: teamClause._teamOf, deletedAt: null })
    .select('_id')
    .lean();

  return {
    $or: [
      ...clauses.filter((c) => !c._teamOf),
      { employeeId: { $in: reports.map((r) => r._id) } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listExits(actor, query = {}) {
  const dto = parse(exitListQuerySchema, query, 'exit filter');
  const { page, pageSize } = dto;

  const filter = { deletedAt: null, ...(await resolveScopeFilter(actor)) };
  if (dto.status) filter.status = dto.status;
  if (dto.activeOnly === 'true') filter.status = { $nin: ['closed', 'cancelled'] };

  const [rows, total] = await Promise.all([
    ExitRequest.find(filter)
      .sort({ initiatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    ExitRequest.countDocuments(filter),
  ]);

  return { data: await hydrate(rows, actor), total, page, pageSize };
}

/** The signed-in employee's own live exit, or null. */
export async function myExit(actor) {
  if (!actor?.employeeId) return null;
  const row = await ExitRequest.findOne({ employeeId: actor.employeeId, deletedAt: null })
    .sort({ initiatedAt: -1 })
    .lean();
  if (!row) return null;
  const [dto] = await hydrate([row], actor);
  return dto;
}

export async function getExit(id, actor) {
  const row = await loadVisible(id, actor);
  const [dto] = await hydrate([row], actor);
  return dto;
}

/**
 * Load a request the actor is allowed to open.
 *
 * The scope filter is applied to the LOOKUP rather than checked afterwards, so
 * "what a manager can list" and "what a manager can open" are by construction
 * the same set. The reference asks those two questions in two different places
 * and leaves the second one unimplemented.
 */
async function loadVisible(id, actor) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Exit request');
  const row = await ExitRequest.findOne({
    _id: id,
    deletedAt: null,
    ...(await resolveScopeFilter(actor)),
  }).lean();
  if (!row) throw new HrmsNotFoundError('Exit request');
  return row;
}

/** Load for a write. Existence and visibility first, then the action's own gate. */
async function loadForWrite(id, actor) {
  await loadVisible(id, actor);
  return ExitRequest.findOne({ _id: id, deletedAt: null });
}

// ---------------------------------------------------------------------------
// Initiate
// ---------------------------------------------------------------------------

export async function initiateExit(input, actor, context = {}) {
  const dto = parse(createExitRequestSchema, input, 'exit request');

  const hr = isHr(actor);
  // Absent employeeId means "mine". The browser never decides whose exit this
  // is — the reference takes employeeId from the body in every case.
  const targetId = dto.employeeId ?? idStr(actor?.employeeId);
  if (!targetId) {
    throw new HrmsValidationError(
      'Your user account is not linked to an employee record, so you cannot file an exit.',
    );
  }

  const isSelf = idStr(actor?.employeeId) === idStr(targetId);
  if (!isSelf && !hr) {
    throw new HrmsForbiddenError('Only the employee or HR can initiate an exit.');
  }

  // Nobody terminates themselves. The reference's schema accepts every category
  // from anyone and merely hides this one in the picker.
  if (isSelf && !hr && !SELF_SERVICE_REASON_CATEGORIES.includes(dto.reasonCategory)) {
    throw new HrmsForbiddenError(
      `You cannot file your own exit as "${dto.reasonCategory}".`,
    );
  }

  const employee = await Employee.findOne({ _id: targetId, deletedAt: null }).lean();
  if (!employee) throw new HrmsValidationError('That employee does not exist.');
  if (employee.status === 'exited' || employee.status === 'inactive') {
    throw new HrmsConflictError('That employee has already left.', {
      code: 'EMPLOYEE_ALREADY_EXITED',
    });
  }

  const existing = await ExitRequest.findOne({
    employeeId: targetId,
    status: { $nin: ['closed', 'cancelled'] },
    deletedAt: null,
  }).lean();
  if (existing) {
    throw new HrmsConflictError('That employee already has an exit in progress.', {
      code: 'EXIT_ALREADY_IN_PROGRESS',
      details: { exitRequestId: idStr(existing._id) },
    });
  }

  let row;
  try {
    row = await ExitRequest.create({
      employeeId: targetId,
      employeeName: `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim(),
      initiatedByEmployeeId: actor?.employeeId ?? null,
      initiatedAt: new Date(),
      reason: dto.reason,
      reasonCategory: dto.reasonCategory,
      requestedLastDay: dto.requestedLastDay,
      status: 'initiated',
    });
  } catch (error) {
    // The partial unique index is what makes "one live exit" true under two
    // simultaneous requests; the read above only produces the better message.
    if (error?.code === 11000) {
      throw new HrmsConflictError('That employee already has an exit in progress.', {
        code: 'EXIT_ALREADY_IN_PROGRESS',
      });
    }
    throw error;
  }

  const [dtoOut] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_INITIATED,
    `Initiated exit for ${dtoOut.employeeName} (last day ${dto.requestedLastDay})`,
    context.req,
    {
      meta: {
        exitRequestId: dtoOut.id,
        employeeId: targetId,
        reasonCategory: dto.reasonCategory,
      },
    },
  );

  /**
   * The reference's `exit.initiated`, to the reporting manager and to HR.
   *
   * The reference de-duplicates by hand here with a `notified` Set — the one
   * producer of its twenty that remembers to. `notify` does it for every
   * caller, so a manager who is also the HR contact is told once.
   *
   * 🔴 No reason in the body. The reference puts `dto.reason` — why somebody is
   * leaving — into the notification and into an outbound email.
   */
  await notify({
    to: await exitApprovers(employee?.reportingManagerId ?? null),
    type: INBOX_TYPES.EXIT_INITIATED,
    title: `${dtoOut.employeeName} has initiated an exit`,
    body: `Requested last day: ${dto.requestedLastDay}.`,
    entity: 'exit_request',
    entityId: dtoOut.id,
  });

  return dtoOut;
}

/**
 * Who is told an exit has started: the reporting manager, and HR.
 *
 * Resolved from the employee's own reporting line and from the role matrix —
 * never from the request.
 */
async function exitApprovers(managerEmployeeId) {
  const assignees = await resolveAreaAssignees(managerEmployeeId);
  return [assignees.manager?.id, assignees.hr?.id].filter(Boolean).map(idStr);
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function managerApprove(id, actor, context = {}) {
  const row = await loadForWrite(id, actor);

  if (row.status !== 'initiated') {
    throw new HrmsConflictError(
      `An exit can only be manager-approved while it is initiated; this one is ${row.status}.`,
      { code: 'EXIT_BAD_STATE' },
    );
  }

  // Nobody approves their own exit, however senior.
  if (idStr(row.employeeId) === idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('You cannot approve your own exit.');
  }

  const hr = isHr(actor);
  let allowed = hr;
  if (!allowed && hasHrmsPermission(actor, M.EXITS, A.APPROVE, S.TEAM)) {
    const employee = await Employee.findOne({ _id: row.employeeId })
      .select('reportingManagerId managerChain')
      .lean();
    const chain = (employee?.managerChain ?? []).map(idStr);
    allowed =
      idStr(employee?.reportingManagerId) === idStr(actor.employeeId) ||
      chain.includes(idStr(actor.employeeId));
  }
  if (!allowed) {
    throw new HrmsForbiddenError('Only the reporting manager or HR can approve this exit.');
  }

  row.status = 'manager_approved';
  row.managerApprovedAt = new Date();
  row.managerApprovedByEmployeeId = actor?.employeeId ?? null;
  await row.save();

  const [dto] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_MANAGER_APPROVED,
    `Manager-approved the exit for ${dto.employeeName}`,
    context.req,
    { meta: { exitRequestId: dto.id } },
  );
  return dto;
}

/**
 * HR approval. Moves the request into the notice period.
 *
 * The reference writes `in_notice` here too, despite declaring an
 * `hr_approved` state — so this is what it does, minus the dead value.
 * Additionally, the EMPLOYEE is moved onto notice, which the reference never
 * does: it has a `notice` employee status and an `in_notice` exit status and
 * never connects the two.
 */
export async function hrApprove(id, actor, context = {}) {
  if (!isHr(actor)) throw new HrmsForbiddenError('Only HR can approve an exit.');
  const row = await loadForWrite(id, actor);

  if (row.status !== 'manager_approved') {
    throw new HrmsConflictError(
      `An exit can only be HR-approved after the manager has approved it; this one is ${row.status}.`,
      { code: 'EXIT_BAD_STATE' },
    );
  }
  if (idStr(row.employeeId) === idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('You cannot approve your own exit.');
  }

  row.status = 'in_notice';
  row.hrApprovedAt = new Date();
  row.hrApprovedByEmployeeId = actor?.employeeId ?? null;
  await row.save();

  await Employee.updateOne(
    { _id: row.employeeId, deletedAt: null, status: { $nin: ['exited', 'inactive'] } },
    {
      $set: {
        status: 'notice',
        noticeStartDate: new Date(),
        noticeEndDate: new Date(`${row.actualLastDay ?? row.requestedLastDay}T00:00:00.000Z`),
      },
    },
  );

  const [dto] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_HR_APPROVED,
    `HR-approved the exit for ${dto.employeeName}; employee moved to notice`,
    context.req,
    { meta: { exitRequestId: dto.id, employeeId: idStr(row.employeeId) } },
  );
  return dto;
}

// ---------------------------------------------------------------------------
// Clearances
// ---------------------------------------------------------------------------

/**
 * Open the five clearances and assign each to its area owner.
 *
 * Only from `in_notice`. The reference also accepts `manager_approved`, which
 * walks straight past the HR gate it defines one method earlier.
 */
export async function openClearances(id, actor, context = {}) {
  if (!isHr(actor)) throw new HrmsForbiddenError('Only HR can open clearances.');
  const row = await loadForWrite(id, actor);

  if (row.status !== 'in_notice') {
    throw new HrmsConflictError(
      `Clearances open once the notice period starts; this exit is ${row.status}.`,
      { code: 'EXIT_BAD_STATE' },
    );
  }
  if ((row.clearances ?? []).length > 0) {
    throw new HrmsConflictError('Clearances are already open for this exit.', {
      code: 'EXIT_CLEARANCES_OPEN',
    });
  }

  const employee = await Employee.findOne({ _id: row.employeeId })
    .select('reportingManagerId')
    .lean();

  const assignees = await resolveAreaAssignees(employee?.reportingManagerId ?? null);

  row.clearances = CLEARANCE_AREAS.map((area) => ({
    area,
    assigneeEmployeeId: assignees[area]?.id ?? null,
    assigneeName: assignees[area]?.name ?? '',
    status: 'pending',
  }));
  row.status = 'clearance_pending';
  await row.save();

  const [dto] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_CLEARANCES_OPENED,
    `Opened ${row.clearances.length} clearances for ${dto.employeeName}`,
    context.req,
    { meta: { exitRequestId: dto.id, areas: CLEARANCE_AREAS } },
  );

  /**
   * The reference's `exit.clearance`, one per area, to whoever owns it.
   *
   * An area with nobody assigned notifies nobody — an unassigned clearance is
   * a visible gap in the queue, not a message sent into the void.
   */
  for (const clearance of row.clearances) {
    if (!clearance.assigneeEmployeeId) continue;
    await notify({
      to: idStr(clearance.assigneeEmployeeId),
      type: INBOX_TYPES.EXIT_CLEARANCE,
      title: `${dto.employeeName} — ${clearance.area} clearance`,
      body: 'Awaiting your sign-off.',
      entity: 'exit_request',
      entityId: dto.id,
    });
  }

  return dto;
}

/**
 * Who owns each clearance area.
 *
 * The reference resolves these to USERS by role key. Here they resolve to
 * employees, because every scope check in this codebase is employee-based and
 * an employee-keyed assignee is what lets the clearance queue be filtered by
 * the server rather than in the browser.
 *
 * An area with nobody to own it is left unassigned rather than silently given
 * to HR — an unassigned clearance is visible as a gap; a misassigned one is not.
 * The reference falls back to the HR admin for `finance` with the comment
 * "fallback until payroll admin resolver"; a payroll admin exists here.
 */
async function resolveAreaAssignees(managerEmployeeId) {
  const { HRMS_ROLES: R } = await import('../../../shared/permissions/constants.js');

  const byRole = async (roles) => {
    const User = (await import('../../../models/User.js')).default;
    const user = await User.findOne({
      roles: { $in: roles },
      status: 'Active',
    })
      .select('_id')
      .lean();
    if (!user) return null;
    const employee = await Employee.findOne({ userId: user._id, deletedAt: null })
      .select('_id firstName lastName')
      .lean();
    return employee
      ? {
          id: employee._id,
          name: `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim(),
        }
      : null;
  };

  const [it, finance, hr] = await Promise.all([
    byRole([R.IT_ADMIN]),
    byRole([R.PAYROLL_ADMIN]),
    byRole([R.HR_ADMIN, R.SUPER_ADMIN]),
  ]);

  let manager = null;
  if (managerEmployeeId) {
    const row = await Employee.findOne({ _id: managerEmployeeId, deletedAt: null })
      .select('_id firstName lastName')
      .lean();
    if (row) {
      manager = {
        id: row._id,
        name: `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim(),
      };
    }
  }

  return { it, finance, admin: hr, hr, manager };
}

/**
 * Update one clearance, and auto-advance the request when the last one lands.
 *
 * Writable by the assignee or by HR — the reference's rule, kept.
 */
export async function updateClearance(id, clearanceId, input, actor, context = {}) {
  const dto = parse(updateClearanceSchema, input, 'clearance');
  const row = await loadForWrite(id, actor);

  const clearance = (row.clearances ?? []).id(clearanceId);
  if (!clearance) throw new HrmsNotFoundError('Clearance');

  if (row.status !== 'clearance_pending') {
    throw new HrmsConflictError(
      `Clearances can only be worked while the exit is awaiting clearance; this one is ${row.status}.`,
      { code: 'EXIT_BAD_STATE' },
    );
  }

  const hr = isHr(actor);
  const isAssignee =
    Boolean(actor?.employeeId) &&
    idStr(clearance.assigneeEmployeeId) === idStr(actor.employeeId);
  if (!hr && !isAssignee) {
    throw new HrmsForbiddenError('Only the assignee or HR can update this clearance.');
  }

  // The leaver never signs off their own clearance, even if they happen to be
  // the area owner — the manager area of a manager's own exit, for instance.
  if (idStr(row.employeeId) === idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('You cannot sign off a clearance on your own exit.');
  }

  if (dto.status !== undefined) clearance.status = dto.status;
  if (dto.notes !== undefined) clearance.notes = dto.notes;
  if (TERMINAL_CLEARANCE_STATUSES.includes(clearance.status)) {
    clearance.completedAt = clearance.completedAt ?? new Date();
    clearance.completedByEmployeeId = actor?.employeeId ?? null;
  } else {
    clearance.completedAt = null;
    clearance.completedByEmployeeId = null;
  }

  const outstanding = row.clearances.filter(
    (c) => !TERMINAL_CLEARANCE_STATUSES.includes(c.status),
  ).length;
  if (outstanding === 0) row.status = 'cleared';

  await row.save();

  const [dtoOut] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_CLEARANCE_UPDATED,
    `Set the ${clearance.area} clearance for ${dtoOut.employeeName} to ${clearance.status}`,
    context.req,
    {
      meta: {
        exitRequestId: dtoOut.id,
        area: clearance.area,
        status: clearance.status,
        remaining: outstanding,
      },
    },
  );
  return dtoOut;
}

// ---------------------------------------------------------------------------
// Handover / edit
// ---------------------------------------------------------------------------

/**
 * HR edits the handover details and the actual last day.
 *
 * Refused once the record is terminal. The reference has no status guard here,
 * so it will rewrite `actualLastDay` on a closed exit — after the relieving
 * letter has already been generated stating that date.
 */
export async function updateExit(id, input, actor, context = {}) {
  if (!isHr(actor)) throw new HrmsForbiddenError('Only HR can edit an exit request.');
  const dto = parse(updateExitRequestSchema, input, 'exit request');
  const row = await loadForWrite(id, actor);

  if (row.status === 'closed' || row.status === 'cancelled') {
    throw new HrmsConflictError(
      `A ${row.status} exit can no longer be edited.`,
      { code: 'EXIT_TERMINAL' },
    );
  }

  if (dto.replacementEmployeeId) {
    if (idStr(dto.replacementEmployeeId) === idStr(row.employeeId)) {
      throw new HrmsValidationError('The leaver cannot be their own replacement.');
    }
    const replacement = await Employee.findOne({
      _id: dto.replacementEmployeeId,
      deletedAt: null,
    }).lean();
    if (!replacement) throw new HrmsValidationError('That replacement employee does not exist.');
  }

  if (dto.actualLastDay !== undefined) row.actualLastDay = dto.actualLastDay;
  if (dto.replacementEmployeeId !== undefined) {
    row.replacementEmployeeId = dto.replacementEmployeeId;
  }
  if (dto.transferNotes !== undefined) row.transferNotes = dto.transferNotes;
  await row.save();

  const [dtoOut] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_UPDATED,
    `Updated the exit handover details for ${dtoOut.employeeName}`,
    context.req,
    { meta: { exitRequestId: dtoOut.id, fields: Object.keys(dto) } },
  );
  return dtoOut;
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Withdraw an exit.
 *
 * Stops once the settlement has been computed. The reference allows an employee
 * to cancel from `cleared` or `f_and_f_pending` — after every area has signed
 * off and the money has been worked out.
 */
export async function cancelExit(id, actor, context = {}) {
  const row = await loadForWrite(id, actor);

  const hr = isHr(actor);
  const isSelf = idStr(row.employeeId) === idStr(actor?.employeeId);
  if (!hr && !isSelf) {
    throw new HrmsForbiddenError('Only the employee or HR can cancel an exit.');
  }

  if (row.status === 'closed' || row.status === 'cancelled') {
    throw new HrmsConflictError(`This exit is already ${row.status}.`, {
      code: 'EXIT_TERMINAL',
    });
  }
  if (!hr && (row.status === 'cleared' || row.status === 'f_and_f_pending')) {
    throw new HrmsForbiddenError(
      'Your clearances are already complete — ask HR to withdraw this exit.',
    );
  }

  const wasStatus = row.status;
  row.status = 'cancelled';
  row.cancelledAt = new Date();
  await row.save();

  // Put the employee back where they were. Leaving them on notice after the
  // exit is withdrawn would quietly keep them in every "leaving soon" report.
  await Employee.updateOne(
    { _id: row.employeeId, deletedAt: null, status: 'notice' },
    { $set: { status: 'active', noticeStartDate: null, noticeEndDate: null } },
  );

  const [dto] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_CANCELLED,
    `Cancelled the exit for ${dto.employeeName} (was ${wasStatus})`,
    context.req,
    { meta: { exitRequestId: dto.id, previousStatus: wasStatus } },
  );
  return dto;
}

// ---------------------------------------------------------------------------
// Full and final
// ---------------------------------------------------------------------------

/**
 * What the settlement WOULD be. Reads only.
 *
 * The reference's preview shares its `compute()` with `create()`, and that
 * function zeroes the employee's loan balances — so its preview is a GET that
 * destroys data, fired automatically by its own drawer.
 */
export async function previewSettlement(id, actor) {
  if (!isHr(actor)) throw new HrmsForbiddenError('Only HR can compute a settlement.');
  const row = await loadVisible(id, actor);
  return computeSettlement(row);
}

export async function createSettlement(id, actor, context = {}) {
  if (!isHr(actor)) throw new HrmsForbiddenError('Only HR can create a settlement.');
  const row = await loadForWrite(id, actor);

  if (row.status !== 'cleared') {
    throw new HrmsConflictError(
      `A settlement is computed once every clearance is done; this exit is ${row.status}.`,
      { code: 'EXIT_BAD_STATE' },
    );
  }
  if (row.fullAndFinal) {
    throw new HrmsConflictError('A settlement already exists for this exit.', {
      code: 'EXIT_FNF_EXISTS',
    });
  }

  const computed = await computeSettlement(row);
  if (!computed.computable) {
    throw new HrmsValidationError(computed.notes[0] ?? 'This settlement cannot be computed.');
  }

  row.fullAndFinal = {
    gross: toDecimal(computed.gross),
    deductions: toDecimal(computed.deductions),
    netPayable: toDecimal(computed.netPayable),
    earnings: computed.earnings.map((l) => ({ ...l, amount: toDecimal(l.amount) })),
    deductionLines: computed.deductionLines.map((l) => ({
      ...l,
      amount: toDecimal(l.amount),
    })),
    leaveEncashment: toDecimal(computed.leaveEncashment),
    gratuity: toDecimal(computed.gratuity),
    noticeAdjustment: toDecimal(computed.noticeAdjustment),
    computedAt: new Date(),
  };
  row.status = 'f_and_f_pending';
  await row.save();

  const [dto] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_FNF_CREATED,
    `Computed the full-and-final settlement for ${dto.employeeName}`,
    context.req,
    { meta: { exitRequestId: dto.id, netPayable: computed.netPayable } },
  );
  return dto;
}

/**
 * Pay the settlement and close the exit.
 *
 * Guarded on status, which the reference is not — it checks only "not already
 * disbursed", so any request carrying an F&F row can be jumped to `closed`.
 */
export async function disburseSettlement(id, actor, context = {}) {
  if (!isHr(actor)) throw new HrmsForbiddenError('Only HR can disburse a settlement.');
  const row = await loadForWrite(id, actor);

  if (row.status !== 'f_and_f_pending') {
    throw new HrmsConflictError(
      `A settlement can only be disbursed while it is pending; this exit is ${row.status}.`,
      { code: 'EXIT_BAD_STATE' },
    );
  }
  if (!row.fullAndFinal) throw new HrmsConflictError('No settlement has been computed yet.');
  if (row.fullAndFinal.disbursedAt) {
    throw new HrmsConflictError('This settlement has already been disbursed.', {
      code: 'EXIT_FNF_DISBURSED',
    });
  }

  const lastDay = row.actualLastDay ?? row.requestedLastDay;
  row.fullAndFinal.disbursedAt = new Date();
  row.actualLastDay = lastDay;
  row.status = 'closed';
  row.closedAt = new Date();
  await row.save();

  // The one lifecycle transition the exit workflow owns.
  await Employee.updateOne(
    { _id: row.employeeId, deletedAt: null },
    { $set: { status: 'exited', noticeEndDate: new Date(`${lastDay}T00:00:00.000Z`) } },
  );

  const [dto] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_FNF_DISBURSED,
    `Disbursed the settlement and closed the exit for ${dto.employeeName}`,
    context.req,
    { meta: { exitRequestId: dto.id, employeeId: idStr(row.employeeId), lastDay } },
  );
  return dto;
}

// ---------------------------------------------------------------------------
// Relieving letter
// ---------------------------------------------------------------------------

export async function generateRelievingLetter(id, actor, context = {}) {
  if (!isHr(actor)) throw new HrmsForbiddenError('Only HR can generate a relieving letter.');
  const row = await loadForWrite(id, actor);

  if (row.status !== 'closed') {
    throw new HrmsConflictError(
      `A relieving letter is issued once the exit is closed; this one is ${row.status}.`,
      { code: 'EXIT_BAD_STATE' },
    );
  }
  if (row.relievingLetter?.storageKey) {
    throw new HrmsConflictError('A relieving letter has already been generated.', {
      code: 'EXIT_LETTER_EXISTS',
    });
  }

  const employee = await Employee.findOne({ _id: row.employeeId }).lean();
  const pdf = await renderRelievingLetter({
    employeeName: row.employeeName,
    designation: employee?.designation ?? '',
    dateOfJoining: employee?.dateOfJoining
      ? new Date(employee.dateOfJoining).toISOString().slice(0, 10)
      : '',
    lastWorkingDay: row.actualLastDay ?? row.requestedLastDay,
  });

  // Through the storage layer, which mints the key. The reference writes the
  // PDF to instance disk and keeps a path.
  const { key } = await putObject({
    category: STORAGE_CATEGORIES.LETTER,
    body: pdf,
    contentType: 'application/pdf',
    scope: idStr(row.employeeId),
    filename: 'relieving-letter.pdf',
    size: pdf.length,
  });

  row.relievingLetter = { storageKey: key, generatedAt: new Date() };
  await row.save();

  const [dto] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXIT_LETTER_GENERATED,
    `Generated the relieving letter for ${dto.employeeName}`,
    context.req,
    { meta: { exitRequestId: dto.id } },
  );
  return dto;
}

/** The storage key for a letter this actor may read. */
export async function relievingLetterKey(id, actor) {
  const row = await loadVisible(id, actor);
  if (!row.relievingLetter?.storageKey) {
    throw new HrmsNotFoundError('Relieving letter');
  }
  return row.relievingLetter.storageKey;
}

/**
 * The storage layer's rule for a relieving-letter object.
 *
 * Registered at bootstrap. Resolving by KEY means the rule holds even if a URL
 * is requested through the generic file endpoint rather than through an exit.
 *
 * The permission list deliberately omits TEAM scope: a manager who could watch
 * their report's exit progress has no claim on the letter afterwards. Only the
 * person who left and HR can read it.
 */
export async function resolveLetterAccess(key) {
  const row = await ExitRequest.findOne({
    'relievingLetter.storageKey': key,
    deletedAt: null,
  })
    .select('employeeId')
    .lean();
  if (!row) return null;

  const employee = await Employee.findById(row.employeeId)
    .select('_id userId departmentId managerChain reportingManagerId deletedAt')
    .lean();
  if (!employee) return null;

  return {
    owner: {
      ownerUserId: idStr(employee.userId) ?? undefined,
      ownerEmployeeId: idStr(employee._id),
      ownerDepartmentId: idStr(employee.departmentId) ?? undefined,
      ownerManagerChain: (employee.managerChain ?? []).map(idStr),
    },
    permissions: [
      { module: M.EXITS, action: A.VIEW, scope: S.ORG },
      { module: M.EXITS, action: A.VIEW, scope: S.SELF },
    ],
  };
}

export default {
  listExits,
  myExit,
  getExit,
  initiateExit,
  managerApprove,
  hrApprove,
  openClearances,
  updateClearance,
  updateExit,
  cancelExit,
  previewSettlement,
  createSettlement,
  disburseSettlement,
  generateRelievingLetter,
  relievingLetterKey,
  resolveLetterAccess,
};
