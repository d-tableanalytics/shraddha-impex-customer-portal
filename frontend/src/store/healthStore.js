import { create } from "zustand";
import { inventoryApi } from "../services/inventory";

/**
 * Stock health state (IMS Module M4).
 *
 * Holds only what the server returned. No band is derived here, no percentage
 * recomputed, no threshold applied — classification is the Health Engine's job,
 * and duplicating any part of it client-side is how the two would drift.
 */

const initialFilters = () => ({
  skuCode: "",
  brand: "",
  band: "",
  plannable: "",
  sort: "percent-asc", // worst covered first — the view a buyer wants
  page: 1,
  limit: 25,
});

export const useHealthStore = create((set, get) => ({
  items: [],
  total: 0,
  pages: 1,
  bandCounts: {},
  loading: true,
  error: null,

  filters: initialFilters(),

  setFilters: (patch) => {
    // Any filter change resets to page 1 — a narrowed result set would
    // otherwise leave the user stranded past the last page.
    const resetsPage = Object.keys(patch).some((k) => k !== "page");
    set((state) => ({
      filters: { ...state.filters, ...patch, ...(resetsPage ? { page: 1 } : {}) },
    }));
    get().fetchHealth();
  },

  resetFilters: () => {
    set({ filters: initialFilters() });
    get().fetchHealth();
  },

  fetchHealth: async () => {
    set({ loading: true, error: null });
    try {
      const result = await inventoryApi.listHealth(get().filters);
      set({ ...result, loading: false });
    } catch (err) {
      set({
        items: [], total: 0, pages: 1, loading: false,
        error: err.response?.data?.message || err.message || "Failed to load stock health",
      });
    }
  },

  // ── Detail drawer ───────────────────────────────────────────────────────
  selected: null,
  detailLoading: false,

  openItem: async (skuCode) => {
    set({ detailLoading: true, selected: null, error: null });
    try {
      const item = await inventoryApi.getHealth(skuCode);
      // A late response for a drawer the user already dismissed must not
      // reopen it — closeItem clears the flag.
      if (!get().detailLoading) return;
      set({ selected: item, detailLoading: false });
    } catch (err) {
      set({
        detailLoading: false,
        error: err.response?.data?.message || "Failed to load health detail",
      });
    }
  },

  closeItem: () => set({ selected: null, detailLoading: false }),
}));
