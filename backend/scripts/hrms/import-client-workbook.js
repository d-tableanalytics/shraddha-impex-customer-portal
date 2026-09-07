#!/usr/bin/env node
/**
 * Client workbook importer.
 *
 *   node scripts/hrms/import-client-workbook.js --file "<path.xlsx>"            # dry run
 *   node scripts/hrms/import-client-workbook.js --file "<path.xlsx>" --execute  # writes
 *
 * DRY RUN IS THE DEFAULT. `--execute` is the only thing that opens a write, and
 * it refuses to proceed while any ERROR stands.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it is NOT
 * ---------------------------------------------------------------------------
 * It is an ORCHESTRATOR. Every write goes through machinery that already
 * exists: the AD-11 employee pipeline, the Org Structure services, the payroll
 * compensation service, the asset service, and the Holiday model. No second
 * import architecture, and no domain logic reimplemented here.
 *
 * The one thing it adds is the cross-domain ordering the workbook needs —
 * departments and the location must exist before an employee can reference
 * them, employees before compensation or assets — plus a validation pass over
 * all six domains at once, so the operator sees every problem before anything
 * is written rather than discovering the fourth one after three have committed.
 *
 * ---------------------------------------------------------------------------
 * Sensitive data
 * ---------------------------------------------------------------------------
 * The workbook holds real PAN, Aadhaar, bank account and IFSC values. Nothing
 * here prints one, writes one to the report, or puts one in an audit entry.
 * Sensitive fields are reported as a COUNT of employees carrying them. The
 * values travel from the adapter into the persistence port, which encrypts them
 * (AD-10), and are never held anywhere else.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import mongoose from 'mongoose';
import 'dotenv/config';

import { connectDatabase } from '../../config/database.js';
import Employee from '../../models/hrms/Employee.js';
import User from '../../models/User.js';
import Order from '../../models/Order.js';
import { Department } from '../../models/hrms/Department.js';
import { Location } from '../../models/hrms/Location.js';
import { Holiday } from '../../models/hrms/Holiday.js';
import { AssetCategory, AssetItem } from '../../models/hrms/AssetModels.js';
import { PayGroup, SalaryStructure, EmployeeCompensation } from '../../models/hrms/PayrollModels.js';
import { bootstrapHrms } from '../../modules/hrms/hrms.bootstrap.js';
import { CUSTOMER_ROLE } from '../../shared/permissions/assignment.js';
import {
  BLIND_INDEXED_FIELDS,
  normaliseSensitiveValue,
} from '../../shared/security/sensitive-fields.js';
import { previewImport, commitImport } from '../../modules/hrms/import/pipeline.js';
import {
  parseWorkbook,
  toCanonicalEmployees,
  toRefCode,
  mapHolidayType,
  weekdayOf,
  splitAssets,
} from '../../modules/hrms/import/adapters/shraddhaWorkbook.js';

export const IMPORTER_VERSION = '1.2.0';

/**
 * The client's Salary-sheet instruction: "Put 10,000/- as salary for all".
 *
 * `EmployeeCompensation.ctc` is ANNUAL cost to company — the payroll screen
 * labels it "Annual CTC". The instruction does not say which basis 10,000 is,
 * and for Indian staff it is almost certainly a MONTHLY figure: read as annual
 * it would be about Rs 833 a month, which is below any minimum wage.
 *
 * A twelvefold ambiguity on a money field is not something to resolve by
 * guessing, so the importer refuses to execute until `--ctc-basis` says which
 * was meant. The dry run shows both readings.
 */
const SALARY_INSTRUCTION_AMOUNT = '10000';
const CTC_BASIS = Object.freeze({
  monthly: { annual: '120000.00', describe: 'Rs 10,000 per month -> Rs 1,20,000 annual CTC' },
  annual: { annual: '10000.00', describe: 'Rs 10,000 per year -> about Rs 833 per month' },
});

/**
 * Account resolutions the CLIENT confirmed on 2026-09-05.
 *
 * The first dry run reported three emails that already had a portal account, as
 * blocking errors, because linking someone else's login to an employee is not a
 * decision an importer may take. The client has since confirmed that each of
 * these accounts belongs to the employee the workbook names, so each is now
 * REUSED rather than duplicated.
 *
 * Recorded here, keyed by employeeCode, rather than passed as a flag: a
 * confirmation is a fact about this dataset that has to survive into the audit
 * trail and into the next person's reading of it. A flag would leave no trace
 * of who agreed to what.
 *
 * `expectRole` is checked against the live account at run time. If the account
 * has changed role since the confirmation, the reuse is REFUSED and has to be
 * re-confirmed - a stale approval is not an approval.
 */
const CONFIRMED_ACCOUNT_LINKS = Object.freeze({
  SI0002: {
    expectRole: 'Customer',
    confirmedOn: '2026-09-05',
    note: 'Client confirmed the existing Customer account is this employee.',
  },
  SI0007: {
    expectRole: 'Sales',
    confirmedOn: '2026-09-05',
    note: 'Client confirmed the existing Sales staff account is this employee.',
  },
  SI0011: {
    expectRole: 'Admin',
    confirmedOn: '2026-09-05',
    note: 'Client confirmed the existing Admin account is this employee.',
  },
});

/**
 * The portal role a staff account carries when it is not a Customer.
 *
 * AD-4 makes Customer and Employee mutually exclusive, and it is enforced in
 * three places - the User schema hook, assertRolesAssignable() on every write
 * path, and structurally in buildHrmsActor(). So a Customer account cannot
 * simply be handed an HRMS role: its PORTAL role has to be corrected first, to
 * the same neutral value `createEmployee` uses for a new staff login.
 *
 * That correction is a real change to an existing account, so it happens only
 * for a code the client confirmed, only when the account carries no customer
 * activity, and only after the dry run has shown it.
 */
const STAFF_PORTAL_ROLE = 'Management';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { file: null, execute: false, report: true, ctcBasis: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i] ?? null;
    else if (a === '--execute') args.execute = true;
    else if (a === '--dry-run') args.execute = false;
    else if (a === '--no-report') args.report = false;
    else if (a === '--ctc-basis') args.ctcBasis = (argv[++i] ?? '').toLowerCase() || null;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

class Findings {
  constructor() {
    this.items = [];
  }

  add(level, domain, message, extra = {}) {
    this.items.push({ level, domain, message, ...extra });
  }

  error(domain, message, extra) { this.add('ERROR', domain, message, extra); }
  warn(domain, message, extra) { this.add('WARNING', domain, message, extra); }
  info(domain, message, extra) { this.add('INFO', domain, message, extra); }

  get errors() { return this.items.filter((i) => i.level === 'ERROR'); }
  get warnings() { return this.items.filter((i) => i.level === 'WARNING'); }
  get infos() { return this.items.filter((i) => i.level === 'INFO'); }
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * Departments the workbook needs, matched against what already exists.
 *
 * Matched on the NORMALISED code and, separately, on a case-and-space-folded
 * name — so `Admin`, `admin` and ` ADMIN ` resolve to one department and the
 * import cannot create a near-duplicate of a department that is already there.
 *
 * Soft-deleted rows are matched too and reported, because silently creating a
 * second `Sales` beside a retired one is exactly the duplicate this guards.
 */
async function planDepartments(names, findings) {
  const wanted = new Map();
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;
    wanted.set(toRefCode(name), name);
  }

  const existing = await Department.find({}).select('code name deletedAt').lean();
  const byCode = new Map(existing.map((d) => [String(d.code).toUpperCase(), d]));
  const byName = new Map(existing.map((d) => [String(d.name).trim().toLowerCase(), d]));

  const plan = { reuse: [], create: [], revive: [] };
  for (const [code, name] of wanted) {
    const hit = byCode.get(code) ?? byName.get(name.toLowerCase());
    if (!hit) {
      plan.create.push({ code, name });
    } else if (hit.deletedAt) {
      plan.revive.push({ code: hit.code, name: hit.name });
      findings.warn(
        'departments',
        `"${hit.name}" exists but is soft-deleted. It will be reused rather than duplicated; restore it if it should be live.`,
        { code: hit.code },
      );
    } else {
      plan.reuse.push({ code: hit.code, name: hit.name, wantedAs: code });
      if (String(hit.code).toUpperCase() !== code) {
        findings.info(
          'departments',
          `"${name}" matched the existing department "${hit.name}" by name (its code is ${hit.code}).`,
        );
      }
    }
  }
  return plan;
}

/** The same treatment for the single work location the workbook names. */
async function planLocations(names, findings) {
  const wanted = new Map();
  for (const raw of names) {
    const name = String(raw).trim();
    if (name) wanted.set(toRefCode(name), name);
  }

  const existing = await Location.find({}).select('code name deletedAt').lean();
  const byCode = new Map(existing.map((l) => [String(l.code).toUpperCase(), l]));
  const byName = new Map(existing.map((l) => [String(l.name).trim().toLowerCase(), l]));

  const plan = { reuse: [], create: [] };
  for (const [code, name] of wanted) {
    const hit = byCode.get(code) ?? byName.get(name.toLowerCase());
    if (!hit) plan.create.push({ code, name });
    else {
      plan.reuse.push({ code: hit.code, name: hit.name });
      if (hit.deletedAt) {
        findings.warn('locations', `"${hit.name}" exists but is soft-deleted; it will be reused.`, {
          code: hit.code,
        });
      }
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The gap this workbook exposed in the shared pipeline
// ---------------------------------------------------------------------------

/**
 * Emails that already belong to a user account.
 *
 * `checkDependencies` looks for duplicates WITHIN the file but never against
 * the database, so an address that is already taken used to surface as a
 * duplicate-key error PART WAY THROUGH the commit — some employees written, the
 * rest not. This is the pre-flight that turns it into a decision taken before
 * anything is written.
 *
 * The decision is never taken here. An account is reused only for a code the
 * client has CONFIRMED, and the live account is re-checked against what was
 * confirmed: an approval given for a Sales account does not carry over to the
 * same address once it has become something else.
 */
async function checkExistingUsers(records, findings) {
  const emails = records.map((r) => r.email).filter(Boolean);
  if (emails.length === 0) return { taken: [], links: [] };

  const users = await User.find({ email: { $in: emails } })
    .select('email role roles status')
    .lean();
  const byEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));

  // One address can be claimed by more than one row. That is a separate
  // problem, reported by checkSharedAccounts() — here it only means the code
  // this account belongs to is ambiguous, so no reuse is planned for it.
  const codesByEmail = new Map();
  for (const r of records) {
    if (!r.email) continue;
    if (!codesByEmail.has(r.email)) codesByEmail.set(r.email, []);
    codesByEmail.get(r.email).push(r.employeeCode);
  }

  const taken = [];
  const links = [];

  for (const [email, user] of byEmail) {
    const codes = codesByEmail.get(email) ?? [];
    const code = codes.length === 1 ? codes[0] : '(shared)';
    const holder = await Employee.findOne({ userId: user._id }).select('employeeCode').lean();

    // An existing linkage is never moved or re-pointed, only preserved.
    if (holder && codes.includes(holder.employeeCode)) {
      findings.info(
        'employees',
        `${holder.employeeCode}: already linked to its existing portal account; the linkage is preserved.`,
        { employeeCode: holder.employeeCode },
      );
      links.push({ employeeCode: holder.employeeCode, action: 'already-linked' });
      continue;
    }
    if (holder) {
      taken.push(code);
      findings.error(
        'employees',
        `${code}: this email belongs to an account already linked to employee ${holder.employeeCode}. One account resolves to exactly one employee, so it cannot be linked to a second.`,
        { employeeCode: code },
      );
      continue;
    }

    // Reported by checkSharedAccounts(); nothing to add here.
    if (codes.length !== 1) continue;

    const confirmed = CONFIRMED_ACCOUNT_LINKS[code];
    if (!confirmed) {
      taken.push(code);
      findings.error(
        'employees',
        `${code}: a portal account with this email already exists (role ${user.role}) but is not linked to any employee, and no confirmation covers it. Confirm that the account belongs to this employee, or rename it, before importing.`,
        { employeeCode: code },
      );
      continue;
    }

    if (user.role !== confirmed.expectRole) {
      taken.push(code);
      findings.error(
        'employees',
        `${code}: the account was confirmed on ${confirmed.confirmedOn} as a ${confirmed.expectRole} account, but it is a ${user.role} account now. A stale confirmation is not a confirmation — please re-confirm.`,
        { employeeCode: code },
      );
      continue;
    }

    // AD-4: a Customer may hold no HRMS role, so a Customer account cannot be
    // an employee login until its PORTAL role is corrected. That correction is
    // only safe on an account with no customer activity behind it — stripping
    // Customer from an account that has placed orders would take away access
    // the client has not agreed to give up.
    if (user.role === CUSTOMER_ROLE) {
      const orders = await Order.countDocuments({ user: user._id });
      if (orders > 0) {
        taken.push(code);
        findings.error(
          'employees',
          `${code}: the confirmed account is a ${CUSTOMER_ROLE} account carrying ${orders} order(s). AD-4 requires its portal role to change before it can be an employee login, which would remove that customer access. Please decide that explicitly before this is imported.`,
          { employeeCode: code },
        );
        continue;
      }
      findings.warn(
        'employees',
        `${code}: the confirmed account is a ${CUSTOMER_ROLE} account with no orders on it. --execute will correct its portal role to ${STAFF_PORTAL_ROLE} — AD-4 forbids a ${CUSTOMER_ROLE} holding an HRMS role — and grant hrms_employee. The account is reused, never replaced and never deleted.`,
        { employeeCode: code },
      );
      links.push({
        employeeCode: code,
        action: 'reuse',
        userId: String(user._id),
        portalRoleFrom: user.role,
        portalRoleTo: STAFF_PORTAL_ROLE,
        grants: 'hrms_employee',
        customerOrders: orders,
      });
      continue;
    }

    findings.warn(
      'employees',
      `${code}: the confirmed existing portal account (role ${user.role}) will be REUSED and linked to this employee. Its portal role is left untouched and hrms_employee is added. No second account is created.`,
      { employeeCode: code },
    );
    links.push({
      employeeCode: code,
      action: 'reuse',
      userId: String(user._id),
      portalRoleFrom: user.role,
      portalRoleTo: user.role,
      grants: 'hrms_employee',
    });
  }

  return { taken, links };
}

/**
 * Two employees, one email.
 *
 * The workbook gives SI0008 and SI0017 the same address and the client has
 * confirmed there is no second one. Both people are real and both records must
 * exist, so `Employee.userId` was made optional: one of them holds the account,
 * the other is imported with no portal login at all.
 *
 * What did NOT change is that one account resolves to exactly one employee.
 * Self-scope, payroll, attendance, leave, documents, expenses, performance,
 * audit identity and RBAC all read "the employee behind this login", and that
 * has to be a single answer — so the database still refuses two employees on
 * one account, through a partial unique index that ignores the nulls.
 *
 * WHICH of the two keeps the address is the client's decision, not a rule this
 * script may infer, so it is recorded rather than derived. A group nobody has
 * ruled on stays a blocking error.
 *
 * The resolution is applied to the RECORDS, by removing the address from the
 * employee who is not to have a login — which is the same thing as a source
 * that never supplied one. Everything downstream then behaves normally: the
 * pipeline's duplicate-email check sees one claim on the address, and the
 * persistence port creates no account for a record without one.
 */
const CONFIRMED_WITHOUT_LOGIN = Object.freeze({
  SI0017: {
    sharesWith: 'SI0008',
    confirmedOn: '2026-09-05',
    note: 'Client confirmed SI0008 keeps the shared address and that no second address exists. SI0017 is imported without a portal login.',
  },
});

/**
 * Apply the confirmed login resolutions and report anything still unresolved.
 *
 * Returns the records to import — a NEW array, with the address removed from
 * whoever the client said is not to have a login. Nothing is mutated in place,
 * so the parsed workbook still says what it said.
 */
async function resolveSharedAccounts(records, findings) {
  const userIdPath = Employee.schema.path('userId');
  const loginRequired = Boolean(userIdPath?.isRequired);
  const loginOptional = !loginRequired;

  const byEmail = new Map();
  for (const r of records) {
    if (!r.email) continue;
    if (!byEmail.has(r.email)) byEmail.set(r.email, []);
    byEmail.get(r.email).push(r.employeeCode);
  }

  // A confirmation that no longer describes the workbook must not act. If the
  // sheet has since given this employee their own address, dropping it would
  // destroy the very thing the client fixed.
  const stripped = new Set();
  for (const [code, confirmed] of Object.entries(CONFIRMED_WITHOUT_LOGIN)) {
    const record = records.find((r) => r.employeeCode === code);
    if (!record) continue;
    const sharers = record.email ? (byEmail.get(record.email) ?? []) : [];
    if (!record.email || !sharers.includes(confirmed.sharesWith)) {
      findings.info(
        'employees',
        `${code}: the confirmation that it shares an address with ${confirmed.sharesWith} no longer describes the workbook, so it was not applied. The row is imported as it stands.`,
        { employeeCode: code },
      );
      continue;
    }
    stripped.add(code);
  }

  const shared = [];
  for (const [email, codes] of byEmail) {
    if (codes.length < 2) continue;

    const keeping = codes.filter((c) => !stripped.has(c));
    const account = await User.findOne({ email }).select('_id').lean();
    const holder = account
      ? await Employee.findOne({ userId: account._id }).select('employeeCode').lean()
      : null;

    shared.push({
      codes,
      keepsLogin: keeping.length === 1 ? keeping[0] : null,
      withoutLogin: codes.filter((c) => stripped.has(c)),
      accountExists: Boolean(account),
      linkedTo: holder?.employeeCode ?? null,
    });

    if (keeping.length === 1) {
      const without = codes.filter((c) => stripped.has(c));
      findings.warn(
        'employees',
        `${codes.join(' and ')} share one email address. As confirmed, ${keeping[0]} ${account ? 'is linked to the existing account' : 'gets the account created for this address'} and ${without.join(', ')} ${without.length === 1 ? 'is' : 'are'} imported with NO portal login. No address is invented, no second account is created for the address, and one account still resolves to exactly one employee.`,
        { employeeCode: codes.join('+') },
      );
      continue;
    }

    // Nobody has ruled on this group, or the ruling leaves nobody (or more than
    // one) holding the address.
    findings.error(
      'employees',
      `${codes.join(' and ')} share one email address and nothing says which of them is to hold it. ` +
        (loginOptional
          ? 'Employee.userId is optional, so the others can be imported with no portal login — but which one keeps the address is your decision, not one this importer may take. '
          : 'Employee.userId is required in the schema, so an employee cannot be imported without a login at all. ') +
        'No address is invented and no account is fabricated.',
      { employeeCode: codes.join('+') },
    );
  }

  const resolved =
    stripped.size === 0
      ? records
      : records.map((r) => (stripped.has(r.employeeCode) ? { ...r, email: null } : r));

  return { records: resolved, shared, withoutLogin: [...stripped], loginOptional };
}

/**
 * Values carrying a UNIQUE blind index (AD-10): PAN and Aadhaar.
 *
 * Two employees sharing one would collide on that index, and the collision
 * would land mid-commit rather than here. Aadhaar is the real risk on this
 * workbook — the sheet supplies only the LAST FOUR digits, and four digits
 * collide far more easily than a full identifier does.
 *
 * The values are never printed, never written to the report and never compared
 * in the open; only the codes that share one are named.
 */
function checkBlindIndexCollisions(records, findings) {
  for (const field of BLIND_INDEXED_FIELDS) {
    const groups = new Map();
    for (const r of records) {
      if (!r[field]) continue;
      const key = normaliseSensitiveValue(r[field]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r.employeeCode);
    }
    for (const codes of groups.values()) {
      if (codes.length < 2) continue;
      findings.error(
        'employees',
        `${codes.join(' and ')} carry the same ${field}. It has a unique blind index, so the second write would be rejected part way through the import.`,
        { employeeCode: codes.join('+') },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

/**
 * What compensation needs before it can exist.
 *
 * `EmployeeCompensation` requires a pay group AND a salary structure, and a
 * structure requires at least one component. The client's instruction is a bare
 * "10,000 for all", so the minimum faithful configuration is one pay group, one
 * structure and one Basic component at 100% — no allowances and no deductions
 * are invented, because the client specified none.
 *
 * If a default pay group and structure already exist they are reused as-is.
 */
async function planPayroll(employeeCount, findings, ctcBasis) {
  const [payGroup, structure] = await Promise.all([
    PayGroup.findOne({ deletedAt: null }).sort({ isDefault: -1, createdAt: 1 }).lean(),
    SalaryStructure.findOne({ deletedAt: null }).sort({ isDefault: -1, createdAt: 1 }).lean(),
  ]);

  const plan = {
    payGroup: payGroup ? { action: 'reuse', name: payGroup.name } : { action: 'create', name: 'Shraddha Impex Payroll' },
    structure: structure ? { action: 'reuse', name: structure.name } : { action: 'create', name: 'Default Structure' },
    salaryInstruction: `Rs ${SALARY_INSTRUCTION_AMOUNT} for all (client Salary sheet)`,
    ctcBasis: ctcBasis ?? '(not chosen)',
    annualCtc: ctcBasis ? CTC_BASIS[ctcBasis]?.annual ?? null : null,
    compensationToCreate: 0,
    compensationExisting: 0,
  };

  if (!ctcBasis) {
    findings.error(
      'payroll',
      `The Salary sheet says "Put 10,000/- as salary for all" but does not say on what basis, and compensation is stored as ANNUAL CTC. Re-run with --ctc-basis monthly (${CTC_BASIS.monthly.describe}) or --ctc-basis annual (${CTC_BASIS.annual.describe}). Nothing is guessed for a money field.`,
    );
  } else if (!CTC_BASIS[ctcBasis]) {
    findings.error('payroll', `--ctc-basis must be "monthly" or "annual", not "${ctcBasis}".`);
  } else {
    findings.info('payroll', `Salary basis: ${CTC_BASIS[ctcBasis].describe}.`);
  }

  if (!payGroup || !structure) {
    findings.warn(
      'payroll',
      'No pay group or salary structure exists yet. Compensation cannot be stored without both, so the import will create one pay group and one structure with a single Basic component at 100% of CTC. No allowances or deductions are invented — the client specified none.',
    );
  }

  const withComp = await EmployeeCompensation.countDocuments({ effectiveTo: null });
  plan.compensationExisting = withComp;
  plan.compensationToCreate = Math.max(0, employeeCount - withComp);

  findings.info(
    'payroll',
    `Compensation will be initialised from the client's Salary-sheet instruction for ${plan.compensationToCreate} employee(s). The amount is not written to logs or audit metadata.`,
  );
  return plan;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Asset rows to individual physical items.
 *
 * One spreadsheet row can name several machines (`Computer / Phone`), and the
 * Assets model holds one row per physical item — so the cell is split. Three
 * employees appear on two rows each; those are treated as ADDITIONAL assets,
 * deduplicated per (employee, item) so a re-run cannot double them.
 *
 * No serial numbers are invented. The categories are created with
 * `requiresSerialNumber: false`, which is the flag the model already provides
 * for kit that is not serial-tracked.
 */
async function planAssets(assetRows, knownCodes, findings) {
  const wanted = new Map(); // employeeCode -> Set(itemName)
  const categories = new Set();
  let blankRows = 0;

  for (const row of assetRows) {
    if (!row.employeeCode) continue;
    if (!knownCodes.has(row.employeeCode)) {
      findings.error(
        'assets',
        `Row ${row.row}: asset assigned to "${row.employeeCode}", which is not an employee in this workbook.`,
        { employeeCode: row.employeeCode, row: row.row },
      );
      continue;
    }
    const items = splitAssets(row.raw);
    if (items.length === 0) {
      blankRows += 1;
      findings.info('assets', `Row ${row.row} (${row.employeeCode}) has no asset; nothing is created.`, {
        employeeCode: row.employeeCode,
        row: row.row,
      });
      continue;
    }
    if (!wanted.has(row.employeeCode)) wanted.set(row.employeeCode, new Set());
    for (const item of items) {
      wanted.get(row.employeeCode).add(item);
      categories.add(item);
    }
  }

  // Already-assigned items, so a re-run adds nothing.
  const employees = await Employee.find({ employeeCode: { $in: [...wanted.keys()] } })
    .select('_id employeeCode')
    .lean();
  const idByCode = new Map(employees.map((e) => [e.employeeCode, String(e._id)]));

  const existingItems = await AssetItem.find({
    assignedToEmployeeId: { $in: employees.map((e) => e._id) },
    deletedAt: null,
  })
    .select('assignedToEmployeeId categoryId notes')
    .lean();

  const existingCats = await AssetCategory.find({ deletedAt: null }).select('name code').lean();
  const catByName = new Map(existingCats.map((c) => [String(c.name).trim().toLowerCase(), c]));

  const categoriesToCreate = [...categories].filter((c) => !catByName.has(c.toLowerCase()));
  let toCreate = 0;
  let alreadyAssigned = 0;
  const existingByEmployee = new Map();
  for (const it of existingItems) {
    const key = String(it.assignedToEmployeeId);
    if (!existingByEmployee.has(key)) existingByEmployee.set(key, new Set());
    existingByEmployee.get(key).add(String(it.categoryId));
  }

  for (const [code, items] of wanted) {
    const empId = idByCode.get(code);
    const have = empId ? (existingByEmployee.get(empId) ?? new Set()) : new Set();
    for (const item of items) {
      const cat = catByName.get(item.toLowerCase());
      if (cat && have.has(String(cat._id))) alreadyAssigned += 1;
      else toCreate += 1;
    }
  }

  return {
    rows: assetRows.length,
    blankRows,
    employeesWithAssets: wanted.size,
    categoriesToCreate,
    categoriesExisting: [...categories].filter((c) => catByName.has(c.toLowerCase())),
    itemsToCreate: toCreate,
    alreadyAssigned,
    wanted,
  };
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

/**
 * Holiday rows to the Holiday model.
 *
 * The model has no `Holiday_ID` field, so the workbook's `HOL-00n` cannot be
 * the natural key. Its own unique key is `(date, name)` over live rows, and
 * that is what idempotency uses — which also handles the three rows all named
 * "Diwali (Deepavali)" on three consecutive dates.
 *
 * The second `Holiday_Name` column is the WEEKDAY. It is not imported; it is
 * used as an independent check on the date, which is how the timezone bug in
 * the original read was caught.
 */
async function planHolidays(rows, findings) {
  const plan = { rows: rows.length, create: [], update: 0, unchanged: 0, skipped: 0 };
  const seen = new Map();

  for (const h of rows) {
    if (!h.date) {
      findings.error('holidays', `Row ${h.row} (${h.sourceId ?? 'no id'}): ${h.dateError ?? 'no date'}.`, {
        row: h.row,
      });
      plan.skipped += 1;
      continue;
    }
    if (!h.name) {
      findings.error('holidays', `Row ${h.row}: no holiday name.`, { row: h.row });
      plan.skipped += 1;
      continue;
    }

    const mapped = mapHolidayType(h.typeRaw);
    if (!mapped) {
      findings.error(
        'holidays',
        `Row ${h.row} (${h.name}): holiday type "${h.typeRaw}" is not GH or RH.`,
        { row: h.row },
      );
      plan.skipped += 1;
      continue;
    }

    // The workbook's own weekday column, as a cross-check on the date.
    if (h.claimedWeekday) {
      const actual = weekdayOf(h.date);
      if (actual.toLowerCase() !== h.claimedWeekday.trim().toLowerCase()) {
        findings.warn(
          'holidays',
          `${h.name} on ${h.date} is a ${actual}, but the workbook's weekday column says ${h.claimedWeekday}. The DATE column is imported; please confirm which is right.`,
          { row: h.row, holiday: h.name, date: h.date },
        );
      }
    }

    const key = `${h.date}|${h.name.trim().toLowerCase()}`;
    if (seen.has(key)) {
      findings.warn('holidays', `Row ${h.row}: duplicates row ${seen.get(key)} (same date and name).`, {
        row: h.row,
      });
      plan.skipped += 1;
      continue;
    }
    seen.set(key, h.row);

    plan.create.push({
      date: h.date,
      name: h.name.trim(),
      type: mapped.type,
      isOptional: mapped.isOptional,
      description: h.applicableTo ? `Applicable to: ${h.applicableTo}` : null,
      sourceId: h.sourceId,
    });
  }

  const existing = await Holiday.find({
    deletedAt: null,
    date: { $in: plan.create.map((h) => h.date) },
  })
    .select('date name')
    .lean();
  const existingKeys = new Set(existing.map((e) => `${e.date}|${String(e.name).trim().toLowerCase()}`));

  const fresh = plan.create.filter((h) => !existingKeys.has(`${h.date}|${h.name.toLowerCase()}`));
  plan.unchanged = plan.create.length - fresh.length;
  plan.create = fresh;
  return plan;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function writeReport(report, findings, args) {
  if (!args.report) return null;
  const dir = path.resolve(process.cwd(), '..', 'documentation', 'import-reports');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const mode = args.execute ? 'execute' : 'dry-run';
  const file = path.join(dir, `hrms-employee-import-${stamp}-${mode}.json`);
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main({
  argv = process.argv.slice(2),
  executeFn = execute,
  connect = connectDatabase,
  // Injectable so a test can drive `main` without tearing down the
  // connection its own fixtures are sharing.
  disconnect = () => mongoose.disconnect(),
} = {}) {
  const args = parseArgs(argv);
  if (!args.file) {
    console.error('Usage: node scripts/hrms/import-client-workbook.js --file "<path.xlsx>" [--execute]');
    process.exitCode = 1;
    return;
  }

  const absolute = path.resolve(process.cwd(), args.file);
  try {
    await fs.access(absolute);
  } catch {
    console.error(`No such workbook: ${absolute}`);
    process.exitCode = 1;
    return;
  }

  const findings = new Findings();
  const mode = args.execute ? 'EXECUTE' : 'DRY RUN';
  console.log(`\n=== HRMS client workbook import — ${mode} ===`);
  console.log(`source: ${path.basename(absolute)}`);
  console.log(`importer: v${IMPORTER_VERSION}\n`);

  // ---- parse (no database) ------------------------------------------------
  const parsed = parseWorkbook(absolute);
  const { records: parsedRecords, conflicts, issues } = toCanonicalEmployees(parsed);
  for (const i of issues) {
    findings.add(i.level, 'employees', `${i.employeeCode} (row ${i.row}, ${i.field}): ${i.message}`, {
      employeeCode: i.employeeCode,
      row: i.row,
    });
  }

  await connect();
  bootstrapHrms();

  try {
    // ---- reference data ---------------------------------------------------
    const deptPlan = await planDepartments(
      parsed.users.map((u) => u.department).filter(Boolean),
      findings,
    );
    const locPlan = await planLocations(
      parsed.master.map((m) => m.workLocation).filter(Boolean),
      findings,
    );

    // ---- employees --------------------------------------------------------
    // Order matters. The shared address is resolved first, so the account
    // check and the pipeline both see a single claim on it rather than two.
    const sharedCheck = await resolveSharedAccounts(parsedRecords, findings);
    const records = sharedCheck.records;

    const userCheck = await checkExistingUsers(records, findings);
    checkBlindIndexCollisions(records, findings);

    // The pipeline's own validation. Department and location codes cannot
    // resolve until they exist, so on a first run those come back as errors —
    // reported separately from problems in the data itself.
    const preview = await previewImport(records);
    const refErrors = preview.errors.filter(
      (e) => e.field === 'departmentCode' || e.field === 'locationCode',
    );
    const dataErrors = preview.errors.filter(
      (e) => e.field !== 'departmentCode' && e.field !== 'locationCode',
    );

    for (const e of dataErrors) {
      findings.error('employees', `Row ${e.row ?? '?'} (${e.field ?? 'record'}): ${e.message}`, {
        row: e.row,
      });
    }
    if (refErrors.length > 0) {
      findings.info(
        'employees',
        `${refErrors.length} reference(s) do not resolve yet because the departments and location above have not been created. They resolve once this import creates them.`,
      );
    }
    for (const w of preview.warnings) {
      findings.warn('employees', `Row ${w.row ?? '?'}: ${w.message}`, { row: w.row });
    }

    const existingEmployees = await Employee.find({
      employeeCode: { $in: records.map((r) => r.employeeCode) },
    })
      .select('employeeCode')
      .lean();
    const existingCodes = new Set(existingEmployees.map((e) => e.employeeCode));
    const toCreate = records.filter((r) => !existingCodes.has(r.employeeCode));
    const toUpdate = records.filter((r) => existingCodes.has(r.employeeCode));

    // ---- the other domains ------------------------------------------------
    const knownCodes = new Set(records.map((r) => r.employeeCode));
    const assetPlan = await planAssets(parsed.assets, knownCodes, findings);
    const holidayPlan = await planHolidays(parsed.holidays, findings);
    const payrollPlan = await planPayroll(records.length, findings, args.ctcBasis);

    // ---- gaps, stated rather than silently dropped ------------------------
    findings.info(
      'employees',
      'Gender, shift timings (full day / first half / second half / change of time) and HR_Assigned_To have no field in this HRMS and are NOT imported. There is no shift model, and inventing one to hold four spreadsheet columns would be a second scheduling system. Recorded as an intentional gap.',
    );
    if (records.some((r) => r.reportingManagerCode)) {
      findings.info('employees', 'Reporting managers are present in the workbook and will be linked.');
    } else {
      findings.info(
        'employees',
        'Reporting_Manager is empty for every row, so no hierarchy is imported and none is inferred. Existing manager links on an update are left untouched.',
      );
    }

    const sensitiveCounts = {
      pan: records.filter((r) => r.panNumber).length,
      bankAccount: records.filter((r) => r.bankAccountNumber).length,
      ifsc: records.filter((r) => r.bankIfsc).length,
      aadhaarLast4: records.filter((r) => r.aadhaarNumber).length,
    };

    // ---- summary ----------------------------------------------------------
    const summary = {
      employees: {
        rows: parsed.master.length,
        valid: preview.totals.valid,
        create: toCreate.length,
        update: toUpdate.length,
        unchanged: 0,
      },
      accounts: {
        // Codes only. No address is printed, written to the report, or logged.
        reuseExisting: userCheck.links
          .filter((l) => l.action === 'reuse')
          // The account id stays out of the report: the writer needs it,
          // a reader does not.
          .map(({ userId: _accountId, ...rest }) => rest),
        alreadyLinked: userCheck.links
          .filter((l) => l.action === 'already-linked')
          .map((l) => l.employeeCode),
        newAccounts: toCreate.filter(
          (r) => r.email && !userCheck.links.some((l) => l.employeeCode === r.employeeCode),
        ).length,
        sharedEmail: sharedCheck.shared,
        withoutLogin: sharedCheck.withoutLogin,
        employeeLoginOptional: sharedCheck.loginOptional,
      },
      departments: { existing: deptPlan.reuse.length, create: deptPlan.create.length, names: deptPlan.create.map((d) => d.name) },
      locations: { existing: locPlan.reuse.length, create: locPlan.create.length, names: locPlan.create.map((l) => l.name) },
      payroll: payrollPlan,
      assets: {
        rows: assetPlan.rows,
        blankRows: assetPlan.blankRows,
        employeesWithAssets: assetPlan.employeesWithAssets,
        categoriesToCreate: assetPlan.categoriesToCreate,
        itemsToCreate: assetPlan.itemsToCreate,
        alreadyAssigned: assetPlan.alreadyAssigned,
      },
      holidays: {
        rows: holidayPlan.rows,
        create: holidayPlan.create.length,
        unchanged: holidayPlan.unchanged,
        skipped: holidayPlan.skipped,
      },
      conflicts: conflicts.length,
      sensitiveFieldsPresent: sensitiveCounts,
    };

    printSummary(summary, conflicts, findings);

    const report = {
      timestamp: new Date().toISOString(),
      importerVersion: IMPORTER_VERSION,
      mode: args.execute ? 'execute' : 'dry-run',
      sourceFilename: path.basename(absolute),
      sheets: parsed.sheetNames,
      summary,
      conflicts,
      findings: findings.items,
      employeeCodes: {
        create: toCreate.map((r) => r.employeeCode),
        update: toUpdate.map((r) => r.employeeCode),
        failed: [...new Set(findings.errors.map((f) => f.employeeCode).filter(Boolean))],
      },
      executed: false,
      result: null,
    };

    // ---- the gate ---------------------------------------------------------
    if (!args.execute) {
      const file = await writeReport(report, findings, args);
      console.log(`\nDRY RUN — nothing was written to the database.`);
      if (file) console.log(`report: ${path.relative(path.resolve(process.cwd(), '..'), file)}`);
      if (findings.errors.length > 0) {
        console.log(`\n${findings.errors.length} error(s) must be resolved before --execute will run.`);
      } else {
        console.log(`\nNo errors. Re-run with --execute to write.`);
      }
      return { dryRun: true, executed: false, errors: findings.errors.length, summary };
    }

    if (findings.errors.length > 0) {
      console.error(`\nREFUSED: ${findings.errors.length} error(s) stand. Nothing was written.`);
      report.result = { refused: true, reason: 'validation errors' };
      await writeReport(report, findings, args);
      // `executeFn` is deliberately NOT reached. This return is the only
      // thing between a workbook carrying errors and a half-written database.
      return { refused: true, executed: false, errors: findings.errors.length };
    }

    // ---- execute ----------------------------------------------------------
    const result = await executeFn({
      records,
      deptPlan,
      locPlan,
      assetPlan,
      holidayPlan,
      accountLinks: userCheck.links,
      ctcBasis: args.ctcBasis,
      findings,
    });
    report.executed = true;
    report.result = result;
    const file = await writeReport(report, findings, args);
    console.log('\nEXECUTED.');
    console.log(JSON.stringify(result, null, 2));
    if (file) console.log(`report: ${file}`);
    return { executed: true, result };
  } finally {
    await disconnect();
  }
}

// ---------------------------------------------------------------------------
// Execution — only reached with --execute and zero errors
// ---------------------------------------------------------------------------

async function execute({
  records,
  deptPlan,
  locPlan,
  assetPlan,
  holidayPlan,
  accountLinks = [],
  ctcBasis,
  findings,
}) {
  const { createDepartment } = await import('../../modules/hrms/org/department.service.js');
  const { createLocation } = await import('../../modules/hrms/org/location.service.js');

  const systemContext = { user: null, req: null };
  const result = {
    departments: 0,
    locations: 0,
    accountsCorrected: 0,
    employees: null,
    compensation: 0,
    assets: 0,
    holidays: 0,
  };

  // 1. Departments and the location, so employee references resolve.
  for (const d of deptPlan.create) {
    await createDepartment({ code: d.code, name: d.name }, systemContext);
    result.departments += 1;
  }
  for (const l of locPlan.create) {
    await createLocation({ code: l.code, name: l.name }, systemContext);
    result.locations += 1;
  }

  // 2. Nothing may touch an existing account until the employee import is
  //    certain to go through. The preview is free and writes nothing, and the
  //    references it needs exist as of step 1, so it can be asked now.
  const check = await previewImport(records);
  if (!check.canCommit) {
    throw new Error(
      `Employee import would be refused (${check.errors.length} error(s)); no account was touched.`,
    );
  }

  // 3. Portal-role corrections the client confirmed, BEFORE the pipeline runs.
  //
  //    AD-4 is enforced inside the persistence port, which refuses to link a
  //    Customer account outright. That refusal is correct and stays: the port
  //    must not be the thing that decides a customer is really staff. The
  //    decision is the client's, it was recorded in CONFIRMED_ACCOUNT_LINKS,
  //    the dry run showed it, and it is applied here - to the ROLE only. No
  //    account is created, replaced or deleted, and no password is touched.
  result.accountsCorrected = await correctPortalRoles(accountLinks, findings);

  // 4. Employees, through the AD-11 pipeline: upsert, link, derive chains,
  //    seed leave balances. Idempotent on employeeCode.
  const commit = await commitImport(records);
  if (!commit.committed) {
    throw new Error(`Employee import refused: ${commit.reason}`);
  }
  result.employees = commit.result;

  // 5. Compensation, through the payroll service so Decimal128 and
  //    supersession are its job rather than this script's.
  result.compensation = await initialiseCompensation(records, ctcBasis, findings);

  // 6. Assets and 7. holidays.
  result.assets = await createAssets(assetPlan, findings);
  result.holidays = await createHolidays(holidayPlan);

  return result;
}

/**
 * Apply the portal-role corrections the client confirmed.
 *
 * Only ever a role change, and only in one direction: Customer -> the neutral
 * staff role, because AD-4 forbids a Customer account from holding an HRMS
 * role and the client has confirmed these accounts are employees. Accounts that
 * are already staff are left exactly as they are — the persistence port adds
 * `hrms_employee` to those without any help from here.
 *
 * Every precondition is re-checked against the live account rather than trusted
 * from the dry run, because minutes or days may have passed since:
 *
 *   - the account still exists
 *   - it still carries the role that was confirmed
 *   - it still has no customer orders behind it
 *   - it is still linked to no employee
 *
 * A failed precondition throws. The pipeline has not run at this point, so
 * nothing employee-shaped has been written and the run stops with the database
 * holding only the departments and the location — both idempotent, both reused
 * by the next attempt.
 */
async function correctPortalRoles(accountLinks, findings) {
  const corrections = accountLinks.filter(
    (l) => l.action === 'reuse' && l.portalRoleTo !== l.portalRoleFrom,
  );
  if (corrections.length === 0) return 0;

  let applied = 0;
  for (const link of corrections) {
    const { employeeCode } = link;

    const user = await User.findById(link.userId).select('_id role roles').lean();
    if (!user) {
      throw new Error(
        `${employeeCode}: the confirmed account no longer exists. Nothing employee-shaped has been written; re-run the dry run.`,
      );
    }
    if (user.role !== link.portalRoleFrom) {
      throw new Error(
        `${employeeCode}: that account is a ${user.role} account now, not ${link.portalRoleFrom}. The confirmation no longer describes it, so nothing was changed.`,
      );
    }
    if (user.role === CUSTOMER_ROLE) {
      const orders = await Order.countDocuments({ user: user._id });
      if (orders > 0) {
        throw new Error(
          `${employeeCode}: that account has picked up ${orders} order(s) since the dry run. Removing its ${CUSTOMER_ROLE} role would take that access away, so nothing was changed.`,
        );
      }
    }
    const holder = await Employee.findOne({ userId: user._id }).select('employeeCode').lean();
    if (holder) {
      throw new Error(
        `${employeeCode}: that account is linked to employee ${holder.employeeCode} now. One account resolves to exactly one employee, so nothing was changed.`,
      );
    }

    await User.updateOne({ _id: user._id }, { $set: { role: link.portalRoleTo } });
    applied += 1;
    findings.info(
      'employees',
      `${employeeCode}: portal role corrected ${link.portalRoleFrom} -> ${link.portalRoleTo} so the confirmed account can be an employee login (AD-4). The account was reused, not replaced.`,
      { employeeCode },
    );
  }

  return applied;
}

async function initialiseCompensation(records, ctcBasis, findings) {
  const { PayGroup: PG, SalaryStructure: SS, SalaryComponent } = await import(
    '../../models/hrms/PayrollModels.js'
  );
  const { createCompensation } = await import('../../modules/hrms/payroll/compensation.service.js');

  let payGroup = await PG.findOne({ deletedAt: null }).sort({ isDefault: -1, createdAt: 1 });
  if (!payGroup) {
    payGroup = await PG.create({
      code: 'MAIN',
      name: 'Shraddha Impex Payroll',
      legalEntityName: 'Shraddha Impex',
      isDefault: true,
    });
  }

  let structure = await SS.findOne({ deletedAt: null, payGroupId: payGroup._id }).sort({ isDefault: -1 });
  if (!structure) {
    let basic = await SalaryComponent.findOne({ deletedAt: null, code: 'BASIC' });
    if (!basic) {
      // One earning equal to the whole CTC. No allowance and no deduction is
      // invented, because the client specified none - this is the minimum a
      // structure can hold, and a structure is what compensation requires.
      basic = await SalaryComponent.create({
        code: 'BASIC',
        name: 'Basic',
        type: 'earning',
        taxable: true,
        calculationType: 'percent_of',
        formula: { pct_of_annual: 'CTC', percent: 100 },
        order: 1,
      });
    }
    structure = await SS.create({
      name: 'Default Structure',
      payGroupId: payGroup._id,
      isDefault: true,
      components: [{ componentId: basic._id, order: 0 }],
    });
  }

  const employees = await Employee.find({ employeeCode: { $in: records.map((r) => r.employeeCode) } })
    .select('_id employeeCode dateOfJoining')
    .lean();

  let created = 0;
  for (const emp of employees) {
    const already = await EmployeeCompensation.findOne({ employeeId: emp._id, effectiveTo: null }).lean();
    if (already) continue;

    const effectiveFrom = emp.dateOfJoining
      ? new Date(emp.dateOfJoining).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    await createCompensation(
      {
        employeeId: String(emp._id),
        payGroupId: String(payGroup._id),
        structureId: String(structure._id),
        ctc: CTC_BASIS[ctcBasis].annual,
        effectiveFrom,
      },
      { user: null, req: null },
    );
    created += 1;
  }

  findings.info(
    'payroll',
    `Compensation initialised for ${created} employee(s) from the client's Salary-sheet instruction. A super admin can revise it through Payroll > Compensation.`,
  );
  return created;
}

async function createAssets(assetPlan, findings) {
  const catByName = new Map(
    (await AssetCategory.find({ deletedAt: null }).select('name').lean()).map((c) => [
      String(c.name).trim().toLowerCase(),
      c,
    ]),
  );

  for (const name of assetPlan.categoriesToCreate) {
    const created = await AssetCategory.create({
      name,
      code: toRefCode(name).slice(0, 40),
      // The workbook carries no serial numbers, and inventing them would put
      // fiction in an inventory. The model already allows a category that is
      // not serial-tracked.
      requiresSerialNumber: false,
    });
    catByName.set(name.toLowerCase(), created);
  }

  const employees = await Employee.find({ employeeCode: { $in: [...assetPlan.wanted.keys()] } })
    .select('_id employeeCode firstName lastName')
    .lean();
  const byCode = new Map(employees.map((e) => [e.employeeCode, e]));

  let created = 0;
  for (const [code, items] of assetPlan.wanted) {
    const emp = byCode.get(code);
    if (!emp) {
      findings.error('assets', `${code}: employee not found at write time; no asset created.`, {
        employeeCode: code,
      });
      continue;
    }
    for (const item of items) {
      const cat = catByName.get(item.toLowerCase());
      if (!cat) continue;

      const already = await AssetItem.findOne({
        assignedToEmployeeId: emp._id,
        categoryId: cat._id,
        deletedAt: null,
      }).lean();
      if (already) continue;

      await AssetItem.create({
        categoryId: cat._id,
        serialNumber: null,
        status: 'assigned',
        assignedToEmployeeId: emp._id,
        notes: 'Imported from the client asset register.',
        assignments: [
          {
            employeeId: emp._id,
            employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
            assignedAt: new Date(),
            conditionOnAssign: null,
          },
        ],
      });
      created += 1;
    }
  }
  return created;
}

async function createHolidays(holidayPlan) {
  let created = 0;
  for (const h of holidayPlan.create) {
    await Holiday.create({
      name: h.name,
      date: h.date,
      type: h.type,
      isOptional: h.isOptional,
      description: h.description,
    });
    created += 1;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Console output — never a sensitive value
// ---------------------------------------------------------------------------

function printSummary(s, conflicts, findings) {
  const L = (label, value) => console.log(`  ${String(label).padEnd(26)} ${value}`);

  console.log('Employees:');
  L('rows', s.employees.rows);
  L('valid', s.employees.valid);
  L('to create', s.employees.create);
  L('to update', s.employees.update);

  console.log('\nPortal accounts:');
  L('new accounts to create', s.accounts.newAccounts);
  L(
    'existing to reuse/link',
    s.accounts.reuseExisting.length === 0
      ? 'none'
      : s.accounts.reuseExisting
          .map(
            (l) =>
              `${l.employeeCode} (${l.portalRoleFrom}` +
              `${l.portalRoleTo !== l.portalRoleFrom ? ` -> ${l.portalRoleTo}` : ''}, +${l.grants})`,
          )
          .join(', '),
  );
  L('already linked', s.accounts.alreadyLinked.join(', ') || 'none');
  L('imported with NO login', s.accounts.withoutLogin.join(', ') || 'none');
  for (const sh of s.accounts.sharedEmail) {
    L(
      'SHARED email',
      sh.keepsLogin
        ? `${sh.codes.join(' + ')} — ${sh.keepsLogin} holds it, ${sh.withoutLogin.join(', ')} has no login`
        : `${sh.codes.join(' + ')} — UNRESOLVED: nothing says which of them holds it`,
    );
  }

  console.log('\nDepartments:');
  L('existing (reused)', s.departments.existing);
  L('to create', `${s.departments.create}${s.departments.names.length ? ` — ${s.departments.names.join(', ')}` : ''}`);

  console.log('\nLocations:');
  L('existing (reused)', s.locations.existing);
  L('to create', `${s.locations.create}${s.locations.names.length ? ` — ${s.locations.names.join(', ')}` : ''}`);

  console.log('\nPayroll:');
  L('pay group', `${s.payroll.payGroup.action} (${s.payroll.payGroup.name})`);
  L('salary structure', `${s.payroll.structure.action} (${s.payroll.structure.name})`);
  L('compensation to create', s.payroll.compensationToCreate);
  L('salary basis', s.payroll.ctcBasis);
  L('annual CTC to store', s.payroll.annualCtc ?? '(blocked until --ctc-basis is given)');

  console.log('\nAssets:');
  L('rows', s.assets.rows);
  L('blank rows skipped', s.assets.blankRows);
  L('employees with assets', s.assets.employeesWithAssets);
  L('categories to create', s.assets.categoriesToCreate.join(', ') || 'none');
  L('items to create', s.assets.itemsToCreate);
  L('already assigned', s.assets.alreadyAssigned);

  console.log('\nHolidays:');
  L('rows', s.holidays.rows);
  L('to create', s.holidays.create);
  L('unchanged', s.holidays.unchanged);
  L('skipped', s.holidays.skipped);

  console.log('\nSensitive fields (counts only — no values are read back or logged):');
  L('PAN present', s.sensitiveFieldsPresent.pan);
  L('bank account present', s.sensitiveFieldsPresent.bankAccount);
  L('IFSC present', s.sensitiveFieldsPresent.ifsc);
  L('Aadhaar last-4 present', s.sensitiveFieldsPresent.aadhaarLast4);

  if (conflicts.length > 0) {
    console.log(`\nField conflicts (Users vs Master) — ${conflicts.length}:`);
    for (const c of conflicts) {
      const detail = c.detail?.master
        ? ` Master="${c.detail.master}" Users="${c.detail.users}"`
        : '';
      console.log(`  ${c.employeeCode} ${c.field}: ${c.resolution}.${detail}`);
    }
  }

  console.log(`\nFindings: ${findings.errors.length} error(s), ${findings.warnings.length} warning(s), ${findings.infos.length} info.`);
  for (const level of ['ERROR', 'WARNING', 'INFO']) {
    const items = findings.items.filter((i) => i.level === level);
    if (items.length === 0) continue;
    console.log(`\n${level}:`);
    for (const i of items) console.log(`  [${i.domain}] ${i.message}`);
  }
}

const isDirect = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isDirect) {
  // The exit code is the CLI's business, not `main`'s — a test that exercises
  // the refusal must not make its own process exit non-zero.
  main()
    .then((verdict) => {
      if (verdict?.refused) process.exitCode = 1;
    })
    .catch(async (error) => {
    console.error('\nIMPORT FAILED:', error.message);
    try { await mongoose.disconnect(); } catch { /* already closed */ }
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
  planDepartments,
  planLocations,
  planHolidays,
  planAssets,
  checkExistingUsers,
  resolveSharedAccounts,
  checkBlindIndexCollisions,
  correctPortalRoles,
  CONFIRMED_ACCOUNT_LINKS,
  CONFIRMED_WITHOUT_LOGIN,
  STAFF_PORTAL_ROLE,
  Findings,
};
