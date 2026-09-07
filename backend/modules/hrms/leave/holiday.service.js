/**
 * Holiday service.
 *
 * Ported from the reference's `HolidayService`. Holidays live inside the leave
 * module there and here: they are governed by the `leave` permission keys
 * (`leave:view:self` to read, `leave:edit:org` to change), and Leave itself
 * reads them to price a request.
 *
 * Two corrections to the reference:
 *
 *   1. DUPLICATES ARE HANDLED SERVER-SIDE. The reference relies on a Postgres
 *      unique constraint and lets the driver error surface. AD-2 removed
 *      foreign keys but a unique index remains, so the index is still the
 *      guarantee - what changes is that the duplicate-key error is translated
 *      into a business conflict rather than escaping as a 500.
 *
 *   2. DELETE IS SOFT, matching every other HRMS catalogue. The reference hard
 *      deletes; a holiday that has already priced approved leave should not
 *      vanish from the record of why those days were free.
 */

import Holiday from '../../../models/hrms/Holiday.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import {
  upsertHolidaySchema,
  bulkImportHolidaysSchema,
} from '../../../shared/schemas/leave.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import { HrmsNotFoundError, HrmsConflictError, HrmsValidationError } from '../hrms.errors.js';
import mongoose from 'mongoose';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

const toDto = (row) => ({
  id: idStr(row._id),
  name: row.name,
  date: row.date,
  year: row.year,
  type: row.type,
  region: row.region ?? null,
  description: row.description ?? null,
  isOptional: row.isOptional,
});

function parse(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new HrmsValidationError('Invalid holiday.', formatZodIssues(result.error));
  }
  return result.data;
}

function translateDuplicate(error, { name, date }) {
  if (error?.code === 11000) {
    return new HrmsConflictError(`"${name}" is already recorded on ${date}.`, {
      code: 'HOLIDAY_DUPLICATE',
      details: { name, date },
    });
  }
  return error;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every live holiday in a year, earliest first.
 *
 * @param {number} [year] defaults to the current calendar year
 */
export async function listHolidays({ year } = {}) {
  const filter = { deletedAt: null };
  if (year !== undefined) filter.year = year;

  const rows = await Holiday.find(filter).sort({ date: 1 }).lean();
  return rows.map(toDto);
}

/** Which years have a calendar, and how full each is. Drives the year picker. */
export async function listHolidayYears() {
  const rows = await Holiday.aggregate([
    { $match: { deletedAt: null } },
    { $group: { _id: '$year', count: { $sum: 1 } } },
    { $sort: { _id: -1 } },
  ]);
  return rows.map((r) => ({ year: r._id, count: r.count }));
}

/**
 * The dates Leave treats as non-working, as a Set of `YYYY-MM-DD`.
 *
 * The single point where Leave depends on Holidays. Optional holidays are
 * excluded: a "restricted" holiday is one an employee may choose to take, so
 * it is not automatically a day off and must not silently reduce a request.
 */
export async function holidayDateSet(years = []) {
  const filter = { deletedAt: null, isOptional: false };
  if (years.length > 0) filter.year = { $in: [...new Set(years)] };

  const rows = await Holiday.find(filter).select('date').lean();
  return new Set(rows.map((r) => r.date));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createHoliday(input, context = {}) {
  const dto = parse(upsertHolidaySchema, input);

  let row;
  try {
    row = await Holiday.create({ ...dto, createdByUserId: context.user?._id ?? null });
  } catch (error) {
    throw translateDuplicate(error, dto);
  }

  const holiday = toDto(row);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.HOLIDAY_CREATED,
    `Added holiday ${holiday.name} on ${holiday.date}`,
    context.req,
    { meta: { holidayId: holiday.id, name: holiday.name, date: holiday.date } },
  );

  return holiday;
}

export async function updateHoliday(id, input, context = {}) {
  const dto = parse(upsertHolidaySchema, input);
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Holiday');

  const existing = await Holiday.findOne({ _id: id, deletedAt: null });
  if (!existing) throw new HrmsNotFoundError('Holiday');

  Object.assign(existing, dto);

  try {
    await existing.save();
  } catch (error) {
    throw translateDuplicate(error, dto);
  }

  const holiday = toDto(existing.toObject());
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.HOLIDAY_UPDATED,
    `Updated holiday ${holiday.name} (${holiday.date})`,
    context.req,
    { meta: { holidayId: holiday.id, fields: Object.keys(dto) } },
  );

  return holiday;
}

export async function deleteHoliday(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Holiday');

  const existing = await Holiday.findOne({ _id: id, deletedAt: null }).lean();
  if (!existing) throw new HrmsNotFoundError('Holiday');

  await Holiday.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.HOLIDAY_DELETED,
    `Removed holiday ${existing.name} (${existing.date})`,
    context.req,
    { meta: { holidayId: idStr(existing._id), name: existing.name, date: existing.date } },
  );

  return { id: idStr(existing._id), name: existing.name, deleted: true };
}

/**
 * Import a year's calendar in one go.
 *
 * `overwrite` retires the year first, so a re-import replaces rather than
 * merges. Without it, existing rows are kept and only the new ones land - the
 * reference's `skipDuplicates` behaviour, reported the same way as
 * `{ inserted, skipped }`.
 */
export async function bulkImportHolidays(input, context = {}) {
  const dto = parse(bulkImportHolidaysSchema, input);

  // Every row must belong to the year being imported, or the calendar would
  // quietly acquire dates the caller never intended to touch.
  const stray = dto.holidays.filter((h) => Number(h.date.slice(0, 4)) !== dto.year);
  if (stray.length > 0) {
    throw new HrmsValidationError(
      `${stray.length} holiday(s) fall outside ${dto.year}.`,
      stray.map((h) => ({ path: 'holidays', message: `${h.name} is dated ${h.date}` })),
    );
  }

  if (dto.overwrite) {
    await Holiday.updateMany(
      { year: dto.year, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
  }

  const live = await Holiday.find({ year: dto.year, deletedAt: null }).select('date name').lean();
  const taken = new Set(live.map((r) => `${r.date}::${r.name}`));

  const fresh = [];
  const seen = new Set();
  for (const holiday of dto.holidays) {
    const key = `${holiday.date}::${holiday.name}`;
    // Skip both what is already stored and what repeats inside this payload.
    if (taken.has(key) || seen.has(key)) continue;
    seen.add(key);
    fresh.push({
      ...holiday,
      region: holiday.region ?? dto.region ?? null,
      createdByUserId: context.user?._id ?? null,
    });
  }

  const inserted = fresh.length > 0 ? (await Holiday.insertMany(fresh)).length : 0;

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.HOLIDAY_BULK_IMPORTED,
    `Imported ${inserted} holiday(s) for ${dto.year}`,
    context.req,
    {
      meta: {
        year: dto.year,
        inserted,
        skipped: dto.holidays.length - inserted,
        overwrite: dto.overwrite,
      },
    },
  );

  return { year: dto.year, inserted, skipped: dto.holidays.length - inserted };
}

export default {
  listHolidays,
  listHolidayYears,
  holidayDateSet,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  bulkImportHolidays,
};
