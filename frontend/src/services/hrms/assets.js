import { hrmsClient } from "./client";

/**
 * Assets API.
 *
 * Mirrors the reference's `api/asset.ts`, with three differences worth knowing
 * at the call site:
 *
 *   1. THE INVENTORY AND THE REQUEST QUEUE ARE PAGED, FILTERED AND SEARCHED BY
 *      THE SERVER. The reference fetches every item and every request and pages
 *      the arrays in the browser, with no filter or search at all.
 *
 *   2. AN ASSIGNMENT CARRIES ITS ASSET — category, serial, brand, model. The
 *      reference's assignment DTO omits all four, which is why its My Assets
 *      table can say when something was issued but never what.
 *
 *   3. A RETURN IS ADDRESSED BY THE ITEM, not by an assignment id. There is one
 *      open issue per item, so the item is the thing the administrator has in
 *      front of them.
 */

export const assetsApi = {
  // -- Catalogue ------------------------------------------------------------
  categories: () => hrmsClient.get("/assets/categories"),
  createCategory: (dto) => hrmsClient.post("/assets/categories", dto),
  updateCategory: (id, dto) => hrmsClient.patch(`/assets/categories/${id}`, dto),
  /** Soft delete. Refused while any item or request still points at it. */
  removeCategory: (id) => hrmsClient.delete(`/assets/categories/${id}`),

  // -- Inventory ------------------------------------------------------------
  /** `{ data, total, page, pageSize }`. Administrators only. */
  items: (params = {}) => hrmsClient.get("/assets/items", params),
  /** One item plus its full issue history. */
  item: (id) => hrmsClient.get(`/assets/items/${id}`),
  createItem: (dto) => hrmsClient.post("/assets/items", dto),
  updateItem: (id, dto) => hrmsClient.patch(`/assets/items/${id}`, dto),
  setStatus: (id, status, note) =>
    hrmsClient.post(`/assets/items/${id}/status`, { status, note: note ?? null }),

  // -- Assignment -----------------------------------------------------------
  assign: (assetItemId, employeeId, conditionOnAssign) =>
    hrmsClient.post("/assets/items/assign", {
      assetItemId,
      employeeId,
      conditionOnAssign: conditionOnAssign ?? null,
    }),
  returnItem: (id, conditionOnReturn) =>
    hrmsClient.post(`/assets/items/${id}/return`, {
      conditionOnReturn: conditionOnReturn ?? null,
    }),

  /** `{ data, outstanding }` — what I hold and have held. */
  myAssignments: () => hrmsClient.get("/assets/assignments/me"),
  /**
   * The same, for one employee. Requires org scope. This is what an IT admin
   * opens when working the `it` clearance on an exit.
   */
  employeeAssignments: (employeeId) =>
    hrmsClient.get(`/assets/assignments/employee/${employeeId}`),

  // -- Requests -------------------------------------------------------------
  /** Scoped by the server: your own, or the whole queue if you administer. */
  requests: (params = {}) => hrmsClient.get("/assets/requests", params),
  createRequest: (dto) => hrmsClient.post("/assets/requests", dto),
  decideRequest: (id, decision, reason) =>
    hrmsClient.post(`/assets/requests/${id}/decide`, {
      decision,
      reason: reason ?? null,
    }),
  fulfillRequest: (id, assetItemId) =>
    hrmsClient.post(`/assets/requests/${id}/fulfill`, { assetItemId }),
  cancelRequest: (id) => hrmsClient.post(`/assets/requests/${id}/cancel`),
};

export const ASSET_STATUS_LABELS = {
  available: "Available",
  assigned: "Assigned",
  in_repair: "In repair",
  retired: "Retired",
  lost: "Lost",
};

/**
 * The statuses an administrator may set.
 *
 * `assigned` is absent: it is reached by assigning and left by returning. The
 * reference offers it in its status picker, which produces an item that reads
 * as issued to nobody.
 */
export const SETTABLE_ASSET_STATUSES = ["available", "in_repair", "retired", "lost"];

export const ASSET_REQUEST_STATUS_LABELS = {
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
};

export default { assetsApi, ASSET_STATUS_LABELS, SETTABLE_ASSET_STATUSES, ASSET_REQUEST_STATUS_LABELS };
