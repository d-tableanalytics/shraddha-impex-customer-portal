/**
 * Department service.
 *
 * Ported from the reference's `DepartmentService` (`department.service.ts`).
 * Its five operations are `list`, `findOne`, `create`, `update`, `remove`, and
 * that is exactly what is here — the reference has no search, no pagination and
 * no filtering on this endpoint, so none is invented.
 *
 * ---------------------------------------------------------------------------
 * What changes, and why
 * ---------------------------------------------------------------------------
 * 1. DELETE IS SOFT (O-3). The reference hard-deletes and lets a Postgres
 *    foreign key refuse. AD-2 removed foreign keys, so nothing would refuse:
 *    the row would vanish and every employee holding that `departmentId` would
 *    render a blank field with no way to find out what it used to say. The
 *    check the database used to perform is done here, explicitly, before the
 *    write — and never in the browser.
 *
 * 2. `employeeCount` COUNTS LIVE EMPLOYEES ONLY. The reference's
 *    `_count: { select: { employees: true } }` carries no `where`, so a
 *    department whose entire staff has been soft-deleted still reports them.
 *    In the reference that number is also what its confirm dialog uses to
 *    disable deletion, so such a department can never be removed at all. Here
 *    the count and the delete guard read the same filter, so the number shown
 *    is the number that blocks.
 *
 * 3. AUDIT LIVES HERE, not in the controller as it does in Employee Master.
 *    These services are also the path a future seed or import would take, and
 *    an audit entry that only exists when the change arrived over HTTP is one
 *    that quietly goes missing. `context` is optional so the service can still
 *    be called without a request.
 */

import mongoose from 'mongoose';

import Department from '../../../models/hrms/Department.js';
import Employee from '../../../models/hrms/Employee.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
} from '../../../shared/schemas/org.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
} from '../hrms.errors.js';
import { formatZodIssues } from '../../../shared/validation/common.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

/** The public shape. `parentId` is deliberately absent — see the model (O-1). */
const toDto = (row) => ({
  id: idStr(row._id),
  code: row.code,
  name: row.name,
});

/**
 * Parse with the shared schema.
 *
 * The controller will validate too (step 3), but a service that trusts its
 * caller is only safe until something other than a controller calls it.
 * Parsing twice is idempotent; parsing never is a hole.
 */
function parse(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new HrmsValidationError('Invalid department.', formatZodIssues(result.error));
  }
  return result.data;
}

/**
 * Translate a duplicate-key error into the business conflict it represents.
 *
 * The partial unique index is the real guarantee. A read-then-write pre-check
 * would look friendlier and would still lose a race between two admins, so the
 * index stays authoritative and this only improves the message.
 */
function translateDuplicate(error, code) {
  if (error?.code === 11000) {
    return new HrmsConflictError(`Department code "${code}" is already in use.`, {
      code: 'DEPARTMENT_CODE_TAKEN',
    });
  }
  return error;
}

/** Live employees per department id, in one pass rather than one query per row. */
async function liveEmployeeCounts(field) {
  const rows = await Employee.aggregate([
    { $match: { deletedAt: null, [field]: { $ne: null } } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [idStr(r._id), r.count]));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every live department, ordered by name, each with its live employee count.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeDeleted] retired departments too. An
 *   employee can still reference one, so a caller resolving names for display
 *   needs to be able to see them.
 */
export async function listDepartments({ includeDeleted = false } = {}) {
  const filter = includeDeleted ? {} : { deletedAt: null };

  const [rows, counts] = await Promise.all([
    Department.find(filter).sort({ name: 1 }).lean(),
    liveEmployeeCounts('departmentId'),
  ]);

  return rows.map((row) => ({
    ...toDto(row),
    employeeCount: counts.get(idStr(row._id)) ?? 0,
    deletedAt: row.deletedAt ?? null,
  }));
}

/** @throws {HrmsNotFoundError} */
export async function getDepartment(id, { includeDeleted = false } = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Department');

  const filter = includeDeleted ? { _id: id } : { _id: id, deletedAt: null };
  const row = await Department.findOne(filter).lean();
  if (!row) throw new HrmsNotFoundError('Department');

  return toDto(row);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createDepartment(input, context = {}) {
  const dto = parse(createDepartmentSchema, input);

  let row;
  try {
    row = await Department.create({ code: dto.code, name: dto.name });
  } catch (error) {
    throw translateDuplicate(error, dto.code);
  }

  const department = toDto(row);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DEPARTMENT_CREATED,
    `Created department ${department.code} (${department.name})`,
    context.req,
    { meta: { departmentId: department.id, code: department.code, name: department.name } },
  );

  return department;
}

export async function updateDepartment(id, input, context = {}) {
  const dto = parse(updateDepartmentSchema, input);
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Department');

  // A retired department is not editable — bringing one back is a restore, and
  // there is no restore in the reference's product.
  const existing = await Department.findOne({ _id: id, deletedAt: null });
  if (!existing) throw new HrmsNotFoundError('Department');

  if (Object.keys(dto).length === 0) return toDto(existing.toObject());

  if (dto.code !== undefined) existing.code = dto.code;
  if (dto.name !== undefined) existing.name = dto.name;

  try {
    await existing.save();
  } catch (error) {
    throw translateDuplicate(error, dto.code ?? existing.code);
  }

  const department = toDto(existing.toObject());
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DEPARTMENT_UPDATED,
    `Updated department ${department.code}`,
    context.req,
    { meta: { departmentId: department.id, fields: Object.keys(dto) } },
  );

  return department;
}

/**
 * Retire a department (O-3).
 *
 * Refuses while any LIVE employee still references it. The reference relies on
 * a foreign key for this; we have none, so the check is explicit, server-side,
 * and the only thing standing between a retired department and a set of
 * employee records pointing at nothing.
 *
 * @throws {HrmsConflictError} when employees still reference it
 */
export async function deleteDepartment(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Department');

  const existing = await Department.findOne({ _id: id, deletedAt: null }).lean();
  if (!existing) throw new HrmsNotFoundError('Department');

  // `deletedAt: null`, not `status: 'active'`. Status is where someone is in
  // their employment; deletedAt is whether the record exists at all. An exited
  // employee still has a profile that renders this department's name.
  const inUse = await Employee.countDocuments({ departmentId: id, deletedAt: null });
  if (inUse > 0) {
    throw new HrmsConflictError(
      `${inUse} employee${inUse === 1 ? '' : 's'} still assigned to "${existing.name}". Reassign them before deleting.`,
      // employeeCount goes in `details`: HrmsError reads only `code` and
      // `details`, so a sibling key would be silently dropped and the
      // response would lose the one number that tells the admin what to do.
      { code: 'DEPARTMENT_IN_USE', details: { employeeCount: inUse } },
    );
  }

  await Department.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DEPARTMENT_DELETED,
    `Deleted department ${existing.code} (${existing.name})`,
    context.req,
    { meta: { departmentId: idStr(existing._id), code: existing.code, name: existing.name } },
  );

  return { id: idStr(existing._id), code: existing.code, deleted: true };
}

export default {
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
};
