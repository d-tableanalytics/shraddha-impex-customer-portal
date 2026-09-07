/**
 * Reports — catalogue, run, export.
 *
 * The reference's `ReportsService`, ported. Its three public methods and their
 * permission model are kept exactly:
 *
 *   catalog(actor)                filter the registry by each report's own
 *                                 `moduleRequired` + `scopeRequired`
 *   run(key, actor, params)       404 unknown key, 403 no grant, then generate
 *   exportCsv(key, actor, params) the same two checks, then CSV
 *
 * Re-checking in `run` and `exportCsv` rather than trusting the catalogue is the
 * reference's own design and it is correct — it is what stops a recruiter, who
 * holds `reports:hiring:view:org` and so passes the route gate, from guessing
 * `employees_directory` and reading the whole company.
 *
 * The changes are in the generation, not the gating:
 *
 *   - results are paged (the reference returns `any[]`, unbounded);
 *   - params are validated against each report's own schema (the reference
 *     accepts `Record<string,string>` and ignores it);
 *   - the CSV guards against formula injection (the reference quotes for
 *     RFC 4180 and nothing else);
 *   - the export is capped;
 *   - both actions are audited (the reference records nothing at all, so a
 *     full-directory export leaves no trace).
 */

import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import { HRMS_ACTIONS as A } from '../../../shared/permissions/constants.js';
import { HrmsNotFoundError, HrmsForbiddenError, HrmsValidationError } from '../hrms.errors.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import { recordAudit } from '../../../utils/auditLog.js';
import {
  REPORT_EXPORT_MAX_ROWS,
  EXPORT_STRIPPED_KEYS,
} from '../../../shared/schemas/report.js';
import { createDefaultRegistry } from './report.registry.js';

/** The process-wide registry, seeded with the reference's three built-ins. */
const registry = createDefaultRegistry();

export { registry };

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/**
 * May this actor read this report?
 *
 * Note what is checked: the report's DATA module at the report's own scope —
 * `employees:view:org`, not `reports:view:org`. Holding a `reports*` grant gets
 * you through the route; it does not get you a report whose underlying module
 * you cannot read org-wide.
 */
const canReadReport = (actor, definition) =>
  hasHrmsPermission(actor, definition.moduleRequired, A.VIEW, definition.scopeRequired);

/**
 * Look a report up, or refuse.
 *
 * 404 for an unknown key and 403 for a known one the actor cannot read, which
 * is the reference's own pair. The distinction is safe here because the key
 * space is three fixed strings published in the catalogue — a 404 confirms only
 * that a report the caller could already name does not exist.
 */
function loadReadable(key, actor) {
  const definition = registry.get(key);
  if (!definition) throw new HrmsNotFoundError(`Report "${key}"`);
  if (!canReadReport(actor, definition)) {
    throw new HrmsForbiddenError(`Cannot run report "${key}".`);
  }
  return definition;
}

/**
 * Validate the query against THIS report's schema.
 *
 * The reference declares `params: Record<string, string>` and every generator
 * ignores it, so `?departmentId=<other department>` returns the whole
 * organisation and looks to the caller like a filter that matched everything.
 */
function parseParams(definition, raw, { strip = [] } = {}) {
  const input = { ...(raw ?? {}) };
  for (const key of strip) delete input[key];

  const parsed = definition.paramsSchema.safeParse(input);
  if (!parsed.success) {
    throw new HrmsValidationError(
      `Invalid parameters for report "${definition.key}".`,
      formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
}

/** Strip the generator and the schema — neither is serialisable, nor public. */
const publicShape = ({ key, label, description, category, columns, moduleRequired, scopeRequired }) => ({
  key,
  label,
  description,
  category,
  columns,
  moduleRequired,
  scopeRequired,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The reports this actor may run.
 *
 * Filtered, never annotated: a report the actor cannot read is absent, not
 * present-and-disabled. The reference does the same, and it is the right call —
 * the catalogue would otherwise enumerate which modules exist and who is
 * allowed to read them.
 */
export function catalog(actor) {
  return registry
    .all()
    .filter((definition) => canReadReport(actor, definition))
    .map(publicShape);
}

/**
 * Run one report, one page.
 *
 * @returns `{ report, columns, data, total, page, pageSize }`
 */
export async function run(key, actor, rawParams = {}, req = null, options = {}) {
  const definition = loadReadable(key, actor);
  const params = parseParams(definition, rawParams);

  const { page, pageSize } = params;
  const { rows, total } = await definition.run(
    actor,
    params,
    { skip: (page - 1) * pageSize, limit: pageSize },
    options,
  );

  await recordAudit(
    { _id: actor?.userId ?? null },
    AUDIT_ACTIONS.REPORT_RUN,
    `Ran report "${key}".`,
    req,
    // The filters and the row COUNT, never the rows. An audit trail that
    // copies the report into itself is a second, unguarded copy of the data.
    { meta: { reportKey: key, filters: auditableFilters(params), rows: rows.length, total } },
  );

  return {
    report: publicShape(definition),
    columns: definition.columns,
    data: rows,
    total,
    page,
    pageSize,
  };
}

/**
 * Export one report as CSV.
 *
 * Paging is stripped rather than honoured — an export is the whole result set
 * by definition, and accepting `pageSize` here would only invite
 * `?pageSize=1000000`. `REPORT_EXPORT_MAX_ROWS` is the real bound.
 */
export async function exportCsv(key, actor, rawParams = {}, req = null, options = {}) {
  const definition = loadReadable(key, actor);
  const params = parseParams(definition, rawParams, { strip: EXPORT_STRIPPED_KEYS });

  const { rows, total } = await definition.run(
    actor,
    { ...params, page: 1, pageSize: REPORT_EXPORT_MAX_ROWS },
    { skip: 0, limit: REPORT_EXPORT_MAX_ROWS },
    options,
  );

  const truncated = total > rows.length;

  await recordAudit(
    { _id: actor?.userId ?? null },
    AUDIT_ACTIONS.REPORT_EXPORTED,
    `Exported report "${key}" (${rows.length} rows).`,
    req,
    { meta: { reportKey: key, filters: auditableFilters(params), rows: rows.length, total, truncated } },
  );

  return {
    csv: toCsv(definition.columns, rows),
    filename: `${definition.key}.csv`,
    rows: rows.length,
    total,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * `-` is in the list because `-2+3+cmd|' /c calc'!A0` is a formula, even though
 * a leading minus also begins a perfectly ordinary negative number.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV cell.
 *
 * Two separate jobs, and the reference does only the first:
 *
 *   1. RFC 4180 quoting — double the quotes, wrap when the value contains a
 *      delimiter. `\r` is added to the reference's `[,\n"]` trigger class: a
 *      lone carriage return breaks a row just as a newline does.
 *
 *   2. Formula neutralisation — prefix a leading `= + - @ TAB CR` with an
 *      apostrophe. Every column in every report is user-supplied text: an
 *      employee whose designation is `=cmd|'/c calc'!A1` becomes a live formula
 *      in Excel for whoever opens the export. The reference has no guard, and
 *      its export is the whole employee directory.
 *
 * The apostrophe goes INSIDE the quotes so the quoting still describes the
 * cell's real content.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';

  let s = String(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;

  const escaped = s.replace(/"/g, '""');
  return /[,\n\r"]/.test(escaped) ? `"${escaped}"` : escaped;
}

/** Header row from the column labels, then one line per row. */
export function toCsv(columns, rows) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------

/** The filters, without the paging noise, for the audit meta. */
function auditableFilters(params) {
  const { page: _p, pageSize: _s, sortDir: _d, ...filters } = params;
  return filters;
}

export default { catalog, run, exportCsv, csvCell, toCsv, registry };
