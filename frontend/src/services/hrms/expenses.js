import { api } from "../api";
import { hrmsClient } from "./client";
// One `formatDay`, not two. It renders a `YYYY-MM-DD` without ever building a
// local-time Date, which is exactly what an expense date needs too.
import { formatDay } from "./leave";

/**
 * Expenses API.
 *
 * Mirrors the reference's `api/expense.ts`, minus the two areas that are not
 * built here (reimbursement batches, which depend on Payroll's run model, and
 * travel requests).
 *
 * Two differences from the reference worth knowing at the call site:
 *
 *   1. THE LIST IS SCOPED AND PAGED BY THE SERVER. The reference fetches every
 *      claim and filters in the browser — `claims.filter(c => c.employeeId ===
 *      me.employee.id)` — which means the payload contained everyone's claims
 *      whatever the viewer was allowed to see. Here the server decides, and the
 *      response is a page object, not a bare array.
 *
 *   2. A RECEIPT IS FETCHED AS A SHORT-LIVED URL, not linked to directly. The
 *      reference points an anchor at a streaming endpoint; ours mints a
 *      presigned URL per view so the object is never publicly addressable.
 */

export const expensesApi = {
  // -- Categories & policies ------------------------------------------------
  /** Live categories. `includeInactive` is for administrators only. */
  categories: (params = {}) => hrmsClient.get("/expenses/categories", params),
  category: (id) => hrmsClient.get(`/expenses/categories/${id}`),
  createCategory: (dto) => hrmsClient.post("/expenses/categories", dto),
  updateCategory: (id, dto) => hrmsClient.patch(`/expenses/categories/${id}`, dto),
  /** Soft delete. Refused while any claim still books to the category. */
  removeCategory: (id) => hrmsClient.delete(`/expenses/categories/${id}`),

  /** One policy per category; the endpoint is an upsert, as in the reference. */
  savePolicy: (dto) => hrmsClient.post("/expenses/policies", dto),

  // -- Claims ---------------------------------------------------------------
  /** `{ data, total, page, pageSize }` — scoped by the server. */
  claims: (params = {}) => hrmsClient.get("/expenses/claims", params),
  claim: (id) => hrmsClient.get(`/expenses/claims/${id}`),

  /** Always filed for the signed-in employee; no employeeId is sent. */
  create: (dto) => hrmsClient.post("/expenses/claims", dto),
  update: (id, dto) => hrmsClient.patch(`/expenses/claims/${id}`, dto),

  submit: (id) => hrmsClient.post(`/expenses/claims/${id}/submit`),
  decide: (id, decision, comment) =>
    hrmsClient.post(`/expenses/claims/${id}/decide`, {
      decision,
      comment: comment ?? null,
    }),
  reimburse: (id) => hrmsClient.post(`/expenses/claims/${id}/reimburse`),

  /** `{ url, expiresInSeconds }`. The URL expires; do not cache it. */
  receiptUrl: (claimId, lineItemId) =>
    hrmsClient.get(`/expenses/claims/${claimId}/lines/${lineItemId}/receipt`),
};

/**
 * Attach a receipt to a draft line item.
 *
 * Multipart, so it goes through `api` directly rather than `hrmsClient` — the
 * same shape as `uploadSelfie`. The server re-checks the type by reading the
 * file's leading bytes, so the `accept` attribute on the input is a
 * convenience, never the control.
 */
export async function uploadReceipt(claimId, lineItemId, file) {
  const form = new FormData();
  form.append("receipt", file, file.name ?? "receipt");

  const res = await api.request({
    method: "post",
    url: `/hrms/expenses/claims/${claimId}/lines/${lineItemId}/receipt`,
    data: form,
  });
  return res.data?.data ?? null;
}

/** The reference's six statuses, with the label each is shown as. */
export const CLAIM_STATUS_LABELS = {
  draft: "Draft",
  submitted: "Submitted",
  manager_approved: "Manager approved",
  finance_approved: "Finance approved",
  reimbursed: "Reimbursed",
  rejected: "Rejected",
};

/**
 * `"1234.50"` -> `"₹ 1,234.50"`.
 *
 * The amount arrives as a STRING and is grouped as one, never parsed to a
 * Number first: `Number("12345678901234.56")` has already lost the paise before
 * any formatter sees it.
 */
export function formatMoney(value) {
  if (value === null || value === undefined || value === "") return "—";

  const text = String(value);
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const paise = `${fraction}00`.slice(0, 2);

  // Indian grouping: the last three digits, then pairs.
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;

  return `₹ ${negative ? "-" : ""}${grouped}.${paise}`;
}

/**
 * An ISO instant -> `5 Jan 2026`.
 *
 * Used for `submittedAt` and `reimbursedAt`, which are timestamps rather than
 * calendar days. A line item's `date` is already a plain day and goes through
 * `formatDay` instead.
 */
export const formatInstant = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatDay(date.toISOString().slice(0, 10));
};

/** Today as `YYYY-MM-DD` in the viewer's own calendar, for a date input's max. */
export function todayIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default {
  expensesApi,
  uploadReceipt,
  formatMoney,
  formatInstant,
  todayIso,
  CLAIM_STATUS_LABELS,
};
