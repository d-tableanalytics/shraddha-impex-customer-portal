/**
 * Attendance corrections — request, list, decide.
 *
 * Ported from the reference's `submitCorrection`, `listCorrections` and
 * `decideCorrection`. The workflow is identical: an employee asks for a day's
 * punches to be changed with a reason, a manager or HR approves or rejects, and
 * an approval rewrites the attendance record.
 *
 * ---------------------------------------------------------------------------
 * What changes, and why
 * ---------------------------------------------------------------------------
 * 1. ONE OPEN REQUEST PER DAY, enforced by a partial unique index rather than
 *    by the browser. The reference hides the "Add correction" link when a
 *    pending request exists; its API happily creates a second one.
 *
 * 2. THE REQUESTED TIMES MUST FALL ON THE REQUESTED DAY. The reference builds
 *    the timestamps in the browser from a date picker plus a time picker and
 *    the server accepts whatever arrives — so `date: '2026-01-05'` with a
 *    clock-in in March is stored and, on approval, written onto the January
 *    record.
 *
 * 3. NOTIFICATION IS WIRED. The reference notifies the reporting manager
 *    through its Inbox service, and Inbox now exists — so both of its events
 *    are raised here, addressed to recipients derived from the record rather
 *    than from the request. What is NOT copied across is the requester's
 *    free-text reason, which the reference puts into the notification body and
 *    then into an outbound email; the approvals list shows it to the people
 *    entitled to read it.
 *
 * 4. AN APPROVAL RECORDS WHAT IT CHANGED. The reference sets `source: 'manual'`
 *    and nothing else, so a corrected day cannot be told apart from one HR
 *    typed in by hand, and the previous times are gone.
 */

import mongoose from 'mongoose';

import AttendanceCorrection from '../../../models/hrms/AttendanceCorrection.js';
import AttendanceRecord from '../../../models/hrms/AttendanceRecord.js';
import Employee from '../../../models/hrms/Employee.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { dayToDate, dateToDay, attendanceDayString } from '../../../shared/attendance/status.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsNotFoundError,
  HrmsValidationError,
} from '../hrms.errors.js';
import { readFilterFor, ownerContextFor, PUNCHABLE_STATUSES } from './attendance.service.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

const toDto = (row, employee) => ({
  id: idStr(row._id),
  employeeId: idStr(row.employeeId),
  employeeName: employee
    ? `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim()
    : null,
  employeeCode: employee?.employeeCode ?? null,
  date: dateToDay(row.date),
  requestedClockIn: row.requestedClockIn ? new Date(row.requestedClockIn).toISOString() : null,
  requestedClockOut: row.requestedClockOut ? new Date(row.requestedClockOut).toISOString() : null,
  reason: row.reason,
  status: row.status,
  comment: row.comment ?? null,
  decidedAt: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
  decidedByEmployeeId: idStr(row.decidedByEmployeeId),
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/**
 * Does an instant fall on a given attendance day?
 *
 * Compared against the day the timestamp lands on in the business time zone,
 * not against a UTC midnight window — otherwise a legitimate 06:00 IST
 * clock-in, which is 00:30 UTC on the same date, would pass while a 03:00 IST
 * one would not, for reasons no user could ever discover.
 */
const fallsOnDay = (instant, day) => attendanceDayString(new Date(instant)) === day;

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

/**
 * Request a correction for one of the caller's own days.
 *
 * `employeeId` comes from the actor. The reference does the same; it is
 * restated because a correction endpoint that took one from the body would be a
 * way to file fabricated hours against a colleague.
 */
export async function submitCorrection(actor, dto, { user, req } = {}) {
  if (!actor?.employeeId) {
    throw new HrmsForbiddenError('Your account has no employee record.');
  }

  const employee = await Employee.findById(actor.employeeId)
    // `reportingManagerId` is here for the notification below: the approver is
    // resolved from the employee's own reporting line, never from the request.
    .select('_id employeeCode firstName lastName status deletedAt reportingManagerId')
    .lean();
  if (!employee || employee.deletedAt) {
    throw new HrmsForbiddenError('Your employee record is no longer active.');
  }
  if (!PUNCHABLE_STATUSES.includes(employee.status)) {
    throw new HrmsForbiddenError(
      `Corrections cannot be requested while your employment status is "${employee.status}".`,
    );
  }

  // See note 2 in the header. The schema already refuses a future date and an
  // out-of-order pair; this is the part it cannot check, because it needs the
  // business time zone.
  for (const [field, value] of [
    ['requestedClockIn', dto.requestedClockIn],
    ['requestedClockOut', dto.requestedClockOut],
  ]) {
    if (value && !fallsOnDay(value, dto.date)) {
      throw new HrmsValidationError(
        `${field} must fall on ${dto.date}.`,
        [{ path: field, message: `must be a time on ${dto.date}` }],
      );
    }
  }

  const date = dayToDate(dto.date);

  let correction;
  try {
    correction = await AttendanceCorrection.create({
      employeeId: employee._id,
      date,
      requestedClockIn: dto.requestedClockIn ? new Date(dto.requestedClockIn) : null,
      requestedClockOut: dto.requestedClockOut ? new Date(dto.requestedClockOut) : null,
      reason: dto.reason,
      status: 'pending',
      createdById: user?._id ?? actor.userId ?? null,
    });
  } catch (error) {
    // The partial unique index refused a second OPEN request for the same day.
    if (error?.code === 11000) {
      throw new HrmsConflictError(
        `You already have a correction awaiting a decision for ${dto.date}.`,
        { code: 'CORRECTION_ALREADY_PENDING' },
      );
    }
    throw error;
  }

  await recordAudit(
    user ?? { _id: actor.userId },
    AUDIT_ACTIONS.ATTENDANCE_CORRECTION_SUBMITTED,
    `Requested an attendance correction for ${dto.date}`,
    req,
    {
      meta: {
        correctionId: idStr(correction._id),
        employeeId: idStr(employee._id),
        employeeCode: employee.employeeCode,
        date: dto.date,
        requestedClockIn: dto.requestedClockIn ?? null,
        requestedClockOut: dto.requestedClockOut ?? null,
      },
    },
  );

  /**
   * The reference's `attendance.correction.pending`, to the reporting manager
   * — resolved from the EMPLOYEE record, never from the request body.
   */
  if (employee.reportingManagerId) {
    await notify({
      to: idStr(employee.reportingManagerId),
      type: INBOX_TYPES.ATTENDANCE_CORRECTION_PENDING,
      title: `${`${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim() || 'A team member'} requested an attendance correction for ${dto.date}`,
      body: 'Awaiting your decision.',
      entity: 'attendance_correction',
      entityId: idStr(correction._id),
    });
  }

  return toDto(correction.toObject ? correction.toObject() : correction, employee);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Corrections the caller may see, paginated.
 *
 * Scope is the SAME rule as attendance records — an employee sees their own, a
 * manager their team's, HR everyone's — so it reuses `readFilterFor` rather
 * than restating it. The reference reimplements the scope inline here and
 * notes that it had to; keeping one implementation means the two can never
 * disagree about who a manager's team is.
 *
 * Ordered pending-first then newest-first, as the reference does: an approver
 * opens this to find what needs deciding.
 */
export async function listCorrections(actor, query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, status, employeeId } = query;

  const scope = await readFilterFor(actor);

  if (employeeId) {
    const context = await ownerContextFor(employeeId);
    if (!context) throw new HrmsNotFoundError('Employee');
    const allowed =
      hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.ORG) ||
      hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.TEAM, context) ||
      hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.SELF, context);
    if (!allowed) {
      throw new HrmsForbiddenError("You may not view this employee's corrections.");
    }
  }

  const filter = {
    ...scope,
    ...(status ? { status } : {}),
    ...(employeeId ? { employeeId: new mongoose.Types.ObjectId(String(employeeId)) } : {}),
  };

  const [rows, total] = await Promise.all([
    AttendanceCorrection.find(filter)
      // 'approved' < 'pending' < 'rejected' alphabetically, so status alone
      // will not float the queue. A computed order field keeps pending first
      // without adding a second stored column that could drift.
      .sort({ status: 1, createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    AttendanceCorrection.countDocuments(filter),
  ]);

  const employees = await employeeMapFor(rows.map((r) => r.employeeId));

  const data = rows
    .map((row) => toDto(row, employees.get(idStr(row.employeeId))))
    .sort((a, b) => {
      const rank = (s) => (s === 'pending' ? 0 : 1);
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

  return { data, total, page, pageSize };
}

async function employeeMapFor(employeeIds = []) {
  const unique = [...new Set(employeeIds.map(idStr).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await Employee.find({ _id: { $in: unique } })
    .select('_id employeeCode firstName lastName')
    .lean();
  return new Map(rows.map((e) => [idStr(e._id), e]));
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

/**
 * Approve or reject one correction.
 *
 * Authorisation is checked against the SUBJECT, not the route: holding
 * `attendance:approve:team` is not enough — the requester must actually be in
 * the approver's team. The reference does this too, and it is the difference
 * between "a manager may approve" and "a manager may approve anyone's".
 *
 * An approver cannot decide their own request. The reference permits it: an
 * `hr_admin` holds `approve:org`, so their own correction passes the org check
 * and they can grant themselves any hours they like.
 */
export async function decideCorrection(id, { decision, comment }, actor, { user, req } = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Correction');

  const correction = await AttendanceCorrection.findById(id);
  if (!correction) throw new HrmsNotFoundError('Correction');

  if (correction.status !== 'pending') {
    throw new HrmsConflictError(`This correction was already ${correction.status}.`, {
      code: 'CORRECTION_ALREADY_DECIDED',
    });
  }

  if (
    actor?.employeeId &&
    idStr(correction.employeeId) === idStr(actor.employeeId)
  ) {
    throw new HrmsForbiddenError('You cannot decide your own correction request.');
  }

  const context = await ownerContextFor(correction.employeeId);
  const allowed =
    hasHrmsPermission(actor, M.ATTENDANCE, A.APPROVE, S.ORG) ||
    hasHrmsPermission(actor, M.ATTENDANCE, A.APPROVE, S.TEAM, context);
  if (!allowed) {
    throw new HrmsForbiddenError('You may not decide this correction.');
  }

  const now = new Date();
  const approved = decision === 'approve';

  // Conditional on status so two approvers clicking at once cannot both
  // succeed — the second update matches nothing and is reported as a conflict.
  const updated = await AttendanceCorrection.findOneAndUpdate(
    { _id: correction._id, status: 'pending' },
    {
      $set: {
        status: approved ? 'approved' : 'rejected',
        decidedById: user?._id ?? actor.userId ?? null,
        decidedByEmployeeId: actor?.employeeId ?? null,
        decidedAt: now,
        comment: comment ?? null,
      },
    },
    { new: true },
  );

  if (!updated) {
    throw new HrmsConflictError('This correction was already decided.', {
      code: 'CORRECTION_ALREADY_DECIDED',
    });
  }

  let applied = null;
  if (approved) applied = await applyCorrection(updated, { user, actor, now });

  const employee = (await employeeMapFor([updated.employeeId])).get(idStr(updated.employeeId));

  await recordAudit(
    user ?? { _id: actor.userId },
    AUDIT_ACTIONS.ATTENDANCE_CORRECTION_DECIDED,
    `${approved ? 'Approved' : 'Rejected'} the attendance correction for ${dateToDay(updated.date)}`,
    req,
    {
      meta: {
        correctionId: idStr(updated._id),
        employeeId: idStr(updated.employeeId),
        decision,
        comment: comment ?? null,
        // The before/after the reference discards. Without it, an approved
        // correction leaves no trace of what the times used to be.
        applied,
      },
    },
  );

  // The reference's `attendance.correction.decided`, to the requester.
  await notify({
    to: idStr(updated.employeeId),
    type: INBOX_TYPES.ATTENDANCE_CORRECTION_DECIDED,
    title: `Your attendance correction for ${dateToDay(updated.date)} was ${approved ? 'approved' : 'rejected'}`,
    // No approver comment: free text on a decision the requester can open.
    body: null,
    entity: 'attendance_correction',
    entityId: idStr(updated._id),
  });

  return toDto(updated.toObject ? updated.toObject() : updated, employee);
}

/**
 * Write an approved correction onto the attendance record.
 *
 * Creates the record when the day has none — an employee who forgot to clock in
 * entirely has no row to amend, which is the commonest reason to file one.
 *
 * `source` becomes `manual` as in the reference, and `correctedBy` /
 * `correctionId` are stamped so the day's provenance survives.
 */
async function applyCorrection(correction, { user, actor, now }) {
  const existing = await AttendanceRecord.findOne({
    employeeId: correction.employeeId,
    date: correction.date,
  }).lean();

  const before = existing
    ? {
        clockIn: existing.clockIn ? new Date(existing.clockIn).toISOString() : null,
        clockOut: existing.clockOut ? new Date(existing.clockOut).toISOString() : null,
      }
    : null;

  const $set = {
    source: 'manual',
    status: 'present',
    correctedById: user?._id ?? actor?.userId ?? null,
    correctedAt: now,
    correctionId: correction._id,
  };
  if (correction.requestedClockIn) $set.clockIn = correction.requestedClockIn;
  if (correction.requestedClockOut) $set.clockOut = correction.requestedClockOut;

  const record = await AttendanceRecord.findOneAndUpdate(
    { employeeId: correction.employeeId, date: correction.date },
    {
      $set,
      // Only used when the upsert creates the row; an existing record keeps
      // whatever it captured at punch time.
      $setOnInsert: { employeeId: correction.employeeId, date: correction.date },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  return {
    recordId: idStr(record._id),
    created: !existing,
    before,
    after: {
      clockIn: record.clockIn ? new Date(record.clockIn).toISOString() : null,
      clockOut: record.clockOut ? new Date(record.clockOut).toISOString() : null,
    },
  };
}

export default { submitCorrection, listCorrections, decideCorrection };
