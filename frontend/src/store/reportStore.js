import { create } from "zustand";
import { inventoryApi } from "../services/inventory";

/**
 * Reports and snapshots state (IMS Module M6).
 *
 * Holds server responses verbatim. Nothing is aggregated, compared or derived
 * here — the report service already did it, and duplicating any of it in the
 * client is how the two would eventually disagree.
 */

const isoDaysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

const initialFilters = () => ({
  brand: "",
  category: "",
  locationCode: "",
  skuCode: "",
  band: "",
  movementType: "",
  from: isoDaysAgo(30),
  to: "",
  page: 1,
  limit: 50,
});

export const useReportStore = create((set, get) => ({
  reportKey: "inventory-summary",
  data: null,
  loading: false,
  error: null,
  filters: initialFilters(),

  setReport: (reportKey) => {
    // Paging is per-report, so switching reports must not carry page 7 across.
    set((state) => ({ reportKey, data: null, filters: { ...state.filters, page: 1 } }));
    get().fetchReport();
  },

  setFilters: (patch) => {
    const resetsPage = Object.keys(patch).some((k) => k !== "page");
    set((state) => ({
      filters: { ...state.filters, ...patch, ...(resetsPage ? { page: 1 } : {}) },
    }));
    get().fetchReport();
  },

  resetFilters: () => {
    set({ filters: initialFilters() });
    get().fetchReport();
  },

  fetchReport: async () => {
    const { reportKey, filters } = get();
    set({ loading: true, error: null });
    try {
      // Only the parameters a given report understands are sent — the server
      // ignores the rest, but a lean query keeps the cache key meaningful.
      const common = {
        brand: filters.brand,
        category: filters.category,
        page: filters.page,
        limit: filters.limit,
      };
      const byReport = {
        "inventory-summary": {},
        movements: {
          skuCode: filters.skuCode, movementType: filters.movementType,
          locationCode: filters.locationCode, from: filters.from, to: filters.to,
        },
        health: { band: filters.band },
        balances: { skuCode: filters.skuCode, locationCode: filters.locationCode },
        aging: { locationCode: filters.locationCode },
      };
      const data = await inventoryApi.getReport(reportKey, {
        ...common,
        ...(byReport[reportKey] || {}),
      });
      set({ data, loading: false });
    } catch (err) {
      set({
        data: null,
        loading: false,
        error: err.response?.data?.message || err.message || "Failed to run the report",
      });
    }
  },

  // ── Snapshots ───────────────────────────────────────────────────────────
  snapshots: [],
  snapshotsLoading: false,
  generating: false,

  fetchSnapshots: async () => {
    set({ snapshotsLoading: true });
    try {
      const { items } = await inventoryApi.listSnapshots({ limit: 100 });
      set({ snapshots: items, snapshotsLoading: false });
    } catch {
      set({ snapshots: [], snapshotsLoading: false });
    }
  },

  createSnapshot: async (payload) => {
    set({ generating: true });
    try {
      const result = await inventoryApi.createSnapshot(payload);
      set({ generating: false });
      await get().fetchSnapshots();
      return { success: true, result };
    } catch (err) {
      set({ generating: false });
      return {
        success: false,
        error: err.response?.data?.message || "Could not generate the snapshot.",
        // A duplicate is recoverable by rebuilding, so the UI needs to know.
        existingRunId: err.response?.data?.existingRunId ?? null,
        code: err.response?.data?.code ?? null,
      };
    }
  },

  // ── Comparison ──────────────────────────────────────────────────────────
  comparison: null,
  comparing: false,
  compareFrom: "",
  compareTo: "",

  setCompare: (patch) => set(patch),

  runComparison: async () => {
    const { compareFrom, compareTo, filters } = get();
    if (!compareFrom || !compareTo) return { success: false, error: "Choose two snapshots." };
    set({ comparing: true, comparison: null });
    try {
      const comparison = await inventoryApi.compareSnapshots({
        from: compareFrom, to: compareTo, brand: filters.brand,
      });
      set({ comparison, comparing: false });
      return { success: true };
    } catch (err) {
      set({ comparing: false });
      return { success: false, error: err.response?.data?.message || "Comparison failed." };
    }
  },
}));
