/**
 * Hiring plans — the roles to be filled, and by when.
 *
 * Ported from `planning.service.ts#listHiringPlans / createHiringPlan`.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. THE STATUS CAN ACTUALLY CHANGE. 🔴 The reference declares five statuses —
 *    `planned | in_progress | completed | delayed | cancelled` — defaults to
 *    `planned`, and then ships NO update endpoint of any kind. Four of the five
 *    are unreachable, `actualByDate` can never be filled, and the two table
 *    columns rendering them show "planned" and "—" for every row that will ever
 *    exist. A hiring plan whose progress cannot be recorded is a list of
 *    strings. The transition table lives in `shared/constants/planning.js` as
 *    DATA, and is enforced here — not in the client, which is where a state
 *    machine goes to die.
 *
 * 2. `actualByDate` IS STAMPED ON COMPLETION, which is the only thing that
 *    column could have meant.
 *
 * 3. THE DATE IS A DAY. 🔴 The reference's DTO is an ISO *datetime*, its column
 *    is a SQL `Date`, and the bridge between them is `new Date(dto.plannedByDate)`
 *    — so a target date entered in the evening in IST is stored as the day
 *    before. Stored as `YYYY-MM-DD` end to end here, so there is no instant to
 *    truncate and no zone to truncate it in.
 *
 * 4. REFERENCES ARE VALIDATED. The reference accepts any UUID for
 *    `departmentId` and `requisitionId` and checks neither. AD-2 removed the
 *    foreign keys that would have refused, so the check belongs here.
 *
 * 5. THE LIST IS PAGINATED AND FILTERABLE (AD-13). The reference returns every
 *    hiring plan ever created, unbounded, with no filter at all — not even by
 *    status, on a table whose main column IS the status.
 *
 * ---------------------------------------------------------------------------
 * What is NOT done
 * ---------------------------------------------------------------------------
 * `requisitionId` links a plan to a requisition and NOTHING MORE. The reference
 * stores it and never reads it — no pipeline join, no status propagation, no
 * lookup anywhere in its codebase. Its page subtitle says "hiring plans vs
 * pipeline"; its code does not, and driving a plan's status from Hiring's
 * pipeline would be inventing a feature. The requisition is resolved once, to
 * confirm it exists and to label the row.
 */

import mongoose from 'mongoose';

import { HiringPlan } from '../../../models/hrms/PlanningModels.js';
import { JobRequisition } from '../../../models/hrms/HiringModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import {
  HIRING_PLAN_TRANSITIONS,
  HIRING_PLAN_STATUS_LABELS,
  HIRING_PLAN_COMPLETED_STATUS,
  CLOSED_HIRING_PLAN_STATUSES,
} from '../../../shared/constants/planning.js';
import { resolveDepartment } from '../references/reference.service.js';
import {
  HrmsNotFoundError,
  HrmsValidationError,
  HrmsConflictError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const toDto = (row) => ({
  id: idStr(row._id),
  role: row.role,
  plannedByDate: row.plannedByDate,
  actualByDate: row.actualByDate ?? null,
  status: row.status,
  statusLabel: HIRING_PLAN_STATUS_LABELS[row.status] ?? row.status,
  /**
   * Derived, so the client does not each invent its own idea of "late".
   * A closed plan is never overdue — a cancelled role is not still waiting.
   */
  overdue:
    !CLOSED_HIRING_PLAN_STATUSES.includes(row.status) && row.plannedByDate < today(),
  departmentId: idStr(row.departmentId),
  departmentName: row.departmentName ?? null,
  requisitionId: idStr(row.requisitionId),
  requisitionTitle: row.requisitionTitle ?? null,
  notes: row.notes ?? null,
  /** The moves this plan can make, so the UI offers exactly those. */
  allowedTransitions: HIRING_PLAN_TRANSITIONS[row.status] ?? [],
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
});

// ---------------------------------------------------------------------------
// Reference resolution (correction 4)
// ---------------------------------------------------------------------------

async function resolveTargetDepartment(departmentId) {
  if (!departmentId) return { departmentId: null, departmentName: null };

  const department = await resolveDepartment(departmentId).catch(() => null);
  if (!department) throw new HrmsNotFoundError('Department');

  return { departmentId: oid(departmentId), departmentName: department.name ?? null };
}

/**
 * Confirm the requisition exists, and take its title for the row's label.
 *
 * A read, and only a read. A soft-deleted requisition is not offered, because
 * planning against a withdrawn requisition is a mistake worth catching at the
 * moment it is made rather than a dangling id discovered months later.
 */
async function resolveRequisition(requisitionId) {
  if (!requisitionId) return { requisitionId: null, requisitionTitle: null };
  if (!mongoose.isValidObjectId(requisitionId)) throw new HrmsNotFoundError('Job requisition');

  const requisition = await JobRequisition.findOne({ _id: requisitionId, deletedAt: null })
    .select('_id title')
    .lean();
  if (!requisition) throw new HrmsNotFoundError('Job requisition');

  return { requisitionId: oid(requisitionId), requisitionTitle: requisition.title ?? null };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listHiringPlans(query = {}) {
  const {
    page = 1,
    pageSize = PAGE_SIZE_DEFAULT,
    status,
    departmentId,
    requisitionId,
    search,
  } = query;

  const filter = {
    ...(status ? { status } : {}),
    ...(departmentId ? { departmentId: oid(departmentId) } : {}),
    ...(requisitionId ? { requisitionId: oid(requisitionId) } : {}),
    // Anchored and escaped: an unescaped user string here is a regex injection
    // and, with a leading `.*`, an unindexed collection scan.
    ...(search
      ? { role: { $regex: `^${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    HiringPlan.find(filter)
      // The reference's ordering: soonest target first.
      .sort({ plannedByDate: 1, createdAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    HiringPlan.countDocuments(filter),
  ]);

  return { data: rows.map(toDto), total, page, pageSize };
}

export async function getHiringPlan(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Hiring plan');
  const row = await HiringPlan.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Hiring plan');
  return toDto(row);
}

/** The counts behind the tab's status filter, over the whole set rather than a page. */
export async function hiringPlanSummary() {
  const rows = await HiringPlan.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);

  const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const openFilter = {
    status: { $nin: CLOSED_HIRING_PLAN_STATUSES },
    plannedByDate: { $lt: today() },
  };

  return {
    total: rows.reduce((sum, r) => sum + r.count, 0),
    byStatus,
    overdue: await HiringPlan.countDocuments(openFilter),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createHiringPlan(input, context = {}) {
  const department = await resolveTargetDepartment(input.departmentId);
  const requisition = await resolveRequisition(input.requisitionId);

  const row = await HiringPlan.create({
    role: input.role,
    plannedByDate: input.plannedByDate,
    // Always `planned`; the client does not get to open a plan mid-flight.
    status: 'planned',
    actualByDate: null,
    ...department,
    ...requisition,
    notes: input.notes ?? null,
    createdByUserId: context.user?._id ?? null,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.HIRING_PLAN_CREATED,
    `Planned to hire ${input.role} for ${department.departmentName ?? 'the company'} by ${input.plannedByDate}`,
    context.req,
    {
      meta: {
        hiringPlanId: idStr(row._id),
        role: input.role,
        plannedByDate: input.plannedByDate,
        departmentId: idStr(department.departmentId),
        requisitionId: idStr(requisition.requisitionId),
      },
    },
  );

  return toDto(row.toObject());
}

export async function updateHiringPlan(id, input, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Hiring plan');

  const existing = await HiringPlan.findById(id);
  if (!existing) throw new HrmsNotFoundError('Hiring plan');

  /**
   * A closed plan is a record of what happened. Editing the target date of a
   * role that was filled — or cancelled — three months ago rewrites history
   * rather than correcting it.
   */
  if (CLOSED_HIRING_PLAN_STATUSES.includes(existing.status)) {
    throw new HrmsConflictError(
      `This plan is ${HIRING_PLAN_STATUS_LABELS[existing.status].toLowerCase()} and can no longer be edited.`,
    );
  }

  const patch = {};
  if (input.role !== undefined) patch.role = input.role;
  if (input.plannedByDate !== undefined) patch.plannedByDate = input.plannedByDate;
  if (input.notes !== undefined) patch.notes = input.notes ?? null;
  if (input.departmentId !== undefined) {
    Object.assign(patch, await resolveTargetDepartment(input.departmentId));
  }
  if (input.requisitionId !== undefined) {
    Object.assign(patch, await resolveRequisition(input.requisitionId));
  }

  existing.set(patch);
  await existing.save();

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.HIRING_PLAN_UPDATED,
    `Updated the hiring plan for ${existing.role}`,
    context.req,
    { meta: { hiringPlanId: idStr(existing._id), changed: Object.keys(patch) } },
  );

  return toDto(existing.toObject());
}

/**
 * Move a plan along.
 *
 * Legality is decided HERE, from the transition table — not from what the
 * client offered. The reference has no equivalent because it has no endpoint at
 * all; correction 1.
 */
export async function changeHiringPlanStatus(id, input, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Hiring plan');

  const existing = await HiringPlan.findById(id);
  if (!existing) throw new HrmsNotFoundError('Hiring plan');

  const from = existing.status;
  const to = input.status;

  if (from === to) {
    throw new HrmsValidationError(
      `This plan is already ${HIRING_PLAN_STATUS_LABELS[to].toLowerCase()}.`,
    );
  }

  const allowed = HIRING_PLAN_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HrmsConflictError(
      `A ${HIRING_PLAN_STATUS_LABELS[from].toLowerCase()} plan cannot become ${HIRING_PLAN_STATUS_LABELS[to].toLowerCase()}.`,
      { details: { from, to, allowedTransitions: allowed } },
    );
  }

  existing.status = to;

  if (to === HIRING_PLAN_COMPLETED_STATUS) {
    // Correction 2. Defaults to today, because that is when it completed.
    existing.actualByDate = input.actualByDate ?? today();
  } else {
    // Reopening a plan clears a date that no longer describes anything.
    existing.actualByDate = null;
  }

  if (input.notes) existing.notes = input.notes;

  await existing.save();

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.HIRING_PLAN_STATUS_CHANGED,
    `Moved the hiring plan for ${existing.role} from ${HIRING_PLAN_STATUS_LABELS[from].toLowerCase()} to ${HIRING_PLAN_STATUS_LABELS[to].toLowerCase()}`,
    context.req,
    {
      meta: {
        hiringPlanId: idStr(existing._id),
        from,
        to,
        actualByDate: existing.actualByDate ?? null,
      },
    },
  );

  return toDto(existing.toObject());
}

export default {
  listHiringPlans,
  getHiringPlan,
  hiringPlanSummary,
  createHiringPlan,
  updateHiringPlan,
  changeHiringPlanStatus,
};
