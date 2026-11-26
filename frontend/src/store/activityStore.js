import { create } from "zustand";
import { inventoryApi } from "../services/inventory";

/**
 * SKU Activity Log state.
 *
 * Two modes, one store:
 *   no SKU chosen  → the cross-SKU feed, so the screen is never empty
 *   a SKU chosen   → that SKU's own history, plus its period summary
 *
 * The brief asks for "the most recent 20" and, separately, for the complete
 * history. Those are the same request with a different page size, so there is
 * one fetch and a `showAll` flag, not two code paths able to disagree.
 */

const RECENT_LIMIT = 20;
const FULL_LIMIT = 50;

const initialFilters = () => ({
  activityType: "",
  reference: "",
  customerId: "",
  userId: "",
  from: "",
  to: "",
  page: 1,
});

export const useActivityStore = create((set, get) => ({
  // The SKU in focus. Empty string means the cross-SKU feed.
  skuCode: "",
  item: null,

  records: [],
  summary: null,
  total: 0,
  pages: 1,
  loading: true,
  error: null,

  // false → the latest 20. true → page through everything.
  showAll: false,

  activityTypes: [],
  skuOptions: [],
  skuSearchLoading: false,

  filters: initialFilters(),

  setFilters: (patch) => {
    const resetsPage = Object.keys(patch).some((k) => k !== "page");
    set((state) => ({
      filters: { ...state.filters, ...patch, ...(resetsPage ? { page: 1 } : {}) },
    }));
    get().fetch();
  },

  resetFilters: () => {
    set({ filters: initialFilters(), showAll: false });
    get().fetch();
  },

  setShowAll: (showAll) => {
    set({ showAll, filters: { ...get().filters, page: 1 } });
    get().fetch();
  },

  /**
   * Focus a SKU, or clear the focus.
   *
   * Clears the previous SKU's summary immediately rather than leaving it on
   * screen under a new heading — a stale "Closing stock 412" beside another
   * SKU's rows is worse than a blank space.
   */
  selectSku: (skuCode) => {
    set({
      skuCode: skuCode || "",
      item: null,
      summary: null,
      records: [],
      filters: { ...get().filters, page: 1 },
    });
    get().fetch();
  },

  fetch: async () => {
    const { skuCode, filters, showAll } = get();
    const limit = showAll ? FULL_LIMIT : RECENT_LIMIT;
    set({ loading: true, error: null });
    try {
      if (!skuCode) {
        const result = await inventoryApi.listActivity({ ...filters, limit });
        set({
          records: result.records, total: result.total, pages: result.pages,
          item: null, summary: null, loading: false,
        });
        return;
      }

      // The history and its summary are one question, so they are one wait —
      // the header must not show a closing balance before the rows that
      // explain it, or the other way round.
      const [result, summary] = await Promise.all([
        inventoryApi.getSkuActivity(skuCode, { ...filters, limit }),
        inventoryApi
          .getSkuActivitySummary(skuCode, { from: filters.from, to: filters.to })
          // The summary is a convenience; the history is the screen. A failure
          // here hides a panel, it does not empty the page.
          .catch(() => null),
      ]);
      set({
        records: result.records,
        item: result.item,
        total: result.total,
        pages: result.pages,
        summary,
        loading: false,
      });
    } catch (err) {
      set({
        records: [], total: 0, pages: 1, summary: null, loading: false,
        error: err.response?.data?.message || err.message || "Failed to load the activity log",
      });
    }
  },

  fetchActivityTypes: async () => {
    try {
      set({ activityTypes: await inventoryApi.getActivityTypes() });
    } catch {
      // Non-blocking: the type filter simply stays empty.
      set({ activityTypes: [] });
    }
  },

  searchSkus: async (search) => {
    set({ skuSearchLoading: true });
    try {
      set({ skuOptions: await inventoryApi.listActivitySkus({ search }), skuSearchLoading: false });
    } catch {
      set({ skuOptions: [], skuSearchLoading: false });
    }
  },
}));

export default useActivityStore;
