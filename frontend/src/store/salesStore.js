import { create } from "zustand";
import { salesApi } from "../services/sales";

export const useSalesStore = create((set, get) => ({
  bookings: [],
  meta: { total: 0, pendingPo: 0, generated: 0 },
  scope: "all", // all | pending | generated
  search: "",
  selected: null, // the booking open in the review drawer
  loading: true,
  saving: false,
  error: null,

  fetchBookings: async () => {
    set({ loading: true, error: null });
    try {
      const { scope, search } = get();
      const { data, meta } = await salesApi.getBookings({ status: scope, search });
      set({ bookings: data, meta, loading: false });
    } catch (err) {
      set({
        error: err.response?.data?.message || err.message || "Failed to load bookings",
        loading: false,
      });
    }
  },

  setScope: (scope) => {
    set({ scope });
    get().fetchBookings();
  },
  setSearch: (search) => {
    set({ search });
    get().fetchBookings();
  },

  // Selecting a booking drops the previous booking's price quote — see the
  // note on `pricing` below.
  select: (booking) => set({ selected: booking, pricing: null }),
  close: () => set({ selected: null, pricing: null }),

  /** Refresh the open booking from the server (after an edit elsewhere). */
  reloadSelected: async () => {
    const open = get().selected;
    if (!open) return;
    try {
      set({ selected: await salesApi.getBooking(open.orderId) });
    } catch {
      // Non-blocking: keep showing what we have.
    }
  },

  saveItems: async (orderId, lines) => {
    set({ saving: true });
    try {
      const res = await salesApi.updateItems(orderId, lines);
      set({ selected: res.data, saving: false });
      await get().fetchBookings();
      return { success: true, changes: res.changes || [] };
    } catch (err) {
      set({ saving: false });
      return {
        success: false,
        // 423 carries the lock message; surface the server's wording verbatim.
        error: err.response?.data?.message || err.message || "Could not save the booking.",
        locked: err.response?.status === 423,
      };
    }
  },

  /**
   * Persist a new line order.
   *
   * The server answers with the whole booking, so `selected` is replaced the
   * same way saveItems replaces it - which is what makes the new sequence stick
   * when the drawer re-derives its draft.
   */
  reorderLines: async (orderId, lineIds) => {
    set({ saving: true });
    try {
      const data = await salesApi.reorderLines(orderId, lineIds);
      set({ selected: data, saving: false });
      await get().fetchBookings();
      return { success: true };
    } catch (err) {
      set({ saving: false });
      return {
        success: false,
        error: err.response?.data?.message || err.message || "Could not save the line order.",
        locked: err.response?.status === 423,
      };
    }
  },

  /**
   * The tier quote for the open booking: every rate for every line.
   *
   * Kept in the store rather than the dialog so it survives the dialog being
   * closed and reopened, and cleared whenever a different booking is selected —
   * showing one booking's prices against another's lines would be worse than
   * showing none.
   */
  pricing: null,
  pricingLoading: false,

  loadPricing: async (orderId) => {
    set({ pricingLoading: true });
    try {
      const pricing = await salesApi.getPricing(orderId);
      set({ pricing, pricingLoading: false });
      return { success: true, pricing };
    } catch (err) {
      set({ pricing: null, pricingLoading: false });
      return {
        success: false,
        // A 403 here means the account may work bookings but not see prices,
        // which is a legitimate configuration rather than a fault.
        forbidden: err.response?.status === 403,
        error: err.response?.data?.message || err.message || "Could not load prices.",
      };
    }
  },

  /** Set or clear the rate on a booking whose PO has already been raised. */
  setPricing: async (orderId, priceType) => {
    set({ saving: true });
    try {
      const res = await salesApi.setPricing(orderId, priceType);
      set({ selected: res.data, saving: false });
      await get().fetchBookings();
      return { success: true, pricing: res.pricing };
    } catch (err) {
      set({ saving: false });
      return {
        success: false,
        error: err.response?.data?.message || err.message || "Could not set the price.",
      };
    }
  },

  raisePo: async (orderId, poData) => {
    set({ saving: true });
    try {
      const updated = await salesApi.raisePo(orderId, poData);
      set({ selected: updated, saving: false });
      await get().fetchBookings();
      return { success: true, poNumber: updated.poNumber };
    } catch (err) {
      set({ saving: false });
      return {
        success: false,
        error: err.response?.data?.message || err.message || "Could not raise the PO.",
        locked: err.response?.status === 423,
      };
    }
  },
}));
