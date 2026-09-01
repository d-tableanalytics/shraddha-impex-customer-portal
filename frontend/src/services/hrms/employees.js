import { hrmsClient } from "./client";

/**
 * Employee Master API.
 *
 * Mirrors the reference's `api/employees.ts`. Query params are dropped when
 * empty so a cleared filter disappears from the URL rather than being sent as
 * an empty string the server would then try to match on.
 */

const clean = (params = {}) =>
  Object.fromEntries(
    Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== null && String(v).length > 0,
    ),
  );

export const employeesApi = {
  /** Server-paginated (AD-13). Returns `{ data, total, page, pageSize }`. */
  list: (params = {}) => hrmsClient.get("/employees", clean(params)),

  get: (id) => hrmsClient.get(`/employees/${id}`),

  /** Returns `{ employee, tempPassword }` — the password is shown once. */
  create: (dto) => hrmsClient.post("/employees", dto),

  update: (id, dto) => hrmsClient.patch(`/employees/${id}`, dto),

  /** Soft delete: the record is kept, the login is suspended. */
  deactivate: (id) => hrmsClient.delete(`/employees/${id}`),

  /**
   * Reveal ONE sensitive value in full.
   *
   * Separate from the read on purpose: the profile shows presence only, and
   * seeing an actual PAN or bank account is an audited act requiring
   * compensation access.
   */
  reveal: (id, field, reason) =>
    hrmsClient.post(`/employees/${id}/reveal`, { field, reason }),

  getRoles: (id) => hrmsClient.get(`/employees/${id}/roles`),
  assignRoles: (id, roleKeys) => hrmsClient.patch(`/employees/${id}/roles`, { roleKeys }),

  /** Super admin only. Returns a one-time password. */
  resetPassword: (id) => hrmsClient.post(`/employees/${id}/reset-password`),
};

/** Admin-defined extra employee fields. */
export const employeeCustomFieldsApi = {
  list: () => hrmsClient.get("/employees/custom-fields"),
  create: (dto) => hrmsClient.post("/employees/custom-fields", dto),
  update: (id, dto) => hrmsClient.patch(`/employees/custom-fields/${id}`, dto),
  remove: (id) => hrmsClient.delete(`/employees/custom-fields/${id}`),
};
