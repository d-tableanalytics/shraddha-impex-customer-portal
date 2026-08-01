import { create } from "zustand";
import { inventoryApi } from "../services/inventory";

/**
 * Inventory dashboard state (IMS Module M5).
 *
 * Holds the server's composed payload verbatim. No figure is derived here — not
 * a band, not a percentage, not a total. The dashboard renders what M3 and M4
 * computed, and anything it recomputed client-side would eventually disagree
 * with the screens that read the projections directly.
 */

const isoDaysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

const initialFilters = () => ({
  brand: "",
  category: "",
  // The date range narrows the activity feed only — health and balances are
  // current-state projections with no time dimension.
  from: isoDaysAgo(30),
  to: "",
});

export const useDashboardStore = create((set, get) => ({
  data: null,
  loading: true,
  refreshing: false,
  error: null,
  cached: false,

  filters: initialFilters(),
  categories: [],

  setFilters: (patch) => {
    set((state) => ({ filters: { ...state.filters, ...patch } }));
    get().fetchDashboard();
  },

  resetFilters: () => {
    set({ filters: initialFilters() });
    get().fetchDashboard();
  },

  fetchDashboard: async ({ refresh = false } = {}) => {
    // A manual refresh keeps the current view on screen rather than blanking it
    // back to skeletons — the data is already there and still valid.
    set(refresh ? { refreshing: true, error: null } : { loading: true, error: null });
    try {
      const data = await inventoryApi.getDashboard({ ...get().filters, refresh });
      set({ data, cached: data.cached, loading: false, refreshing: false });
    } catch (err) {
      set({
        loading: false,
        refreshing: false,
        error: err.response?.data?.message || err.message || "Failed to load the dashboard",
      });
    }
  },

  fetchCategories: async () => {
    try {
      set({ categories: await inventoryApi.getCategories() });
    } catch {
      // Non-blocking: the filter simply stays empty.
      set({ categories: [] });
    }
  },
}));
