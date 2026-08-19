import { create } from "zustand";
import { productsApi } from "../services/products";
import { useUserStore } from "./userStore";
import { defaultBrand } from "../utils/brandAccess";

// Resolves which brand collection to search based on the logged-in user's access.
// Returns null when the user has no brand access — callers must not fall back to
// a brand, or a user with Koken switched off would still request Koken products
// (which the server correctly rejects, leaving the page stuck on an error).
const getActiveBrand = () => defaultBrand(useUserStore.getState().user);

// Monotonic ticket for the SKU search. Module scope rather than store state on
// purpose: bumping it must not re-render every subscriber of the dropdown.
let searchSeq = 0;

export const useProductStore = create((set, get) => ({
  products: [],
  searchResults: [],
  loading: false,
  searching: false,
  error: null,

  // SKU picker paging. A one-character term matches thousands of SKUs, so the
  // picker holds a page at a time and pulls the next as the list is scrolled.
  // `searchTotal` is how many matched in all — what tells the user to narrow.
  searchTerm: '',
  searchBrand: null,
  searchPage: 1,
  searchTotal: 0,
  searchHasMore: false,
  searchLoadingMore: false,

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

  // Typing is faster than the network, so responses can land out of order: a
  // slow answer for "1" arriving after the quick one for "13012" would leave
  // 6,000 unrelated rows on screen under the narrower term. Each call takes a
  // ticket and only the latest is allowed to write results.
  searchProducts: async (query, brand) => {
    if (!query) {
      searchSeq += 1; // cancel anything in flight
      set({
        searchResults: [], searching: false,
        searchTotal: 0, searchHasMore: false, searchPage: 1, searchTerm: '',
      });
      return;
    }
    const ticket = (searchSeq += 1);
    set({ searching: true, searchTerm: query });
    try {
      const b = brand || getActiveBrand();
      if (!b) {
        if (ticket === searchSeq) {
          set({ searchResults: [], searching: false, searchTotal: 0, searchHasMore: false });
        }
        return;
      }
      const { items, total, hasMore } = await productsApi.search(query, b, { page: 1 });
      if (ticket !== searchSeq) return; // superseded — drop this answer
      set({
        searchResults: items, searching: false,
        searchTotal: total, searchHasMore: hasMore, searchPage: 1, searchBrand: b,
      });
    } catch {
      if (ticket === searchSeq) set({ searching: false });
    }
  },

  /**
   * Append the next page of matches, for the picker's scroll.
   *
   * Shares the search ticket: if the user has typed again while this was in
   * flight, the page belongs to a term nobody is looking at any more and is
   * discarded rather than appended to an unrelated result set.
   */
  loadMoreSearchResults: async () => {
    const { searchTerm, searchPage, searchHasMore, searchLoadingMore, searchBrand } = get();
    if (!searchTerm || !searchHasMore || searchLoadingMore) return;

    const ticket = searchSeq;
    set({ searchLoadingMore: true });
    try {
      const nextPage = searchPage + 1;
      const { items, total, hasMore } = await productsApi.search(
        searchTerm, searchBrand || getActiveBrand(), { page: nextPage },
      );
      if (ticket !== searchSeq) return; // the term moved on
      set((s) => ({
        searchResults: [...s.searchResults, ...items],
        searchPage: nextPage,
        searchTotal: total,
        searchHasMore: hasMore,
        searchLoadingMore: false,
      }));
    } catch {
      if (ticket === searchSeq) set({ searchLoadingMore: false });
    }
  },

  clearSearchResults: () => {
    searchSeq += 1; // abandon anything in flight, results and pages alike
    set({
      searchResults: [], searchTerm: '', searchPage: 1,
      searchTotal: 0, searchHasMore: false, searchLoadingMore: false,
      searching: false,
    });
  },
}));
