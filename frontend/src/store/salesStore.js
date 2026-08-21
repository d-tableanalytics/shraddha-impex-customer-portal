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

  select: (booking) => set({ selected: booking }),
  close: () => set({ selected: null }),

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
