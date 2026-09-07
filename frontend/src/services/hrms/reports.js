import { api } from "../api";
import { hrmsClient } from "./client";

/**
 * Reports API.
 *
 * Mirrors the reference's three endpoints — `catalog`, `:key/run`,
 * `:key/export.csv` — with three differences worth knowing at the call site:
 *
 *   1. `run` IS PAGED. The reference returns a bare `any[]` with no `take` and
 *      no cursor, and its screen then paginates 50 rows at a time in the
 *      browser having already received all of them. Here the response is
 *      `{ report, columns, data, total, page, pageSize }`.
 *
 *   2. FILTERS ARE REAL. The reference accepts `Record<string, string>` on all
 *      three endpoints and every generator ignores it — `?departmentId=x`
 *      returns the whole organisation and no error. Here each report declares
 *      its own params and an unknown one is a 400.
 *
 *   3. THE COLUMNS COME WITH THE ROWS. The reference's screen renders columns
 *      from the catalogue entry it happens to be holding, so a report opened
 *      by URL has no columns at all.
 */

export const reportsApi = {
  /** The reports this actor may run, already filtered by the server. */
  catalog: () => hrmsClient.get("/reports/catalog"),

  /** One page of one report. `params` are per-report; see `REPORT_FILTERS`. */
  run: (key, params = {}) => hrmsClient.get(`/reports/${key}/run`, params),

  /**
   * The whole report as CSV.
   *
   * Not on `hrmsClient`, which unwraps a JSON envelope this endpoint does not
   * send. It still goes through the shared axios instance, so the Bearer
   * header and the single-flight 401 refresh are unchanged.
   *
   * Returns the text and the filename the SERVER chose. The browser is never
   * told a filename derived from the URL — the reference interpolates its
   * `:key` parameter straight into `Content-Disposition`.
   */
  async exportCsv(key, params = {}) {
    const res = await api.request({
      method: "get",
      url: `/hrms/reports/${key}/export.csv`,
      params,
      responseType: "text",
    });

    // Every one of these headers can be UNREADABLE, and the download still has
    // to be right when they are. `VITE_API_URL` may point the API at its own
    // origin (it defaults to :5000 beside a Vite dev server), and the shared
    // `cors()` config sets no `exposedHeaders` — so cross-origin the browser
    // hands back only the six CORS-safelisted headers, and
    // `Content-Disposition` and `X-Report-*` are not among them. Same-origin
    // (AD-14, `/hrms/` on the app's own domain) they are all present.
    //
    // So each falls back to something derived from the body rather than to a
    // wrong number: a row count read off the CSV beats a confident "0 rows".
    const rowsHeader = header(res.headers, "x-report-rows");
    const totalHeader = header(res.headers, "x-report-total");
    const rows = rowsHeader === null ? countDataRows(res.data) : Number(rowsHeader);
    const total = totalHeader === null ? rows : Number(totalHeader);

    return {
      csv: res.data,
      filename: filenameFrom(res.headers) ?? `${key}.csv`,
      rows,
      total,
      // Absent means unknown, and unknown must not claim truncation.
      truncated: header(res.headers, "x-report-truncated") === "true",
    };
  },
};

/** Data rows in a CSV: every non-empty line after the header. */
function countDataRows(csv) {
  if (typeof csv !== "string" || csv.length === 0) return 0;
  return csv.split("\n").slice(1).filter((line) => line.trim() !== "").length;
}

/** Axios normalises header names, but a fetch-style Headers object may not. */
function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

/** `attachment; filename="employees_directory.csv"` → the filename. */
function filenameFrom(headers) {
  const disposition = header(headers, "content-disposition");
  const match = /filename="?([^";]+)"?/i.exec(disposition ?? "");
  // Basename only: a filename is never allowed to carry a path.
  return match ? match[1].split(/[\\/]/).pop() : null;
}

/**
 * Hand the CSV to the browser.
 *
 * A blob and a synthetic click, as the reference does — but the filename comes
 * from the server's own `Content-Disposition`, and the object URL is revoked
 * after the click rather than immediately, which is what makes the download
 * survive in Firefox.
 */
export function downloadCsv({ csv, filename }) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The filters each report accepts.
 *
 * Declared here so the screen renders the controls a report actually has
 * rather than one fixed toolbar. The reference has no filters at all, so it
 * has nothing equivalent — its "Monthly Attendance Summary" is hardwired to
 * the current month with no way to ask for another.
 */
export const REPORT_FILTERS = {
  employees_directory: ["status", "department", "search"],
  attendance_monthly: ["dateRange", "department"],
  leave_balances: ["year", "leaveType", "department"],
};

/** Statuses the directory filter offers, in the order the employee list uses. */
export const DIRECTORY_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "probation", label: "Probation" },
  { value: "notice", label: "Notice period" },
  { value: "invited", label: "Invited" },
  { value: "exited", label: "Exited" },
  { value: "suspended", label: "Suspended" },
  { value: "inactive", label: "Inactive" },
];

/** `2026-03` → `{ from: '2026-03-01', to: '2026-03-31' }`. */
export function monthRange(month) {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** The current month as `YYYY-MM`, in the browser's own zone. */
export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Render one cell.
 *
 * A `number` column is right-aligned and shown without trailing zeros — a
 * half-day count reads `2.5`, a whole one reads `2`.
 */
export function formatCell(value, type) {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "number") return String(value);
  return String(value);
}

/**
 * Turn the screen's filter state into the report's own query parameters.
 *
 * A month picker is one control; the server takes a closed `from`/`to` pair,
 * because a window with only a lower bound is what makes the reference's
 * "current month" report include every future-dated record forever.
 */
export function toQuery(reportKey, filters) {
  const query = {};

  if (reportKey === "employees_directory") {
    if (filters.status) query.status = filters.status;
    if (filters.departmentId) query.departmentId = filters.departmentId;
    if (filters.search) query.search = filters.search;
  }

  if (reportKey === "attendance_monthly") {
    const { from, to } = monthRange(filters.month ?? currentMonth());
    query.from = from;
    query.to = to;
    if (filters.departmentId) query.departmentId = filters.departmentId;
  }

  if (reportKey === "leave_balances") {
    if (filters.year) query.year = filters.year;
    if (filters.leaveTypeId) query.leaveTypeId = filters.leaveTypeId;
    if (filters.departmentId) query.departmentId = filters.departmentId;
  }

  return query;
}

export default { reportsApi, downloadCsv, REPORT_FILTERS };
