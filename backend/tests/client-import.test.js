/**
 * The client workbook importer.
 *
 * Two halves. The adapter is a pure mapping, so most of this runs with no
 * database at all and asserts against a workbook BUILT IN THE TEST — no client
 * file is read, and no real employee data is in this repository.
 *
 * The second half uses the in-memory MongoDB the other HRMS suites use, and
 * checks the things only a database can answer: idempotency on employeeCode,
 * reference reuse, and that a dry run writes nothing.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import mongoose from 'mongoose';
import Employee from '../models/hrms/Employee.js';
import User from '../models/User.js';
import Order from '../models/Order.js';
import { Department } from '../models/hrms/Department.js';
import { Location } from '../models/hrms/Location.js';
import { employeePersistencePort } from '../modules/hrms/employees/employee.provider.js';
import { previewImport } from '../modules/hrms/import/pipeline.js';
import { Holiday } from '../models/hrms/Holiday.js';
import {
  parseWorkbook,
  toCanonicalEmployees,
  parseWorkbookDay,
  serialToIsoDay,
  weekdayOf,
  normaliseAadhaarLast4,
  normaliseBankAccount,
  normalisePhone,
  normaliseCode,
  splitAssets,
  splitName,
  toRefCode,
  mapEmploymentType,
  mapHolidayType,
  shraddhaWorkbookAdapter,
} from '../modules/hrms/import/adapters/shraddhaWorkbook.js';
import {
  main as runImporter,
  planDepartments,
  planLocations,
  planHolidays,
  checkExistingUsers,
  resolveSharedAccounts,
  checkBlindIndexCollisions,
  correctPortalRoles,
  CONFIRMED_ACCOUNT_LINKS,
  CONFIRMED_WITHOUT_LOGIN,
  STAFF_PORTAL_ROLE,
  Findings,
} from '../scripts/hrms/import-client-workbook.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const require = createRequire(import.meta.url);
const xlsx = require('xlsx');

// ---------------------------------------------------------------------------
// A stand-in workbook, shaped exactly like the client's
// ---------------------------------------------------------------------------

/** The Excel serial for a `YYYY-MM-DD`, so fixtures can assert the round trip. */
const serialFor = (iso) =>
  Math.round((Date.parse(`${iso}T00:00:00.000Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

function buildWorkbook({ users, master, assets, holidays } = {}) {
  const wb = xlsx.utils.book_new();
  const sheet = (rows) => xlsx.utils.aoa_to_sheet(rows);

  xlsx.utils.book_append_sheet(
    wb,
    sheet([
      ['Emp code', 'Name', 'Email', 'Designation', 'Department', 'Mobile Number',
       'Full day Shift timing', '1St half', '2nd half', 'Change of time'],
      ...(users ?? [
        ['SI0001', 'Asha Kumar', 'asha@example.net', 'Officer', 'Admin', 9123456780, '10am - 6.30pm', '10 to 2.15', '2.15 to 6.30', '9 to 5.30'],
        ['SI0002', 'Bala Rao', 'bala@example.net', 'Analyst', 'Imports', 9123456781, '9am - 5pm', '9 to 1.30', '1.30 to 5', '10.30 to 6.30'],
      ]),
    ]),
    'Users',
  );

  xlsx.utils.book_append_sheet(
    wb,
    sheet([
      ['Emp_ID', 'Full_Name', 'Father_Name', 'Date_of_Birth', 'Gender', 'Mobile_Number',
       'Personal_Email', 'Designation', 'Reporting_Manager', 'Date_of_Joining', 'Employment_Type',
       'Work_Location', 'Bank_Account_No', 'Bank_Name_Branch', 'IFSC_Code', 'PAN_Number',
       'Aadhaar_Last4', 'HR_Assigned_To'],
      ...(master ?? [
        // Joining date as an Excel SERIAL, birth date as DD/MM/YYYY text —
        // the mixture the real workbook uses.
        ['SI0001', 'Asha Kumar', null, '28/12/1995', 'Female', 9123456780, 'asha@example.net',
         'Officer', null, serialFor('2025-11-11'), 'Full Time', 'Head Office',
         '`123456789012345', 'Bank / Branch', 'ABCD0123456', 'ABCDE1234F', 36, 'hr@example.net'],
        ['SI0002', 'Bala Rao', null, '08/02/2002', 'Male', 9123456781, 'bala@example.net',
         'Analyst', null, '15/01/2025', 'Full Time', 'Head Office',
         null, null, null, 'BBCDE1234F', 1234, 'hr@example.net'],
      ]),
    ]),
    'Master',
  );

  xlsx.utils.book_append_sheet(
    wb,
    sheet([
      ['Emp id', 'Employee Name', 'Designation', 'Assets assigned'],
      ...(assets ?? [
        ['SI0001', 'Asha Kumar', 'Officer', 'Computer / Phone'],
        ['SI0002', 'Bala Rao', 'Analyst', 'Laptop'],
        ['SI0002', 'Bala Rao', 'Analyst', ''],
      ]),
    ]),
    'Assets',
  );

  xlsx.utils.book_append_sheet(
    wb,
    sheet([
      ['Holiday_ID', 'Date', 'Holiday_Name', 'Holiday_Name', 'Type', 'Applicable_To'],
      ...(holidays ?? [
        ['HOL-001', serialFor('2026-01-26'), 'Republic Day', 'Monday', 'GH', 'All'],
        ['HOL-002', serialFor('2026-09-14'), 'Ganesh Chaturthi', 'Monday', 'RH', 'All'],
      ]),
    ]),
    'Holiday Master',
  );

  xlsx.utils.book_append_sheet(
    wb,
    sheet([['Put 10,000/- as salary for all and give the provision in super admin panel to change that afterwards.']]),
    'Salary',
  );

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hrms-import-')), 'book.xlsx');
  xlsx.writeFile(wb, file);
  return file;
}

// ===========================================================================
// Normalisation
// ===========================================================================

test('an Aadhaar last-4 keeps its leading zeros', () => {
  // Excel stores this column as a NUMBER, so `0036` has already become 36 by
  // the time any code sees the cell. Padding is the only thing that makes the
  // stored value match the card.
  assert.equal(normaliseAadhaarLast4(36), '0036');
  assert.equal(normaliseAadhaarLast4(6), '0006');
  assert.equal(normaliseAadhaarLast4(0), '0000');
  assert.equal(normaliseAadhaarLast4('0036'), '0036');
  assert.equal(normaliseAadhaarLast4(1234), '1234');
  // A full Aadhaar pasted into a last-4 column keeps only the last four.
  assert.equal(normaliseAadhaarLast4('123456780036'), '0036');
  assert.equal(normaliseAadhaarLast4(null), null);
  assert.equal(normaliseAadhaarLast4(''), null);
});

test('a bank account keeps every digit and loses only the formatting marker', () => {
  // The client prefixes these with a backtick so Excel does not round a
  // 15-digit number into scientific notation.
  assert.equal(normaliseBankAccount('`123456789012345'), '123456789012345');
  assert.equal(normaliseBankAccount("'123456789012345"), '123456789012345');
  assert.equal(normaliseBankAccount('1234 5678 9012'), '123456789012');
  assert.equal(normaliseBankAccount('1234-5678-9012'), '123456789012');
  // A leading zero is part of the account, not formatting.
  assert.equal(normaliseBankAccount('`000123456789'), '000123456789');
  assert.equal(normaliseBankAccount(null), null);
});

test('a phone number survives Excel storing it as a number', () => {
  assert.equal(normalisePhone(9123456780), '9123456780');
  // `String()` on a large number yields exponent notation; this must not.
  assert.equal(normalisePhone(9999999999), '9999999999');
  assert.ok(!normalisePhone(9123456780).includes('e'));
  assert.equal(normalisePhone('+91 91234 56780'), '919123456780');
  assert.equal(normalisePhone(null), null);
});

test('employee codes are the natural key, trimmed and upper-cased', () => {
  assert.equal(normaliseCode(' si0001 '), 'SI0001');
  assert.equal(normaliseCode('SI0001'), 'SI0001');
});

test('a name splits into first and last, keeping middle names on the first', () => {
  assert.deepEqual(splitName('Asha Kumar'), { firstName: 'Asha', lastName: 'Kumar' });
  assert.deepEqual(splitName('Asha Devi Kumar'), { firstName: 'Asha Devi', lastName: 'Kumar' });
  assert.deepEqual(splitName('  Asha   Kumar '), { firstName: 'Asha', lastName: 'Kumar' });
  // A single token still has to satisfy a required lastName.
  assert.deepEqual(splitName('Asha'), { firstName: 'Asha', lastName: 'Asha' });
});

test('reference codes normalise so case and spacing cannot make a duplicate', () => {
  assert.equal(toRefCode('Head Office'), 'HEAD_OFFICE');
  assert.equal(toRefCode(' head office '), 'HEAD_OFFICE');
  assert.equal(toRefCode('HR'), 'HR');
});

test('employment types map to the enum, and nothing is invented', () => {
  assert.equal(mapEmploymentType('Full Time'), 'full_time');
  assert.equal(mapEmploymentType('full-time'), 'full_time');
  assert.equal(mapEmploymentType('Intern'), 'intern');
  assert.equal(mapEmploymentType('Permanent'), null);
});

test('one asset cell splits into individual physical assets', () => {
  assert.deepEqual(splitAssets('Computer / Phone'), ['Computer', 'Phone']);
  assert.deepEqual(splitAssets('Computer / Pen drives'), ['Computer', 'Pen drives']);
  assert.deepEqual(splitAssets('Laptop'), ['Laptop']);
  assert.deepEqual(splitAssets(''), []);
  assert.deepEqual(splitAssets(null), []);
});

test('GH and RH map to the holiday enum the model already defines', () => {
  assert.deepEqual(mapHolidayType('GH'), { type: 'public', isOptional: false });
  assert.deepEqual(mapHolidayType('RH'), { type: 'restricted', isOptional: true });
  assert.equal(mapHolidayType('XX'), null);
});

// ===========================================================================
// Dates — the bug that would have shifted every row
// ===========================================================================

test('an Excel serial reads as the SAME calendar day in every timezone', () => {
  // 26 January 2026 is Republic Day and a Monday. Read with `cellDates: true`
  // it arrives as a Date at LOCAL midnight, and `toISOString()` from any zone
  // east of UTC lands on the 25th — a Sunday. Reading the serial on the UTC
  // line is what keeps the holiday on the right day.
  assert.equal(serialToIsoDay(serialFor('2026-01-26')), '2026-01-26');
  assert.equal(weekdayOf('2026-01-26'), 'Monday');
  assert.equal(serialToIsoDay(serialFor('2025-01-01')), '2025-01-01');
  assert.equal(serialToIsoDay(serialFor('2026-12-31')), '2026-12-31');
});

test('both date shapes in the workbook parse, day-first', () => {
  assert.deepEqual(parseWorkbookDay(serialFor('2025-11-11')), { ok: true, value: '2025-11-11' });
  // Day-first, which the column unambiguously is — several rows carry a day
  // above twelve, and reading them month-first would be a different year's date.
  assert.deepEqual(parseWorkbookDay('15/01/2025'), { ok: true, value: '2025-01-15' });
  assert.deepEqual(parseWorkbookDay('19/10/2021'), { ok: true, value: '2021-10-19' });
  assert.deepEqual(parseWorkbookDay('2025-11-11'), { ok: true, value: '2025-11-11' });
});

test('an impossible date is refused rather than rolled over', () => {
  // `new Date('2026-02-31')` silently becomes 3 March. That must not happen to
  // somebody's date of birth.
  assert.equal(parseWorkbookDay('31/02/2026').ok, false);
  assert.equal(parseWorkbookDay('32/01/2026').ok, false);
  assert.equal(parseWorkbookDay('15/13/2026').ok, false);
  assert.equal(parseWorkbookDay('not a date').ok, false);
  assert.equal(parseWorkbookDay('').ok, false);
  assert.equal(parseWorkbookDay(null).ok, false);
});

// ===========================================================================
// The workbook as a whole
// ===========================================================================

test('every sheet is read, and the two same-named Holiday_Name columns stay distinct', () => {
  const file = buildWorkbook();
  const parsed = parseWorkbook(file);

  assert.deepEqual(parsed.sheetNames, ['Users', 'Master', 'Assets', 'Holiday Master', 'Salary']);
  assert.equal(parsed.users.length, 2);
  assert.equal(parsed.master.length, 2);
  assert.equal(parsed.assets.length, 3);
  assert.equal(parsed.holidays.length, 2);

  // Read by NAME, one of the two identical headers would overwrite the other —
  // and the second is not a name at all.
  assert.equal(parsed.holidays[0].name, 'Republic Day');
  assert.equal(parsed.holidays[0].claimedWeekday, 'Monday');
  assert.equal(parsed.holidays[0].date, '2026-01-26');
});

test('Master is canonical and the sensitive fields land on the record', () => {
  const file = buildWorkbook();
  const { records } = toCanonicalEmployees(parseWorkbook(file));

  const a = records.find((r) => r.employeeCode === 'SI0001');
  assert.equal(a.firstName, 'Asha');
  assert.equal(a.lastName, 'Kumar');
  assert.equal(a.dateOfJoining, '2025-11-11');
  assert.equal(a.dateOfBirth, '1995-12-28');
  assert.equal(a.employmentType, 'full_time');
  assert.equal(a.departmentCode, 'ADMIN');
  assert.equal(a.locationCode, 'HEAD_OFFICE');
  assert.equal(a.status, 'active');

  // Carried for the port to encrypt (AD-10), normalised on the way.
  assert.equal(a.bankAccountNumber, '123456789012345');
  assert.equal(a.aadhaarNumber, '0036');
  assert.equal(a.panNumber, 'ABCDE1234F');
  assert.equal(a.bankIfsc, 'ABCD0123456');

  // Every address in this workbook is a company one, so none is filed as
  // personal — that would misplace it.
  assert.equal(a.personalEmail, null);
  assert.equal(a.email, 'asha@example.net');
});

test('a reporting manager is never invented', () => {
  const file = buildWorkbook();
  const { records } = toCanonicalEmployees(parseWorkbook(file));
  for (const r of records) {
    assert.equal(r.reportingManagerCode, null, `${r.employeeCode} must have no manager`);
  }
});

test('a difference between Users and Master is reported, not silently resolved', () => {
  const file = buildWorkbook({
    users: [['SI0001', 'Asha Kumar', 'asha@example.net', 'Senior Officer', 'Admin', 9123456780, '', '', '', '']],
    master: [['SI0001', 'Asha Kumar', null, '28/12/1995', 'Female', 9123456780, 'asha@example.net',
      'Officer', null, '15/01/2025', 'Full Time', 'Head Office', null, null, null, 'ABCDE1234F', 36, 'hr@example.net']],
  });
  const { records, conflicts } = toCanonicalEmployees(parseWorkbook(file));

  const designation = conflicts.find((c) => c.field === 'designation');
  assert.ok(designation, 'the designation difference must be reported');
  assert.equal(designation.resolution, 'Master is canonical');
  // And Master's value is the one that wins.
  assert.equal(records[0].designation, 'Officer');
});

test('a row missing its joining date is an ERROR, a missing birth date only a warning', () => {
  const file = buildWorkbook({
    master: [['SI0001', 'Asha Kumar', null, 'rubbish', 'Female', 9123456780, 'asha@example.net',
      'Officer', null, 'also rubbish', 'Full Time', 'Head Office', null, null, null, 'ABCDE1234F', 36, 'hr@example.net']],
  });
  const { issues } = toCanonicalEmployees(parseWorkbook(file));

  assert.ok(issues.some((i) => i.level === 'ERROR' && i.field === 'Date_of_Joining'));
  assert.ok(issues.some((i) => i.level === 'WARNING' && i.field === 'Date_of_Birth'));
});

test('the adapter hands the pipeline canonical shape with no null padding', async () => {
  const file = buildWorkbook();
  const rows = await shraddhaWorkbookAdapter.load(file);
  assert.equal(rows.length, 2);
  // A null optional is the same as an absent one to the pipeline, and its
  // schema is strict about what it will accept.
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      assert.notEqual(value, null, `${key} should be omitted rather than null`);
    }
  }
});

// ===========================================================================
// Against a database
// ===========================================================================

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, Department, Location, Holiday);
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

test('departments already present are reused, never duplicated on case or spacing', async () => {
  await Department.create({ code: 'ADMIN', name: 'Admin' });
  await Department.create({ code: 'ENG', name: 'Engineering' });

  const findings = new Findings();
  const plan = await planDepartments(['Admin', ' admin ', 'ADMIN', 'Sales'], findings);

  assert.equal(plan.reuse.length, 1, 'the four Admin spellings are one department');
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].name, 'Sales');
  // An unrelated existing department is left alone.
  assert.ok(!plan.create.some((d) => d.name === 'Engineering'));
});

test('a department that exists under a different CODE is matched by name', async () => {
  await Department.create({ code: 'HR_DEPT', name: 'HR' });
  const findings = new Findings();
  const plan = await planDepartments(['HR'], findings);

  assert.equal(plan.create.length, 0, 'it must not create a second HR');
  assert.equal(plan.reuse[0].code, 'HR_DEPT');
  assert.ok(findings.infos.some((i) => i.message.includes('matched the existing department')));
});

test('a soft-deleted department is reused and reported, not duplicated', async () => {
  await Department.create({ code: 'SALES', name: 'Sales', deletedAt: new Date() });
  const findings = new Findings();
  const plan = await planDepartments(['Sales'], findings);

  assert.equal(plan.create.length, 0);
  assert.equal(plan.revive.length, 1);
  assert.ok(findings.warnings.some((w) => w.message.includes('soft-deleted')));
});

test('Head Office is created once and reused thereafter', async () => {
  const findings = new Findings();
  const first = await planLocations(['Head Office'], findings);
  assert.equal(first.create.length, 1);

  await Location.create({ code: 'HEAD_OFFICE', name: 'Head Office' });
  const second = await planLocations(['Head Office', 'head office'], findings);
  assert.equal(second.create.length, 0);
  assert.equal(second.reuse.length, 1);
});

test('an address nobody holds raises nothing', async () => {
  const findings = new Findings();
  await checkExistingUsers([{ employeeCode: 'SI0001', email: 'nobody@example.net' }], findings);
  assert.equal(findings.errors.length, 0);
});

test('holidays are keyed on date and name, so a re-run creates nothing', async () => {
  const rows = [
    { row: 2, sourceId: 'HOL-001', date: '2026-01-26', name: 'Republic Day', claimedWeekday: 'Monday', typeRaw: 'GH', applicableTo: 'All', dateError: null },
    { row: 3, sourceId: 'HOL-012', date: '2026-11-08', name: 'Diwali (Deepavali)', claimedWeekday: 'Sunday', typeRaw: 'GH', applicableTo: 'All', dateError: null },
    { row: 4, sourceId: 'HOL-013', date: '2026-11-09', name: 'Diwali (Deepavali)', claimedWeekday: 'Monday', typeRaw: 'RH', applicableTo: 'All', dateError: null },
  ];

  const first = await planHolidays(rows, new Findings());
  // Three rows share a name across two of them; the key is (date, name), so
  // both Diwali days survive as separate holidays.
  assert.equal(first.create.length, 3);

  for (const h of first.create) {
    await Holiday.create({ name: h.name, date: h.date, type: h.type, isOptional: h.isOptional });
  }

  const second = await planHolidays(rows, new Findings());
  assert.equal(second.create.length, 0, 'a re-run must create nothing');
  assert.equal(second.unchanged, 3);
});

test('a weekday that disagrees with the date is a warning, and the DATE is kept', async () => {
  const findings = new Findings();
  const plan = await planHolidays(
    [{ row: 2, sourceId: 'HOL-002', date: '2026-04-03', name: 'Holi', claimedWeekday: 'Wednesday', typeRaw: 'GH', applicableTo: 'All', dateError: null }],
    findings,
  );

  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].date, '2026-04-03', 'the Date column is authoritative');
  assert.ok(findings.warnings.some((w) => /weekday column says Wednesday/.test(w.message)));
});

test('a holiday with an unknown type or no date is skipped, not guessed', async () => {
  const findings = new Findings();
  const plan = await planHolidays(
    [
      { row: 2, sourceId: 'X', date: '2026-01-26', name: 'Republic Day', claimedWeekday: null, typeRaw: 'ZZ', applicableTo: 'All', dateError: null },
      { row: 3, sourceId: 'Y', date: null, name: 'Something', claimedWeekday: null, typeRaw: 'GH', applicableTo: 'All', dateError: 'empty' },
    ],
    findings,
  );

  assert.equal(plan.create.length, 0);
  assert.equal(plan.skipped, 2);
  assert.equal(findings.errors.length, 2);
});

test('no sensitive value appears in a finding message', async () => {
  // The report and the console are both built from findings, so this is the
  // one place to hold the line for both.
  const file = buildWorkbook();
  const { records, conflicts, issues } = toCanonicalEmployees(parseWorkbook(file));
  const secrets = records.flatMap((r) =>
    [r.panNumber, r.bankAccountNumber, r.bankIfsc, r.aadhaarNumber].filter(Boolean),
  );
  assert.ok(secrets.length > 0, 'the fixture must actually carry secrets');

  const text = JSON.stringify({ conflicts, issues });
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `a sensitive value leaked into the findings: ${secret.slice(0, 2)}…`);
  }
});

// ===========================================================================
// The gate — the single most safety-critical property here
// ===========================================================================

test('--execute REFUSES while an error stands, and never reaches the writer', async () => {
  // The client workbook carries five blocking errors (a Customer-owned email,
  // two addresses already taken by staff accounts, two employees sharing one
  // address, and an unchosen salary basis). None of them may reach a write.
  //
  // `executeFn` is injected so this asserts the thing that matters: not that
  // the database happened to stay empty, but that the writer was NEVER CALLED.
  const file = buildWorkbook({
    // One employee, and no --ctc-basis, which is an error on its own.
    master: [['SI0001', 'Asha Kumar', null, '28/12/1995', 'Female', 9123456780, 'asha@example.net',
      'Officer', null, '15/01/2025', 'Full Time', 'Head Office', null, null, null, 'ABCDE1234F', 36, 'hr@example.net']],
  });

  let called = false;
  const verdict = await runImporter({
    argv: ['--file', file, '--execute', '--no-report'],
    connect: async () => {},
    disconnect: async () => {},
    executeFn: async () => {
      called = true;
      return {};
    },
  });

  assert.equal(called, false, 'the writer must never be called while an error stands');
  assert.equal(verdict.executed, false);
  assert.equal(verdict.refused, true);
  assert.ok(verdict.errors > 0);
});

test('a dry run never reaches the writer either, errors or not', async () => {
  const file = buildWorkbook();
  let called = false;

  const verdict = await runImporter({
    argv: ['--file', file, '--no-report'],
    connect: async () => {},
    disconnect: async () => {},
    executeFn: async () => {
      called = true;
      return {};
    },
  });

  assert.equal(called, false, 'a dry run must never write');
  assert.equal(verdict.dryRun, true);
  assert.equal(verdict.executed, false);
  // And it still produced a plan to review.
  assert.equal(verdict.summary.employees.rows, 2);
});

test('the salary basis is required before any write is attempted', async () => {
  // Ten thousand read as annual is about Rs 833 a month. A twelvefold
  // ambiguity on a money field is refused, not guessed.
  const file = buildWorkbook();
  const verdict = await runImporter({
    argv: ['--file', file, '--no-report'],
    connect: async () => {},
    disconnect: async () => {},
    executeFn: async () => ({}),
  });

  const basis = verdict.summary.payroll;
  assert.equal(basis.ctcBasis, '(not chosen)');
  assert.equal(basis.annualCtc, null);
});

// ---------------------------------------------------------------------------
// Existing portal accounts (the client's confirmed resolutions)
// ---------------------------------------------------------------------------

/** An address nobody has confirmed. SI0099 is deliberately not in the list. */
test('an UNCONFIRMED email already held by a staff account is refused', async () => {
  // upsertEmployees would otherwise link a login nobody agreed to link, and
  // before that it would fail on the unique email index part way through a
  // commit. Neither is acceptable, so it is a pre-flight error.
  await User.create({
    email: 'sales@example.net',
    password: 'x',
    user: 'Sales Person',
    role: 'Sales',
    status: 'Active',
  });

  const findings = new Findings();
  const plan = await checkExistingUsers(
    [{ employeeCode: 'SI0099', email: 'sales@example.net' }],
    findings,
  );

  const err = findings.errors.find((e) => e.employeeCode === 'SI0099');
  assert.ok(err, 'an unconfirmed collision must be an error');
  assert.match(err.message, /no confirmation covers it/);
  assert.equal(plan.links.length, 0, 'nothing may be planned for it');
});

test('a CONFIRMED staff account is reused, and its portal role is left alone', async () => {
  await User.create({
    email: 'sales@example.net',
    password: 'x',
    user: 'Sales Person',
    role: CONFIRMED_ACCOUNT_LINKS.SI0007.expectRole,
    status: 'Active',
  });

  const findings = new Findings();
  const plan = await checkExistingUsers(
    [{ employeeCode: 'SI0007', email: 'sales@example.net' }],
    findings,
  );

  assert.equal(findings.errors.length, 0, 'a confirmed account is not an error');
  const link = plan.links.find((l) => l.employeeCode === 'SI0007');
  assert.equal(link.action, 'reuse');
  assert.equal(link.portalRoleTo, 'Sales', 'the portal role must not be touched');
  assert.equal(link.portalRoleFrom, 'Sales');
  assert.ok(findings.warnings.some((w) => w.message.includes('REUSED')));
});

test('a CONFIRMED Customer account with no orders is planned as an AD-4 role correction', async () => {
  await User.create({
    email: 'customer@example.net',
    password: 'x',
    user: 'A Customer',
    role: 'Customer',
    status: 'Active',
  });

  const findings = new Findings();
  const plan = await checkExistingUsers(
    [{ employeeCode: 'SI0002', email: 'customer@example.net' }],
    findings,
  );

  assert.equal(findings.errors.length, 0);
  const link = plan.links.find((l) => l.employeeCode === 'SI0002');
  assert.equal(link.portalRoleFrom, 'Customer');
  assert.equal(link.portalRoleTo, STAFF_PORTAL_ROLE);
  assert.equal(link.customerOrders, 0);
  // The change is announced before it happens, never applied silently.
  assert.ok(findings.warnings.some((w) => /portal role to Management/.test(w.message)));
});

test('a CONFIRMED Customer account WITH orders is refused, not silently converted', async () => {
  const user = await User.create({
    email: 'customer@example.net',
    password: 'x',
    user: 'A Customer',
    role: 'Customer',
    status: 'Active',
  });
  await Order.create({ brand: 'Koken', user: user._id, orderId: 'PO-1', skuCode: 'SKU-1' });

  const findings = new Findings();
  const plan = await checkExistingUsers(
    [{ employeeCode: 'SI0002', email: 'customer@example.net' }],
    findings,
  );

  const err = findings.errors.find((e) => e.employeeCode === 'SI0002');
  assert.ok(err, 'converting an account with customer activity needs a decision');
  assert.match(err.message, /1 order/);
  assert.equal(plan.links.length, 0);
});

test('a confirmation does not carry over once the account has changed role', async () => {
  // Confirmed as a Sales account; it is an Admin account now. A stale approval
  // is not an approval.
  await User.create({
    email: 'sales@example.net',
    password: 'x',
    user: 'Someone Else',
    role: 'Admin',
    status: 'Active',
  });

  const findings = new Findings();
  await checkExistingUsers([{ employeeCode: 'SI0007', email: 'sales@example.net' }], findings);

  const err = findings.errors.find((e) => e.employeeCode === 'SI0007');
  assert.ok(err);
  assert.match(err.message, /re-confirm/);
});

test('an account already linked to another employee is never re-pointed', async () => {
  const user = await User.create({
    email: 'sales@example.net',
    password: 'x',
    user: 'Sales Person',
    role: 'Sales',
    status: 'Active',
  });
  await Employee.create({
    userId: user._id,
    employeeCode: 'SI9000',
    firstName: 'Held',
    lastName: 'Already',
    dateOfJoining: new Date('2025-01-01'),
    employmentType: 'full_time',
    status: 'active',
  });

  const findings = new Findings();
  const plan = await checkExistingUsers(
    [{ employeeCode: 'SI0007', email: 'sales@example.net' }],
    findings,
  );

  const err = findings.errors.find((e) => e.employeeCode === 'SI0007');
  assert.ok(err, 'even a confirmed code cannot take a linked account');
  assert.match(err.message, /already linked to employee SI9000/);
  assert.equal(plan.links.length, 0);
});

test('an existing linkage to the SAME employee is preserved, not re-reported as a problem', async () => {
  const user = await User.create({
    email: 'sales@example.net',
    password: 'x',
    user: 'Sales Person',
    role: 'Sales',
    status: 'Active',
  });
  await Employee.create({
    userId: user._id,
    employeeCode: 'SI0007',
    firstName: 'Same',
    lastName: 'Person',
    dateOfJoining: new Date('2025-01-01'),
    employmentType: 'full_time',
    status: 'active',
  });

  const findings = new Findings();
  const plan = await checkExistingUsers(
    [{ employeeCode: 'SI0007', email: 'sales@example.net' }],
    findings,
  );

  assert.equal(findings.errors.length, 0);
  assert.equal(plan.links[0].action, 'already-linked');
  assert.ok(findings.infos.some((i) => i.message.includes('preserved')));
});

// ---------------------------------------------------------------------------
// Two employees, one email
// ---------------------------------------------------------------------------

test('the confirmed resolution gives the address to one and no login to the other', async () => {
  const findings = new Findings();
  const { records, shared, withoutLogin } = await resolveSharedAccounts(
    [
      { employeeCode: 'SI0008', email: 'shared@example.net' },
      { employeeCode: 'SI0017', email: 'shared@example.net' },
      { employeeCode: 'SI0001', email: 'alone@example.net' },
    ],
    findings,
  );

  assert.equal(findings.errors.length, 0, 'a confirmed group must not block');
  assert.deepEqual(withoutLogin, ['SI0017']);

  const byCode = new Map(records.map((r) => [r.employeeCode, r]));
  assert.equal(byCode.get('SI0008').email, 'shared@example.net', 'SI0008 keeps the address');
  assert.equal(byCode.get('SI0017').email, null, 'SI0017 has none, so it gets no login');
  assert.equal(byCode.get('SI0001').email, 'alone@example.net', 'unrelated rows are untouched');

  assert.equal(shared[0].keepsLogin, 'SI0008');
  assert.deepEqual(shared[0].withoutLogin, ['SI0017']);
  assert.ok(findings.warnings.some((w) => /NO portal login/.test(w.message)));
});

test('the resolution is applied to a COPY — the parsed workbook still says what it said', async () => {
  const parsed = [
    { employeeCode: 'SI0008', email: 'shared@example.net' },
    { employeeCode: 'SI0017', email: 'shared@example.net' },
  ];
  await resolveSharedAccounts(parsed, new Findings());
  assert.equal(parsed[1].email, 'shared@example.net', 'the source rows must not be mutated');
});

test('a shared address nobody has ruled on is still a blocking error', async () => {
  const findings = new Findings();
  const { records, withoutLogin } = await resolveSharedAccounts(
    [
      { employeeCode: 'SI0003', email: 'shared@example.net' },
      { employeeCode: 'SI0004', email: 'shared@example.net' },
    ],
    findings,
  );

  const err = findings.errors.find((e) => e.employeeCode === 'SI0003+SI0004');
  assert.ok(err, 'which one keeps the address is not a decision this script may take');
  assert.match(err.message, /your decision/);
  assert.match(err.message, /No address is invented/);
  assert.equal(withoutLogin.length, 0);
  // Nothing is stripped, so nothing is quietly imported without a login.
  assert.ok(records.every((r) => r.email === 'shared@example.net'));
});

test('a confirmation that no longer describes the workbook is NOT applied', async () => {
  // The client gives SI0017 its own address later. Dropping it because a
  // confirmation once said to would destroy exactly what they fixed.
  const findings = new Findings();
  const { records, withoutLogin } = await resolveSharedAccounts(
    [
      { employeeCode: 'SI0008', email: 'anita@example.net' },
      { employeeCode: 'SI0017', email: 'meera@example.net' },
    ],
    findings,
  );

  assert.equal(withoutLogin.length, 0);
  assert.equal(records.find((r) => r.employeeCode === 'SI0017').email, 'meera@example.net');
  assert.equal(findings.errors.length, 0);
  assert.ok(findings.infos.some((i) => /no longer describes the workbook/.test(i.message)));
});

test('CONFIRMED_WITHOUT_LOGIN records who it applies to and who keeps the address', () => {
  assert.equal(CONFIRMED_WITHOUT_LOGIN.SI0017.sharesWith, 'SI0008');
  assert.ok(CONFIRMED_WITHOUT_LOGIN.SI0017.confirmedOn);
});

test('Employee.userId is optional, and unique among those who have one', async () => {
  // The change option (b) required, asserted so that reverting either half is
  // a deliberate act rather than an accident.
  const path = Employee.schema.path('userId');
  assert.equal(path.isRequired, undefined, 'an employee need not have a login');

  const unique = Employee.schema.indexes().find(([spec, opts]) => spec.userId === 1 && opts?.unique);
  assert.ok(unique, 'one account still resolves to exactly one employee');
  assert.deepEqual(unique[1].partialFilterExpression, { userId: { $type: 'objectId' } });

  // And the database agrees, not just the schema object.
  const live = await mongoose.connection.db.collection('employees').indexes();
  const idx = live.find((i) => i.name === 'userId_1');
  assert.equal(idx.unique, true);
  assert.deepEqual(idx.partialFilterExpression, { userId: { $type: 'objectId' } });
});

// ---------------------------------------------------------------------------
// Unique blind indexes (AD-10)
// ---------------------------------------------------------------------------

test('two employees carrying the same PAN or Aadhaar are caught before the commit', async () => {
  const findings = new Findings();
  checkBlindIndexCollisions(
    [
      { employeeCode: 'SI0001', panNumber: 'ABCDE1234F', aadhaarNumber: '0036' },
      { employeeCode: 'SI0002', panNumber: 'abcde 1234 f', aadhaarNumber: '9999' },
      { employeeCode: 'SI0003', panNumber: 'ZZZZZ9999Z', aadhaarNumber: '0036' },
    ],
    findings,
  );

  // Normalised: SI0001 and SI0002 share a PAN despite case and spacing.
  const pan = findings.errors.find((e) => e.message.includes('panNumber'));
  assert.ok(pan);
  assert.match(pan.message, /SI0001 and SI0002/);

  // Four digits collide far more easily than a full identifier.
  const aadhaar = findings.errors.find((e) => e.message.includes('aadhaarNumber'));
  assert.ok(aadhaar);
  assert.match(aadhaar.message, /SI0001 and SI0003/);

  // The values themselves never appear.
  for (const e of findings.errors) {
    assert.doesNotMatch(e.message, /ABCDE1234F|0036|9999/);
  }
});

test('distinct sensitive values raise nothing', async () => {
  const findings = new Findings();
  checkBlindIndexCollisions(
    [
      { employeeCode: 'SI0001', panNumber: 'ABCDE1234F', aadhaarNumber: '0036' },
      { employeeCode: 'SI0002', panNumber: 'ZZZZZ9999Z', aadhaarNumber: '0037' },
    ],
    findings,
  );
  assert.equal(findings.errors.length, 0);
});

// ---------------------------------------------------------------------------
// The portal-role correction, at write time
// ---------------------------------------------------------------------------

test('the role correction reuses the account — it is never replaced or deleted', async () => {
  const user = await User.create({
    email: 'customer@example.net',
    password: 'x',
    user: 'A Customer',
    role: 'Customer',
    status: 'Active',
  });

  const findings = new Findings();
  const applied = await correctPortalRoles(
    [
      {
        employeeCode: 'SI0002',
        action: 'reuse',
        userId: String(user._id),
        portalRoleFrom: 'Customer',
        portalRoleTo: STAFF_PORTAL_ROLE,
      },
    ],
    findings,
  );

  assert.equal(applied, 1);
  const after = await User.find({ email: 'customer@example.net' }).lean();
  assert.equal(after.length, 1, 'the same account, not a second one');
  assert.equal(String(after[0]._id), String(user._id));
  assert.equal(after[0].role, STAFF_PORTAL_ROLE);
});

test('a staff account needs no correction, so none is applied', async () => {
  const user = await User.create({
    email: 'sales@example.net',
    password: 'x',
    user: 'Sales Person',
    role: 'Sales',
    status: 'Active',
  });

  const applied = await correctPortalRoles(
    [
      {
        employeeCode: 'SI0007',
        action: 'reuse',
        userId: String(user._id),
        portalRoleFrom: 'Sales',
        portalRoleTo: 'Sales',
      },
    ],
    new Findings(),
  );

  assert.equal(applied, 0);
  assert.equal((await User.findById(user._id).lean()).role, 'Sales');
});

test('the correction re-checks the live account, and refuses when it has moved on', async () => {
  const user = await User.create({
    email: 'customer@example.net',
    password: 'x',
    user: 'A Customer',
    role: 'Customer',
    status: 'Active',
  });
  // An order arrives between the dry run and the execute.
  await Order.create({ brand: 'Koken', user: user._id, orderId: 'PO-2', skuCode: 'SKU-2' });

  await assert.rejects(
    correctPortalRoles(
      [
        {
          employeeCode: 'SI0002',
          action: 'reuse',
          userId: String(user._id),
          portalRoleFrom: 'Customer',
          portalRoleTo: STAFF_PORTAL_ROLE,
        },
      ],
      new Findings(),
    ),
    /picked up 1 order/,
  );
  assert.equal((await User.findById(user._id).lean()).role, 'Customer', 'unchanged');
});

// ---------------------------------------------------------------------------
// What the writer is handed
// ---------------------------------------------------------------------------

test('the salary basis and the account plan reach the writer', async () => {
  // `ctcBasis` was referenced inside execute() without being destructured from
  // its argument, so the real import would have thrown a ReferenceError AFTER
  // departments, locations and employees were written. This asserts the
  // contract between main() and the writer.
  const file = buildWorkbook();
  await Department.create({ code: 'ADMIN', name: 'Admin' });
  await Location.create({ code: 'HEAD_OFFICE', name: 'Head Office' });

  let payload = null;
  await runImporter({
    argv: ['--file', file, '--ctc-basis', 'monthly', '--execute', '--no-report'],
    connect: async () => {},
    disconnect: async () => {},
    executeFn: async (arg) => {
      payload = arg;
      return {};
    },
  });

  assert.ok(payload, 'the writer must have been reached with a clean workbook');
  assert.equal(payload.ctcBasis, 'monthly');
  assert.ok(Array.isArray(payload.accountLinks));
  assert.ok(payload.records.length > 0);
});

// ---------------------------------------------------------------------------
// The AD-11 persistence port — the write path this import commits through
// ---------------------------------------------------------------------------

/** The canonical record shape, with only the fields a test cares about set. */
const canonical = (over = {}) => ({
  employeeCode: 'SI0001',
  firstName: 'Asha',
  lastName: 'Kumar',
  email: 'asha@example.net',
  dateOfJoining: '2025-01-15',
  employmentType: 'full_time',
  status: 'active',
  customFieldValues: {},
  ...over,
});

test('sensitive values from an import are ENCRYPTED and stored, not dropped', async () => {
  // They used to be extracted and then discarded, so an imported PAN, bank
  // account, IFSC or Aadhaar simply never arrived — which looks exactly like a
  // successful import until someone opens the record.
  await employeePersistencePort.upsertEmployees([
    canonical({
      panNumber: 'ABCDE1234F',
      bankAccountNumber: '123456789012',
      bankIfsc: 'HDFC0001234',
      aadhaarNumber: '0036',
    }),
  ]);

  const raw = await mongoose.connection.db
    .collection('employees')
    .findOne({ employeeCode: 'SI0001' });

  for (const field of ['panNumber', 'bankAccountNumber', 'bankIfsc', 'aadhaarNumber']) {
    assert.ok(raw[`${field}Enc`], `${field} must be stored`);
    // An envelope, never the value.
    assert.doesNotMatch(JSON.stringify(raw[`${field}Enc`]), /ABCDE1234F|123456789012|HDFC0001234/);
  }
  // Blind-indexed fields carry their index so uniqueness can be enforced.
  assert.equal(typeof raw.panNumberIdx, 'string');
  assert.equal(typeof raw.aadhaarNumberIdx, 'string');

  // And it reads back exactly as it went in — including the leading zero.
  const doc = await Employee.findOne({ employeeCode: 'SI0001' }).select(
    '+aadhaarNumberEnc +panNumberEnc',
  );
  assert.equal(await doc.readSensitive('aadhaarNumber', { reveal: true }), '0036');
  assert.equal(await doc.readSensitive('panNumber', { reveal: true }), 'ABCDE1234F');
});

test('an imported employee lands in its department and location', async () => {
  // The port resolved these codes for the dependency check and then never
  // wrote them, so every imported employee arrived unassigned.
  const dept = await Department.create({ code: 'ADMIN', name: 'Admin' });
  const loc = await Location.create({ code: 'HEAD_OFFICE', name: 'Head Office' });

  await employeePersistencePort.upsertEmployees([
    canonical({ departmentCode: 'ADMIN', locationCode: 'HEAD_OFFICE' }),
  ]);

  const emp = await Employee.findOne({ employeeCode: 'SI0001' }).lean();
  assert.equal(String(emp.departmentId), String(dept._id));
  assert.equal(String(emp.locationId), String(loc._id));
});

test('a re-run with no department column does not blank the one already set', async () => {
  const dept = await Department.create({ code: 'ADMIN', name: 'Admin' });
  await employeePersistencePort.upsertEmployees([canonical({ departmentCode: 'ADMIN' })]);
  await employeePersistencePort.upsertEmployees([canonical()]);

  const emp = await Employee.findOne({ employeeCode: 'SI0001' }).lean();
  assert.equal(String(emp.departmentId), String(dept._id));
});

test('an existing login is REUSED, keeping its portal role, and gains hrms_employee', async () => {
  const user = await User.create({
    email: 'asha@example.net',
    password: 'x',
    user: 'Asha Kumar',
    role: 'Sales',
    roles: [],
    status: 'Active',
  });

  await employeePersistencePort.upsertEmployees([canonical()]);

  const accounts = await User.find({ email: 'asha@example.net' }).lean();
  assert.equal(accounts.length, 1, 'no second account may be minted');
  assert.equal(String(accounts[0]._id), String(user._id));
  assert.equal(accounts[0].role, 'Sales', 'the portal role is not disturbed');
  assert.deepEqual(accounts[0].roles, ['hrms_employee']);

  const emp = await Employee.findOne({ employeeCode: 'SI0001' }).lean();
  assert.equal(String(emp.userId), String(user._id));
});

test('the port refuses a Customer login outright — AD-4 is not its decision to waive', async () => {
  await User.create({
    email: 'asha@example.net',
    password: 'x',
    user: 'A Customer',
    role: 'Customer',
    status: 'Active',
  });

  // The generic role rule would also stop this, but only once the write is
  // attempted and with a message about roles. The port refuses FIRST, and names
  // the employee and what has to happen instead.
  await assert.rejects(
    employeePersistencePort.upsertEmployees([canonical()]),
    (err) => {
      assert.match(err.message, /^SI0001: /);
      assert.match(err.message, /AD-4/);
      assert.match(err.message, /portal role is corrected/);
      return true;
    },
  );
  assert.equal(await Employee.countDocuments({ employeeCode: 'SI0001' }), 0);
  // And nothing was granted to the Customer on the way past.
  assert.deepEqual((await User.findOne({ email: 'asha@example.net' }).lean()).roles, []);
});

test('one login cannot be linked to a second employee', async () => {
  const user = await User.create({
    email: 'asha@example.net',
    password: 'x',
    user: 'Asha Kumar',
    role: 'Sales',
    status: 'Active',
  });
  await Employee.create({
    userId: user._id,
    employeeCode: 'SI9000',
    firstName: 'Held',
    lastName: 'Already',
    dateOfJoining: new Date('2025-01-01'),
    employmentType: 'full_time',
    status: 'active',
  });

  await assert.rejects(
    employeePersistencePort.upsertEmployees([canonical()]),
    /already belongs to employee SI9000/,
  );
  assert.equal(await Employee.countDocuments({ employeeCode: 'SI0001' }), 0);
});

test('a new employee still gets a suspended account with no usable password', async () => {
  await employeePersistencePort.upsertEmployees([canonical()]);

  const user = await User.findOne({ email: 'asha@example.net' }).select('+password').lean();
  assert.equal(user.status, 'Inactive', 'an import must not mint a signable-in account');
  assert.deepEqual(user.roles, ['hrms_employee']);
  assert.equal(user.role, 'Management');
});

test('re-running the import is idempotent on employeeCode', async () => {
  await employeePersistencePort.upsertEmployees([canonical({ panNumber: 'ABCDE1234F' })]);
  const first = await Employee.findOne({ employeeCode: 'SI0001' }).lean();

  const second = await employeePersistencePort.upsertEmployees([
    canonical({ panNumber: 'ABCDE1234F', designation: 'Officer' }),
  ]);

  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal(await Employee.countDocuments({}), 1);
  assert.equal(await User.countDocuments({ email: 'asha@example.net' }), 1);

  const after = await Employee.findOne({ employeeCode: 'SI0001' }).lean();
  assert.equal(String(after._id), String(first._id), 'the same record, updated in place');
  assert.equal(String(after.userId), String(first.userId), 'the linkage is preserved');
  assert.equal(after.designation, 'Officer');
});

// ---------------------------------------------------------------------------
// Importing an employee who has no login
// ---------------------------------------------------------------------------

test('a record with no email produces an employee and no account at all', async () => {
  const before = await User.countDocuments({});
  await employeePersistencePort.upsertEmployees([canonical({ email: null })]);

  const emp = await Employee.findOne({ employeeCode: 'SI0001' }).lean();
  assert.ok(emp, 'the employee record must still be created');
  assert.equal(emp.userId, null);
  assert.equal(await User.countDocuments({}), before, 'no account may be invented for them');
});

test('SI0008 and SI0017: one address, one account, two employees', async () => {
  // The shape the client confirmed, driven end to end through the pipeline's
  // port exactly as the import does it.
  const findings = new Findings();
  const { records } = await resolveSharedAccounts(
    [
      canonical({ employeeCode: 'SI0008', firstName: 'Anita', lastName: 'Rao', email: 'shared@example.net' }),
      canonical({ employeeCode: 'SI0017', firstName: 'Meera', lastName: 'Iyer', email: 'shared@example.net' }),
    ],
    findings,
  );

  const result = await employeePersistencePort.upsertEmployees(records);
  assert.equal(result.created, 2, 'both people are imported');

  const anita = await Employee.findOne({ employeeCode: 'SI0008' }).lean();
  const meera = await Employee.findOne({ employeeCode: 'SI0017' }).lean();

  assert.ok(anita.userId, 'SI0008 holds the account');
  assert.equal(meera.userId, null, 'SI0017 has no login');

  const accounts = await User.find({ email: 'shared@example.net' }).lean();
  assert.equal(accounts.length, 1, 'exactly one account for the address');
  assert.equal(String(anita.userId), String(accounts[0]._id));

  // One account, one employee - still true, and enforced by the database.
  assert.equal(await Employee.countDocuments({ userId: accounts[0]._id }), 1);
});

test('re-running that import changes nothing and mints nothing', async () => {
  const build = async () =>
    (
      await resolveSharedAccounts(
        [
          canonical({ employeeCode: 'SI0008', firstName: 'Anita', lastName: 'Rao', email: 'shared@example.net' }),
          canonical({ employeeCode: 'SI0017', firstName: 'Meera', lastName: 'Iyer', email: 'shared@example.net' }),
        ],
        new Findings(),
      )
    ).records;

  await employeePersistencePort.upsertEmployees(await build());
  const first = {
    anita: await Employee.findOne({ employeeCode: 'SI0008' }).lean(),
    meera: await Employee.findOne({ employeeCode: 'SI0017' }).lean(),
  };

  const again = await employeePersistencePort.upsertEmployees(await build());
  assert.equal(again.created, 0);
  assert.equal(again.updated, 2);

  assert.equal(await Employee.countDocuments({}), 2);
  assert.equal(await User.countDocuments({ email: 'shared@example.net' }), 1);

  const after = {
    anita: await Employee.findOne({ employeeCode: 'SI0008' }).lean(),
    meera: await Employee.findOne({ employeeCode: 'SI0017' }).lean(),
  };
  assert.equal(String(after.anita._id), String(first.anita._id));
  assert.equal(String(after.anita.userId), String(first.anita.userId), 'the linkage is preserved');
  assert.equal(after.meera.userId, null, 'and the one with no login still has none');
});

test('the pipeline still refuses two rows claiming the SAME address', async () => {
  const { errors } = await previewImport([
    canonical({ employeeCode: 'A1', email: 'one@example.net' }),
    canonical({ employeeCode: 'A2', email: 'one@example.net' }),
  ]);
  const dup = errors.find((e) => e.field === 'email');
  assert.ok(dup, 'one account resolves to exactly one employee');
  assert.match(dup.message, /Duplicate email/);
});

test('but several rows with NO address are not treated as duplicates of each other', async () => {
  // They would all collide on `undefined` without the guard, and only the first
  // would import.
  const preview = await previewImport([
    canonical({ employeeCode: 'A1', email: null }),
    canonical({ employeeCode: 'A2', email: null }),
    canonical({ employeeCode: 'A3', email: null }),
  ]);
  assert.deepEqual(
    preview.errors.filter((e) => e.field === 'email'),
    [],
  );
  assert.equal(preview.totals.toCreate, 3);
});
