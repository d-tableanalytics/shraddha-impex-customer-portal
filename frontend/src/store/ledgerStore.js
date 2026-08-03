import { create } from "zustand";
import { inventoryApi } from "../services/inventory";

/**
 * Stock ledger state (IMS Module M2).
 *
 * The server refuses an unbounded ledger search, so the store opens with a
 * default 30-day window rather than an empty filter set — otherwise the first
 * render would always be a validation error, which reads as a broken screen.
 */

const isoDaysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

const initialFilters = () => ({
  skuCode: "",
  brand: "",
  movementType: "",
  reasonCode: "",
  batchId: "",
  referenceId: "",
  from: isoDaysAgo(30),
  to: "",
  sort: "date-desc",
  page: 1,
  limit: 50,
});

export const useLedgerStore = create((set, get) => ({
  movements: [],
  groups: [],
  // Grouped is the default: one action a user performed reads as one row.
  grouped: true,
  total: 0,
  pages: 1,
  loading: true,
  error: null,

  movementTypes: [],
  filters: initialFilters(),

  setFilters: (patch) => {
    // Any filter change resets to page 1 — a narrowed result set would
    // otherwise leave the user stranded past the last page.
    const resetsPage = Object.keys(patch).some((k) => k !== "page");
    set((state) => ({
      filters: { ...state.filters, ...patch, ...(resetsPage ? { page: 1 } : {}) },
    }));
    get().fetchMovements();
  },

  resetFilters: () => {
    set({ filters: initialFilters() });
    get().fetchMovements();
  },

  setGrouped: (grouped) => {
    set({ grouped, filters: { ...get().filters, page: 1 } });
    get().fetchMovements();
  },

  fetchMovements: async () => {
    set({ loading: true, error: null });
    try {
      // One call or the other — the grouped view is a different shape, not a
      // client-side fold of the flat one, because a posting's movements can
      // span pages and folding a page would group only what happened to be on it.
      const result = get().grouped
        ? await inventoryApi.searchLedgerGrouped(get().filters)
        : await inventoryApi.searchLedger(get().filters);
      set({ movements: [], groups: [], ...result, loading: false });
    } catch (err) {
      set({
        movements: [],
        groups: [],
        total: 0,
        pages: 1,
        loading: false,
        error: err.response?.data?.message || err.message || "Failed to load the stock ledger",
      });
    }
  },

  fetchMovementTypes: async () => {
    try {
      set({ movementTypes: await inventoryApi.getMovementTypes() });
    } catch {
      // Non-blocking: the type filter simply stays empty.
      set({ movementTypes: [] });
    }
  },

  // ── Batch drill-through ─────────────────────────────────────────────────
  selectedBatch: null,
  batchLoading: false,

  openBatch: async (batchId) => {
    set({ batchLoading: true, selectedBatch: null });
    try {
      const batch = await inventoryApi.getBatch(batchId);
      // A late response for a panel the user already dismissed must not reopen
      // it — closeBatch clears the flag.
      if (!get().batchLoading) return;
      set({ selectedBatch: batch, batchLoading: false });
    } catch (err) {
      set({
        batchLoading: false,
        error: err.response?.data?.message || "Failed to load the batch",
      });
    }
  },

  closeBatch: () => set({ selectedBatch: null, batchLoading: false }),
}));
