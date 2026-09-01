/**
 * The employee reference provider and the import persistence port.
 *
 * Phase 0 and Phase 1 left both registries deliberately empty, with every
 * lookup failing 503 rather than returning null. This module fills them, which
 * is what turns `team` and `department` permission scopes from theory into
 * something that resolves, and what makes the canonical import pipeline able to
 * commit.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import User from '../../../models/User.js';
import { hashPassword } from '../../../utils/password.js';
import { sanitiseCustomFields } from '../../../utils/hrms/crypto/index.js';
import { rebuildAllManagerChains, assertNoCycle } from './managerChain.js';
import { HrmsValidationError } from '../hrms.errors.js';
import crypto from 'node:crypto';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const isObjectId = (v) => mongoose.isValidObjectId(v);

const toRef = (row, user) => ({
  id: idStr(row._id),
  employeeCode: row.employeeCode,
  displayName: `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim(),
  departmentId: idStr(row.departmentId),
  locationId: idStr(row.locationId),
  reportingManagerId: idStr(row.reportingManagerId),
  managerChain: (row.managerChain ?? []).map(idStr),
  userId: idStr(row.userId),
  status: row.status,
});

/**
 * The fields a reference needs, and nothing else.
 *
 * Explicitly narrow: this runs on EVERY authenticated HRMS request through
 * `attachHrmsActor`, so pulling the whole document — including the encrypted
 * envelopes — would be wasteful and would put ciphertext in memory for no
 * reason.
 */
const REF_FIELDS = 'employeeCode firstName lastName departmentId locationId reportingManagerId managerChain userId status';

export const employeeReferenceProvider = {
  async byId(id) {
    if (!isObjectId(id)) return null;
    const row = await Employee.findOne({ _id: id, deletedAt: null }).select(REF_FIELDS).lean();
    return row ? toRef(row) : null;
  },

  /**
   * The employee behind a login.
   *
   * Returns null when the user has no employee record — an HR admin who is not
   * themselves an employee is legitimate, and must not be an error.
   */
  async byUserId(userId) {
    if (!isObjectId(userId)) return null;
    const row = await Employee.findOne({ userId, deletedAt: null }).select(REF_FIELDS).lean();
    return row ? toRef(row) : null;
  },

  async byCodes(codes = []) {
    if (codes.length === 0) return new Map();
    const rows = await Employee.find({ employeeCode: { $in: codes }, deletedAt: null })
      .select(REF_FIELDS)
      .lean();
    return new Map(rows.map((r) => [r.employeeCode, toRef(r)]));
  },

  async byIds(ids = []) {
    const valid = ids.filter(isObjectId);
    if (valid.length === 0) return new Map();
    const rows = await Employee.find({ _id: { $in: valid }, deletedAt: null })
      .select(REF_FIELDS)
      .lean();
    return new Map(rows.map((r) => [idStr(r._id), toRef(r)]));
  },
};

// ---------------------------------------------------------------------------
// Import persistence port (AD-11)
// ---------------------------------------------------------------------------

/**
 * Implements the port the Phase 0 import pipeline writes through.
 *
 * The pipeline owns validation, sanitisation, dependency checking and the
 * three-pass ordering; this only performs the writes it asks for. Keeping that
 * split is what let the pipeline be written and tested before the Employee
 * Master existed.
 */
export const employeePersistencePort = {
  async findByEmployeeCodes(codes = []) {
    return employeeReferenceProvider.byCodes(codes);
  },

  /**
   * Org Structure is not built, so these cannot resolve yet.
   *
   * Returning an empty Map is correct rather than evasive: the pipeline treats
   * an unresolved code as a row error and reports it, which is exactly the
   * outcome wanted — "create the department first" — instead of a dangling id.
   */
  async resolveDepartmentCodes() {
    return new Map();
  },

  async resolveLocationCodes() {
    return new Map();
  },

  /**
   * Pass 1: create or update every employee, manager deliberately unset.
   *
   * Upserts on `employeeCode`, the stable natural key, so re-running an import
   * is idempotent rather than duplicating everyone.
   *
   * Sanitisation runs again here even though the pipeline already did it. That
   * is not redundant: this port is a public entry point, and a future caller
   * that skipped the pipeline must not be able to write a plaintext PAN.
   */
  async upsertEmployees(records = []) {
    let created = 0;
    let updated = 0;
    const byCode = new Map();

    for (const record of records) {
      const { clean, extracted } = sanitiseCustomFields(record.customFieldValues);
      const sensitive = { ...extracted };
      for (const key of Object.keys(record)) {
        if (key.endsWith('Number') || key === 'bankIfsc') sensitive[key] ??= record[key];
      }

      const existing = await Employee.findOne({ employeeCode: record.employeeCode })
        .select('_id userId')
        .lean();

      if (existing) {
        await Employee.updateOne(
          { _id: existing._id },
          {
            $set: {
              firstName: record.firstName,
              lastName: record.lastName,
              personalEmail: record.personalEmail ?? null,
              phone: record.phone ?? null,
              phone2: record.phone2 ?? null,
              dateOfBirth: record.dateOfBirth ? new Date(record.dateOfBirth) : null,
              dateOfJoining: new Date(record.dateOfJoining),
              employmentType: record.employmentType,
              designation: record.designation ?? null,
              status: record.status,
              fatherName: record.fatherName ?? null,
              motherName: record.motherName ?? null,
              permanentAddress: record.permanentAddress ?? null,
              temporaryAddress: record.temporaryAddress ?? null,
              emergencyContacts: record.emergencyContacts ?? [],
              dependents: record.dependents ?? [],
              customFieldValues: clean,
            },
          },
        );
        updated += 1;
        byCode.set(record.employeeCode, idStr(existing._id));
        continue;
      }

      // A new employee needs a login. Created suspended with an unguessable
      // password: an import must never mint an account someone can sign into
      // before HR has deliberately invited them.
      const [user] = await User.create([
        {
          email: record.email,
          password: await hashPassword(crypto.randomBytes(24).toString('base64url')),
          user: `${record.firstName} ${record.lastName}`,
          role: 'Management',
          roles: ['hrms_employee'],
          status: 'Inactive',
        },
      ]);

      const [employee] = await Employee.create([
        {
          userId: user._id,
          employeeCode: record.employeeCode,
          firstName: record.firstName,
          lastName: record.lastName,
          personalEmail: record.personalEmail ?? null,
          phone: record.phone ?? null,
          phone2: record.phone2 ?? null,
          dateOfBirth: record.dateOfBirth ? new Date(record.dateOfBirth) : null,
          dateOfJoining: new Date(record.dateOfJoining),
          employmentType: record.employmentType,
          designation: record.designation ?? null,
          status: record.status,
          fatherName: record.fatherName ?? null,
          motherName: record.motherName ?? null,
          permanentAddress: record.permanentAddress ?? null,
          temporaryAddress: record.temporaryAddress ?? null,
          emergencyContacts: record.emergencyContacts ?? [],
          dependents: record.dependents ?? [],
          customFieldValues: clean,
          // managerChain is left empty on purpose - pass 3 derives it.
          managerChain: [],
        },
      ]);

      created += 1;
      byCode.set(record.employeeCode, idStr(employee._id));
    }

    return { created, updated, byCode };
  },

  /**
   * Pass 2: resolve manager CODES to ids, now that every row exists.
   *
   * Separate from pass 1 because a manager can appear later in the file than
   * the person reporting to them. Each link is cycle-checked before it is
   * written, so a malformed source file cannot corrupt the hierarchy.
   */
  async linkReportingManagers(links = []) {
    const codes = [...new Set(links.flatMap((l) => [l.employeeCode, l.managerEmployeeCode]))];
    const byCode = await employeeReferenceProvider.byCodes(codes);

    let linked = 0;
    for (const { employeeCode, managerEmployeeCode } of links) {
      const employee = byCode.get(employeeCode);
      const manager = byCode.get(managerEmployeeCode);
      if (!employee || !manager) {
        throw new HrmsValidationError(
          `Cannot link ${employeeCode} to ${managerEmployeeCode}: one of them was not found.`,
        );
      }

      await assertNoCycle(employee.id, manager.id);
      await Employee.updateOne(
        { _id: employee.id },
        { $set: { reportingManagerId: manager.id } },
      );
      linked += 1;
    }
    return linked;
  },

  /** Pass 3: derive every chain from the reporting lines just written. */
  async rebuildManagerChains() {
    return rebuildAllManagerChains();
  },

  /**
   * Leave balances.
   *
   * The Leave module is not built, so there is nothing to seed into. Returning
   * 0 is honest; inventing a LeaveBalance collection here would be building
   * Leave under another name.
   */
  async seedLeaveBalances() {
    return 0;
  },
};

export default { employeeReferenceProvider, employeePersistencePort };
