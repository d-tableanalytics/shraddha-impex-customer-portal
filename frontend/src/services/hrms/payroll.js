import { hrmsClient } from "./client";

/**
 * Payroll API.
 *
 * A thin wrapper over `hrmsClient`, which already unwraps the
 * `{ success, data }` envelope and normalises errors into `HrmsApiError` — so a
 * screen branches on `err.code`, never on a message.
 *
 * Money crosses this boundary as NUMBERS for display and as STRINGS on the way
 * in. That asymmetry is deliberate: the server stores Decimal128 and builds it
 * from a string, so a CTC typed into a form is sent as text and never becomes a
 * float in transit.
 */

export const payGroupsApi = {
  list: () => hrmsClient.get("/payroll/pay-groups"),
  create: (dto) => hrmsClient.post("/payroll/pay-groups", dto),
  update: (id, dto) => hrmsClient.patch(`/payroll/pay-groups/${id}`, dto),
  /** Soft delete. Refused server-side while anyone is still paid through it. */
  remove: (id) => hrmsClient.delete(`/payroll/pay-groups/${id}`),
};

export const salaryComponentsApi = {
  list: () => hrmsClient.get("/payroll/components"),
  create: (dto) => hrmsClient.post("/payroll/components", dto),
  update: (id, dto) => hrmsClient.patch(`/payroll/components/${id}`, dto),
  remove: (id) => hrmsClient.delete(`/payroll/components/${id}`),
};

export const salaryStructuresApi = {
  list: (params = {}) => hrmsClient.get("/payroll/structures", params),
  get: (id) => hrmsClient.get(`/payroll/structures/${id}`),
  create: (dto) => hrmsClient.post("/payroll/structures", dto),
  update: (id, dto) => hrmsClient.patch(`/payroll/structures/${id}`, dto),
  remove: (id) => hrmsClient.delete(`/payroll/structures/${id}`),
  /**
   * What a CTC yields under this structure.
   *
   * Runs the real engine server-side, so what the admin sees while designing a
   * structure is what payroll will actually produce.
   */
  preview: (id, dto) => hrmsClient.post(`/payroll/structures/${id}/preview`, dto),
};

export const statutoryApi = {
  list: () => hrmsClient.get("/payroll/statutory"),
  /** The version in force. `null` when nothing is configured — not an error. */
  effective: (on) => hrmsClient.get("/payroll/statutory/effective", on ? { on } : {}),
  create: (dto) => hrmsClient.post("/payroll/statutory", dto),
  update: (id, dto) => hrmsClient.patch(`/payroll/statutory/${id}`, dto),
  remove: (id) => hrmsClient.delete(`/payroll/statutory/${id}`),
};

export const compensationApi = {
  history: (employeeId, params = {}) =>
    hrmsClient.get(`/payroll/compensation/${employeeId}`, params),
  current: (employeeId) => hrmsClient.get(`/payroll/compensation/${employeeId}/current`),
  create: (dto) => hrmsClient.post("/payroll/compensation", dto),
  remove: (id) => hrmsClient.delete(`/payroll/compensation/entry/${id}`),
};

export const payrollRunsApi = {
  list: (params = {}) => hrmsClient.get("/payroll/runs", params),
  get: (id) => hrmsClient.get(`/payroll/runs/${id}`),
  create: (dto) => hrmsClient.post("/payroll/runs", dto),
  payslips: (id) => hrmsClient.get(`/payroll/runs/${id}/payslips`),

  /**
   * The four state transitions.
   *
   * Every one is re-checked server-side against the declared state machine, so
   * a button the UI shows in error is refused rather than obeyed.
   */
  compute: (id) => hrmsClient.post(`/payroll/runs/${id}/compute`, {}),
  lock: (id) => hrmsClient.post(`/payroll/runs/${id}/lock`, {}),
  disburse: (id) => hrmsClient.post(`/payroll/runs/${id}/disburse`, {}),
  rollback: (id) => hrmsClient.post(`/payroll/runs/${id}/rollback`, {}),

  listAdjustments: (id) => hrmsClient.get(`/payroll/runs/${id}/adjustments`),
  createAdjustment: (id, dto) => hrmsClient.post(`/payroll/runs/${id}/adjustments`, dto),
  deleteAdjustment: (id, adjustmentId) =>
    hrmsClient.delete(`/payroll/runs/${id}/adjustments/${adjustmentId}`),
};

export const payslipsApi = {
  /** The caller's own. No id is sent — the server takes it from the session. */
  mine: (params = {}) => hrmsClient.get("/payroll/payslips/mine", params),
  list: (params = {}) => hrmsClient.get("/payroll/payslips", params),
  get: (id) => hrmsClient.get(`/payroll/payslips/${id}`),
};

/**
 * Indian-format money, for display only.
 *
 * `en-IN` groups by lakh and crore (12,34,567.89), which is what a payslip in
 * this market is expected to look like. Two decimal places always, so a column
 * of figures aligns.
 */
export const formatMoney = (value) =>
  Number(value ?? 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const MONTH_NAMES = Object.freeze([
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]);

/** `Jun 2026`. */
export const formatPeriod = (month, year) => `${MONTH_NAMES[month] ?? month} ${year}`;

export default {
  payGroupsApi,
  salaryComponentsApi,
  salaryStructuresApi,
  statutoryApi,
  compensationApi,
  payrollRunsApi,
  payslipsApi,
  formatMoney,
  formatPeriod,
};
