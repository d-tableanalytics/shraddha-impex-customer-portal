/**
 * Attendance: punches, history and the team grid.
 *
 * Ported from the reference's `AttendanceService` (`attendance.service.ts`).
 * Its operations are `clockIn`, `clockOut`, `today`, `list` and `teamGrid`,
 * and that is what is here.
 *
 * ---------------------------------------------------------------------------
 * What changes, and why
 * ---------------------------------------------------------------------------
 * 1. THE PUNCH DOES NOT WAIT ON A THIRD PARTY (AD-15, defect 3). The reference
 *    awaits a Nominatim lookup before writing the record. Here the record is
 *    written and the label resolves afterwards.
 *
 * 2. COORDINATES ARE STORED PER PUNCH (AD-15, defect 2). The reference's
 *    clock-out overwrites the clock-in's coordinates while leaving the
 *    clock-in's label, so the two describe different places.
 *
 * 3. CAPTURE IS CONSENTED, AND OPTIONAL (AD-15). A punch with no selfie and no
 *    location is a complete, valid punch. The reference makes both mandatory.
 *
 * 4. THE LIST IS PAGINATED (AD-13). The reference takes the newest 400 rows and
 *    silently drops the rest.
 *
 * 5. SOFT-DELETED AND NON-EMPLOYABLE PEOPLE CANNOT PUNCH. The reference checks
 *    only that the actor HAS an employee id, so someone soft-deleted this
 *    morning — or still `invited`, or `exited` — keeps clocking in.
 *
 * 6. DERIVED STATUS IS COMPUTED SERVER-SIDE, from the shared module the UI also
 *    uses. The reference computes it in the browser alone.
 */

import mongoose from 'mongoose';

import AttendanceRecord from '../../../models/hrms/AttendanceRecord.js';
import Employee from '../../../models/hrms/Employee.js';
import { recordAudit } from '../../../utils/auditLog.js';
import {
  AUDIT_ACTIONS,
  CONSENT_PURPOSES,
  PAGE_SIZE_DEFAULT,
} from '../../../shared/constants/hrms.js';
import {
  todayDate,
  dayToDate,
  dateToDay,
  shiftDay,
  attendanceDayString,
  deriveAttendanceStatus,
  hoursBetween,
} from '../../../shared/attendance/status.js';
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
import { hasConsent } from './consent.service.js';
import { selfieKeyBelongsTo } from './selfie.service.js';
import { resolveLater } from './geocode.service.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

/**
 * Employment states in which a person may record attendance.
 *
 * `invited` is absent because they have not started; `exited` and `inactive`
 * because they have finished; `suspended` because a suspension that still let
 * someone clock in would not be one. `notice` and `probation` are working
 * states and are included.
 *
 * The reference has no such check at all.
 */
const PUNCHABLE_STATUSES = Object.freeze(['active', 'probation', 'notice']);

/** How far back the history list defaults to, matching the reference's 31 days. */
const DEFAULT_RANGE_DAYS = 30;

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * One record, as the API returns it.
 *
 * A selfie appears as `hasSelfie: true`, NEVER as a key or a URL. The browser
 * asks for a presigned URL by record id and punch when it actually needs to
 * render one, so a storage key never leaves the server and a listing does not
 * mint access to hundreds of photographs nobody looked at.
 *
 * `viewCapture` is the caller's permission to see location detail at all. When
 * false the coordinates and the label are omitted rather than blanked, so a
 * client cannot tell "no location captured" apart from "not yours to see" —
 * which is the correct answer to give.
 */
function toDto(row, { now = new Date(), viewCapture = true } = {}) {
  const capture = (block) => {
    if (!block) return { hasSelfie: false, geo: null, locationLabel: null };
    return {
      hasSelfie: Boolean(block.selfieKey),
      geo: viewCapture && block.geo ? { ...block.geo } : null,
      locationLabel: viewCapture ? (block.locationLabel ?? null) : null,
    };
  };

  const clockIn = row.clockIn ?? null;
  const clockOut = row.clockOut ?? null;

  return {
    id: idStr(row._id),
    employeeId: idStr(row.employeeId),
    date: dateToDay(row.date),
    clockIn: clockIn ? new Date(clockIn).toISOString() : null,
    clockOut: clockOut ? new Date(clockOut).toISOString() : null,
    source: row.source,
    status: row.status,
    notes: row.notes ?? null,
    deviceId: row.deviceId ?? null,
    clockInCapture: capture(row.clockInCapture),
    clockOutCapture: capture(row.clockOutCapture),
    hoursWorked: Number(hoursBetween(clockIn, clockOut).toFixed(4)),
    /**
     * Computed here rather than left to the caller, from the same shared module
     * the UI imports. One implementation, so a report and a screen cannot
     * disagree about what a half day is.
     */
    derived: deriveAttendanceStatus(clockIn, clockOut, now),
    corrected: Boolean(row.correctedAt),
  };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The employees a `team` grant reaches.
 *
 * A `team` grant covers the actor plus everyone whose `managerChain` contains
 * them — direct AND indirect reports, which is what the chain is for. The ids
 * are looked up rather than joined because AD-2 has no joins: one indexed query
 * on `managerChain`, then an `$in`.
 */
async function teamEmployeeIds(actorEmployeeId) {
  const rows = await Employee.find({ managerChain: actorEmployeeId, deletedAt: null })
    .select('_id')
    .lean();
  return [new mongoose.Types.ObjectId(String(actorEmployeeId)), ...rows.map((r) => r._id)];
}

/**
 * The Mongo filter for what this actor may read.
 *
 * Applied to the QUERY, not to the results. Filtering after the fetch would
 * make the pagination total describe rows the caller cannot see — the page
 * would come back short and the count would be a lie.
 *
 * `{}` for an org-wide grant; a refusal for an actor with none, which is the
 * same shape the reference uses.
 */
export async function readFilterFor(actor) {
  if (hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.ORG)) return {};

  if (hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.TEAM)) {
    if (!actor.employeeId) throw new HrmsForbiddenError('Your account has no employee record.');
    return { employeeId: { $in: await teamEmployeeIds(actor.employeeId) } };
  }

  if (hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.SELF)) {
    if (!actor.employeeId) throw new HrmsForbiddenError('Your account has no employee record.');
    return { employeeId: new mongoose.Types.ObjectId(String(actor.employeeId)) };
  }

  throw new HrmsForbiddenError('You do not have permission to view attendance.');
}

/**
 * May this actor see capture detail — coordinates and the resolved address?
 *
 * AD-15 §2 states the gate plainly: `attendance:view:self` on one's OWN record,
 * `:team` for a report, `:org` for HR. The reference is different and worse in
 * both directions — it hides location from the employee who was standing there
 * (`canSeeLocation = can(org) || can(team)`) while serving the photograph to
 * the entire internet. AD-15 is followed.
 */
export function canViewCapture(actor, ownerContext) {
  return (
    hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.ORG) ||
    hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.TEAM, ownerContext) ||
    hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.SELF, ownerContext)
  );
}

/** The ResourceContext for an employee, for scope evaluation. */
export async function ownerContextFor(employeeId) {
  const employee = await Employee.findById(employeeId)
    .select('_id userId departmentId managerChain')
    .lean();
  if (!employee) return undefined;
  return {
    ownerUserId: idStr(employee.userId) ?? undefined,
    ownerEmployeeId: idStr(employee._id),
    ownerDepartmentId: idStr(employee.departmentId) ?? undefined,
    ownerManagerChain: (employee.managerChain ?? []).map(idStr),
  };
}

// ---------------------------------------------------------------------------
// The punching employee
// ---------------------------------------------------------------------------

/**
 * The employee who may punch, or a refusal explaining why not.
 *
 * Resolved from the AUTHENTICATED actor, never from the request body. That is
 * the single most important line in this module: a punch endpoint that accepted
 * an employee id would let anyone record anyone else's attendance.
 */
async function punchingEmployee(actor) {
  if (!actor?.employeeId) {
    throw new HrmsForbiddenError('Your account has no employee record, so it cannot clock in.');
  }

  const employee = await Employee.findById(actor.employeeId)
    .select('_id employeeCode firstName lastName status deletedAt')
    .lean();

  if (!employee || employee.deletedAt) {
    // Soft-deleted between the actor being built and the punch arriving, or a
    // stale token. Either way there is no live employee to attribute this to.
    throw new HrmsForbiddenError('Your employee record is no longer active.');
  }

  if (!PUNCHABLE_STATUSES.includes(employee.status)) {
    throw new HrmsForbiddenError(
      `Attendance cannot be recorded while your employment status is "${employee.status}".`,
    );
  }

  return employee;
}

/**
 * Turn the validated punch body into a capture block.
 *
 * Consent is checked HERE, once, for both purposes. Three outcomes per field:
 *   - consented and supplied   -> stored
 *   - not consented and absent -> stored as null, punch proceeds (the AD-15 rule)
 *   - not consented but supplied -> REFUSED
 *
 * The third is a 400 rather than a silent drop. A client sending data the
 * employee has not agreed to share is either broken or hostile, and quietly
 * discarding it would leave the UI showing a selfie that was never stored.
 */
async function buildCapture({ employee, dto, at }) {
  const capture = { at, geo: null, locationLabel: null, selfieKey: null };

  if (dto.selfieKey) {
    if (!(await hasConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_SELFIE))) {
      throw new HrmsValidationError(
        'A selfie was supplied but consent for selfie capture has not been given.',
      );
    }
    // The key's own path carries the employee it was minted for, so a key
    // belonging to a colleague is refused without a storage read.
    if (!selfieKeyBelongsTo(dto.selfieKey, employee._id)) {
      throw new HrmsForbiddenError('That selfie does not belong to you.');
    }
    capture.selfieKey = dto.selfieKey;
  }

  if (dto.geo || dto.locationLabel) {
    if (!(await hasConsent(employee._id, CONSENT_PURPOSES.ATTENDANCE_LOCATION))) {
      throw new HrmsValidationError(
        'A location was supplied but consent for location capture has not been given.',
      );
    }
    if (dto.geo) capture.geo = { ...dto.geo, accuracy: dto.geo.accuracy ?? null };
    if (dto.locationLabel) capture.locationLabel = dto.locationLabel;
  }

  return capture;
}

// ---------------------------------------------------------------------------
// Clock in / out
// ---------------------------------------------------------------------------

/**
 * Clock in for today.
 *
 * 409 on a second clock-in, as the reference does — the correction workflow is
 * how a mistake gets fixed, not a silent overwrite.
 *
 * The TIME IS THE SERVER'S. The body carries no timestamp and the schema would
 * reject one: a client-supplied punch time is a client-supplied pay claim.
 */
export async function clockIn(actor, dto, { user, req } = {}) {
  const employee = await punchingEmployee(actor);
  const now = new Date();
  const date = todayDate(now);

  const capture = await buildCapture({ employee, dto, at: now });

  const existing = await AttendanceRecord.findOne({ employeeId: employee._id, date });
  if (existing?.clockIn) {
    throw new HrmsConflictError('You have already clocked in today.', {
      code: 'ATTENDANCE_ALREADY_CLOCKED_IN',
    });
  }

  let record;
  try {
    record = existing
      ? await AttendanceRecord.findOneAndUpdate(
          // `clockIn: null` in the filter is the race guard: two simultaneous
          // requests both read no clock-in, and only the first update matches.
          { _id: existing._id, clockIn: null },
          {
            $set: {
              clockIn: now,
              source: dto.source,
              status: 'present',
              clockInCapture: capture,
              ...(dto.notes ? { notes: dto.notes } : {}),
            },
          },
          { new: true },
        )
      : await AttendanceRecord.create({
          employeeId: employee._id,
          date,
          clockIn: now,
          source: dto.source,
          status: 'present',
          clockInCapture: capture,
          notes: dto.notes ?? null,
        });
  } catch (error) {
    // The unique (employeeId, date) index refused a concurrent create. That is
    // the same business condition as the pre-check above, reported the same way.
    if (error?.code === 11000) {
      throw new HrmsConflictError('You have already clocked in today.', {
        code: 'ATTENDANCE_ALREADY_CLOCKED_IN',
      });
    }
    throw error;
  }

  if (!record) {
    throw new HrmsConflictError('You have already clocked in today.', {
      code: 'ATTENDANCE_ALREADY_CLOCKED_IN',
    });
  }

  await recordAudit(
    user ?? { _id: actor.userId },
    AUDIT_ACTIONS.ATTENDANCE_CLOCK_IN,
    `Clocked in at ${now.toISOString()} (${attendanceDayString(now)})`,
    req,
    {
      meta: {
        employeeId: idStr(employee._id),
        employeeCode: employee.employeeCode,
        recordId: idStr(record._id),
        source: dto.source,
        withSelfie: Boolean(capture.selfieKey),
        withLocation: Boolean(capture.geo),
      },
    },
  );

  // Fired, NOT awaited (AD-15, defect 3). The punch is already durable; the
  // label catches up. `.catch` because a detached rejection must not surface
  // as an unhandled promise.
  if (capture.geo && !capture.locationLabel) {
    resolveLater(record._id, 'in', capture.geo).catch(() => {});
  }

  return toDto(record.toObject ? record.toObject() : record, { now });
}

/**
 * Clock out.
 *
 * The reference's two conflicts, kept: not clocked in, and already clocked out.
 */
export async function clockOut(actor, dto, { user, req } = {}) {
  const employee = await punchingEmployee(actor);
  const now = new Date();
  const date = todayDate(now);

  const capture = await buildCapture({ employee, dto, at: now });

  const existing = await AttendanceRecord.findOne({ employeeId: employee._id, date });
  if (!existing?.clockIn) {
    throw new HrmsConflictError('You have not clocked in today.', {
      code: 'ATTENDANCE_NOT_CLOCKED_IN',
    });
  }
  if (existing.clockOut) {
    throw new HrmsConflictError('You have already clocked out today.', {
      code: 'ATTENDANCE_ALREADY_CLOCKED_OUT',
    });
  }

  const record = await AttendanceRecord.findOneAndUpdate(
    { _id: existing._id, clockOut: null },
    {
      $set: {
        clockOut: now,
        clockOutCapture: capture,
        ...(dto.notes ? { notes: dto.notes } : {}),
      },
    },
    { new: true },
  );

  if (!record) {
    throw new HrmsConflictError('You have already clocked out today.', {
      code: 'ATTENDANCE_ALREADY_CLOCKED_OUT',
    });
  }

  await recordAudit(
    user ?? { _id: actor.userId },
    AUDIT_ACTIONS.ATTENDANCE_CLOCK_OUT,
    `Clocked out at ${now.toISOString()} (${attendanceDayString(now)})`,
    req,
    {
      meta: {
        employeeId: idStr(employee._id),
        employeeCode: employee.employeeCode,
        recordId: idStr(record._id),
        source: dto.source,
        withSelfie: Boolean(capture.selfieKey),
        withLocation: Boolean(capture.geo),
        hoursWorked: Number(hoursBetween(record.clockIn, now).toFixed(4)),
      },
    },
  );

  if (capture.geo && !capture.locationLabel) {
    resolveLater(record._id, 'out', capture.geo).catch(() => {});
  }

  return toDto(record.toObject ? record.toObject() : record, { now });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Today's record for the caller, or null.
 *
 * Null is a legitimate answer — it means "has not clocked in yet" — so this is
 * the one read that does not 404.
 */
export async function today(actor, { now = new Date() } = {}) {
  if (!actor?.employeeId) return null;

  const row = await AttendanceRecord.findOne({
    employeeId: actor.employeeId,
    date: todayDate(now),
  }).lean();

  if (!row) return null;
  // Their own record, so capture detail is theirs to see (AD-15 §2).
  return toDto(row, { now, viewCapture: true });
}

/**
 * Attendance history, scope-aware and paginated.
 *
 * @param {object} actor
 * @param {object} query  validated by attendanceListQuerySchema
 */
export async function list(actor, query = {}, { now = new Date() } = {}) {
  const {
    page = 1,
    pageSize = PAGE_SIZE_DEFAULT,
    employeeId,
    from,
    to,
    status,
  } = query;

  const scope = await readFilterFor(actor);

  /**
   * A request for a NAMED employee is re-checked against that employee.
   *
   * The scope filter alone would already exclude them, returning an empty page
   * — but "empty" and "not yours to see" are different answers and a caller
   * deserves the accurate one. It is also what the reference does
   * (`assertCanViewEmployee`).
   */
  let ownerContext;
  if (employeeId) {
    ownerContext = await ownerContextFor(employeeId);
    if (!ownerContext) throw new HrmsNotFoundError('Employee');
    if (!canViewCapture(actor, ownerContext)) {
      throw new HrmsForbiddenError("You may not view this employee's attendance.");
    }
  }

  const range = normaliseRange(from, to, now);

  const filter = {
    ...scope,
    ...(employeeId ? { employeeId: new mongoose.Types.ObjectId(String(employeeId)) } : {}),
    ...(status ? { status } : {}),
    date: { $gte: dayToDate(range.from), $lte: dayToDate(range.to) },
  };

  const [rows, total] = await Promise.all([
    AttendanceRecord.find(filter)
      .sort({ date: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    AttendanceRecord.countDocuments(filter),
  ]);

  /**
   * Capture visibility is decided PER ROW.
   *
   * A manager's list can mix their own days with a report's; an org-wide list
   * spans everyone. Deciding once for the whole page would either leak a
   * stranger's coordinates or hide the caller's own.
   */
  const contexts = await ownerContextsFor(rows.map((r) => r.employeeId));

  return {
    data: rows.map((row) =>
      toDto(row, {
        now,
        viewCapture: canViewCapture(actor, contexts.get(idStr(row.employeeId))),
      }),
    ),
    total,
    page,
    pageSize,
    range,
  };
}

/** ResourceContexts for many employees, in one query rather than N. */
async function ownerContextsFor(employeeIds = []) {
  const unique = [...new Set(employeeIds.map(idStr).filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await Employee.find({ _id: { $in: unique } })
    .select('_id userId departmentId managerChain')
    .lean();

  return new Map(
    rows.map((e) => [
      idStr(e._id),
      {
        ownerUserId: idStr(e.userId) ?? undefined,
        ownerEmployeeId: idStr(e._id),
        ownerDepartmentId: idStr(e.departmentId) ?? undefined,
        ownerManagerChain: (e.managerChain ?? []).map(idStr),
      },
    ]),
  );
}

/** The default window: the last 31 days ending today, as in the reference. */
export function normaliseRange(from, to, now = new Date()) {
  const today_ = attendanceDayString(now);
  return {
    from: from ?? shiftDay(today_, -DEFAULT_RANGE_DAYS),
    to: to ?? today_,
  };
}

/**
 * One row per report, with today's summary. The manager's Team tab.
 *
 * Reads through `managerChain`, so it covers indirect reports too — the
 * reference does the same, and a skip-level manager who saw only their direct
 * reports would see almost nobody.
 *
 * Soft-deleted employees are excluded: a departed colleague showing as "Absent"
 * every day forever is noise, not information.
 */
export async function teamGrid(actor, { now = new Date() } = {}) {
  if (!actor?.employeeId) return [];

  const orgWide = hasHrmsPermission(actor, M.ATTENDANCE, A.VIEW, S.ORG);

  const employees = await Employee.find(
    orgWide
      ? { deletedAt: null, status: { $in: PUNCHABLE_STATUSES } }
      : { deletedAt: null, managerChain: actor.employeeId },
  )
    .select('_id employeeCode firstName lastName status departmentId')
    .sort({ firstName: 1, lastName: 1 })
    .lean();

  if (employees.length === 0) return [];

  const records = await AttendanceRecord.find({
    employeeId: { $in: employees.map((e) => e._id) },
    date: todayDate(now),
  }).lean();

  const byEmployee = new Map(records.map((r) => [idStr(r.employeeId), r]));

  return employees.map((employee) => {
    const record = byEmployee.get(idStr(employee._id));
    const clockIn = record?.clockIn ?? null;
    const clockOut = record?.clockOut ?? null;

    return {
      employeeId: idStr(employee._id),
      employeeCode: employee.employeeCode,
      displayName: `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim(),
      employmentStatus: employee.status,
      recordId: record ? idStr(record._id) : null,
      clockIn: clockIn ? new Date(clockIn).toISOString() : null,
      clockOut: clockOut ? new Date(clockOut).toISOString() : null,
      status: record?.status ?? 'absent',
      source: record?.source ?? null,
      // Everyone in this grid is inside the caller's scope by construction —
      // they are the caller's own reports, or the caller sees the whole company
      // — so capture detail is visible without a further per-row check.
      clockInCapture: {
        hasSelfie: Boolean(record?.clockInCapture?.selfieKey),
        geo: record?.clockInCapture?.geo ?? null,
        locationLabel: record?.clockInCapture?.locationLabel ?? null,
      },
      clockOutCapture: {
        hasSelfie: Boolean(record?.clockOutCapture?.selfieKey),
        geo: record?.clockOutCapture?.geo ?? null,
        locationLabel: record?.clockOutCapture?.locationLabel ?? null,
      },
      derived: deriveAttendanceStatus(clockIn, clockOut, now),
      hoursWorked: Number(hoursBetween(clockIn, clockOut).toFixed(4)),
    };
  });
}

export { toDto as attendanceRecordDto, PUNCHABLE_STATUSES };

export default {
  clockIn,
  clockOut,
  today,
  list,
  teamGrid,
  readFilterFor,
  canViewCapture,
  ownerContextFor,
  normaliseRange,
};
