import { create } from "zustand";
import { inventoryApi } from "../services/inventory";

/**
 * Stock count state (IMS Module M7).
 *
 * Counted quantities are held locally while the counter works through a sheet,
 * then saved in one call — a warehouse floor is exactly where a per-keystroke
 * request is worst. The variance shown beside each row is recomputed locally
 * for immediate feedback ONLY; the authoritative difference is the one the
 * server stores against the frozen expected quantity.
 */
export const useCountStore = create((set, get) => ({
  // ── Session list ────────────────────────────────────────────────────────
  counts: [],
  statusCounts: {},
  total: 0,
  loading: true,
  error: null,
  filters: { status: "", brand: "", page: 1, limit: 25 },

  setFilters: (patch) => {
    const resetsPage = Object.keys(patch).some((k) => k !== "page");
    set((s) => ({ filters: { ...s.filters, ...patch, ...(resetsPage ? { page: 1 } : {}) } }));
    get().fetchCounts();
  },

  fetchCounts: async () => {
    set({ loading: true, error: null });
    try {
      const { items, total, statusCounts } = await inventoryApi.listCounts(get().filters);
      set({ counts: items, total, statusCounts, loading: false });
    } catch (err) {
      set({ loading: false, error: err.response?.data?.message || "Failed to load count sessions" });
    }
  },

  // ── Open session ────────────────────────────────────────────────────────
  session: null,
  lines: [],
  sessionLoading: false,
  // Unsaved counted quantities, keyed by SKU.
  drafts: {},
  saving: false,

  openSession: async (countId) => {
    set({ sessionLoading: true, session: null, lines: [], drafts: {} });
    try {
      const data = await inventoryApi.getCount(countId);
      if (!get().sessionLoading) return; // dismissed while loading
      set({ session: data.count, lines: data.lines, sessionLoading: false });
    } catch (err) {
      set({ sessionLoading: false, error: err.response?.data?.message || "Failed to load the session" });
    }
  },

  closeSession: () => set({ session: null, lines: [], drafts: {}, sessionLoading: false }),

  setDraft: (skuCode, value) =>
    set((s) => ({ drafts: { ...s.drafts, [skuCode]: value } })),

  clearDrafts: () => set({ drafts: {} }),

  /** Persist every entered quantity in one request. */
  saveDrafts: async () => {
    const { session, drafts } = get();
    const lines = Object.entries(drafts)
      .filter(([, v]) => v !== "" && v !== null && v !== undefined)
      .map(([skuCode, v]) => {
        const row = get().lines.find((l) => l.skuCode === skuCode);
        const counted = Number(v);
        // A reason is only required when the figures differ; the server is the
        // authority on that, this just avoids a guaranteed round-trip failure.
        const needsReason = row && counted !== row.expectedQuantity;
        return {
          skuCode,
          countedQuantity: counted,
          reasonCode: needsReason ? (get().reasonFor[skuCode] || null) : null,
          note: get().noteFor[skuCode] || null,
        };
      });

    if (lines.length === 0) return { success: true, saved: 0 };

    set({ saving: true });
    try {
      const res = await inventoryApi.saveCountLines(session.countId, lines);
      await get().openSession(session.countId);
      set({ saving: false, drafts: {} });
      return { success: true, saved: res.updated };
    } catch (err) {
      set({ saving: false });
      return { success: false, error: err.response?.data?.message || "Could not save the counts." };
    }
  },

  // Reason and note held alongside the draft quantity.
  reasonFor: {},
  noteFor: {},
  setReason: (skuCode, code) => set((s) => ({ reasonFor: { ...s.reasonFor, [skuCode]: code } })),
  setNote: (skuCode, note) => set((s) => ({ noteFor: { ...s.noteFor, [skuCode]: note } })),

  // ── Workflow actions ────────────────────────────────────────────────────
  act: async (action, ...args) => {
    const { session } = get();
    if (!session) return { success: false, error: "No session open." };
    set({ saving: true });
    try {
      const result = await inventoryApi[action](session.countId, ...args);
      await get().openSession(session.countId);
      await get().fetchCounts();
      set({ saving: false });
      return { success: true, result };
    } catch (err) {
      set({ saving: false });
      return {
        success: false,
        error: err.response?.data?.message || "The action failed.",
        code: err.response?.data?.code ?? null,
      };
    }
  },

  createCount: async (payload) => {
    set({ saving: true });
    try {
      const result = await inventoryApi.createCount(payload);
      set({ saving: false });
      await get().fetchCounts();
      return { success: true, result };
    } catch (err) {
      set({ saving: false });
      return {
        success: false,
        error: err.response?.data?.message || "Could not create the session.",
        code: err.response?.data?.code ?? null,
      };
    }
  },

  // ── Oversold exceptions ─────────────────────────────────────────────────
  oversold: [],
  fetchOversold: async () => {
    try { set({ oversold: await inventoryApi.listOversold("Open") }); }
    catch { set({ oversold: [] }); }
  },

  resolveOversold: async (id, resolution, note) => {
    try {
      await inventoryApi.resolveOversold(id, resolution, note);
      await get().fetchOversold();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Could not resolve." };
    }
  },
}));
