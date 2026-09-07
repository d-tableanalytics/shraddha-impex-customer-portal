/**
 * The Shraddha Impex client workbook adapter (AD-11).
 *
 *   [ Employee master data .xlsx ] -> THIS -> CanonicalEmployeeRecord[] -> pipeline
 *
 * AD-11 deferred the migration source and built everything to the right of this
 * boundary first. This is that adapter: a pure mapping with no database access
 * and no side effects, so the whole of it is testable against fixtures and the
 * dry run can call it without a connection.
 *
 * The workbook carries six domains, not one flat employee table:
 *
 *   Users           portal email, department, shift timings
 *   Master          the employee record proper, including sensitive fields
 *   Assets          asset assignments, one or more per row
 *   Holiday Master  the holiday calendar
 *   Salary          an INSTRUCTION, not a table
 *
 * ---------------------------------------------------------------------------
 * Dates are read as SERIALS, never as Date objects
 * ---------------------------------------------------------------------------
 * `xlsx` with `cellDates: true` builds a Date at LOCAL midnight. Read back with
 * `toISOString()` from any zone east of UTC that lands on the previous day —
 * in Asia/Calcutta (+05:30) every single date in this workbook came back one
 * day early. Republic Day arrived as 25 January, and the workbook's own
 * weekday column said Monday, which 26 January 2026 is and the 25th is not.
 *
 * So the workbook is opened with `cellDates: false` and the raw Excel serial is
 * converted on the UTC epoch. No timezone is consulted at any point. The
 * Holiday model documents the same hazard from the other side.
 *
 * ---------------------------------------------------------------------------
 * Sensitive fields
 * ---------------------------------------------------------------------------
 * Bank account, IFSC, PAN and the Aadhaar last-4 are carried on the canonical
 * record and encrypted by the persistence port (AD-10). Nothing here logs them,
 * and `describeSensitive` exists so the dry run can report PRESENCE and shape
 * without ever holding a value it might print.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const xlsx = require('xlsx');

// ---------------------------------------------------------------------------
// Sheet names, exactly as the client sends them
// ---------------------------------------------------------------------------

export const SHEETS = Object.freeze({
  USERS: 'Users',
  MASTER: 'Master',
  ASSETS: 'Assets',
  HOLIDAYS: 'Holiday Master',
  SALARY: 'Salary',
});

/**
 * Column positions, not names.
 *
 * `Holiday Master` has TWO columns headed `Holiday_Name`, so a name-keyed read
 * silently drops one of them — and the second is not a name at all, it is the
 * weekday. Reading by position is what makes that visible.
 */
const COL = Object.freeze({
  users: { code: 0, name: 1, email: 2, designation: 3, department: 4, mobile: 5, shift: 6, half1: 7, half2: 8, altShift: 9 },
  master: {
    code: 0, fullName: 1, fatherName: 2, dob: 3, gender: 4, mobile: 5, personalEmail: 6,
    designation: 7, reportingManager: 8, doj: 9, employmentType: 10, workLocation: 11,
    bankAccount: 12, bankBranch: 13, ifsc: 14, pan: 15, aadhaarLast4: 16, hrAssignedTo: 17,
  },
  assets: { code: 0, name: 1, designation: 2, assets: 3 },
  holidays: { id: 0, date: 1, name: 2, weekday: 3, type: 4, applicableTo: 5 },
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** The natural key. Trimmed and upper-cased, so `si0001` and `SI0001 ` are one. */
export const normaliseCode = (v) => text(v).toUpperCase();

export const normaliseEmail = (v) => text(v).toLowerCase();

/**
 * A phone number that survived Excel.
 *
 * The mobile column is stored as a NUMBER, so `String()` on a large value can
 * produce exponent notation. Ten Indian digits are well inside 2^53 so no
 * precision is lost, but the formatting has to be forced back to digits.
 */
export function normalisePhone(v) {
  if (v === null || v === undefined || v === '') return null;
  const digits =
    typeof v === 'number'
      ? // `toFixed(0)` rather than `String()`: the latter yields `9.1e+9`.
        Math.trunc(v).toFixed(0)
      : text(v).replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/**
 * A bank account number, with Excel's formatting marker removed.
 *
 * The client prefixes these with a backtick so Excel keeps them as text rather
 * than rounding a 15-digit number into scientific notation. The marker is
 * formatting; the digits are the account. Only the LEADING marker is stripped —
 * anything else is left alone so a genuinely odd value is reported rather than
 * quietly rewritten.
 */
export function normaliseBankAccount(v) {
  const s = text(v).replace(/^[`']/, '').replace(/[\s-]/g, '');
  return s.length > 0 ? s : null;
}

/**
 * The last four digits of an Aadhaar, with leading zeros restored.
 *
 * Excel stores this column as a NUMBER, so `0036` is read back as `36` and the
 * two leading zeros are gone before this code ever sees the cell. Padding to
 * four is not cosmetic — it is the only way the stored value matches the card.
 */
export function normaliseAadhaarLast4(v) {
  if (v === null || v === undefined || v === '') return null;
  const digits = typeof v === 'number' ? Math.trunc(v).toFixed(0) : text(v).replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length > 4) return digits.slice(-4);
  return digits.padStart(4, '0');
}

export const normalisePan = (v) => (text(v).toUpperCase() || null);
export const normaliseIfsc = (v) => (text(v).toUpperCase().replace(/\s/g, '') || null);

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Excel's epoch. Day 1 is 1900-01-01, and its phantom 1900 leap day is why. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/** A whole-day Excel serial to `YYYY-MM-DD`, on the UTC line. */
export function serialToIsoDay(serial) {
  const ms = EXCEL_EPOCH_UTC + Math.round(Number(serial)) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Any of the three shapes this workbook uses, to `YYYY-MM-DD`.
 *
 * `Date_of_Joining` is a mixture: ten rows are real Excel dates and seven are
 * `DD/MM/YYYY` text. `Date_of_Birth` is text throughout. Both are handled, and
 * an ambiguous `03/05/2026` is read DAY-first because that is what the column
 * unambiguously is — several rows carry a day above twelve, which settles it.
 *
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function parseWorkbookDay(v) {
  if (v === null || v === undefined || text(v) === '') {
    return { ok: false, reason: 'empty' };
  }

  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v < 1 || v > 100_000) return { ok: false, reason: `serial ${v} out of range` };
    return { ok: true, value: serialToIsoDay(v) };
  }

  // A Date can still arrive if a caller opened the workbook with cellDates.
  // Read its UTC parts — never the local ones, which is the whole bug.
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return { ok: true, value: v.toISOString().slice(0, 10) };
  }

  const s = text(v);
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
  if (dmy) {
    const [, d, m, y] = dmy;
    const day = Number(d);
    const month = Number(m);
    if (month < 1 || month > 12) return { ok: false, reason: `month ${month} out of range` };
    if (day < 1 || day > 31) return { ok: false, reason: `day ${day} out of range` };
    const iso = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // Round-trip so 31/02/2026 is refused rather than rolling into March.
    const back = new Date(`${iso}T00:00:00.000Z`);
    if (Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso) {
      return { ok: false, reason: `${s} is not a real calendar date` };
    }
    return { ok: true, value: iso };
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return { ok: true, value: s };

  return { ok: false, reason: `unrecognised date format "${s}"` };
}

/** The weekday a `YYYY-MM-DD` falls on, computed on the UTC line. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayOf = (isoDay) => WEEKDAYS[new Date(`${isoDay}T00:00:00.000Z`).getUTCDay()];

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/** A department or location name to the stable CODE the resolvers key on. */
export function toRefCode(name) {
  return text(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
}

/** `Full Time` to the model's enum. Nothing is invented for an unknown value. */
export function mapEmploymentType(v) {
  const key = text(v).toLowerCase().replace(/[\s_-]+/g, '');
  const known = {
    fulltime: 'full_time',
    parttime: 'part_time',
    contract: 'contract',
    intern: 'intern',
    internship: 'intern',
    consultant: 'consultant',
  };
  return known[key] ?? null;
}

/**
 * `GH` / `RH` to the Holiday model's own enum.
 *
 * The client's two codes are General Holiday and Restricted Holiday. A
 * restricted holiday is offered rather than automatic, which is exactly what
 * the model's `isOptional` means, so it is set alongside the type.
 */
export function mapHolidayType(v) {
  const key = text(v).toUpperCase();
  if (key === 'GH') return { type: 'public', isOptional: false };
  if (key === 'RH') return { type: 'restricted', isOptional: true };
  return null;
}

/**
 * Split one `Assets assigned` cell into individual physical assets.
 *
 * `Computer / Phone` is two machines, not one asset with a slash in its name.
 * The Assets model holds one row per physical item, so the cell is split on the
 * separators the client actually uses.
 */
export function splitAssets(cell) {
  return text(cell)
    .split(/\s*[/,+]\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A person's full name to first and last, keeping middle names on the first. */
export function splitName(full) {
  const parts = text(full).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/** Shape, never value. What the dry run is allowed to say about a secret. */
export const describeSensitive = (v) => (v === null || v === undefined || v === '' ? 'absent' : 'present');

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Rows of one sheet, by position, with trailing blank rows dropped.
 *
 * `cellDates: false` is the important half: dates arrive as serials and no
 * timezone is ever consulted. See the header.
 */
export function readSheet(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  const rows = xlsx.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    blankrows: false,
    raw: true,
  });
  return rows
    .slice(1)
    .filter((r) => Array.isArray(r) && r.some((c) => c !== null && String(c).trim() !== ''));
}

export function openWorkbook(filePath) {
  return xlsx.readFile(filePath, { cellDates: false, raw: true });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Parse the whole workbook into per-domain shapes.
 *
 * Every row keeps its 1-based spreadsheet row number so a validation message
 * can point the client at the line to fix, rather than at an array index.
 */
export function parseWorkbook(filePath) {
  const wb = openWorkbook(filePath);

  const usersRows = readSheet(wb, SHEETS.USERS);
  const masterRows = readSheet(wb, SHEETS.MASTER);
  const assetRows = readSheet(wb, SHEETS.ASSETS);
  const holidayRows = readSheet(wb, SHEETS.HOLIDAYS);

  const U = COL.users;
  const users = usersRows.map((r, i) => ({
    row: i + 2,
    employeeCode: normaliseCode(r[U.code]),
    name: text(r[U.name]),
    email: normaliseEmail(r[U.email]),
    designation: text(r[U.designation]) || null,
    department: text(r[U.department]) || null,
    phone: normalisePhone(r[U.mobile]),
    shift: text(r[U.shift]) || null,
    firstHalf: text(r[U.half1]) || null,
    secondHalf: text(r[U.half2]) || null,
    alternateShift: text(r[U.altShift]) || null,
  }));

  const M = COL.master;
  const master = masterRows.map((r, i) => ({
    row: i + 2,
    employeeCode: normaliseCode(r[M.code]),
    fullName: text(r[M.fullName]),
    fatherName: text(r[M.fatherName]) || null,
    dobRaw: r[M.dob],
    gender: text(r[M.gender]) || null,
    phone: normalisePhone(r[M.mobile]),
    personalEmail: normaliseEmail(r[M.personalEmail]) || null,
    designation: text(r[M.designation]) || null,
    reportingManager: text(r[M.reportingManager]) || null,
    dojRaw: r[M.doj],
    employmentTypeRaw: text(r[M.employmentType]) || null,
    workLocation: text(r[M.workLocation]) || null,
    bankAccount: normaliseBankAccount(r[M.bankAccount]),
    bankBranch: text(r[M.bankBranch]) || null,
    ifsc: normaliseIfsc(r[M.ifsc]),
    pan: normalisePan(r[M.pan]),
    aadhaarLast4: normaliseAadhaarLast4(r[M.aadhaarLast4]),
    hrAssignedTo: normaliseEmail(r[M.hrAssignedTo]) || null,
  }));

  const A = COL.assets;
  const assets = assetRows.map((r, i) => ({
    row: i + 2,
    employeeCode: normaliseCode(r[A.code]),
    employeeName: text(r[A.name]),
    designation: text(r[A.designation]) || null,
    raw: text(r[A.assets]),
    items: splitAssets(r[A.assets]),
  }));

  const H = COL.holidays;
  const holidays = holidayRows.map((r, i) => {
    const parsed = parseWorkbookDay(r[H.date]);
    return {
      row: i + 2,
      sourceId: text(r[H.id]) || null,
      date: parsed.ok ? parsed.value : null,
      dateError: parsed.ok ? null : parsed.reason,
      name: text(r[H.name]),
      // The SECOND `Holiday_Name` column. It is the weekday, and it is kept as
      // an independent cross-check on the date rather than imported.
      claimedWeekday: text(r[H.weekday]) || null,
      typeRaw: text(r[H.type]) || null,
      applicableTo: text(r[H.applicableTo]) || null,
    };
  });

  return { users, master, assets, holidays, sheetNames: wb.SheetNames };
}

/**
 * Master and Users merged into CanonicalEmployeeRecords.
 *
 * MASTER IS CANONICAL for the employee record. Users contributes only what
 * Master does not carry: the portal email and the department. Where both hold a
 * field, Master wins and the difference is reported as a conflict rather than
 * being resolved silently — `conflicts` is returned alongside the records so
 * the dry run can show them.
 */
export function toCanonicalEmployees({ users, master }) {
  const usersByCode = new Map(users.map((u) => [u.employeeCode, u]));
  const conflicts = [];
  const issues = [];
  const records = [];

  for (const m of master) {
    const u = usersByCode.get(m.employeeCode) ?? null;
    const { firstName, lastName } = splitName(m.fullName);

    const dob = parseWorkbookDay(m.dobRaw);
    const doj = parseWorkbookDay(m.dojRaw);

    if (!doj.ok) {
      issues.push({
        level: 'ERROR',
        row: m.row,
        employeeCode: m.employeeCode,
        field: 'Date_of_Joining',
        message: `Date of joining could not be read (${doj.reason}).`,
      });
    }
    if (!dob.ok && dob.reason !== 'empty') {
      issues.push({
        level: 'WARNING',
        row: m.row,
        employeeCode: m.employeeCode,
        field: 'Date_of_Birth',
        message: `Date of birth could not be read (${dob.reason}); it will be left unset.`,
      });
    }

    // Compare the overlapping columns. Master wins; the difference is surfaced.
    if (u) {
      const pairs = [
        ['name', m.fullName, u.name],
        ['designation', m.designation, u.designation],
        ['phone', m.phone, u.phone],
      ];
      for (const [field, canonical, other] of pairs) {
        const a = text(canonical).toLowerCase();
        const b = text(other).toLowerCase();
        if (a && b && a !== b) {
          conflicts.push({
            employeeCode: m.employeeCode,
            field,
            resolution: 'Master is canonical',
            // Names and phone numbers are personal data; only the FACT of a
            // difference travels into a report that may be shared.
            detail: field === 'designation' ? { master: canonical, users: other } : { differs: true },
          });
        }
      }
    } else {
      issues.push({
        level: 'WARNING',
        row: m.row,
        employeeCode: m.employeeCode,
        field: 'Users',
        message: 'No matching row on the Users sheet, so no department or portal email.',
      });
    }

    const employmentType = mapEmploymentType(m.employmentTypeRaw);
    if (m.employmentTypeRaw && !employmentType) {
      issues.push({
        level: 'ERROR',
        row: m.row,
        employeeCode: m.employeeCode,
        field: 'Employment_Type',
        message: `"${m.employmentTypeRaw}" is not one of the employment types this system defines.`,
      });
    }

    // The portal login. Users.Email is the work address; Master's column is
    // headed Personal_Email but on this workbook holds a company address too,
    // so it is NOT stored as a personal email — that would misfile it.
    const workEmail = u?.email || m.personalEmail || null;
    if (u && m.personalEmail && u.email !== m.personalEmail) {
      conflicts.push({
        employeeCode: m.employeeCode,
        field: 'email',
        resolution: 'Users.Email is used as the portal login',
        detail: { differs: true },
      });
    }
    if (!workEmail) {
      issues.push({
        level: 'ERROR',
        row: m.row,
        employeeCode: m.employeeCode,
        field: 'Email',
        message: 'No email on either sheet; an employee needs one to sign in.',
      });
    }

    records.push({
      employeeCode: m.employeeCode,
      firstName,
      lastName,
      email: workEmail ?? '',
      // Deliberately null: every address in this workbook is a company one.
      personalEmail: null,
      phone: m.phone,
      dateOfBirth: dob.ok ? dob.value : null,
      dateOfJoining: doj.ok ? doj.value : null,
      employmentType: employmentType ?? 'full_time',
      designation: m.designation,
      // These people are current staff being migrated, not pending invitations.
      status: 'active',
      departmentCode: u?.department ? toRefCode(u.department) : null,
      locationCode: m.workLocation ? toRefCode(m.workLocation) : null,
      // Empty for every row in this workbook, and never inferred.
      reportingManagerCode: m.reportingManager || null,
      fatherName: m.fatherName,
      // AD-10. Encrypted by the persistence port; never logged.
      panNumber: m.pan,
      bankAccountNumber: m.bankAccount,
      bankIfsc: m.ifsc,
      aadhaarNumber: m.aadhaarLast4,
    });
  }

  return { records, conflicts, issues };
}

/**
 * The AD-11 adapter contract: raw rows in canonical SHAPE.
 *
 * Validation is the pipeline's job, so this stays a pure mapping and its
 * failures surface as row errors rather than exceptions.
 */
export const shraddhaWorkbookAdapter = {
  description: 'Shraddha Impex client employee master workbook (.xlsx)',
  async load(filePath) {
    const parsed = parseWorkbook(filePath);
    const { records } = toCanonicalEmployees(parsed);
    // The pipeline rejects unknown keys, and a null optional is the same as an
    // absent one to it — so nulls are dropped rather than sent.
    return records.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)));
  },
};

export default {
  SHEETS,
  parseWorkbook,
  toCanonicalEmployees,
  shraddhaWorkbookAdapter,
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
};
