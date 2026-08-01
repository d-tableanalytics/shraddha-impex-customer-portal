import { create } from "zustand";
import { inventoryApi } from "../services/inventory";

/**
 * Import / export state (IMS Module M9).
 *
 * Mirrors the server's pipeline exactly — upload, preview, confirm, watch —
 * and holds no rules of its own. Validation happened on the server against the
 * template registry; this store only shows what came back.
 */

const POLL_MS = 1500;

export const useImportStore = create((set, get) => ({
  // ── Catalogue ───────────────────────────────────────────────────────────
  types: [],
  typesLoaded: false,

  fetchTypes: async () => {
    if (get().typesLoaded) return;
    try {
      set({ types: await inventoryApi.listImportTypes(), typesLoaded: true });
    } catch (err) {
      set({ error: err.response?.data?.message || "Failed to load import types" });
    }
  },

  // ── Wizard ──────────────────────────────────────────────────────────────
  // step: 1 choose · 2 uploading · 3 preview · 4 processing · 5 summary
  step: 1,
  importType: "",
  file: null,
  uploadPercent: 0,
  uploading: false,
  job: null,
  preview: { columns: [], rows: [], pagination: null },
  errors: { errors: [], byCategory: {}, pagination: null },
  showInvalidOnly: false,
  error: null,

  setImportType: (importType) => set({ importType }),
  setFile: (file) => set({ file }),
  clearError: () => set({ error: null }),

  reset: () => {
    const timer = get().pollTimer;
    if (timer) clearInterval(timer);
    set({
      step: 1, importType: "", file: null, uploadPercent: 0, uploading: false,
      job: null, preview: { columns: [], rows: [], pagination: null },
      errors: { errors: [], byCategory: {}, pagination: null },
      showInvalidOnly: false, error: null, pollTimer: null,
    });
  },

  upload: async ({ brand = "", locationCode = "", force = false } = {}) => {
    const { file, importType } = get();
    if (!file || !importType) {
      set({ error: "Choose an import type and a file first." });
      return { ok: false };
    }

    set({ uploading: true, uploadPercent: 0, error: null, step: 2 });
    try {
      const job = await inventoryApi.uploadImport(
        { file, importType, brand, locationCode, force },
        (percent) => set({ uploadPercent: percent }),
      );
      set({ job, uploading: false, step: 3 });
      await get().loadPreview();
      await get().loadErrors();
      return { ok: true, job };
    } catch (err) {
      const message = err.response?.data?.message || "The upload failed";
      // A duplicate file is offered back as a decision rather than an error —
      // re-importing is legitimate, it just has to be deliberate.
      const duplicate = err.response?.data?.code === "DUPLICATE_FILE";
      set({ uploading: false, error: message, step: 1, duplicateWarning: duplicate ? message : null });
      return { ok: false, message, duplicate };
    }
  },

  duplicateWarning: null,
  dismissDuplicate: () => set({ duplicateWarning: null }),

  loadPreview: async (page = 1) => {
    const job = get().job;
    if (!job) return;
    try {
      const data = await inventoryApi.previewImport(job.jobId, {
        page, limit: 50, invalidOnly: get().showInvalidOnly,
      });
      set({ preview: { columns: data.columns, rows: data.rows, pagination: data.pagination } });
    } catch (err) {
      set({ error: err.response?.data?.message || "Failed to load the preview" });
    }
  },

  toggleInvalidOnly: async () => {
    set((s) => ({ showInvalidOnly: !s.showInvalidOnly }));
    await get().loadPreview(1);
  },

  loadErrors: async (page = 1) => {
    const job = get().job;
    if (!job) return;
    try {
      set({ errors: await inventoryApi.importErrors(job.jobId, { page, limit: 100 }) });
    } catch {
      // The error report is secondary; the job's own summary still shows.
    }
  },

  // ── Confirm and watch ───────────────────────────────────────────────────
  confirming: false,
  pollTimer: null,

  confirm: async () => {
    const job = get().job;
    if (!job) return { ok: false };

    set({ confirming: true, error: null });
    try {
      const started = await inventoryApi.confirmImport(job.jobId);
      set({ job: started, confirming: false, step: 4 });
      get().startPolling();
      return { ok: true };
    } catch (err) {
      const message = err.response?.data?.message || "The import could not be confirmed";
      set({ confirming: false, error: message });
      return { ok: false, message };
    }
  },

  /**
   * Watch a running import.
   *
   * Processing is detached on the server — a 40,000-row file takes minutes —
   * so progress is polled rather than awaited. The timer is cleared the moment
   * the job leaves Processing, and again on reset, so a user who navigates away
   * mid-import does not leave it running.
   */
  startPolling: () => {
    const existing = get().pollTimer;
    if (existing) clearInterval(existing);

    const timer = setInterval(async () => {
      const job = get().job;
      if (!job) return;
      try {
        const fresh = await inventoryApi.getImport(job.jobId);
        set({ job: fresh });
        if (fresh.status !== "Processing") {
          clearInterval(get().pollTimer);
          set({ pollTimer: null, step: 5 });
          await get().loadErrors();
        }
      } catch {
        // A dropped poll is not fatal — the next one recovers.
      }
    }, POLL_MS);

    set({ pollTimer: timer });
  },

  stopPolling: () => {
    const timer = get().pollTimer;
    if (timer) clearInterval(timer);
    set({ pollTimer: null });
  },

  cancel: async (reason = null) => {
    const job = get().job;
    if (!job) return { ok: false };
    try {
      await inventoryApi.cancelImport(job.jobId, reason);
      get().reset();
      await get().fetchHistory();
      return { ok: true };
    } catch (err) {
      const message = err.response?.data?.message || "The import could not be cancelled";
      set({ error: message });
      return { ok: false, message };
    }
  },

  resume: async (jobId) => {
    try {
      await inventoryApi.resumeImport(jobId);
      const job = await inventoryApi.getImport(jobId);
      set({ job, step: 4 });
      get().startPolling();
      return { ok: true };
    } catch (err) {
      const message = err.response?.data?.message || "The import could not be resumed";
      set({ error: message });
      return { ok: false, message };
    }
  },

  // ── History ─────────────────────────────────────────────────────────────
  history: [],
  historyTotal: 0,
  historyPages: 1,
  historyLoading: true,
  historyFilters: { importType: "", status: "", page: 1, limit: 25 },

  setHistoryFilters: (patch) => {
    const resetsPage = Object.keys(patch).some((k) => k !== "page");
    set((s) => ({ historyFilters: { ...s.historyFilters, ...patch, ...(resetsPage ? { page: 1 } : {}) } }));
    get().fetchHistory();
  },

  fetchHistory: async () => {
    set({ historyLoading: true });
    try {
      const { items, total, pages } = await inventoryApi.listImports(get().historyFilters);
      set({ history: items, historyTotal: total, historyPages: pages, historyLoading: false });
    } catch (err) {
      set({ historyLoading: false, error: err.response?.data?.message || "Failed to load import history" });
    }
  },

  openJob: async (jobId) => {
    try {
      const job = await inventoryApi.getImport(jobId);
      set({ job, step: job.status === "Validated" ? 3 : 5, importType: job.importType });
      if (job.status === "Validated") await get().loadPreview();
      await get().loadErrors();
      if (job.status === "Processing") { set({ step: 4 }); get().startPolling(); }
    } catch (err) {
      set({ error: err.response?.data?.message || "Failed to open the import" });
    }
  },

  downloadTemplate: async (importType) => {
    try {
      await inventoryApi.downloadImportTemplate(importType);
      return { ok: true };
    } catch (err) {
      const message = err.response?.data?.message || "The template could not be downloaded";
      set({ error: message });
      return { ok: false, message };
    }
  },
}));

/**
 * Export state (IMS Module M9).
 *
 * Exports stream straight to the browser, so there is no job to track — the
 * only asynchronous thing here is the download itself.
 */
export const useExportStore = create((set, get) => ({
  types: [],
  formats: ["xlsx", "csv"],
  snapshotRuns: [],
  loaded: false,
  downloading: null,
  error: null,

  history: [],
  historyTotal: 0,
  historyLoading: false,

  fetchTypes: async () => {
    if (get().loaded) return;
    try {
      const { types, formats } = await inventoryApi.listExportTypes();
      const runs = await inventoryApi.listSnapshotRunsForExport().catch(() => []);
      set({ types, formats, snapshotRuns: runs, loaded: true });
    } catch (err) {
      set({ error: err.response?.data?.message || "Failed to load export types" });
    }
  },

  download: async (exportType, options) => {
    set({ downloading: exportType, error: null });
    try {
      await inventoryApi.runExport(exportType, options);
      set({ downloading: null });
      await get().fetchHistory();
      return { ok: true };
    } catch (err) {
      // A failed export arrives as a blob, not JSON, because the response was
      // set up to stream a file. Read it back to get the message.
      let message = "The export failed";
      try {
        const text = err.response?.data instanceof Blob ? await err.response.data.text() : null;
        message = text ? (JSON.parse(text).message ?? message) : (err.response?.data?.message ?? message);
      } catch {
        message = err.response?.data?.message || message;
      }
      set({ downloading: null, error: message });
      return { ok: false, message };
    }
  },

  fetchHistory: async () => {
    set({ historyLoading: true });
    try {
      const { items, total } = await inventoryApi.listExportHistory({ limit: 25 });
      set({ history: items, historyTotal: total, historyLoading: false });
    } catch {
      set({ historyLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));

export default useImportStore;
