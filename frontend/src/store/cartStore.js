import { create } from "zustand";
import { reservationsApi } from "../services/reservations";
import { registerSessionReset } from "./sessionReset";
import { invalidateBookingData, registerStaleMarker } from "./invalidation";
import { queryClient } from "../lib/queryClient";
import { queryKeys } from "../lib/queryKeys";

// The selection list feeds the dashboard's "In List" figure.
const selectionListChanged = () => queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });

/**
 * How long a loaded indent list counts as current for a screen that only READS
 * it (the booking drawer). Writes never rely on it: every action that can change
 * indents refreshes the list itself, and the server re-checks stock on every
 * booking regardless of what the browser last saw.
 */
export const PENDING_FRESH_MS = 30_000;

// The in-flight /reservations/pending request, so concurrent callers share it,
// and a ticket so an older response cannot overwrite a newer one.
let pendingRequest = null;
let pendingSeq = 0;

const initialHeader = {
  customer: "",
  poNumber: "",
  deliveryLocation: "",
  expectedDeliveryDate: "",
  remarks: "",
};


/** GET /reservations/pending, mapped to the shape the indent screens use. */
const loadPendingItems = async () => {
  const dbPending = await reservationsApi.getPending();
  const pendingItems = dbPending.map((r) => {
    const p = r.productId || {};
    const c = r.customerId || {};
    return {
      _id: r._id,
      id: r.reservationId,
      status: r.status,
      indentNumber: r.indentNumber || null, // PI-YYYY-###### (display id)
      poNumber: r.poNumber || null,          // once a PO exists for it
      // The booking this indent came from, reported by the server (null for
      // a standalone indent). The reliable link: a PO number only exists
      // once one has been raised.
      bookingId: r.bookingId || null,
      pendingQuantity: r.quantity,
      updatedAt: r.updatedAt,
      customer:
        typeof c === "object"
          ? { name: c.name || c.company || c.email || "—" }
          : { name: "—" },
      product: {
        id: p._id || r.productId,
        code: r.skuCode,
        msilCode: r.msilCode,
        category: Array.isArray(p.category) ? p.category.join(", ") : (p.category || "—"),
        brand: p.brand || "—",
        availableStock: p.availableForSale !== undefined ? p.availableForSale : 0,
      },
    };
  });
  return pendingItems;
};

export const useCartStore = create((set, get) => ({
  items: [], // Stores reservation objects
  pendingItems: [], // Backordered quantities awaiting stock
  // Starts true so the Indent History table shows skeleton rows on first paint
  // rather than a "no indents" flash before the first fetch resolves.
  pendingLoading: true,
  // Whether an indent list has ever loaded for this session, and when the one on
  // hand was last read successfully (0 = it must be re-read before reuse).
  pendingLoaded: false,
  pendingFetchedAt: 0,
  header: { ...initialHeader },
  loading: false,
  error: null,

  setPOHeader: (fields) => {
    set((state) => ({
      header: { ...state.header, ...fields },
    }));
  },

  fetchReservations: async () => {
    set({ loading: true, error: null });
    try {
      const dbReservations = await reservationsApi.getAll();
      
      // Map to items expected by the frontend
      // Each item has: { product: { id, code, name, msilCode, category, brand, availableStock, price, unit, warehouse }, orderQuantity, reservationDate, expiryDate, remainingDays, status, _id }
      const items = dbReservations.map((r) => {
        const remainingTime = new Date(r.expiryDate).getTime() - Date.now();
        const remainingDays = Math.ceil(remainingTime / (1000 * 60 * 60 * 24));
        const p = r.productId || {};
        
        return {
          _id: r._id,
          id: r.reservationId,
          reservationDate: r.reservationDate,
          expiryDate: r.expiryDate,
          remainingDays: remainingDays < 0 ? 0 : remainingDays,
          status: r.status,
          orderQuantity: r.quantity,
          product: {
            id: p._id || r.productId,
            code: r.skuCode,
            msilCode: r.msilCode,
            // Products are keyed by SKU (no separate display name field).
            name: r.skuCode,
            category: Array.isArray(p.category) ? p.category.join(', ') : (p.category || '—'),
            brand: p.brand || '—',
            availableStock: p.availableForSale !== undefined ? p.availableForSale : 0,
            moq: p.moq || 1,
            unit: p.unit || 'PCS',
            warehouse: p.warehouse || 'Warehouse'
          }
        };
      });

      // To get real product pricing/names, we'll populate them from the store or backend
      set({ items, loading: false });
    } catch (err) {
      set({ error: err.message || "Failed to load reservations", loading: false });
    }
  },

  /**
   * The indent list, unless a fresh enough one is already loaded.
   *
   * For read-only views. Joins a request already in flight rather than firing a
   * second one.
   */
  ensurePendingReservations: (maxAgeMs = PENDING_FRESH_MS) => {
    if (pendingRequest) return pendingRequest;
    const { pendingFetchedAt } = get();
    if (pendingFetchedAt && Date.now() - pendingFetchedAt < maxAgeMs) return Promise.resolve();
    return get().fetchPendingReservations();
  },

  /** Always re-read the indent list — after any action that may have changed it. */
  fetchPendingReservations: () => {
    const seq = ++pendingSeq;
    // Skeletons only while there is nothing to show; a refresh keeps the rows.
    set((state) => ({ pendingLoading: !state.pendingLoaded }));
    const request = (async () => {
      let pendingItems;
      try {
        pendingItems = await loadPendingItems();
      } catch {
        if (seq !== pendingSeq) return;
        // Non-blocking: pending backorders are supplementary info. A failed
        // refresh keeps the last list it had rather than blanking it, and is
        // marked stale so the next read tries again.
        set((state) => ({
          pendingItems: state.pendingLoaded ? state.pendingItems : [],
          pendingLoading: false,
          pendingFetchedAt: 0,
        }));
        return;
      } finally {
        if (pendingRequest === request) pendingRequest = null;
      }
      if (seq !== pendingSeq) return;
      set({ pendingItems, pendingLoading: false, pendingLoaded: true, pendingFetchedAt: Date.now() });
    })();
    pendingRequest = request;
    return request;
  },

  // restorePending() backed the indent list's "To Selection List" action, which
  // has been removed — an indent returns to the customer's selection list
  // automatically once stock covers it, with no manual step.

  addItem: async (product, quantity) => {
    set({ loading: true, error: null });
    try {
      const productId = product.id || product._id;
      const { merged } = await reservationsApi.create(productId, quantity);
      selectionListChanged();
      await get().fetchReservations();
      set({ loading: false });
      return { success: true, merged };
    } catch (err) {
      set({ error: err.response?.data?.message || err.message, loading: false });
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  removeItem: async (productCode) => {
    // Find matching item in state
    const item = get().items.find((i) => i.product.code === productCode);
    if (!item) return;

    set({ loading: true });
    try {
      await reservationsApi.cancel(item._id);
      selectionListChanged();
      await get().fetchReservations();
    } catch (err) {
      set({ error: err.message, loading: false });
    }
  },

  // Bulk delete: cancel several selected reservations together (by _id).
  removeItems: async (reservationIds) => {
    const targets = get().items.filter((i) => reservationIds.includes(i._id));
    if (targets.length === 0) return { success: true, removed: 0, failed: [] };

    set({ loading: true });
    const results = await Promise.allSettled(
      targets.map((item) => reservationsApi.cancel(item._id)),
    );
    const failed = [];
    results.forEach((r, idx) => {
      if (r.status === "rejected") {
        const err = r.reason;
        failed.push({
          code: targets[idx].product.code,
          error: err?.response?.data?.message || err?.message || "failed",
        });
      }
    });
    const removed = targets.length - failed.length;
    if (removed > 0) selectionListChanged();
    await get().fetchReservations();
    set({ loading: false });
    return { success: failed.length === 0, removed, failed };
  },

  updateQuantity: async (productCode, quantity) => {
    const item = get().items.find((i) => i.product.code === productCode);
    if (!item) return { success: false, error: "Product not found." };

    set({ loading: true });
    try {
      await reservationsApi.updateQuantity(item._id, quantity);
      selectionListChanged();
      await get().fetchReservations();
      return { success: true };
    } catch (err) {
      set({ error: err.response?.data?.message || err.message, loading: false });
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  clearCart: async () => {
    // Cancel all active reservations in the selection list
    const activeItems = [...get().items];
    set({ loading: true });
    try {
      for (const item of activeItems) {
        await reservationsApi.cancel(item._id);
      }
      selectionListChanged();
      set({ items: [], loading: false });
    } catch (err) {
      set({ loading: false });
    }
  },

  resetAll: () => set({ items: [], header: { ...initialHeader } }),

  confirmBooking: async () => {
    set({ loading: true, error: null });
    try {
      const header = get().header;
      const order = await reservationsApi.confirm(header.deliveryLocation, header.remarks);
      set({ items: [], header: { ...initialHeader }, loading: false });
      // A new booking: every screen showing bookings, indents or the dashboard
      // figures is now out of date.
      invalidateBookingData();
      // Refresh backorders — a partial/unfulfilled confirmation may add to them.
      await get().fetchPendingReservations();
      return order;
    } catch (err) {
      set({ error: err.response?.data?.message || err.message, loading: false });
      throw err;
    }
  },

  getTotalProducts: () => get().items.length,

  getTotalQuantity: () =>
    get().items.reduce((total, item) => total + item.orderQuantity, 0),

}));

// Selection list and indents belong to the account that loaded them.
registerSessionReset(() => {
  pendingSeq += 1;
  pendingRequest = null;
  useCartStore.setState({
    items: [], pendingItems: [], pendingLoading: true, pendingLoaded: false, pendingFetchedAt: 0,
    header: { ...initialHeader }, loading: false, error: null,
  });
});
registerStaleMarker(() => useCartStore.setState({ pendingFetchedAt: 0 }));
