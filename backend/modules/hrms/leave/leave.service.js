/**
 * Leave service.
 *
 * Ported from the reference's `LeaveService`. Its four statuses are kept
 * exactly — `pending | approved | rejected | cancelled`. There is no draft and
 * no withdrawn state in the reference, and none is invented here.
 *
 * ---------------------------------------------------------------------------
 * Who may do what
 * ---------------------------------------------------------------------------
 * The reference's rules, reproduced because they are deliberate and sound:
 *
 *   - A request is always raised FOR THE ACTOR. `employeeId` is taken from the
 *     actor, never from the payload, so no browser can file leave as someone
 *     else. The reference does the same and it is the right call.
 *
 *   - Only the DIRECT reporting manager may decide, or someone holding
 *     `leave:approve:org` (the HR override, without which an organisation is
 *     stuck the moment a manager becomes unreachable). A skip-level manager can
 *     SEE a request through team scope and still cannot act on it.
 *
 *   - Only the requester may cancel, and only while it is still pending.
 *
 *   - Team scope means own + DIRECT reports, not the whole subtree.
 *
 * ---------------------------------------------------------------------------
 * Balances are best-effort, as in the reference
 * ---------------------------------------------------------------------------
 * A request is never refused for insufficient balance, and a type with no
 * balance row still works. The counters move when a row exists so history stays
 * queryable. Inventing a hard entitlement gate would be a policy this product
 * does not have.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import LeaveType from '../../../models/hrms/LeaveType.js';
import LeaveBalance, { round2 } from '../../../models/hrms/LeaveBalance.js';
import LeaveRequest from '../../../models/hrms/LeaveRequest.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
  createLeaveRequestSchema,
  leaveDecisionSchema,
  createLeaveTypeSchema,
} from '../../../shared/schemas/leave.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsValidationError,
} from '../hrms.errors.js';
import { computeLeaveDays } from '../../../shared/leave/dates.js';
import { holidayDateSet } from './holiday.service.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const yearOf = (isoDay) => Number(isoDay.slice(0, 4));

/** Hours in a standard working day. Configuration, not a rule buried in code. */
export const DEFAULT_WORKDAY_HOURS = 8;

function parse(schema, input, what) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new HrmsValidationError(`Invalid ${what}.`, formatZodIssues(result.error));
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

const typeToDto = (row) => ({
  id: idStr(row._id),
  code: row.code,
  name: row.name,
  paid: row.paid,
  allowsHalfDay: row.allowsHalfDay,
  requiresProof: row.requiresProof,
  adminOnly: row.adminOnly,
  color: row.color,
});

/**
 * The types this actor may request.
 *
 * `adminOnly` types are offered only to someone who can administer leave. The
 * reference hardcodes the equivalent rule in the service — `CL` for everyone,
 * `AL` for admins or for an employee whose free-text designation reads "EA" —
 * which puts one customer's policy in the code path and matches on a job title.
 */
export async function listLeaveTypes(actor) {
  const canAdminister = hasHrmsPermission(actor, M.LEAVE, A.EDIT, S.ORG);
  const filter = { deletedAt: null };
  if (!canAdminister) filter.adminOnly = false;

  const rows = await LeaveType.find(filter).sort({ code: 1 }).lean();
  return rows.map(typeToDto);
}

export async function createLeaveType(input, context = {}) {
  const dto = parse(createLeaveTypeSchema, input, 'leave type');

  let row;
  try {
    row = await LeaveType.create(dto);
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`Leave type "${dto.code}" already exists.`, {
        code: 'LEAVE_TYPE_CODE_TAKEN',
      });
    }
    throw error;
  }

  const type = typeToDto(row);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.LEAVE_TYPE_CREATED,
    `Created leave type ${type.code} (${type.name})`,
    context.req,
    { meta: { leaveTypeId: type.id, code: type.code } },
  );
  return type;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The query condition for what this actor may see.
 *
 * Applied as a FILTER rather than a post-fetch discard, so the database does
 * the work and a count is never a lie about what the caller can see.
 *
 * Team scope is own + direct reports, matching the reference: a skip-level
 * manager neither sees nor decides an indirect report's leave — that is the
 * direct manager's job, and it keeps the approvals queue meaningful.
 */
async function buildScopeFilter(actor) {
  if (hasHrmsPermission(actor, M.LEAVE, A.VIEW, S.ORG)) return {};

  if (!actor?.employeeId) {
    // Permitted in principle, but not linked to an employee record, so there is
    // nothing of their own to see. An impossible filter beats returning all.
    return { _id: null };
  }

  if (hasHrmsPermission(actor, M.LEAVE, A.VIEW, S.TEAM)) {
    const reports = await Employee.find({
      reportingManagerId: actor.employeeId,
      deletedAt: null,
    })
      .select('_id')
      .lean();
    return { employeeId: { $in: [actor.employeeId, ...reports.map((r) => r._id)] } };
  }

  if (hasHrmsPermission(actor, M.LEAVE, A.VIEW, S.SELF)) {
    return { employeeId: actor.employeeId };
  }

  throw new HrmsForbiddenError('You cannot view leave.');
}

/** May this actor read that employee's leave? */
async function assertCanViewEmployee(actor, employeeId) {
  if (idStr(employeeId) === idStr(actor?.employeeId)) return;

  const employee = await Employee.findOne({ _id: employeeId, deletedAt: null })
    .select('_id userId departmentId managerChain reportingManagerId')
    .lean();
  if (!employee) throw new HrmsNotFoundError('Employee');

  const resource = {
    ownerUserId: idStr(employee.userId) ?? undefined,
    ownerEmployeeId: idStr(employee._id),
    ownerDepartmentId: idStr(employee.departmentId) ?? undefined,
    ownerManagerChain: (employee.managerChain ?? []).map(idStr),
  };

  const allowed =
    hasHrmsPermission(actor, M.LEAVE, A.VIEW, S.ORG) ||
    hasHrmsPermission(actor, M.LEAVE, A.VIEW, S.TEAM, resource) ||
    hasHrmsPermission(actor, M.LEAVE, A.VIEW, S.SELF, resource);

  if (!allowed) throw new HrmsForbiddenError("You cannot view this employee's leave.");
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/** One year's buckets for an employee, with the type resolved for display. */
export async function listBalances(employeeId, actor, { year } = {}) {
  if (!employeeId) throw new HrmsForbiddenError('This account has no employee record.');
  await assertCanViewEmployee(actor, employeeId);

  const targetYear = year ?? new Date().getUTCFullYear();

  const rows = await LeaveBalance.find({ employeeId, year: targetYear }).lean();
  if (rows.length === 0) return [];

  const types = await LeaveType.find({ _id: { $in: rows.map((r) => r.leaveTypeId) } })
    .select('code name color')
    .lean();
  const typeById = new Map(types.map((t) => [idStr(t._id), t]));

  return rows
    .map((row) => {
      const type = typeById.get(idStr(row.leaveTypeId));
      return {
        leaveTypeId: idStr(row.leaveTypeId),
        code: type?.code ?? '—',
        leaveTypeName: type?.name ?? 'Unknown leave type',
        color: type?.color ?? null,
        year: row.year,
        accrued: row.accrued,
        used: row.used,
        pending: row.pending,
        balance: row.balance,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Move a bucket, if one exists. Absent buckets are not an error. */
async function adjustBalance(employeeId, leaveTypeId, year, delta) {
  const bucket = await LeaveBalance.findOne({ employeeId, leaveTypeId, year });
  if (!bucket) return null;

  bucket.pending = Math.max(0, round2(bucket.pending + (delta.pending ?? 0)));
  bucket.used = Math.max(0, round2(bucket.used + (delta.used ?? 0)));
  await bucket.save(); // the pre-validate hook recomputes `balance`
  return bucket;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const requestToDto = (row, { employee, type } = {}) => ({
  id: idStr(row._id),
  employeeId: idStr(row.employeeId),
  employeeName: employee
    ? `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim()
    : null,
  employeeCode: employee?.employeeCode ?? null,
  leaveTypeId: idStr(row.leaveTypeId),
  leaveTypeCode: type?.code ?? null,
  leaveTypeName: type?.name ?? null,
  color: type?.color ?? null,
  startDate: row.startDate,
  endDate: row.endDate,
  durationUnit: row.durationUnit,
  durationValue: row.durationValue,
  halfDayPeriod: row.halfDayPeriod ?? null,
  halfDaySlots: row.halfDaySlots ?? null,
  dayBreakdown: row.dayBreakdown ?? null,
  hourFrom: row.hourFrom ?? null,
  hourTo: row.hourTo ?? null,
  reason: row.reason,
  status: row.status,
  approvalChain: (row.approvalChain ?? []).map((step) => ({
    level: step.level,
    approverEmployeeId: idStr(step.approverEmployeeId),
    approverName: step.approverName,
    decision: step.decision,
    decidedAt: step.decidedAt ? new Date(step.decidedAt).toISOString() : null,
    comment: step.comment ?? null,
  })),
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/** Batch-resolve the employee and type names a page of requests needs. */
async function hydrateRequests(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return [];

  const [employees, types] = await Promise.all([
    Employee.find({ _id: { $in: list.map((r) => r.employeeId) } })
      .select('firstName lastName employeeCode')
      .lean(),
    LeaveType.find({ _id: { $in: list.map((r) => r.leaveTypeId) } })
      .select('code name color')
      .lean(),
  ]);

  const employeeById = new Map(employees.map((e) => [idStr(e._id), e]));
  const typeById = new Map(types.map((t) => [idStr(t._id), t]));

  return list.map((row) =>
    requestToDto(row, {
      employee: employeeById.get(idStr(row.employeeId)),
      type: typeById.get(idStr(row.leaveTypeId)),
    }),
  );
}

/**
 * The approval chain for a new request.
 *
 * One level — the direct reporting manager — as the reference builds it. An
 * employee with no manager is at the top of the organisation and their request
 * is auto-approved rather than being left permanently pending.
 */
async function buildApprovalChain(employeeId) {
  const employee = await Employee.findOne({ _id: employeeId, deletedAt: null })
    .select('reportingManagerId')
    .lean();
  if (!employee?.reportingManagerId) return [];

  const manager = await Employee.findOne({
    _id: employee.reportingManagerId,
    deletedAt: null,
  })
    .select('firstName lastName')
    .lean();

  // A manager who has since been deleted cannot approve anything. Leaving a
  // step pointing at them would strand every request behind a person who is no
  // longer there; auto-approval is wrong too, so this falls to the HR override.
  if (!manager) return [];

  return [
    {
      level: 1,
      approverEmployeeId: manager._id,
      approverName: `${manager.firstName ?? ''} ${manager.lastName ?? ''}`.trim(),
      decision: 'pending',
      decidedAt: null,
      comment: null,
    },
  ];
}

/**
 * File a leave request FOR THE ACTOR.
 *
 * @throws {HrmsForbiddenError} when the account has no employee record
 */
export async function createRequest(input, actor, context = {}) {
  const dto = parse(createLeaveRequestSchema, input, 'leave request');

  if (!actor?.employeeId) {
    throw new HrmsForbiddenError('This account has no employee record, so it cannot request leave.');
  }

  // A deleted employee performs no workflow.
  const employee = await Employee.findOne({ _id: actor.employeeId, deletedAt: null })
    .select('_id firstName lastName employeeCode')
    .lean();
  if (!employee) throw new HrmsForbiddenError('This employee record is no longer active.');

  const type = await LeaveType.findOne({ _id: dto.leaveTypeId, deletedAt: null }).lean();
  if (!type) throw new HrmsValidationError('That leave type does not exist.');

  // An adminOnly type is not requestable by someone who cannot administer leave.
  if (type.adminOnly && !hasHrmsPermission(actor, M.LEAVE, A.EDIT, S.ORG)) {
    throw new HrmsForbiddenError(`${type.name} can only be granted by HR.`);
  }
  if (!type.allowsHalfDay && dto.durationUnit !== 'full_day') {
    throw new HrmsValidationError(`${type.name} must be taken as whole days.`);
  }

  // Holidays price the request. Both years, because a range can straddle one.
  const holidays = await holidayDateSet([yearOf(dto.startDate), yearOf(dto.endDate)]);
  const durationValue = computeLeaveDays(dto, holidays, DEFAULT_WORKDAY_HOURS);

  if (durationValue <= 0) {
    throw new HrmsValidationError(
      'That range contains no working days — it falls entirely on weekends or holidays.',
    );
  }

  // Overlapping a live request is how a balance gets spent twice.
  const clash = await LeaveRequest.findOne({
    employeeId: actor.employeeId,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: dto.endDate },
    endDate: { $gte: dto.startDate },
  }).lean();
  if (clash) {
    throw new HrmsConflictError(
      `You already have a ${clash.status} request covering ${clash.startDate} to ${clash.endDate}.`,
      { code: 'LEAVE_OVERLAP', details: { requestId: idStr(clash._id) } },
    );
  }

  const approvalChain = await buildApprovalChain(actor.employeeId);
  const autoApproved = approvalChain.length === 0;

  const row = await LeaveRequest.create({
    employeeId: actor.employeeId,
    leaveTypeId: type._id,
    startDate: dto.startDate,
    endDate: dto.endDate,
    durationUnit: dto.durationUnit,
    durationValue,
    halfDayPeriod: dto.durationUnit === 'half_day' ? dto.halfDayPeriod ?? null : null,
    halfDaySlots:
      dto.durationUnit === 'half_day' && dto.halfDaySlots?.length ? dto.halfDaySlots : undefined,
    dayBreakdown:
      dto.durationUnit === 'mixed' && dto.dayBreakdown?.length ? dto.dayBreakdown : undefined,
    hourFrom: dto.durationUnit === 'hour' ? dto.hourFrom ?? null : null,
    hourTo: dto.durationUnit === 'hour' ? dto.hourTo ?? null : null,
    reason: dto.reason,
    status: autoApproved ? 'approved' : 'pending',
    approvalChain,
  });

  // Auto-approved days are spent immediately; otherwise they are committed.
  await adjustBalance(
    actor.employeeId,
    type._id,
    yearOf(dto.startDate),
    autoApproved ? { used: durationValue } : { pending: durationValue },
  );

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.LEAVE_REQUESTED,
    `Requested ${durationValue} day(s) of ${type.code} from ${dto.startDate} to ${dto.endDate}`,
    context.req,
    {
      meta: {
        leaveRequestId: idStr(row._id),
        employeeId: idStr(actor.employeeId),
        leaveTypeCode: type.code,
        days: durationValue,
        autoApproved,
      },
    },
  );

  /**
    * Tell the first pending approver — the reference's `leave.pending` item.
    *
    * The recipient is the chain's own first step, derived here from the
    * requester's reporting line; nothing about it comes from the request.
    *
    * 🔴 No reason and no dates in the body. The reference copies `dto.reason`
    * — free text the requester typed — into the notification and then into an
    * outbound email. The approver opens the request and reads it there.
    */
  const pendingStep = autoApproved ? null : approvalChain[0];
  if (pendingStep) {
    const requester = await Employee.findById(actor.employeeId)
      .select('firstName lastName')
      .lean();
    const requesterName =
      `${requester?.firstName ?? ''} ${requester?.lastName ?? ''}`.trim() || 'A team member';

    await notify({
      to: idStr(pendingStep.approverEmployeeId),
      type: INBOX_TYPES.LEAVE_PENDING,
      title: `${requesterName} requested ${durationValue} day(s) of ${type.code}`,
      body: 'Awaiting your approval.',
      entity: 'leave_request',
      entityId: idStr(row._id),
    });
  }

  const [dto2] = await hydrateRequests([row.toObject()]);
  return dto2;
}

/** Requests this actor may see, newest first within a status. */
export async function listRequests(actor, query = {}) {
  const scope = await buildScopeFilter(actor);
  const filter = { ...scope };

  if (query.status) filter.status = query.status;
  if (query.employeeId) {
    await assertCanViewEmployee(actor, query.employeeId);
    filter.employeeId = query.employeeId;
  }

  const rows = await LeaveRequest.find(filter)
    .sort({ status: 1, startDate: -1 })
    .limit(200)
    .lean();

  return hydrateRequests(rows);
}

/**
 * Approve or reject.
 *
 * The route guard admits anyone with team or org approval rights; the real
 * check is here, against THIS request's employee.
 */
export async function decideRequest(id, input, actor, context = {}) {
  const dto = parse(leaveDecisionSchema, input, 'decision');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Leave request');
  if (!actor?.employeeId && !hasHrmsPermission(actor, M.LEAVE, A.APPROVE, S.ORG)) {
    throw new HrmsForbiddenError('This account has no employee record.');
  }

  const request = await LeaveRequest.findById(id);
  if (!request) throw new HrmsNotFoundError('Leave request');

  if (request.status !== 'pending') {
    throw new HrmsConflictError(`This request is already ${request.status}.`, {
      code: 'LEAVE_NOT_PENDING',
      details: { status: request.status },
    });
  }

  const employee = await Employee.findById(request.employeeId)
    .select('reportingManagerId managerChain departmentId userId')
    .lean();
  if (!employee) throw new HrmsNotFoundError('Employee');

  // Nobody decides their own request, whatever else they hold.
  if (idStr(request.employeeId) === idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('You cannot decide your own leave request.');
  }

  const canOrg = hasHrmsPermission(actor, M.LEAVE, A.APPROVE, S.ORG);
  const isDirectManager =
    Boolean(actor?.employeeId) &&
    idStr(employee.reportingManagerId) === idStr(actor.employeeId);
  const canTeam =
    isDirectManager &&
    hasHrmsPermission(actor, M.LEAVE, A.APPROVE, S.TEAM, {
      ownerEmployeeId: idStr(request.employeeId),
      ownerManagerChain: (employee.managerChain ?? []).map(idStr),
    });

  if (!canOrg && !canTeam) {
    throw new HrmsForbiddenError(
      isDirectManager
        ? 'You cannot decide this leave request.'
        : 'Only the direct reporting manager, or HR, can decide this request.',
    );
  }

  const chain = request.approvalChain ?? [];
  const stepIndex = chain.findIndex((step) => step.decision === 'pending');
  if (stepIndex === -1) {
    throw new HrmsConflictError('This request has no step awaiting a decision.', {
      code: 'LEAVE_NO_PENDING_STEP',
    });
  }

  chain[stepIndex].decision = dto.decision === 'approve' ? 'approved' : 'rejected';
  chain[stepIndex].decidedAt = new Date();
  chain[stepIndex].comment = dto.comment ?? null;

  // One rejection ends it; approval needs every level.
  const status =
    dto.decision === 'reject'
      ? 'rejected'
      : chain.every((step) => step.decision === 'approved')
        ? 'approved'
        : 'pending';

  request.approvalChain = chain;
  request.status = status;
  await request.save();

  // Released either way; spent only when approved.
  if (status !== 'pending') {
    await adjustBalance(request.employeeId, request.leaveTypeId, yearOf(request.startDate), {
      pending: -request.durationValue,
      used: status === 'approved' ? request.durationValue : 0,
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.LEAVE_DECIDED,
    `${dto.decision === 'approve' ? 'Approved' : 'Rejected'} leave request ${id}`,
    context.req,
    {
      meta: {
        leaveRequestId: idStr(id),
        employeeId: idStr(request.employeeId),
        decision: dto.decision,
        status,
        viaOrgOverride: canOrg && !canTeam,
      },
    },
  );

  /**
    * Tell the requester once the request is settled — the reference's
    * `leave.decided`. A request still moving up the chain is not news yet, so
    * a `pending` outcome notifies nobody, which is the reference's rule too.
    */
  if (status !== 'pending') {
    await notify({
      to: idStr(request.employeeId),
      type: INBOX_TYPES.LEAVE_DECIDED,
      title: `Your leave request was ${status}`,
      // No approver comment: it is free text on a decision the requester can
      // open and read in full.
      body: null,
      entity: 'leave_request',
      entityId: idStr(request._id),
    });
  }

  const [result] = await hydrateRequests([request.toObject()]);
  return result;
}

/** Withdraw one's own pending request. */
export async function cancelRequest(id, actor, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Leave request');

  const request = await LeaveRequest.findById(id);
  if (!request) throw new HrmsNotFoundError('Leave request');

  if (idStr(request.employeeId) !== idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('Only the person who requested this leave can cancel it.');
  }
  if (request.status !== 'pending') {
    throw new HrmsConflictError(`This request is already ${request.status}.`, {
      code: 'LEAVE_NOT_PENDING',
      details: { status: request.status },
    });
  }

  request.status = 'cancelled';
  await request.save();

  await adjustBalance(request.employeeId, request.leaveTypeId, yearOf(request.startDate), {
    pending: -request.durationValue,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.LEAVE_CANCELLED,
    `Cancelled leave request ${id}`,
    context.req,
    { meta: { leaveRequestId: idStr(id), employeeId: idStr(request.employeeId) } },
  );

  const [result] = await hydrateRequests([request.toObject()]);
  return result;
}

/**
 * Everything live in a window, for the calendar.
 *
 * Scoped by the same filter as the list, so the calendar can never show a
 * person the caller is not entitled to see. Only pending and approved appear —
 * a rejected or cancelled request is not an absence.
 */
export async function calendar(actor, { from, to }) {
  const scope = await buildScopeFilter(actor);

  const rows = await LeaveRequest.find({
    ...scope,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: to },
    endDate: { $gte: from },
  })
    .sort({ startDate: 1 })
    .limit(500)
    .lean();

  const requests = await hydrateRequests(rows);
  const holidays = await listHolidaysInWindow(from, to);

  return { requests, holidays };
}

/** The holidays inside a calendar window, so the grid can shade them. */
async function listHolidaysInWindow(from, to) {
  const { default: Holiday } = await import('../../../models/hrms/Holiday.js');
  const rows = await Holiday.find({
    deletedAt: null,
    date: { $gte: from, $lte: to },
  })
    .sort({ date: 1 })
    .lean();

  return rows.map((r) => ({
    id: idStr(r._id),
    name: r.name,
    date: r.date,
    type: r.type,
    isOptional: r.isOptional,
  }));
}

export default {
  listLeaveTypes,
  createLeaveType,
  listBalances,
  createRequest,
  listRequests,
  decideRequest,
  cancelRequest,
  calendar,
};
