import { hrmsClient } from "./client";

/**
 * Leave and Holiday API.
 *
 * Mirrors the reference's `api/leave.ts` and `api/holidays.ts`. Holidays sit at
 * their own path but are governed by the LEAVE permission keys — there is no
 * separate holidays module, in the reference or here.
 */

export const leaveApi = {
  /** The types this actor may request; `adminOnly` ones are filtered server-side. */
  types: () => hrmsClient.get("/leave/types"),
  createType: (dto) => hrmsClient.post("/leave/types", dto),

  /** This year's buckets for the signed-in employee. */
  myBalances: (params = {}) => hrmsClient.get("/leave/balances/me", params),
  balancesFor: (employeeId, params = {}) =>
    hrmsClient.get(`/leave/balances/${employeeId}`, params),

  /**
   * Requests the actor may see. The SERVER decides the scope — self, own team,
   * or the whole organisation — so this never asks for more than it may have.
   */
  requests: (params = {}) => hrmsClient.get("/leave/requests", params),

  /** Always filed for the signed-in employee; no employeeId is sent. */
  create: (dto) => hrmsClient.post("/leave/requests", dto),

  decide: (id, decision, comment) =>
    hrmsClient.post(`/leave/requests/${id}/decide`, { decision, comment: comment ?? null }),

  cancel: (id) => hrmsClient.post(`/leave/requests/${id}/cancel`),

  /** `{ requests, holidays }` for the window. One call, both layers. */
  calendar: (from, to) => hrmsClient.get("/leave/calendar", { from, to }),
};

export const holidaysApi = {
  list: (year) => hrmsClient.get("/holidays", year ? { year } : {}),
  years: () => hrmsClient.get("/holidays/years"),
  create: (dto) => hrmsClient.post("/holidays", dto),
  update: (id, dto) => hrmsClient.patch(`/holidays/${id}`, dto),
  /** Soft delete. */
  remove: (id) => hrmsClient.delete(`/holidays/${id}`),
  bulkImport: (dto) => hrmsClient.post("/holidays/bulk-import", dto),
};

/** `2026-01-05` -> `5 Jan 2026`, without constructing a local-time Date. */
export const formatDay = (iso) => {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(iso.slice(8, 10))} ${months[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
};

/** `1 day` / `2.5 days`, so a half day never reads as "0.5 day". */
export const formatDays = (value) => `${value} ${Number(value) === 1 ? "day" : "days"}`;
