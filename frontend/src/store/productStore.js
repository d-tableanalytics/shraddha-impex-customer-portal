import { create } from "zustand";
import { productsApi } from "../services/products";
import { useUserStore } from "./userStore";
import { defaultBrand } from "../utils/brandAccess";

// Resolves which brand collection to search based on the logged-in user's access.
// Returns null when the user has no brand access — callers must not fall back to
// a brand, or a user with Koken switched off would still request Koken products
// (which the server correctly rejects, leaving the page stuck on an error).
const getActiveBrand = () => defaultBrand(useUserStore.getState().user);

export const useProductStore = create((set) => ({
  products: [],
  searchResults: [],
  loading: false,
  searching: false,
  error: null,

  fetchProducts: async (brand) => {
    set({ loading: true, error: null });
    try {
      const b = brand || getActiveBrand();
      // No brand access at all → nothing to show, and no request to make.
      if (!b) {
        set({ products: [], loading: false });
        return;
      }
      const products = await productsApi.getAll(b);
      set({ products, loading: false });
    } catch (err) {
      set({ error: err.message || "Failed to load products", loading: false });
    }
  },

  // Load the full catalog across all brands (used by the admin Inventory view so
  // every item — including low/zero-stock — is visible, not just one brand).
  fetchAllProducts: async (limit) => {
    set({ loading: true, error: null });
    try {
      const products = await productsApi.getAllBrands(limit);
      set({ products, loading: false });
    } catch (err) {
      set({ error: err.message || "Failed to load products", loading: false });
    }
  },

  // Server-paginated Inventory view. Kept separate from fetchAllProducts, which
  // Booking History still uses to enrich exports with live stock figures.
  inventory: { items: [], total: 0, pages: 1, catalogueTotal: 0, lowStockCount: 0 },
  inventoryLoading: false,

  fetchInventory: async (params) => {
    set({ inventoryLoading: true, error: null });
    try {
      const inventory = await productsApi.getInventory(params);
      set({ inventory, inventoryLoading: false });
    } catch (err) {
      set({ error: err.message || "Failed to load inventory", inventoryLoading: false });
    }
  },

  // Returns the full filtered catalogue for download (not stored in state).
  exportInventory: async (params) => productsApi.getInventoryExport(params),

  searchProducts: async (query, brand) => {
    if (!query) {
      set({ searchResults: [] });
      return;
    }
    set({ searching: true });
    try {
      const b = brand || getActiveBrand();
      if (!b) {
        set({ searchResults: [], searching: false });
        return;
      }
      const searchResults = await productsApi.search(query, b);
      set({ searchResults, searching: false });
    } catch {
      set({ searching: false });
    }
  },

  clearSearchResults: () => set({ searchResults: [] }),
}));
