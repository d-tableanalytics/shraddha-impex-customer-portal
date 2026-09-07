import { hrmsClient } from "./client";

/**
 * Org Structure API — the department and location catalogues.
 *
 * Added here in the same commit as the screens that consume them, per the
 * convention in ./index.js: a service arrives with its module, not in advance.
 *
 * Employee Master uses the two `list` calls for its pickers and directory
 * filters. The write endpoints are exposed because the API has them, and the
 * Org Structure screens will call them; nothing in Employee Master does.
 */

export const departmentsApi = {
  /**
   * Live departments, ordered by name. Not paginated — the reference returns
   * the whole table and these are catalogues of tens of rows.
   *
   * `includeDeleted` exists only because we soft-delete; a caller resolving the
   * name of a retired department needs it. The pickers must NOT pass it: a
   * retired department is not a valid new assignment.
   */
  list: (params = {}) => hrmsClient.get("/org/departments", params),
  get: (id) => hrmsClient.get(`/org/departments/${id}`),
  create: (dto) => hrmsClient.post("/org/departments", dto),
  update: (id, dto) => hrmsClient.patch(`/org/departments/${id}`, dto),
  /** Soft delete. Refused server-side while live employees are assigned. */
  remove: (id) => hrmsClient.delete(`/org/departments/${id}`),
};

export const locationsApi = {
  list: (params = {}) => hrmsClient.get("/org/locations", params),
  get: (id) => hrmsClient.get(`/org/locations/${id}`),
  create: (dto) => hrmsClient.post("/org/locations", dto),
  update: (id, dto) => hrmsClient.patch(`/org/locations/${id}`, dto),
  remove: (id) => hrmsClient.delete(`/org/locations/${id}`),
};

/** The org chart, as a flat list; the caller assembles the tree. */
export const orgChartApi = {
  tree: () => hrmsClient.get("/org/tree"),
};

/**
 * `CODE · Name`, the label format the reference uses in both pickers
 * (`EmployeeFormFields.tsx:341`). The code is what people say out loud.
 */
export const orgOptionLabel = (row) => `${row.code} · ${row.name}`;

/**
 * Options for a picker, keeping a value that is no longer selectable.
 *
 * The catalogues list live rows only, so an employee assigned to a department
 * that has since been retired would render as "nothing selected" — and the next
 * save would look like a deliberate clearing of a field nobody touched. The
 * retired row is put back, labelled, so the value is visible and honest.
 *
 * @param {Array}  rows        live catalogue rows
 * @param {string} currentId   the value currently held by the record
 * @param {string} currentName its name, resolved by the server
 */
export function optionsWithCurrent(rows, currentId, currentName) {
  const options = (rows ?? []).map((row) => ({
    value: row.id,
    label: orgOptionLabel(row),
  }));

  if (!currentId || options.some((o) => o.value === currentId)) return options;

  return [
    { value: currentId, label: `${currentName ?? "Unknown"} (retired)` },
    ...options,
  ];
}
