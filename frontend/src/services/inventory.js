import { api } from "./api";
import { productsApi } from "./products";

/**
 * Inventory Management System client (Module M1).
 *
 * Talks to /api/v1/inventory — the unified master, locations and configuration.
 * The legacy /products endpoints are untouched and still serve the customer
 * ordering flow.
 */
/**
 * Hand a downloaded blob to the browser (M9).
 *
 * The object URL is revoked on the next tick — not immediately, because Firefox
 * cancels a download whose URL is revoked before the click is processed.
 */
const saveBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** The server's filename, so a download is named the same as its export log. */
const filenameFrom = (response) => {
  const header = response.headers?.["content-disposition"] || "";
  const match = /filename="?([^"]+)"?/.exec(header);
  return match ? match[1] : null;
};

export const inventoryApi = {
  // ── Master ──────────────────────────────────────────────────────────────
  listItems: async ({
    search = "",
    brand = "",
    category = "",
    status = "",
    sort = "sku-asc",
    page = 1,
    limit = 25,
  } = {}) => {
    const params = new URLSearchParams({ sort, page: String(page), limit: String(limit) });
    if (search) params.set("search", search);
    if (brand) params.set("brand", brand);
    if (category) params.set("category", category);
    if (status) params.set("status", status);

    const response = await api.get(`/inventory/items?${params.toString()}`);
    const { data, pagination, totals } = response.data;
    return {
      items: data || [],
      total: pagination?.total ?? 0,
      pages: pagination?.pages ?? 1,
      catalogueTotal: totals?.catalogue ?? 0,
    };
  },

  getItem: async (skuCode) => {
    const response = await api.get(`/inventory/items/${encodeURIComponent(skuCode)}`);
    return response.data.data;
  },

  updatePlanning: async (skuCode, updates) => {
    const response = await api.patch(
      `/inventory/items/${encodeURIComponent(skuCode)}/planning`,
      updates,
    );
    return response.data.data;
  },

  /**
   * Apply one set of planning values to many SKUs (M1).
   *
   * Returns `blocked` and `skipped` alongside the counts — a bulk edit that
   * touches fewer rows than were selected has to say which ones it left alone
   * and why, or the caller is left comparing two numbers and guessing.
   */
  bulkUpdatePlanning: async (skuCodes, updates, onProgress) => {
    // The endpoint accepts 500 SKUs per call, deliberately — a single unbounded
    // write across the catalogue is not something to expose. Selecting a whole
    // filter can exceed that, so the work is split here and the results summed,
    // which keeps the server contract intact.
    const CHUNK = 500;
    const merged = { matched: 0, modified: 0, blocked: [], skipped: [] };

    for (let i = 0; i < skuCodes.length; i += CHUNK) {
      const slice = skuCodes.slice(i, i + CHUNK);
      const response = await api.patch("/inventory/items/planning/bulk", {
        skuCodes: slice,
        ...updates,
      });
      const d = response.data.data || {};
      merged.matched += d.matched || 0;
      merged.modified += d.modified || 0;
      if (d.blocked?.length) merged.blocked.push(...d.blocked);
      if (d.skipped?.length) merged.skipped.push(...d.skipped);
      onProgress?.(Math.min(i + CHUNK, skuCodes.length), skuCodes.length);
    }
    return merged;
  },

  /**
   * Current ledger position for the adjustment dialog. Called on open rather
   * than reusing the figure from the list row, because that row may have been
   * rendered minutes ago and a stale "before" silently becomes a wrong delta.
   */
  getAdjustmentPreview: async (skuCode, brand, locationCode) => {
    const response = await api.get(
      `/inventory/items/${encodeURIComponent(skuCode)}/adjust`,
      { params: { brand, ...(locationCode ? { locationCode } : {}) } },
    );
    return response.data.data;
  },

  /**
   * Post a stock adjustment.
   *
   * `mode: 'set'` means `quantity` is the figure stock should END at;
   * `mode: 'delta'` means it is the signed change to apply. Either way the
   * server posts the DIFFERENCE as an ADJUSTMENT movement — no balance is ever
   * overwritten, so the change stays auditable and reversible.
   */
  adjustStock: async (skuCode, { brand, locationCode, mode, quantity, reasonCode, note }) => {
    const response = await api.post(
      `/inventory/items/${encodeURIComponent(skuCode)}/adjust`,
      { brand, locationCode, mode, quantity, reasonCode, note },
    );
    return response.data;
  },

  /**
   * Every SKU code matching a filter — what select-all needs.
   *
   * The list pages at 200, so asking it for "everything matching" would be
   * dozens of round trips for a question the filter already answers once.
   */
  listItemCodes: async (filters = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) qs.append(k, v);
    const r = await api.get(`/inventory/items/codes?${qs.toString()}`);
    return { skuCodes: r.data.data || [], total: r.data.total || 0 };
  },

  getCategories: async () => {
    const response = await api.get("/inventory/categories");
    return response.data.data || [];
  },

  // ── Locations ───────────────────────────────────────────────────────────
  listLocations: async ({ includeInactive = false } = {}) => {
    const qs = includeInactive ? "?includeInactive=true" : "";
    const response = await api.get(`/inventory/locations${qs}`);
    return response.data.data || [];
  },

  createLocation: async (payload) => {
    const response = await api.post("/inventory/locations", payload);
    return response.data.data;
  },

  updateLocation: async (id, updates) => {
    const response = await api.patch(`/inventory/locations/${id}`, updates);
    return response.data.data;
  },

  setDefaultLocation: async (id) => {
    const response = await api.post(`/inventory/locations/${id}/default`);
    return response.data.data;
  },

  // ── Configuration ───────────────────────────────────────────────────────
  getConfig: async (scope = "global", scopeValue = null) => {
    const params = new URLSearchParams({ scope });
    if (scopeValue) params.set("scopeValue", scopeValue);
    const response = await api.get(`/inventory/config?${params.toString()}`);
    return response.data.data;
  },

  getConfigHistory: async (scope = "global", scopeValue = null) => {
    const params = new URLSearchParams({ scope });
    if (scopeValue) params.set("scopeValue", scopeValue);
    const response = await api.get(`/inventory/config/history?${params.toString()}`);
    return response.data.data || [];
  },

  updateConfig: async (payload) => {
    const response = await api.put("/inventory/config", payload);
    return response.data.data;
  },

  // ── Stock ledger (M2) ───────────────────────────────────────────────────
  // Read-only. Movements are posted server-side by workflow modules; there is
  // no client-facing write path to the ledger.
  searchLedger: async ({
    skuCode = "", brand = "", movementType = "", movementClass = "",
    reasonCode = "", locationCode = "", batchId = "", referenceId = "",
    userId = "", from = "", to = "", sort = "date-desc", page = 1, limit = 50,
  } = {}) => {
    const params = new URLSearchParams({ sort, page: String(page), limit: String(limit) });
    const optional = {
      skuCode, brand, movementType, movementClass, reasonCode,
      locationCode, batchId, referenceId, userId, from, to,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value) params.set(key, value);
    }

    const response = await api.get(`/inventory/ledger?${params.toString()}`);
    const { data, pagination } = response.data;
    return {
      movements: data || [],
      total: pagination?.total ?? 0,
      pages: pagination?.pages ?? 1,
    };
  },

  getMovement: async (transactionId) => {
    const response = await api.get(`/inventory/ledger/${encodeURIComponent(transactionId)}`);
    return response.data.data;
  },

  getSkuMovements: async (skuCode, { page = 1, limit = 50 } = {}) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    const response = await api.get(
      `/inventory/items/${encodeURIComponent(skuCode)}/movements?${params.toString()}`,
    );
    const { data, pagination } = response.data;
    return { movements: data || [], total: pagination?.total ?? 0, pages: pagination?.pages ?? 1 };
  },

  getBatch: async (identifier) => {
    const response = await api.get(`/inventory/batches/${encodeURIComponent(identifier)}`);
    return response.data.data;
  },

  getMovementTypes: async () => {
    const response = await api.get("/inventory/ledger/movement-types");
    return response.data.data || [];
  },

  // ── Stock health (M4) ───────────────────────────────────────────────────
  // Reads the health projection. All classification happens server-side — the
  // client never computes a band, a target or a percentage.
  listHealth: async ({
    skuCode = "", brand = "", band = "", plannable = "",
    sort = "sku-asc", page = 1, limit = 25,
  } = {}) => {
    const params = new URLSearchParams({ sort, page: String(page), limit: String(limit) });
    for (const [k, v] of Object.entries({ skuCode, brand, band, plannable })) {
      if (v !== "" && v !== null && v !== undefined) params.set(k, String(v));
    }
    const response = await api.get(`/inventory/health?${params.toString()}`);
    const { data, pagination, bandCounts } = response.data;
    return {
      items: data || [],
      total: pagination?.total ?? 0,
      pages: pagination?.pages ?? 1,
      bandCounts: bandCounts || {},
    };
  },

  getHealth: async (skuCode) => {
    const response = await api.get(`/inventory/health/${encodeURIComponent(skuCode)}`);
    return response.data.data;
  },

  getReorderList: async ({ brand = "", page = 1, limit = 50 } = {}) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (brand) params.set("brand", brand);
    const response = await api.get(`/inventory/health/reorder/list?${params.toString()}`);
    return { items: response.data.data || [], total: response.data.pagination?.total ?? 0 };
  },

  getOverstockList: async ({ brand = "", page = 1, limit = 50 } = {}) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (brand) params.set("brand", brand);
    const response = await api.get(`/inventory/health/overstock/list?${params.toString()}`);
    return { items: response.data.data || [], total: response.data.pagination?.total ?? 0 };
  },

  getCoverage: async ({ maxDays, brand = "", page = 1, limit = 50 } = {}) => {
    const params = new URLSearchParams({ maxDays: String(maxDays), page: String(page), limit: String(limit) });
    if (brand) params.set("brand", brand);
    const response = await api.get(`/inventory/health/coverage/lookup?${params.toString()}`);
    return { items: response.data.data || [], total: response.data.pagination?.total ?? 0 };
  },

  rebuildHealth: async ({ skuCode = null, brand = null, apply = false } = {}) => {
    const response = await api.post("/inventory/health/rebuild", { skuCode, brand, apply });
    return response.data.data;
  },

  // ── Dashboard (M5) ──────────────────────────────────────────────────────
  // One composed, server-cached payload. The client renders it and computes
  // nothing — every figure arrives already derived by M3/M4.
  getDashboard: async ({
    brand = "", category = "", locationCode = "", from = "", to = "", refresh = false,
  } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ brand, category, locationCode, from, to })) {
      if (v) params.set(k, v);
    }
    if (refresh) params.set("refresh", "true");
    const qs = params.toString();
    const response = await api.get(`/inventory/dashboard${qs ? `?${qs}` : ""}`);
    return { ...response.data.data, cached: response.data.cached };
  },

  // ── Reports & snapshots (M6) ────────────────────────────────────────────
  // Read-only. Every figure arrives aggregated from the projections; the
  // client renders and computes nothing.
  getReport: async (reportKey, params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== "" && v !== null && v !== undefined) qs.set(k, String(v));
    }
    const q = qs.toString();
    const response = await api.get(`/inventory/reports/${reportKey}${q ? `?${q}` : ""}`);
    return response.data.data;
  },

  listSnapshots: async ({ status = "", page = 1, limit = 50 } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) qs.set("status", status);
    const response = await api.get(`/inventory/reports/snapshots?${qs.toString()}`);
    return { items: response.data.data || [], total: response.data.pagination?.total ?? 0 };
  },

  createSnapshot: async ({ snapshotDate = null, brand = null, frequency = "adhoc", rebuild = false } = {}) => {
    const response = await api.post("/inventory/reports/snapshots", {
      snapshotDate, brand, frequency, rebuild,
    });
    return response.data.data;
  },

  validateSnapshot: async (runId) => {
    const response = await api.get(`/inventory/reports/snapshots/${encodeURIComponent(runId)}/validate`);
    return response.data.data;
  },

  compareSnapshots: async ({ from, to, brand = "", changedOnly = true, limit = 500 } = {}) => {
    const qs = new URLSearchParams({ from, to, changedOnly: String(changedOnly), limit: String(limit) });
    if (brand) qs.set("brand", brand);
    const response = await api.get(`/inventory/reports/snapshot-comparison?${qs.toString()}`);
    return response.data.data;
  },

  // ── Stock verification (M7) ─────────────────────────────────────────────
  listCounts: async ({ status = "", brand = "", page = 1, limit = 25 } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) qs.set("status", status);
    if (brand) qs.set("brand", brand);
    const r = await api.get(`/inventory/counts?${qs.toString()}`);
    return {
      items: r.data.data || [], total: r.data.pagination?.total ?? 0,
      statusCounts: r.data.statusCounts || {},
    };
  },

  getCount: async (countId, { varianceOnly = false, page = 1, limit = 200 } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (varianceOnly) qs.set("varianceOnly", "true");
    const r = await api.get(`/inventory/counts/${encodeURIComponent(countId)}?${qs.toString()}`);
    return { ...r.data.data, pagination: r.data.pagination };
  },

  createCount: async (payload) => (await api.post("/inventory/counts", payload)).data.data,
  startCount: async (id) => (await api.post(`/inventory/counts/${encodeURIComponent(id)}/start`)).data.data,
  saveCountLines: async (id, lines) =>
    (await api.put(`/inventory/counts/${encodeURIComponent(id)}/lines`, { lines })).data.data,
  submitCount: async (id, allowUncounted = false) =>
    (await api.post(`/inventory/counts/${encodeURIComponent(id)}/submit`, { allowUncounted })).data.data,
  reviewCount: async (id, decision, reason = null) =>
    (await api.post(`/inventory/counts/${encodeURIComponent(id)}/review`, { decision, reason })).data.data,
  postCount: async (id) => (await api.post(`/inventory/counts/${encodeURIComponent(id)}/post`)).data.data,
  cancelCount: async (id, reason) =>
    (await api.post(`/inventory/counts/${encodeURIComponent(id)}/cancel`, { reason })).data.data,

  getVariances: async (id) =>
    (await api.get(`/inventory/counts/${encodeURIComponent(id)}/variances?limit=500`)).data,

  listAdjustments: async ({ countId = "", limit = 25 } = {}) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (countId) qs.set("countId", countId);
    return (await api.get(`/inventory/counts/adjustments?${qs.toString()}`)).data.data || [];
  },

  listOversold: async (status = "Open") =>
    (await api.get(`/inventory/counts/oversold?status=${status}`)).data.data || [],

  resolveOversold: async (id, resolution, note = null) =>
    (await api.post(`/inventory/counts/oversold/${encodeURIComponent(id)}/resolve`, { resolution, note })).data.data,

  // ── Alerts & notifications (M8) ─────────────────────────────────────────
  // Read plus three lifecycle actions. There is deliberately no createAlert —
  // alerts are raised by the server in response to projection events, never
  // asserted by a client.
  listAlerts: async ({
    status = "", severity = "", category = "", alertType = "", brand = "",
    skuCode = "", activeOnly = true, page = 1, limit = 25,
  } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) qs.set("status", status);
    if (severity) qs.set("severity", severity);
    if (category) qs.set("category", category);
    if (alertType) qs.set("alertType", alertType);
    if (brand) qs.set("brand", brand);
    if (skuCode) qs.set("skuCode", skuCode);
    if (!activeOnly) qs.set("activeOnly", "false");
    const r = await api.get(`/inventory/alerts?${qs.toString()}`);
    return {
      items: r.data.data || [],
      total: r.data.pagination?.total ?? 0,
      pages: r.data.pagination?.pages ?? 1,
      counts: r.data.counts || { byStatus: {}, bySeverity: {}, byCategory: {} },
    };
  },

  getAlert: async (alertId) =>
    (await api.get(`/inventory/alerts/${encodeURIComponent(alertId)}`)).data.data,

  acknowledgeAlert: async (alertId) =>
    (await api.post(`/inventory/alerts/${encodeURIComponent(alertId)}/acknowledge`)).data.data,

  resolveAlert: async (alertId, note) =>
    (await api.post(`/inventory/alerts/${encodeURIComponent(alertId)}/resolve`, { note })).data.data,

  closeAlert: async (alertId, note = null) =>
    (await api.post(`/inventory/alerts/${encodeURIComponent(alertId)}/close`, { note })).data.data,

  getAlertStatistics: async () =>
    (await api.get("/inventory/alerts/statistics")).data.data,

  listAlertTypes: async () => (await api.get("/inventory/alerts/types")).data,

  listAlertRules: async () => {
    const r = await api.get("/inventory/alerts/rules");
    return { rules: r.data.data || [], categories: r.data.categories || [], severities: r.data.severities || [] };
  },

  updateAlertRule: async (alertType, patch) =>
    (await api.put(`/inventory/alerts/rules/${encodeURIComponent(alertType)}`, patch)).data.data,

  listAlertNotifications: async ({ limit = 20, unreadOnly = false } = {}) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (unreadOnly) qs.set("unreadOnly", "true");
    const r = await api.get(`/inventory/alerts/notifications?${qs.toString()}`);
    return { items: r.data.data || [], unread: r.data.unread ?? 0 };
  },

  markAlertNotificationsRead: async (ids = null) =>
    (await api.post("/inventory/alerts/notifications/read", ids ? { ids } : {})).data,

  // ── Import (M9) ─────────────────────────────────────────────────────────
  listImportTypes: async () => (await api.get("/inventory/imports/types")).data.data || [],

  // Templates and exports are files, so they bypass the JSON client and are
  // fetched as blobs. The auth header still comes from the shared instance.
  downloadImportTemplate: async (importType) => {
    const r = await api.get(`/inventory/imports/templates/${encodeURIComponent(importType)}`, {
      responseType: "blob",
    });
    saveBlob(r.data, `${importType}-template.xlsx`);
  },

  uploadImport: async ({ file, importType, brand = "", locationCode = "", force = false }, onProgress) => {
    const form = new FormData();
    form.append("file", file);
    form.append("importType", importType);
    if (brand) form.append("brand", brand);
    if (locationCode) form.append("locationCode", locationCode);
    if (force) form.append("force", "true");

    const r = await api.post("/inventory/imports", form, {
      // Content-Type is not set here on purpose — axios derives
      // multipart/form-data with the right boundary from the FormData body.
      // The instance-level JSON default that would otherwise win is stripped by
      // the request interceptor in ./api.
      onUploadProgress: onProgress
        ? (e) => onProgress(e.total ? Math.round((e.loaded / e.total) * 100) : 0)
        : undefined,
    });
    return r.data.data;
  },

  getImport: async (jobId) => (await api.get(`/inventory/imports/${encodeURIComponent(jobId)}`)).data.data,

  previewImport: async (jobId, { page = 1, limit = 50, invalidOnly = false } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (invalidOnly) qs.set("invalidOnly", "true");
    const r = await api.get(`/inventory/imports/${encodeURIComponent(jobId)}/preview?${qs.toString()}`);
    return { job: r.data.job, columns: r.data.columns, rows: r.data.rows, pagination: r.data.pagination };
  },

  importErrors: async (jobId, { page = 1, limit = 100, category = "" } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (category) qs.set("category", category);
    const r = await api.get(`/inventory/imports/${encodeURIComponent(jobId)}/errors?${qs.toString()}`);
    return { errors: r.data.errors, byCategory: r.data.byCategory, pagination: r.data.pagination };
  },

  confirmImport: async (jobId) =>
    (await api.post(`/inventory/imports/${encodeURIComponent(jobId)}/confirm`)).data.data,
  resumeImport: async (jobId) =>
    (await api.post(`/inventory/imports/${encodeURIComponent(jobId)}/resume`)).data.data,
  cancelImport: async (jobId, reason = null) =>
    (await api.post(`/inventory/imports/${encodeURIComponent(jobId)}/cancel`, { reason })).data.data,

  listImports: async ({ importType = "", status = "", page = 1, limit = 25 } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (importType) qs.set("importType", importType);
    if (status) qs.set("status", status);
    const r = await api.get(`/inventory/imports?${qs.toString()}`);
    return {
      items: r.data.data || [],
      total: r.data.pagination?.total ?? 0,
      pages: r.data.pagination?.pages ?? 1,
      statusCounts: r.data.statusCounts || {},
    };
  },

  // ── Export (M9) ─────────────────────────────────────────────────────────
  listExportTypes: async () => {
    const r = await api.get("/inventory/exports/types");
    return { types: r.data.data || [], formats: r.data.formats || ["xlsx", "csv"] };
  },

  listSnapshotRunsForExport: async () =>
    (await api.get("/inventory/exports/snapshot-runs")).data.data || [],

  runExport: async (exportType, { format = "xlsx", ...filters } = {}) => {
    const qs = new URLSearchParams({ format });
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, String(v));
    const r = await api.get(`/inventory/exports/${encodeURIComponent(exportType)}?${qs.toString()}`, {
      responseType: "blob",
    });
    saveBlob(r.data, filenameFrom(r) || `${exportType}.${format}`);
  },

  listExportHistory: async ({ exportType = "", page = 1, limit = 25 } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (exportType) qs.set("exportType", exportType);
    const r = await api.get(`/inventory/exports/history?${qs.toString()}`);
    return { items: r.data.data || [], total: r.data.pagination?.total ?? 0, pages: r.data.pagination?.pages ?? 1 };
  },

  // ── Legacy helper ───────────────────────────────────────────────────────
  // Retained so existing callers keep working. Reads through the ordering-side
  // product endpoint, not the IMS master.
  checkStock: async (productCode) => {
    const product = await productsApi.getByCode(productCode);
    return product ? product.availableStock : 0;
  },
};

export default inventoryApi;
