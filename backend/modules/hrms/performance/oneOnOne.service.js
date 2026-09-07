/**
 * 1:1s — a shared notepad between a manager and a direct report.
 *
 * Ported from the reference's `one-on-one.service.ts`. Its header states the
 * rule this module keeps: either party may update agenda, notes and action
 * items; only the manager may schedule.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. ONLY THE MANAGER MAY RESOLVE THE MEETING. The reference lets `update`
 *    write `status` from either participant, so a report can cancel their own
 *    manager's 1:1. Rescheduling is already manager-only there; resolving is
 *    the same kind of act and is treated the same way.
 *
 * 2. STATUS TRANSITIONS ARE ENFORCED. A completed meeting can be put back to
 *    `scheduled` in the reference, and its notes then attach to a session that
 *    has already happened.
 *
 * 3. THE LIST IS PAGINATED (AD-13).
 *
 * 4. THE REPORT MUST BE A LIVE DIRECT REPORT at the time of scheduling — the
 *    reference checks the relationship but not whether either party is still
 *    with the company.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { OneOnOne } from '../../../models/hrms/PerformanceModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { ONE_ON_ONE_TRANSITIONS } from '../../../shared/constants/performance.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

const items = (list) => (list ?? []).map((i) => ({ text: i.text, done: Boolean(i.done) }));

const toDto = (row, viewerEmployeeId) => ({
  id: idStr(row._id),
  managerEmployeeId: idStr(row.managerEmployeeId),
  managerName: row.managerName ?? null,
  reportEmployeeId: idStr(row.reportEmployeeId),
  reportName: row.reportName ?? null,
  scheduledAt: row.scheduledAt ? new Date(row.scheduledAt).toISOString() : null,
  durationMinutes: row.durationMinutes,
  agenda: items(row.agenda),
  notes: items(row.notes),
  actionItems: items(row.actionItems),
  status: row.status,
  /** Which side the viewer is on — the card's heading and its controls follow this. */
  viewerIsManager:
    Boolean(viewerEmployeeId) && idStr(row.managerEmployeeId) === idStr(viewerEmployeeId),
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/**
 * The caller's own 1:1s, from either side.
 *
 * No id is accepted — both sides come from the session. Served by the two
 * single-sided indexes; an `$or` across them is the one query this collection
 * needs.
 */
export async function listMyOneOnOnes(actor, query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, status } = query;
  if (!actor?.employeeId) return { data: [], total: 0, page, pageSize };

  const self = oid(actor.employeeId);
  const filter = {
    $or: [{ managerEmployeeId: self }, { reportEmployeeId: self }],
    ...(status ? { status } : {}),
  };

  const [rows, total] = await Promise.all([
    OneOnOne.find(filter)
      .sort({ scheduledAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    OneOnOne.countDocuments(filter),
  ]);

  return { data: rows.map((r) => toDto(r, actor.employeeId)), total, page, pageSize };
}

/**
 * Schedule a 1:1.
 *
 * Only with a DIRECT report — a single-level `reportingManagerId` check, as the
 * reference does it. Team scope reaches further up the chain, but a 1:1 is a
 * standing meeting between two specific people, and a skip-level manager
 * booking one over the direct manager's head is not the relationship this
 * models.
 */
export async function scheduleOneOnOne(input, context = {}) {
  const actor = context.actor;
  if (!actor?.employeeId) {
    throw new HrmsForbiddenError('You need an employee record to schedule a 1:1.');
  }

  const report = await Employee.findOne({ _id: input.reportEmployeeId, deletedAt: null })
    .select('_id firstName lastName reportingManagerId status')
    .lean()
    .catch(() => null);
  if (!report) {
    throw new HrmsValidationError('Unknown employee.', [
      { path: 'reportEmployeeId', message: 'That employee does not exist.' },
    ]);
  }
  if (idStr(report.reportingManagerId) !== idStr(actor.employeeId)) {
    throw new HrmsForbiddenError('You can only schedule 1:1s with your own direct reports.');
  }
  if (['exited', 'inactive'].includes(report.status)) {
    throw new HrmsValidationError('That employee has left.', [
      { path: 'reportEmployeeId', message: 'They are no longer with the company.' },
    ]);
  }

  // A meeting in the past cannot be attended. The reference accepts one.
  if (new Date(input.scheduledAt).getTime() < Date.now()) {
    throw new HrmsValidationError('A 1:1 cannot be scheduled in the past.', [
      { path: 'scheduledAt', message: 'Choose a future date and time.' },
    ]);
  }

  const manager = await Employee.findById(actor.employeeId)
    .select('_id firstName lastName')
    .lean();

  const row = await OneOnOne.create({
    managerEmployeeId: oid(actor.employeeId),
    managerName: nameOf(manager),
    reportEmployeeId: report._id,
    reportName: nameOf(report),
    scheduledAt: new Date(input.scheduledAt),
    durationMinutes: input.durationMinutes,
    agenda: items(input.agenda),
    notes: [],
    actionItems: [],
    status: 'scheduled',
    createdByUserId: context.user?._id ?? null,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ONE_ON_ONE_SCHEDULED,
    `Scheduled a 1:1 with ${nameOf(report)}`,
    context.req,
    {
      meta: {
        oneOnOneId: idStr(row._id),
        reportEmployeeId: idStr(report._id),
        scheduledAt: input.scheduledAt,
      },
    },
  );

  return toDto(row.toObject(), actor.employeeId);
}

function assertStatusTransition(from, to) {
  if (from === to) return;
  const allowed = ONE_ON_ONE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HrmsConflictError(
      allowed.length === 0
        ? `This 1:1 is ${from} and is final.`
        : `A ${from} 1:1 can only become: ${allowed.join(', ')}.`,
      { code: 'ONE_ON_ONE_INVALID_TRANSITION' },
    );
  }
}

/**
 * Update the shared notepad.
 *
 * Either participant may edit agenda, notes and action items — that is what
 * "shared" means, and it is the reference's rule. Rescheduling and RESOLVING
 * are the manager's: the reference guards the first and not the second, so a
 * report can cancel their manager's meeting.
 */
export async function updateOneOnOne(id, input, context = {}) {
  const actor = context.actor;
  const row = await loadOneOnOne(id);

  const isManager =
    Boolean(actor?.employeeId) && idStr(row.managerEmployeeId) === idStr(actor.employeeId);
  const isReport =
    Boolean(actor?.employeeId) && idStr(row.reportEmployeeId) === idStr(actor.employeeId);
  if (!isManager && !isReport) {
    throw new HrmsForbiddenError('This is not your 1:1.');
  }

  if (row.status !== 'scheduled' && (input.scheduledAt || input.durationMinutes)) {
    throw new HrmsConflictError(`This 1:1 is ${row.status} and cannot be rescheduled.`, {
      code: 'ONE_ON_ONE_INVALID_TRANSITION',
    });
  }

  const $set = {};

  if (input.scheduledAt !== undefined) {
    if (!isManager) throw new HrmsForbiddenError('Only the manager can reschedule a 1:1.');
    $set.scheduledAt = new Date(input.scheduledAt);
  }
  if (input.durationMinutes !== undefined) {
    if (!isManager) throw new HrmsForbiddenError('Only the manager can reschedule a 1:1.');
    $set.durationMinutes = input.durationMinutes;
  }

  // The shared notepad — either side.
  if (input.agenda !== undefined) $set.agenda = items(input.agenda);
  if (input.notes !== undefined) $set.notes = items(input.notes);
  if (input.actionItems !== undefined) $set.actionItems = items(input.actionItems);

  if (input.status !== undefined) {
    if (!isManager) {
      throw new HrmsForbiddenError('Only the manager can complete or cancel a 1:1.');
    }
    assertStatusTransition(row.status, input.status);
    $set.status = input.status;
  }

  const updated = await OneOnOne.findOneAndUpdate(
    { _id: row._id, status: row.status },
    { $set },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This 1:1 changed before your update was saved.', {
      code: 'ONE_ON_ONE_INVALID_TRANSITION',
    });
  }

  /**
   * Only the STATUS change is audited, not every keystroke in the notepad.
   * A 1:1's notes are a working document between two people; filing each edit
   * into an org-wide audit trail would make it something else.
   */
  if (input.status !== undefined) {
    await recordAudit(
      context.user,
      AUDIT_ACTIONS.ONE_ON_ONE_STATUS_CHANGED,
      `Marked the 1:1 with ${isManager ? row.reportName : row.managerName} as ${input.status}`,
      context.req,
      { meta: { oneOnOneId: idStr(row._id), from: row.status, to: input.status } },
    );
  }

  return toDto(updated.toObject(), actor.employeeId);
}

// ---------------------------------------------------------------------------

export async function loadOneOnOne(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('1:1');
  const row = await OneOnOne.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('1:1');
  return row;
}

export { toDto as oneOnOneDto, assertStatusTransition };

export default { listMyOneOnOnes, scheduleOneOnOne, updateOneOnOne };
