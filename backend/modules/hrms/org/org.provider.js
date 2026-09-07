/**
 * The department and location reference providers.
 *
 * These fill the two registries Phase 0 declared and deliberately left empty.
 * Until now `resolveDepartment` rejected with `HrmsNotImplementedError` and
 * Employee Master answered 503 to any request carrying a `departmentId` —
 * correct while the collection did not exist, and wrong from the moment it
 * does.
 *
 * The contract is fixed by `PROVIDER_CONTRACTS` in reference.service.js:
 *   department -> byId, byCodes, list
 *   location   -> byId, byCodes, list
 *
 * ---------------------------------------------------------------------------
 * Live rows only
 * ---------------------------------------------------------------------------
 * Every method filters `deletedAt: null`. That is what makes a retired
 * department behave correctly at the two ends that matter:
 *
 *   - Employee Master's `assertReferencesResolve` gets `null` back and raises
 *     "departmentId does not exist", so nobody can be newly assigned to a
 *     department that has been retired.
 *   - The import's code lookup misses, so a spreadsheet naming a retired
 *     department is rejected row by row rather than silently storing a dangling
 *     id (AD-2 left no foreign key to catch it later).
 *
 * Displaying the name of a department an existing employee is still assigned to
 * is a different question, and the services answer it with `includeDeleted`.
 * The provider is the validation path, so it stays strict.
 */

import mongoose from 'mongoose';

import Department from '../../../models/hrms/Department.js';
import Location from '../../../models/hrms/Location.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const isObjectId = (v) => mongoose.isValidObjectId(v);

/** Narrow on purpose: a reference is an identity, not a record. */
const DEPARTMENT_FIELDS = '_id code name';
const LOCATION_FIELDS = '_id code name timezone';

const toDepartmentRef = (row) => ({
  id: idStr(row._id),
  code: row.code,
  name: row.name,
});

const toLocationRef = (row) => ({
  id: idStr(row._id),
  code: row.code,
  name: row.name,
  timezone: row.timezone,
});

export const departmentReferenceProvider = {
  /** @returns {Promise<object|null>} null when unknown OR retired. */
  async byId(id) {
    if (!isObjectId(id)) return null;
    const row = await Department.findOne({ _id: id, deletedAt: null })
      .select(DEPARTMENT_FIELDS)
      .lean();
    return row ? toDepartmentRef(row) : null;
  },

  /**
   * @param {string[]} codes
   * @returns {Promise<Map<string, object>>} keyed by code. Codes are stored
   *   upper-case, so the lookup upper-cases too — an import sheet written in
   *   lower case should still resolve.
   */
  async byCodes(codes = []) {
    if (codes.length === 0) return new Map();
    const wanted = codes.map((c) => String(c).trim().toUpperCase());
    const rows = await Department.find({ code: { $in: wanted }, deletedAt: null })
      .select(DEPARTMENT_FIELDS)
      .lean();
    return new Map(rows.map((r) => [r.code, toDepartmentRef(r)]));
  },

  /** @returns {Promise<object[]>} live departments, ordered by name. */
  async list() {
    const rows = await Department.find({ deletedAt: null })
      .select(DEPARTMENT_FIELDS)
      .sort({ name: 1 })
      .lean();
    return rows.map(toDepartmentRef);
  },
};

export const locationReferenceProvider = {
  async byId(id) {
    if (!isObjectId(id)) return null;
    const row = await Location.findOne({ _id: id, deletedAt: null })
      .select(LOCATION_FIELDS)
      .lean();
    return row ? toLocationRef(row) : null;
  },

  async byCodes(codes = []) {
    if (codes.length === 0) return new Map();
    const wanted = codes.map((c) => String(c).trim().toUpperCase());
    const rows = await Location.find({ code: { $in: wanted }, deletedAt: null })
      .select(LOCATION_FIELDS)
      .lean();
    return new Map(rows.map((r) => [r.code, toLocationRef(r)]));
  },

  async list() {
    const rows = await Location.find({ deletedAt: null })
      .select(LOCATION_FIELDS)
      .sort({ name: 1 })
      .lean();
    return rows.map(toLocationRef);
  },
};

export default { departmentReferenceProvider, locationReferenceProvider };
