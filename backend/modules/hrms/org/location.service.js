/**
 * Location service.
 *
 * The mirror of `department.service.js` — same five operations, same soft
 * delete, same live-only employee count, same explicit in-use guard (O-3).
 * Ported from the reference's `LocationService` (`location.service.ts`), which
 * likewise has no search, pagination or filtering.
 *
 * The one field that behaves differently is `timezone`: required, defaulted to
 * the reference's `Asia/Kolkata`, and validated against what the runtime can
 * actually resolve rather than a hardcoded list of seven. See
 * shared/constants/timezones.js for why the picker list and the validator are
 * deliberately different sets.
 */

import mongoose from 'mongoose';

import Location from '../../../models/hrms/Location.js';
import Employee from '../../../models/hrms/Employee.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import { createLocationSchema, updateLocationSchema } from '../../../shared/schemas/org.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
} from '../hrms.errors.js';
import { formatZodIssues } from '../../../shared/validation/common.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

const EDITABLE = ['code', 'name', 'address', 'city', 'country', 'timezone'];

const toDto = (row) => ({
  id: idStr(row._id),
  code: row.code,
  name: row.name,
  address: row.address ?? null,
  city: row.city ?? null,
  country: row.country ?? null,
  timezone: row.timezone,
});

function parse(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new HrmsValidationError('Invalid location.', formatZodIssues(result.error));
  }
  return result.data;
}

function translateDuplicate(error, code) {
  if (error?.code === 11000) {
    return new HrmsConflictError(`Location code "${code}" is already in use.`, {
      code: 'LOCATION_CODE_TAKEN',
    });
  }
  return error;
}

/** Live employees per location id, in one pass. */
async function liveEmployeeCounts() {
  const rows = await Employee.aggregate([
    { $match: { deletedAt: null, locationId: { $ne: null } } },
    { $group: { _id: '$locationId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [idStr(r._id), r.count]));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listLocations({ includeDeleted = false } = {}) {
  const filter = includeDeleted ? {} : { deletedAt: null };

  const [rows, counts] = await Promise.all([
    Location.find(filter).sort({ name: 1 }).lean(),
    liveEmployeeCounts(),
  ]);

  return rows.map((row) => ({
    ...toDto(row),
    employeeCount: counts.get(idStr(row._id)) ?? 0,
    deletedAt: row.deletedAt ?? null,
  }));
}

export async function getLocation(id, { includeDeleted = false } = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Location');

  const filter = includeDeleted ? { _id: id } : { _id: id, deletedAt: null };
  const row = await Location.findOne(filter).lean();
  if (!row) throw new HrmsNotFoundError('Location');

  return toDto(row);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createLocation(input, context = {}) {
  const dto = parse(createLocationSchema, input);

  let row;
  try {
    row = await Location.create({
      code: dto.code,
      name: dto.name,
      address: dto.address ?? null,
      city: dto.city ?? null,
      country: dto.country ?? null,
      timezone: dto.timezone,
    });
  } catch (error) {
    throw translateDuplicate(error, dto.code);
  }

  const location = toDto(row);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.LOCATION_CREATED,
    `Created location ${location.code} (${location.name})`,
    context.req,
    {
      meta: {
        locationId: location.id,
        code: location.code,
        name: location.name,
        timezone: location.timezone,
      },
    },
  );

  return location;
}

export async function updateLocation(id, input, context = {}) {
  const dto = parse(updateLocationSchema, input);
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Location');

  const existing = await Location.findOne({ _id: id, deletedAt: null });
  if (!existing) throw new HrmsNotFoundError('Location');

  if (Object.keys(dto).length === 0) return toDto(existing.toObject());

  for (const field of EDITABLE) {
    if (dto[field] !== undefined) existing[field] = dto[field];
  }

  try {
    await existing.save();
  } catch (error) {
    throw translateDuplicate(error, dto.code ?? existing.code);
  }

  const location = toDto(existing.toObject());
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.LOCATION_UPDATED,
    `Updated location ${location.code}`,
    context.req,
    { meta: { locationId: location.id, fields: Object.keys(dto) } },
  );

  return location;
}

/**
 * Retire a location (O-3). Refuses while any LIVE employee references it.
 *
 * @throws {HrmsConflictError} when employees still reference it
 */
export async function deleteLocation(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Location');

  const existing = await Location.findOne({ _id: id, deletedAt: null }).lean();
  if (!existing) throw new HrmsNotFoundError('Location');

  const inUse = await Employee.countDocuments({ locationId: id, deletedAt: null });
  if (inUse > 0) {
    throw new HrmsConflictError(
      `${inUse} employee${inUse === 1 ? '' : 's'} still assigned to "${existing.name}". Reassign them before deleting.`,
      // employeeCount goes in `details`: HrmsError reads only `code` and
      // `details`, so a sibling key would be silently dropped and the
      // response would lose the one number that tells the admin what to do.
      { code: 'LOCATION_IN_USE', details: { employeeCount: inUse } },
    );
  }

  await Location.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.LOCATION_DELETED,
    `Deleted location ${existing.code} (${existing.name})`,
    context.req,
    { meta: { locationId: idStr(existing._id), code: existing.code, name: existing.name } },
  );

  return { id: idStr(existing._id), code: existing.code, deleted: true };
}

export default {
  listLocations,
  getLocation,
  createLocation,
  updateLocation,
  deleteLocation,
};
