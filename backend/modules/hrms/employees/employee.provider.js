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
import {
  departmentReferenceProvider,
  locationReferenceProvider,
} from '../org/org.provider.js';
import User from '../../../models/User.js';
import { hashPassword } from '../../../utils/password.js';
import { sanitiseCustomFields } from '../../../utils/hrms/crypto/index.js';
import { SENSITIVE_EMPLOYEE_FIELD_LIST } from '../../../shared/security/sensitive-fields.js';
import { rebuildAllManagerChains, assertNoCycle } from './managerChain.js';
import { buildSensitiveUpdate } from './sensitiveUpdate.js';
import { HrmsValidationError } from '../hrms.errors.js';
import { assertHrmsRolesAssignable, isPortalOnlyRole } from '../../../utils/hrmsRoleGuard.js';
import crypto from 'node:crypto';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const isObjectId = (v) => mongoose.isValidObjectId(v);

const toRef = (row) => ({
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

/** Code -> id, de-duplicated, for a reference provider that answers `byCodes`. */
async function codesToIds(provider, codes = []) {
  const wanted = [...new Set(codes.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const refs = await provider.byCodes(wanted);
  return new Map([...refs].map(([code, ref]) => [code, ref.id]));
}

/**
 * The login for an employee the import is creating, or `null` when they get
 * none.
 *
 * Returns the existing account when one already holds this address, a new
 * suspended account when the record supplies an address nobody holds, and
 * `null` when it supplies no address at all. Refuses rather than guessing
 * whenever reuse would break an invariant - see the call site for which two and
 * why.
 *
 * No address means no login, deliberately. `Employee.userId` is optional, and
 * an employee without one takes part in everything the HRMS does not gate
 * behind authentication; the alternative - inventing an address so that every
 * record has an account - would put fiction in the User collection.
 */
async function linkOrCreateUser(record) {
  if (!record.email) return null;

  const existingUser = await User.findOne({ email: record.email })
    .select('_id email role roles')
    .lean();

  if (existingUser) {
    // The uniqueness check covers soft-deleted employees too: the unique index
    // on userId does not exclude them, so a soft-deleted holder would still
    // reject the write - just later, and less legibly.
    const holder = await Employee.findOne({ userId: existingUser._id })
      .select('employeeCode')
      .lean();
    if (holder && holder.employeeCode !== record.employeeCode) {
      throw new HrmsValidationError(
        `${record.employeeCode}: that login already belongs to employee ${holder.employeeCode}. ` +
          'One account resolves to exactly one employee, so it cannot be linked to a second.',
      );
    }

    // Any PORTAL-ONLY role, not just the literal Customer: a Super Admin can
    // mark a role they invent as portalOnly, and an account on one is as fenced
    // as a Customer is.
    if (isPortalOnlyRole(existingUser.role)) {
      throw new HrmsValidationError(
        `${record.employeeCode}: that login is a ${existingUser.role} account, which is confined to ` +
          'the customer portal. AD-4 makes a portal account and an Employee mutually exclusive, so it ' +
          'cannot become an employee login until its portal role is corrected.',
      );
    }

    // Grant HRMS access without disturbing the portal role the account already
    // holds - a salesperson who is also an employee keeps role='Sales'.
    const roles = [...new Set([...(existingUser.roles ?? []), 'hrms_employee'])];
    if (roles.length !== (existingUser.roles ?? []).length) {
      assertHrmsRolesAssignable(existingUser.role, roles);
      await User.updateOne({ _id: existingUser._id }, { $set: { roles } });
    }
    return existingUser;
  }

  // Created suspended with an unguessable password: an import must never mint
  // an account someone can sign into before HR has deliberately invited them.
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
  return user;
}

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
   * Code -> id, for the import's reference check.
   *
   * These delegate to the Org Structure providers, which return live rows
   * only. A sheet naming a retired department therefore fails the pipeline's
   * per-row check with "Create it before importing" rather than storing a
   * dangling id - AD-2 left no foreign key to catch that later.
   *
   * Before Org Structure existed both returned an empty Map, which was honest
   * then and would be a silent bug now.
   */
  async resolveDepartmentCodes(codes = []) {
    return codesToIds(departmentReferenceProvider, codes);
  },

  async resolveLocationCodes(codes = []) {
    return codesToIds(locationReferenceProvider, codes);
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

    // Org references arrive as CODES, which is the only thing an external
    // source can know. Resolved once for the whole batch rather than per row:
    // the pipeline has already refused any code that does not resolve, so a
    // miss here can only mean the row carried none.
    const [departments, locations] = await Promise.all([
      codesToIds(departmentReferenceProvider, records.map((r) => r.departmentCode)),
      codesToIds(locationReferenceProvider, records.map((r) => r.locationCode)),
    ]);

    for (const record of records) {
      const { clean, extracted } = sanitiseCustomFields(record.customFieldValues);

      // Sensitive values reach here from two directions: named fields on the
      // record, and reserved keys the sanitiser pulled out of the custom-field
      // blob. Both are encrypted through the same builder the employee service
      // uses, so an imported PAN is stored exactly as a typed one is.
      const sensitiveInput = { ...extracted };
      for (const field of SENSITIVE_EMPLOYEE_FIELD_LIST) {
        if (record[field] !== undefined && record[field] !== null && record[field] !== '') {
          sensitiveInput[field] ??= record[field];
        }
      }

      // Written only when the row supplies one. A source that omits the column
      // must not blank the department an administrator has since set.
      const orgRefs = {};
      if (record.departmentCode && departments.has(record.departmentCode)) {
        orgRefs.departmentId = departments.get(record.departmentCode);
      }
      if (record.locationCode && locations.has(record.locationCode)) {
        orgRefs.locationId = locations.get(record.locationCode);
      }

      const existing = await Employee.findOne({ employeeCode: record.employeeCode })
        .select('_id userId')
        .lean();

      if (existing) {
        const sensitive = await buildSensitiveUpdate(sensitiveInput, {
          employeeId: existing._id,
        });
        await Employee.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...orgRefs,
              ...sensitive,
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

      // A new employee usually needs a login - but the address may already have
      // one, and the record may name no address at all.
      //
      // This used to call User.create unconditionally, which raised a
      // duplicate-key error PART WAY THROUGH a migration: some employees
      // written, the rest not. Reusing the account instead is both the correct
      // outcome (staff being migrated usually already sign in) and the only way
      // an import can link a person to the login they already have.
      //
      // Reuse never bends an invariant. Two are checked here rather than left
      // to the index, so the failure names the account instead of surfacing as
      // E11000 half-way through:
      //
      //   1. one User resolves to exactly one Employee - self-scope, payroll,
      //      attendance, leave, documents, expenses, performance, audit
      //      identity and RBAC all read the employee behind the login, so a
      //      second Employee on one account would make that ambiguous
      //   2. AD-4 - a Customer account may never hold an HRMS role, so it can
      //      never be an employee's login
      const user = await linkOrCreateUser(record);

      const [employee] = await Employee.create([
        {
          ...orgRefs,
          ...(await buildSensitiveUpdate(sensitiveInput)),
          // null when the record supplies no address. The partial unique index
          // excludes nulls, so any number of employees may be in this state
          // while two can still never share one account.
          userId: user?._id ?? null,
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
