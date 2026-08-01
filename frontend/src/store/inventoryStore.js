import { create } from "zustand";
import { inventoryApi } from "../services/inventory";

/**
 * IMS master state (Module M1).
 *
 * Kept separate from productStore, which serves the customer ordering flow
 * against the legacy /products endpoints. The two answer different questions —
 * "what can I sell" versus "what do we hold" — and merging them would tie the
 * ordering screens to inventory-side changes.
 */
export const useInventoryStore = create((set, get) => ({
  // ── Master list ─────────────────────────────────────────────────────────
  items: [],
  total: 0,
  pages: 1,
  catalogueTotal: 0,
  loading: true,
  error: null,

  categories: [],

  filters: {
    search: "",
    brand: "",
    category: "",
    status: "",
    sort: "sku-asc",
    page: 1,
    limit: 25,
  },

  setFilters: (patch) => {
    // Any filter change resets to page 1, or a narrowed result set can leave the
    // user stranded past the last page.
    const resetsPage = Object.keys(patch).some((k) => k !== "page");
    set((state) => ({
      filters: { ...state.filters, ...patch, ...(resetsPage ? { page: 1 } : {}) },
    }));
    get().fetchItems();
  },

  fetchItems: async () => {
    set({ loading: true, error: null });
    try {
      const result = await inventoryApi.listItems(get().filters);
      set({ ...result, loading: false });
    } catch (err) {
      set({
        error: err.response?.data?.message || err.message || "Failed to load inventory",
        loading: false,
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

  // ── Detail ──────────────────────────────────────────────────────────────
  selected: null,
  detailLoading: false,

  openItem: async (skuCode) => {
    set({ detailLoading: true, selected: null, error: null });
    try {
      const item = await inventoryApi.getItem(skuCode);
      // Guard against a late response for a drawer the user already dismissed:
      // closeItem clears detailLoading, so if it is no longer set the request
      // was abandoned and its result must not reopen the panel.
      if (!get().detailLoading) return;
      set({ selected: item, detailLoading: false });
    } catch (err) {
      set({
        detailLoading: false,
        error: err.response?.data?.message || "Failed to load product",
      });
    }
  },

  // Clears the loading flag as well, so dismissing mid-request cannot leave the
  // drawer stuck on its spinner.
  closeItem: () => set({ selected: null, detailLoading: false }),

  savePlanning: async (skuCode, updates) => {
    try {
      const updated = await inventoryApi.updatePlanning(skuCode, updates);
      set({ selected: updated });
      // Refresh the list so the row reflects the change without a full reload.
      await get().fetchItems();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err.response?.data?.message || err.message || "Could not save changes.",
      };
    }
  },
}));

/**
 * Configuration and locations. A separate store because the settings screen is
 * loaded rarely and by a different audience than the master list.
 */
export const useInventoryConfigStore = create((set, get) => ({
  config: null,
  history: [],
  locations: [],
  loading: true,
  saving: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null });
    try {
      const [config, locations] = await Promise.all([
        inventoryApi.getConfig("global"),
        inventoryApi.listLocations({ includeInactive: true }),
      ]);
      set({ config, locations, loading: false });
    } catch (err) {
      set({
        error: err.response?.data?.message || err.message || "Failed to load configuration",
        loading: false,
      });
    }
  },

  fetchHistory: async () => {
    try {
      set({ history: await inventoryApi.getConfigHistory("global") });
    } catch {
      set({ history: [] });
    }
  },

  saveConfig: async (payload) => {
    set({ saving: true });
    try {
      const config = await inventoryApi.updateConfig({ scope: "global", ...payload });
      set({ config, saving: false });
      await get().fetchHistory();
      return { success: true };
    } catch (err) {
      set({ saving: false });
      return {
        success: false,
        error: err.response?.data?.message || err.message || "Could not save configuration.",
      };
    }
  },

  createLocation: async (payload) => {
    try {
      await inventoryApi.createLocation(payload);
      set({ locations: await inventoryApi.listLocations({ includeInactive: true }) });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Could not create location." };
    }
  },

  updateLocation: async (id, updates) => {
    try {
      await inventoryApi.updateLocation(id, updates);
      set({ locations: await inventoryApi.listLocations({ includeInactive: true }) });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Could not update location." };
    }
  },

  setDefaultLocation: async (id) => {
    try {
      await inventoryApi.setDefaultLocation(id);
      set({ locations: await inventoryApi.listLocations({ includeInactive: true }) });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Could not set default." };
    }
  },
}));
