/**
 * Employee Master business logic.
 *
 * Ported from the reference's `employees.service.ts`, rule for rule. Where a
 * rule changed, the reason is stated at the point of change rather than in a
 * summary somewhere else.
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import EmployeeCustomField from '../../../models/hrms/EmployeeCustomField.js';
import User from '../../../models/User.js';
import { hashPassword } from '../../../utils/password.js';
import { isDuplicateKeyError, isTransactionUnsupported } from '../../../utils/mongoSession.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import { assertRolesAssignable } from '../../../shared/permissions/assignment.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
  isHrmsRoleKey,
  HRMS_ROLE_LIST,
} from '../../../shared/permissions/constants.js';
import {
  encryptField,
  decryptField,
  blindIndex,
  maskSensitiveValue,
  sanitiseCustomFields,
} from '../../../utils/hrms/crypto/index.js';
import {
  SENSITIVE_EMPLOYEE_FIELD_LIST,
  BLIND_INDEXED_FIELDS,
} from '../../../shared/security/sensitive-fields.js';
import { encPath, idxPath } from '../../../models/hrms/plugins/sensitiveFields.js';
import { describe as describeReferences, resolveDepartment, resolveLocation } from '../references/reference.service.js';
import {
  assertNoCycle,
  computeManagerChain,
  rebuildDescendantChains,
} from './managerChain.js';
import {
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsNotFoundError,
  HrmsNotImplementedError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const toDate = (v) => (v ? new Date(`${v}T00:00:00.000Z`) : null);
const toDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Add N calendar months, matching the reference's `addMonths`. */
const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};

/**
 * Run `fn` in a transaction, falling back to no session on a standalone mongod.
 *
 * The portal's established pattern — see `utils/mongoSession.js`. Employee
 * creation writes a User AND an Employee, so a partial failure would otherwise
 * leave an orphaned login with no employee record.
 */
async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } catch (err) {
    if (!isTransactionUnsupported(err)) throw err;
    // Standalone deployment: re-run unsessioned. Nothing was committed.
    return fn(null);
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * The wire shape of an employee.
 *
 * Sensitive fields are reported as PRESENCE only — `true` when a value is on
 * file, `null` when it is not. Never the value, never the ciphertext, never the
 * blind index. Revealing one is a separate, audited call.
 */
export function toEmployeeDto(row, { user, manager } = {}) {
  const sensitive = Object.fromEntries(
    SENSITIVE_EMPLOYEE_FIELD_LIST.map((f) => [f, row[encPath(f)] ? true : null]),
  );

  return {
    id: idStr(row._id),
    userId: idStr(row.userId),
    employeeCode: row.employeeCode,
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim(),
    email: user?.email ?? null,
    personalEmail: row.personalEmail ?? null,
    phone: row.phone ?? null,
    phone2: row.phone2 ?? null,
    dateOfBirth: toDay(row.dateOfBirth),
    dateOfJoining: toDay(row.dateOfJoining),
    employmentType: row.employmentType,
    designation: row.designation ?? null,
    status: row.status,
    probationMonths: row.probationMonths ?? null,
    probationStartDate: toDay(row.probationStartDate),
    probationEndDate: toDay(row.probationEndDate),
    confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
    noticeStartDate: toDay(row.noticeStartDate),
    noticeMonths: row.noticeMonths ?? null,
    noticeEndDate: toDay(row.noticeEndDate),
    departmentId: idStr(row.departmentId),
    locationId: idStr(row.locationId),
    reportingManagerId: idStr(row.reportingManagerId),
    reportingManagerName: manager
      ? `${manager.firstName ?? ''} ${manager.lastName ?? ''}`.trim()
      : null,
    fatherName: row.fatherName ?? null,
    motherName: row.motherName ?? null,
    permanentAddress: row.permanentAddress ?? null,
    temporaryAddress: row.temporaryAddress ?? null,
    emergencyContacts: row.emergencyContacts ?? [],
    dependents: row.dependents ?? [],
    customFieldValues: row.customFieldValues ?? {},
    ...sensitive,
    // Derived, exposed read-only so the UI can show a reporting line.
    managerChain: (row.managerChain ?? []).map(idStr),
  };
}

/** Batch-load the users and managers a page of rows needs. Avoids N+1. */
async function hydrate(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const userIds = list.map((r) => r.userId).filter(Boolean);
  const managerIds = list.map((r) => r.reportingManagerId).filter(Boolean);

  const [users, managers] = await Promise.all([
    userIds.length
      ? User.find({ _id: { $in: userIds } }).select('email user').lean()
      : [],
    managerIds.length
      ? Employee.find({ _id: { $in: managerIds } }).select('firstName lastName').lean()
      : [],
  ]);

  const userById = new Map(users.map((u) => [idStr(u._id), u]));
  const managerById = new Map(managers.map((m) => [idStr(m._id), m]));

  return list.map((row) =>
    toEmployeeDto(row, {
      user: userById.get(idStr(row.userId)),
      manager: managerById.get(idStr(row.reportingManagerId)),
    }),
  );
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The scope filter for a list read.
 *
 * Applied as a QUERY condition rather than filtering after the fetch, so the
 * index does the work and pagination counts what the actor can actually see.
 * Filtering post-fetch would also make `total` a lie.
 */
function buildScopeFilter(actor) {
  if (hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.ORG)) return {};

  if (hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.TEAM)) {
    // In the actor's team means the actor is anywhere in the employee's chain —
    // which is exactly what the denormalised array is for.
    if (!actor.employeeId) return { _id: null }; // matches nothing
    const me = new mongoose.Types.ObjectId(String(actor.employeeId));
    return { $or: [{ _id: me }, { managerChain: me }] };
  }

  if (hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.SELF)) {
    if (!actor.employeeId) return { _id: null };
    return { _id: new mongoose.Types.ObjectId(String(actor.employeeId)) };
  }

  throw new HrmsForbiddenError('No permission to list employees.');
}

const resourceOf = (row) => ({
  ownerUserId: idStr(row.userId),
  ownerEmployeeId: idStr(row._id),
  ownerDepartmentId: idStr(row.departmentId) ?? undefined,
  ownerManagerChain: (row.managerChain ?? []).map(idStr),
});

function assertCanView(actor, row) {
  const ctx = resourceOf(row);
  const ok =
    hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.ORG) ||
    hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.TEAM, ctx) ||
    hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.SELF, ctx);
  if (!ok) throw new HrmsForbiddenError('Cannot view this employee.');
}

function assertCanEdit(actor, row) {
  const ctx = resourceOf(row);
  const ok =
    hasHrmsPermission(actor, M.EMPLOYEES, A.EDIT, S.ORG) ||
    hasHrmsPermission(actor, M.EMPLOYEES, A.EDIT, S.SELF, ctx);
  if (!ok) throw new HrmsForbiddenError('Cannot edit this employee.');
}

// ---------------------------------------------------------------------------
// Reference validation (AD-2 removed the foreign keys)
// ---------------------------------------------------------------------------

/**
 * Verify department and location ids resolve.
 *
 * When Org Structure is not built, supplying one of these is REFUSED with a 503
 * rather than stored unvalidated. There are no foreign keys, so an unchecked id
 * becomes a dangling reference nothing will ever catch — and "the module does
 * not exist yet" is a far more useful answer than a broken link discovered
 * months later. Leaving them null is always fine.
 */
async function assertReferencesResolve({ departmentId, locationId }) {
  const wired = describeReferences();

  if (departmentId) {
    if (!wired.department) {
      throw new HrmsNotImplementedError(
        'Assigning a department',
        'Org Structure is not built yet, so a department cannot be validated. Leave it empty for now.',
      );
    }
    if (!(await resolveDepartment(departmentId))) {
      throw new HrmsValidationError('departmentId does not exist.');
    }
  }

  if (locationId) {
    if (!wired.location) {
      throw new HrmsNotImplementedError(
        'Assigning a location',
        'Org Structure is not built yet, so a location cannot be validated. Leave it empty for now.',
      );
    }
    if (!(await resolveLocation(locationId))) {
      throw new HrmsValidationError('locationId does not exist.');
    }
  }
}

async function assertManagerExists(reportingManagerId) {
  if (!reportingManagerId) return;
  const mgr = await Employee.findOne({ _id: reportingManagerId, deletedAt: null })
    .select('_id')
    .lean();
  if (!mgr) throw new HrmsValidationError('reportingManagerId does not exist.');
}

// ---------------------------------------------------------------------------
// Sensitive fields
// ---------------------------------------------------------------------------

/**
 * Turn submitted sensitive values into their stored form.
 *
 * Runs BEFORE any write. Returns the `$set` fragment — ciphertext envelope plus
 * blind index — so the caller never handles a plaintext value again.
 *
 * A blind index is required for uniqueness: the ciphertext differs on every
 * write (random IV), so an equality query could never find a duplicate PAN.
 */
async function buildSensitiveUpdate(dto, { employeeId = null } = {}) {
  const $set = {};

  for (const field of SENSITIVE_EMPLOYEE_FIELD_LIST) {
    if (!(field in dto)) continue;
    const value = dto[field];

    if (value === null || value === '') {
      $set[encPath(field)] = null;
      if (BLIND_INDEXED_FIELDS.includes(field)) $set[idxPath(field)] = null;
      continue;
    }

    $set[encPath(field)] = await encryptField(value);

    if (BLIND_INDEXED_FIELDS.includes(field)) {
      const index = blindIndex(value);
      const clash = await Employee.findOne({
        [idxPath(field)]: index,
        deletedAt: null,
        ...(employeeId ? { _id: { $ne: employeeId } } : {}),
      })
        .select('employeeCode')
        .lean();
      if (clash) {
        // Names the field, never the value — the whole point of the index is
        // that the value is not readable from it.
        throw new HrmsConflictError(
          `Another employee (${clash.employeeCode}) already has this ${field}.`,
          { code: 'SENSITIVE_VALUE_DUPLICATE' },
        );
      }
      $set[idxPath(field)] = index;
    }
  }

  return $set;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listEmployees(actor, query) {
  const scope = buildScopeFilter(actor);

  const filter = {
    deletedAt: null,
    ...scope,
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.locationId ? { locationId: query.locationId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.managerId ? { reportingManagerId: query.managerId } : {}),
  };

  if (query.search) {
    // Anchored regex on the fields the reference searches. Escaped, because an
    // unescaped user string is both a correctness bug and a ReDoS risk.
    const safe = String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    const matchingUsers = await User.find({ email: rx }).select('_id').lean();
    filter.$and = [
      {
        $or: [
          { firstName: rx },
          { lastName: rx },
          { employeeCode: rx },
          ...(matchingUsers.length
            ? [{ userId: { $in: matchingUsers.map((u) => u._id) } }]
            : []),
        ],
      },
    ];
  }

  if (query.roleKey) {
    const users = await User.find({ roles: query.roleKey }).select('_id').lean();
    filter.userId = { $in: users.map((u) => u._id) };
  }

  // The reference orders by status then first name; an explicit sort overrides.
  const sort = query.sortBy
    ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
    : { status: 1, firstName: 1 };

  const skip = (query.page - 1) * query.pageSize;

  const [rows, total] = await Promise.all([
    Employee.find(filter).sort(sort).skip(skip).limit(query.pageSize).lean(),
    Employee.countDocuments(filter),
  ]);

  return {
    data: await hydrate(rows),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getEmployee(id, actor) {
  const row = await Employee.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Employee');

  // Second line of defence. The route guard checks scope too, but a direct
  // service call from a job or a test must not slip past.
  assertCanView(actor, row);

  const [dto] = await hydrate([row]);
  return dto;
}

/**
 * Reveal ONE sensitive value in full.
 *
 * Deliberately separate from the read, deliberately one field at a time, and
 * deliberately audited by the caller. Requires `employees:compensation:view:org`
 * — the narrowest permission that fits, and one only payroll admin and super
 * admin hold.
 */
export async function revealSensitiveField(id, field, actor) {
  if (!hasHrmsPermission(actor, M.EMPLOYEES_COMPENSATION, A.VIEW, S.ORG)) {
    throw new HrmsForbiddenError(
      'Viewing a full PAN, bank account or government identifier requires compensation access.',
    );
  }
  if (!SENSITIVE_EMPLOYEE_FIELD_LIST.includes(field)) {
    throw new HrmsValidationError(`"${field}" is not a sensitive employee field.`);
  }

  const row = await Employee.findOne({ _id: id, deletedAt: null })
    .select(`employeeCode ${encPath(field)}`)
    .lean();
  if (!row) throw new HrmsNotFoundError('Employee');

  const envelope = row[encPath(field)];
  if (!envelope) return { field, value: null, masked: null };

  const value = await decryptField(envelope);
  return { field, value, masked: maskSensitiveValue(value) };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create an employee, its login, and its HRMS roles.
 *
 * Returns the record plus a one-time temporary password, exactly as the
 * reference does, so an administrator can hand it over. It is never stored in
 * plaintext and never logged.
 */
export async function createEmployee(dto, actor) {
  if (!hasHrmsPermission(actor, M.EMPLOYEES, A.CREATE, S.ORG)) {
    throw new HrmsForbiddenError('Cannot create employees.');
  }

  // AD-4: an employee's login is never a Customer account.
  const roleKeys = dto.initialRoleKeys?.length ? dto.initialRoleKeys : ['hrms_employee'];
  const unknown = roleKeys.filter((k) => !HRMS_ROLE_LIST.includes(k));
  if (unknown.length > 0) {
    throw new HrmsValidationError(`Unknown HRMS role key(s): ${unknown.join(', ')}`);
  }
  if (!roleKeys.every(isHrmsRoleKey)) {
    throw new HrmsValidationError('Only HRMS roles can be granted here.');
  }

  await assertReferencesResolve(dto);
  await assertManagerExists(dto.reportingManagerId);

  // AD-10 / AD-11: strip reserved keys out of the blob IN MEMORY, before
  // anything is assembled for persistence. A later cleanup would leave the
  // plaintext in the oplog, on every replica, and in any backup taken between.
  const { clean: customFieldValues, extracted } = sanitiseCustomFields(dto.customFieldValues);
  const sensitiveInput = { ...extracted, ...pickSensitive(dto) };

  const tempPassword = crypto.randomBytes(9).toString('base64url'); // ~12 chars
  const passwordHash = await hashPassword(tempPassword);

  const joining = toDate(dto.dateOfJoining);
  const probationStart = toDate(dto.probationStartDate) ?? joining;
  const probationMonths = dto.probationMonths ?? 3;

  const created = await withTransaction(async (session) => {
    const opts = session ? { session } : {};

    const [user] = await User.create(
      [
        {
          email: dto.email,
          password: passwordHash,
          user: `${dto.firstName} ${dto.lastName}`,
          // A portal role is required by the schema; staff are not Customers,
          // and this is the neutral non-Customer value (AD-4).
          role: 'Management',
          roles: roleKeys,
          status: dto.status === 'invited' ? 'Inactive' : 'Active',
        },
      ],
      opts,
    ).catch((err) => {
      if (isDuplicateKeyError(err)) {
        throw new HrmsConflictError('That email address is already in use.', {
          code: 'EMAIL_IN_USE',
        });
      }
      throw err;
    });

    const managerChain = await computeManagerChain(dto.reportingManagerId ?? null);
    const sensitive = await buildSensitiveUpdate(sensitiveInput);

    const [employee] = await Employee.create(
      [
        {
          userId: user._id,
          employeeCode: dto.employeeCode,
          firstName: dto.firstName,
          lastName: dto.lastName,
          personalEmail: dto.personalEmail ?? null,
          phone: dto.phone ?? null,
          phone2: dto.phone2 ?? null,
          dateOfBirth: toDate(dto.dateOfBirth),
          dateOfJoining: joining,
          employmentType: dto.employmentType,
          designation: dto.designation ?? null,
          status: dto.status,
          probationMonths,
          probationStartDate: probationStart,
          probationEndDate:
            toDate(dto.probationEndDate) ?? addMonths(probationStart, probationMonths),
          departmentId: dto.departmentId ?? null,
          locationId: dto.locationId ?? null,
          reportingManagerId: dto.reportingManagerId ?? null,
          managerChain,
          noticeStartDate: toDate(dto.noticeStartDate),
          noticeMonths: dto.noticeMonths ?? null,
          noticeEndDate: toDate(dto.noticeEndDate),
          fatherName: dto.fatherName ?? null,
          motherName: dto.motherName ?? null,
          permanentAddress: dto.permanentAddress ?? null,
          temporaryAddress: dto.temporaryAddress ?? null,
          emergencyContacts: dto.emergencyContacts ?? [],
          dependents: dto.dependents ?? [],
          customFieldValues,
          createdById: actor.userId,
          updatedById: actor.userId,
          ...sensitive,
        },
      ],
      opts,
    ).catch(async (err) => {
      if (isDuplicateKeyError(err)) {
        throw new HrmsConflictError('That employee code is already in use.', {
          code: 'EMPLOYEE_CODE_IN_USE',
        });
      }
      throw err;
    });

    return employee.toObject();
  });

  const [employee] = await hydrate([created]);
  return { employee, tempPassword };
}

/** The sensitive values present on a payload, without touching the others. */
function pickSensitive(dto) {
  const out = {};
  for (const f of SENSITIVE_EMPLOYEE_FIELD_LIST) {
    if (f in dto) out[f] = dto[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** Job fields a regular employee may not change on their own record. */
const JOB_FIELDS = [
  'employmentType',
  'designation',
  'departmentId',
  'locationId',
  'reportingManagerId',
  'status',
];

export async function updateEmployee(id, dto, actor) {
  const existing = await Employee.findOne({ _id: id, deletedAt: null }).lean();
  if (!existing) throw new HrmsNotFoundError('Employee');

  assertCanEdit(actor, existing);

  const isSelf = idStr(existing._id) === idStr(actor.employeeId);
  const hasOrgEdit = hasHrmsPermission(actor, M.EMPLOYEES, A.EDIT, S.ORG);

  // Nobody signs off their own probation. HR holds employees:edit:org, so
  // without this they could quietly extend or end their own probation window.
  const touchingProbation =
    dto.probationMonths !== undefined ||
    dto.probationStartDate !== undefined ||
    dto.probationEndDate !== undefined;
  if (touchingProbation && isSelf && !actor.roleKeys.includes('hrms_super_admin')) {
    throw new HrmsForbiddenError('Only a super admin can change your own probation window.');
  }

  // An employee editing their own profile may change personal details only.
  // employees:edit:self is in the baseline, so without this an employee could
  // promote themselves by editing their own designation or manager.
  if (isSelf && !hasOrgEdit) {
    for (const field of JOB_FIELDS) {
      if (dto[field] !== undefined) {
        throw new HrmsForbiddenError(
          `Only HR, a recruiter or a super admin can change ${field}.`,
        );
      }
    }
  }

  await assertReferencesResolve(dto);

  const managerChanged =
    dto.reportingManagerId !== undefined &&
    idStr(dto.reportingManagerId) !== idStr(existing.reportingManagerId);

  if (managerChanged) {
    await assertManagerExists(dto.reportingManagerId);
    // The correction the reference lacks entirely.
    await assertNoCycle(idStr(existing._id), dto.reportingManagerId ?? null);
  }

  const { clean: cleanCustom, extracted } = dto.customFieldValues
    ? sanitiseCustomFields(dto.customFieldValues)
    : { clean: undefined, extracted: {} };

  const sensitive = await buildSensitiveUpdate(
    { ...extracted, ...pickSensitive(dto) },
    { employeeId: existing._id },
  );

  const $set = { updatedById: actor.userId, ...sensitive };

  const DIRECT_FIELDS = [
    'firstName', 'lastName', 'personalEmail', 'phone', 'phone2',
    'employmentType', 'designation', 'status',
    'departmentId', 'locationId', 'reportingManagerId',
    'probationMonths', 'noticeMonths',
    'fatherName', 'motherName', 'permanentAddress', 'temporaryAddress',
    'emergencyContacts', 'dependents',
  ];
  for (const f of DIRECT_FIELDS) {
    if (dto[f] !== undefined) $set[f] = dto[f];
  }

  for (const f of [
    'dateOfBirth', 'probationStartDate', 'probationEndDate',
    'noticeStartDate', 'noticeEndDate',
  ]) {
    if (dto[f] !== undefined) $set[f] = toDate(dto[f]);
  }

  if (cleanCustom !== undefined) $set.customFieldValues = cleanCustom;

  if (managerChanged) {
    $set.managerChain = await computeManagerChain(dto.reportingManagerId ?? null);
  }

  const updated = await withTransaction(async (session) => {
    const opts = session ? { session } : {};

    const row = await Employee.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set },
      { new: true, runValidators: true, ...opts },
    ).lean();

    // Keep the login's display name in step with the employee's name.
    if (dto.firstName !== undefined || dto.lastName !== undefined || dto.displayName) {
      const displayName =
        dto.displayName ??
        `${dto.firstName ?? existing.firstName} ${dto.lastName ?? existing.lastName}`.trim();
      await User.updateOne({ _id: existing.userId }, { $set: { user: displayName } }, opts);
    }

    // Flipping to `inactive` — post-exit, formalities complete — suspends the
    // login. Any other status change leaves the account alone, so HR can
    // suspend and restore access independently of employment status.
    if (dto.status === 'inactive' && existing.status !== 'inactive') {
      await User.updateOne(
        { _id: existing.userId },
        { $set: { status: 'Suspended', refreshTokenHash: null } },
        opts,
      );
    }

    // Descendants inherit a new prefix. Skipping this is the silent RBAC bug:
    // a manager stops being able to see their own reports.
    if (managerChanged) {
      await rebuildDescendantChains(id, { session });
    }

    return row;
  });

  const [dto2] = await hydrate([updated]);
  return dto2;
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

/**
 * Soft delete, matching the reference exactly.
 *
 * A hard delete would strand attendance, leave and payroll rows that reference
 * this employee, and AD-2 has no cascade to catch it. The record is marked
 * `exited`, its login is suspended, and its sessions are revoked.
 *
 * Direct reports block the operation: removing a middle manager would orphan
 * everyone under them and leave their chains pointing at a deleted row.
 */
export async function deactivateEmployee(id, actor) {
  if (!hasHrmsPermission(actor, M.EMPLOYEES, A.DELETE, S.ORG)) {
    throw new HrmsForbiddenError('Cannot deactivate employees.');
  }

  const existing = await Employee.findOne({ _id: id, deletedAt: null }).lean();
  if (!existing) throw new HrmsNotFoundError('Employee');

  const reports = await Employee.countDocuments({
    reportingManagerId: id,
    deletedAt: null,
  });
  if (reports > 0) {
    throw new HrmsConflictError(
      `This employee has ${reports} direct report${reports === 1 ? '' : 's'}. Reassign them first.`,
      { code: 'HAS_DIRECT_REPORTS' },
    );
  }

  await withTransaction(async (session) => {
    const opts = session ? { session } : {};
    await Employee.updateOne(
      { _id: id },
      { $set: { deletedAt: new Date(), status: 'exited', updatedById: actor.userId } },
      opts,
    );
    await User.updateOne(
      { _id: existing.userId },
      { $set: { status: 'Suspended', refreshTokenHash: null } },
      opts,
    );
  });

  return { id: idStr(id), employeeCode: existing.employeeCode };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function getEmployeeRoles(id, actor) {
  if (!hasHrmsPermission(actor, M.EMPLOYEES, A.EDIT, S.ORG)) {
    throw new HrmsForbiddenError('Only org-level editors can view role assignments.');
  }
  const emp = await Employee.findOne({ _id: id, deletedAt: null }).select('userId').lean();
  if (!emp) throw new HrmsNotFoundError('Employee');

  const user = await User.findById(emp.userId).select('roles role').lean();
  return { roleKeys: (user?.roles ?? []).filter(isHrmsRoleKey) };
}

export async function assignEmployeeRoles(id, roleKeys, actor) {
  if (!hasHrmsPermission(actor, M.EMPLOYEES, A.EDIT, S.ORG)) {
    throw new HrmsForbiddenError('Only org-level editors can change role assignments.');
  }

  const unknown = roleKeys.filter((k) => !HRMS_ROLE_LIST.includes(k));
  if (unknown.length > 0) {
    throw new HrmsValidationError(`Unknown HRMS role key(s): ${unknown.join(', ')}`);
  }

  const emp = await Employee.findOne({ _id: id, deletedAt: null }).select('userId').lean();
  if (!emp) throw new HrmsNotFoundError('Employee');

  const user = await User.findById(emp.userId).select('role roles').lean();
  if (!user) throw new HrmsNotFoundError('Employee login');

  // AD-4, checked here as well as in the schema hook: findOneAndUpdate does not
  // run document validation, so this is the real control on this path.
  assertRolesAssignable(user.role, roleKeys);

  // Replace only the HRMS half; portal roles on the same account are untouched.
  const portalRoles = (user.roles ?? []).filter((k) => !isHrmsRoleKey(k));
  await User.updateOne({ _id: emp.userId }, { $set: { roles: [...portalRoles, ...roleKeys] } });

  return { roleKeys };
}

/**
 * Issue a fresh temporary password.
 *
 * Super admin only, as in the reference. Revokes live sessions, and returns the
 * plaintext ONCE — it is never stored or logged.
 */
export async function resetEmployeePassword(id, actor) {
  if (!actor.roleKeys.includes('hrms_super_admin')) {
    throw new HrmsForbiddenError('Only a super admin can reset an employee password.');
  }

  const emp = await Employee.findOne({ _id: id, deletedAt: null }).select('userId').lean();
  if (!emp) throw new HrmsNotFoundError('Employee');

  const tempPassword = crypto.randomBytes(9).toString('base64url');
  await User.updateOne(
    { _id: emp.userId },
    { $set: { password: await hashPassword(tempPassword), refreshTokenHash: null } },
  );

  return { tempPassword };
}

// ---------------------------------------------------------------------------
// Custom field definitions
// ---------------------------------------------------------------------------

export async function listCustomFields() {
  const rows = await EmployeeCustomField.find({}).sort({ order: 1, createdAt: 1 }).lean();
  return rows.map((r) => ({
    id: idStr(r._id),
    name: r.name,
    label: r.label,
    type: r.type,
    options: r.options ?? [],
    required: r.required,
    order: r.order,
  }));
}

export async function createCustomField(dto) {
  try {
    const row = await EmployeeCustomField.create(dto);
    return {
      id: idStr(row._id),
      name: row.name,
      label: row.label,
      type: row.type,
      options: row.options,
      required: row.required,
      order: row.order,
    };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new HrmsConflictError('A custom field with that name already exists.');
    }
    throw err;
  }
}

export async function updateCustomField(id, dto) {
  const row = await EmployeeCustomField.findByIdAndUpdate(id, { $set: dto }, {
    new: true,
    runValidators: true,
  }).lean();
  if (!row) throw new HrmsNotFoundError('Custom field');
  return {
    id: idStr(row._id),
    name: row.name,
    label: row.label,
    type: row.type,
    options: row.options ?? [],
    required: row.required,
    order: row.order,
  };
}

/**
 * Retire a definition.
 *
 * Existing VALUES are deliberately left on their employee records, matching the
 * reference: HR keeps the historical data after a field is withdrawn.
 */
export async function deleteCustomField(id) {
  const row = await EmployeeCustomField.findByIdAndDelete(id).lean();
  if (!row) throw new HrmsNotFoundError('Custom field');
}

export default {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deactivateEmployee,
  revealSensitiveField,
  getEmployeeRoles,
  assignEmployeeRoles,
  resetEmployeePassword,
  listCustomFields,
  createCustomField,
  updateCustomField,
  deleteCustomField,
  toEmployeeDto,
};
