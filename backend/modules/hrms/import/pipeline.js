/**
 * The employee import pipeline (AD-11).
 *
 *   validate -> sanitise -> check dependencies -> preview -> commit -> link -> verify
 *
 * Source-agnostic: it consumes CanonicalEmployeeRecord objects and never knows
 * where they came from.
 *
 * ---------------------------------------------------------------------------
 * Why the commit is THREE passes
 * ---------------------------------------------------------------------------
 * Manager references arrive as employeeCodes, and a manager can appear later in
 * the file than the person reporting to them. So:
 *
 *   pass 1  create/update every employee, manager left unset
 *   pass 2  resolve reportingManagerCode -> id, now that all rows exist
 *   pass 3  recompute managerChain from the resolved hierarchy
 *
 * managerChain is DERIVED in pass 3, never imported. Every `team`-scope
 * permission check reads it, so importing a stale one would silently break
 * authorization rather than fail loudly.
 *
 * ---------------------------------------------------------------------------
 * Sanitisation happens BEFORE the first write
 * ---------------------------------------------------------------------------
 * Not after. Writing the blob and deleting the key later leaves plaintext in
 * the oplog, on every replica, and in any backup taken in between - deleting
 * the field afterwards removes it from the current document and nothing else.
 */

import {
  canonicalEmployeeRecordSchema,
  FORBIDDEN_IMPORT_FIELDS,
} from './canonical.js';
import { getEmployeePersistence } from './adapter.js';
import { sanitiseCustomFields } from '../../../utils/hrms/crypto/index.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import { SENSITIVE_EMPLOYEE_FIELD_LIST } from '../../../shared/security/sensitive-fields.js';

/**
 * Stage 1 + 2: validate and sanitise each row.
 *
 * Sanitisation runs on the parsed record, in memory, before anything is
 * persisted or even assembled for persistence.
 *
 * @param {object[]} rawRecords
 * @returns {{ valid: object[], errors: Array, warnings: Array }}
 */
export function validateAndSanitise(rawRecords = []) {
  const valid = [];
  const errors = [];
  const warnings = [];

  rawRecords.forEach((raw, index) => {
    const row = index + 1;

    // Forbidden fields are reported with their reason, so "why can't I import
    // managerChain?" is answered at the point of failure.
    for (const [field, reason] of Object.entries(FORBIDDEN_IMPORT_FIELDS)) {
      if (raw && Object.prototype.hasOwnProperty.call(raw, field)) {
        errors.push({ row, employeeCode: raw.employeeCode ?? null, field, message: reason });
      }
    }
    if (errors.some((e) => e.row === row)) return;

    // Sanitise BEFORE parsing: a reserved key inside customFieldValues would
    // otherwise pass validation and be carried forward as plaintext.
    const { clean, extracted, warnings: sanitiseNotes } = sanitiseCustomFields(
      raw?.customFieldValues ?? {},
    );

    const candidate = { ...raw, customFieldValues: clean };
    for (const [field, value] of Object.entries(extracted)) {
      if (candidate[field] === undefined || candidate[field] === null || candidate[field] === '') {
        candidate[field] = value;
      } else {
        // The dedicated field wins; the blob copy is discarded, not merged.
        warnings.push({
          row,
          employeeCode: raw?.employeeCode ?? null,
          message: `${field} was supplied both directly and inside customFieldValues; the direct value was kept.`,
        });
      }
    }
    for (const note of sanitiseNotes) {
      warnings.push({ row, employeeCode: raw?.employeeCode ?? null, message: note });
    }

    const parsed = canonicalEmployeeRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of formatZodIssues(parsed.error)) {
        errors.push({
          row,
          employeeCode: raw?.employeeCode ?? null,
          field: issue.path,
          message: issue.message,
        });
      }
      return;
    }

    valid.push({ row, record: parsed.data });
  });

  return { valid, errors, warnings };
}

/**
 * Stage 3: dependency checking.
 *
 * AD-2 removed foreign keys, so nothing at the database level catches a
 * dangling departmentCode or an unresolvable manager. The pipeline has to.
 */
export async function checkDependencies(valid, { persistence = getEmployeePersistence() } = {}) {
  const errors = [];
  const records = valid.map((v) => v.record);

  // Duplicate natural keys. Upserts match on employeeCode, so two rows with the
  // same code would silently overwrite each other.
  const seen = new Map();
  for (const { row, record } of valid) {
    const prior = seen.get(record.employeeCode);
    if (prior) {
      errors.push({
        row,
        employeeCode: record.employeeCode,
        field: 'employeeCode',
        message: `Duplicate employeeCode; row ${prior} uses it too. It is the natural key, so the second row would overwrite the first.`,
      });
    } else {
      seen.set(record.employeeCode, row);
    }
  }

  // Duplicate emails - the login is unique.
  const emails = new Map();
  for (const { row, record } of valid) {
    const prior = emails.get(record.email);
    if (prior) {
      errors.push({
        row,
        employeeCode: record.employeeCode,
        field: 'email',
        message: `Duplicate email; row ${prior} uses it too.`,
      });
    } else {
      emails.set(record.email, row);
    }
  }

  // Every manager code must resolve - either to another row in this import, or
  // to an employee that already exists.
  const codesInFile = new Set(records.map((r) => r.employeeCode));
  const managerCodes = [
    ...new Set(records.map((r) => r.reportingManagerCode).filter(Boolean)),
  ];
  const unknownManagers = managerCodes.filter((c) => !codesInFile.has(c));

  let existingByCode = new Map();
  if (persistence && unknownManagers.length > 0) {
    existingByCode = await persistence.findByEmployeeCodes(unknownManagers);
  }

  for (const { row, record } of valid) {
    const code = record.reportingManagerCode;
    if (!code) continue;
    if (code === record.employeeCode) {
      errors.push({
        row,
        employeeCode: record.employeeCode,
        field: 'reportingManagerCode',
        message: 'An employee cannot report to themselves.',
      });
      continue;
    }
    if (!codesInFile.has(code) && !existingByCode.has(code)) {
      errors.push({
        row,
        employeeCode: record.employeeCode,
        field: 'reportingManagerCode',
        message: `Unknown manager "${code}". No FK constraint would catch this, so the reference must resolve here.`,
      });
    }
  }

  // A cycle would make managerChain infinite in pass 3.
  for (const cycle of findCycles(records)) {
    errors.push({
      row: null,
      employeeCode: cycle[0],
      field: 'reportingManagerCode',
      message: `Reporting cycle: ${cycle.join(' -> ')}. managerChain could not be derived.`,
    });
  }

  // Lookup codes, where a resolver is available.
  if (persistence) {
    const deptCodes = [...new Set(records.map((r) => r.departmentCode).filter(Boolean))];
    const locCodes = [...new Set(records.map((r) => r.locationCode).filter(Boolean))];

    const [depts, locs] = await Promise.all([
      deptCodes.length ? persistence.resolveDepartmentCodes(deptCodes) : new Map(),
      locCodes.length ? persistence.resolveLocationCodes(locCodes) : new Map(),
    ]);

    for (const { row, record } of valid) {
      if (record.departmentCode && !depts.has(record.departmentCode)) {
        errors.push({
          row,
          employeeCode: record.employeeCode,
          field: 'departmentCode',
          message: `Unknown department "${record.departmentCode}". Create it before importing.`,
        });
      }
      if (record.locationCode && !locs.has(record.locationCode)) {
        errors.push({
          row,
          employeeCode: record.employeeCode,
          field: 'locationCode',
          message: `Unknown location "${record.locationCode}". Create it before importing.`,
        });
      }
    }
  }

  return { errors, existingByCode };
}

/** Detect reporting cycles among the rows in this import. */
function findCycles(records) {
  const parent = new Map(
    records.filter((r) => r.reportingManagerCode).map((r) => [r.employeeCode, r.reportingManagerCode]),
  );
  const cycles = [];
  const state = new Map(); // code -> 'visiting' | 'done'

  for (const start of parent.keys()) {
    if (state.get(start) === 'done') continue;

    const path = [];
    let node = start;
    while (node && state.get(node) !== 'done') {
      if (state.get(node) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(node)), node]);
        break;
      }
      state.set(node, 'visiting');
      path.push(node);
      node = parent.get(node);
    }
    for (const n of path) state.set(n, 'done');
  }
  return cycles;
}

/**
 * Stage 4: preview. Runs everything except the writes.
 *
 * The report is what an operator approves before a commit touches anything.
 */
export async function previewImport(rawRecords, { persistence = getEmployeePersistence() } = {}) {
  const { valid, errors, warnings } = validateAndSanitise(rawRecords);
  const dependency = await checkDependencies(valid, { persistence });

  const allErrors = [...errors, ...dependency.errors];
  const failedRows = new Set(allErrors.map((e) => e.row).filter((r) => r !== null));
  const importable = valid.filter((v) => !failedRows.has(v.row));

  let existing = new Map();
  if (persistence && importable.length > 0) {
    existing = await persistence.findByEmployeeCodes(importable.map((v) => v.record.employeeCode));
  }

  const toCreate = importable.filter((v) => !existing.has(v.record.employeeCode));
  const toUpdate = importable.filter((v) => existing.has(v.record.employeeCode));

  return {
    totals: {
      received: rawRecords.length,
      valid: valid.length,
      importable: importable.length,
      toCreate: toCreate.length,
      toUpdate: toUpdate.length,
      errors: allErrors.length,
      warnings: warnings.length,
    },
    errors: allErrors,
    warnings,
    // Enough to review without echoing sensitive values back.
    sample: importable.slice(0, 20).map((v) => ({
      row: v.row,
      employeeCode: v.record.employeeCode,
      name: `${v.record.firstName} ${v.record.lastName}`,
      email: v.record.email,
      departmentCode: v.record.departmentCode ?? null,
      reportingManagerCode: v.record.reportingManagerCode ?? null,
      action: existing.has(v.record.employeeCode) ? 'update' : 'create',
      sensitiveFieldsSupplied: SENSITIVE_EMPLOYEE_FIELD_LIST.filter((f) => v.record[f]),
    })),
    canCommit: allErrors.length === 0 && importable.length > 0,
  };
}

/**
 * Stages 5-7: commit, link, verify.
 *
 * Refuses to run if the preview found any error - a partial migration is far
 * worse than none, because the second attempt has to reason about what the
 * first one already wrote.
 */
export async function commitImport(rawRecords, { persistence = getEmployeePersistence() } = {}) {
  if (!persistence) {
    throw new Error(
      'No employee persistence port is registered. The Employee collection arrives in Phase 1; ' +
        'the pipeline is deliberately written against an interface rather than a model that does not exist yet.',
    );
  }

  const preview = await previewImport(rawRecords, { persistence });
  if (!preview.canCommit) {
    return { committed: false, preview, reason: 'The preview reported errors. Nothing was written.' };
  }

  const { valid } = validateAndSanitise(rawRecords);
  const records = valid.map((v) => v.record);

  // Pass 1 - every employee, manager deliberately unset.
  const upserted = await persistence.upsertEmployees(
    records.map(({ reportingManagerCode, ...rest }) => {
      void reportingManagerCode;
      return rest;
    }),
  );

  // Pass 2 - resolve manager codes now that every row exists.
  const links = records
    .filter((r) => r.reportingManagerCode)
    .map((r) => ({ employeeCode: r.employeeCode, managerEmployeeCode: r.reportingManagerCode }));
  const linked = links.length > 0 ? await persistence.linkReportingManagers(links) : 0;

  // Pass 3 - derive managerChain. Never imported.
  const chainsRebuilt = await persistence.rebuildManagerChains();

  // Leave balances. A bulk insert bypasses the service that seeds them on
  // create, so every imported employee would otherwise show a zero balance.
  const balancesSeeded = await persistence.seedLeaveBalances(records.map((r) => r.employeeCode));

  return {
    committed: true,
    preview,
    result: {
      created: upserted.created,
      updated: upserted.updated,
      managersLinked: linked,
      managerChainsRebuilt: chainsRebuilt,
      leaveBalancesSeeded: balancesSeeded,
    },
  };
}

export default { validateAndSanitise, checkDependencies, previewImport, commitImport };
