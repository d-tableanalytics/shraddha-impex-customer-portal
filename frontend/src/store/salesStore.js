import { create } from "zustand";
import { salesApi } from "../services/sales";
import { ordersApi } from "../services/orders";
import { inventoryApi } from "../services/inventory";
import { registerSessionReset } from "./sessionReset";
import { invalidateBookingData, registerStaleMarker } from "./invalidation";

/**
 * How long the search box waits for typing to pause before asking the server.
 *
 * The bookings list is built server-side from every booking line, and each
 * request costs several database round trips, so a request per keystroke queued
 * work the user had already typed past.
 */
export const SEARCH_DEBOUNCE_MS = 300;

// Module scope, not state: none of these should re-render the desk.
let searchTimer = null;
// Monotonic ticket — only the newest request may write the list. Out-of-order
// responses are not hypothetical: a short term matches more rows and answers
// later than the longer one typed after it.
let requestSeq = 0;
let inFlight = null; // AbortController of the newest request

const isCancelled = (err) => err?.code === "ERR_CANCELED" || err?.name === "CanceledError";

const initialList = {
  bookings: [],
  meta: { total: 0, pendingPo: 0, generated: 0 },
  // What the list on screen was actually fetched for. `search` is the box,
  // which runs ahead of the data while typing; exports name what is shown.
  appliedScope: "all",
  appliedSearch: "",
  // True until the first list has arrived. Later refreshes keep the current
  // rows on screen and set `refreshing` instead.
  loading: true,
  refreshing: false,
  error: null,
  // When the list on screen was read (0 = must be re-read before reuse).
  fetchedAt: 0,
};

/**
 * How long a loaded bookings list is reused when the desk is reopened. Short:
 * PO deadlines run on this list. Any booking change anywhere marks it stale at
 * once (store/invalidation.js), and every write on the desk re-reads it.
 */
export const BOOKINGS_FRESH_MS = 15_000;

export const useSalesStore = create((set, get) => ({
  ...initialList,
  scope: "all", // all | pending | generated
  search: "",
  selected: null, // the booking open in the review drawer
  saving: false,

  /**
   * Load the list for the current scope and search, immediately.
   *
   * Used on mount, by the scope tabs and after every write — none of which are
   * debounced. Supersedes any pending debounced search and aborts the request
   * it replaces, so a stale answer can never land after this one.
   */
  fetchBookings: async () => {
    clearTimeout(searchTimer);
    searchTimer = null;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const seq = ++requestSeq;

    const { scope, search } = get();
    set((state) => ({ error: null, refreshing: !state.loading }));
    try {
      const { data, meta } = await salesApi.getBookings(
        { status: scope, search },
        { signal: controller.signal },
      );
      if (seq !== requestSeq) return;
      set({
        bookings: data, meta, appliedScope: scope, appliedSearch: search,
        loading: false, refreshing: false, fetchedAt: Date.now(),
      });
    } catch (err) {
      // Superseded by a newer request: that one reports, this one says nothing.
      if (seq !== requestSeq || isCancelled(err)) return;
      set({
        error: err.response?.data?.message || err.message || "Failed to load bookings",
        loading: false,
        refreshing: false,
      });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  },

  /**
   * On opening the desk: reuse the list if it is recent and was loaded for the
   * scope and search now selected; otherwise load it.
   */
  ensureBookings: (maxAgeMs = BOOKINGS_FRESH_MS) => {
    const { fetchedAt, scope, search, appliedScope, appliedSearch } = get();
    if (inFlight) return Promise.resolve();
    const matches = scope === appliedScope && search === appliedSearch;
    if (matches && fetchedAt && Date.now() - fetchedAt < maxAgeMs) return Promise.resolve();
    return get().fetchBookings();
  },

  setScope: (scope) => {
    set({ scope });
    get().fetchBookings();
  },

  /**
   * The search box. The input updates at once; the request waits for typing to
   * pause. Clearing the box is a deliberate "show everything" and runs at once.
   */
  setSearch: (search) => {
    set({ search });
    clearTimeout(searchTimer);
    if (search === "") {
      get().fetchBookings();
      return;
    }
    searchTimer = setTimeout(() => {
      searchTimer = null;
      get().fetchBookings();
    }, SEARCH_DEBOUNCE_MS);
  },

  /** Back to the signed-out state; cancels anything pending. */
  reset: () => {
    clearTimeout(searchTimer);
    searchTimer = null;
    inFlight?.abort();
    inFlight = null;
    requestSeq += 1;
    set({ ...initialList, scope: "all", search: "", selected: null, saving: false, pricing: null });
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

  /**
   * Move the booking to another stage. Booking status is managed on the Sales
   * Desk; the server moves every line, records the timeline entry and emails
   * the customer once. Returns its verdict for reportStatusChange().
   */
  updateBookingStatus: async (orderId, status) => {
    try {
      const res = await ordersApi.updateStatus(orderId, status);
      invalidateBookingData();
      await get().reloadSelected();
      await get().fetchBookings();
      return {
        success: true,
        changed: res?.changed !== false,
        message: res?.message,
        notified: res?.notified?.state || null,
        notifyError: res?.notified?.error || res?.notified?.reason || null,
      };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  /** Cancel the booking at any stage; its stock comes back and its indent closes. */
  cancelBooking: async (orderId, reason) => {
    try {
      const res = await ordersApi.cancel(orderId, reason);
      invalidateBookingData();
      await get().reloadSelected();
      await get().fetchBookings();
      return { success: true, message: res?.message };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  /**
   * Cancel ONE inward allocation. Its units return to stock and to their
   * indent; the allocation stays on the booking, marked Cancelled.
   */
  cancelInwardAllocation: async ({ orderId, lineId, seq, reason }) => {
    try {
      const res = await inventoryApi.cancelAllocation({ orderId, lineId, seq, reason });
      invalidateBookingData();
      await get().reloadSelected();
      await get().fetchBookings();
      return { success: true, data: res };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  // One inward allocation's own stage, then the drawer re-reads the booking.
  updateAllocationBatchStatus: async (orderId, at, status) => {
    try {
      await ordersApi.updateAllocationBatchStatus(orderId, at, status);
      invalidateBookingData();
      await get().reloadSelected();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  saveItems: async (orderId, lines) => {
    set({ saving: true });
    try {
      const res = await salesApi.updateItems(orderId, lines);
      set({ selected: res.data, saving: false });
      // Other screens showing bookings must re-read too.
      invalidateBookingData();
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
      // Other screens showing bookings must re-read too.
      invalidateBookingData();
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
      // Other screens showing bookings must re-read too.
      invalidateBookingData();
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

  /** Save the rates typed into the line table ("No pricing" chosen). */
  setManualPricing: async (orderId, prices) => {
    set({ saving: true });
    try {
      const res = await salesApi.setManualPricing(orderId, prices);
      set({ selected: res.data, saving: false });
      invalidateBookingData();
      await get().fetchBookings();
      return { success: true, pricing: res.pricing };
    } catch (err) {
      set({ saving: false });
      return {
        success: false,
        error: err.response?.data?.message || err.message || "Could not save the prices.",
      };
    }
  },

  raisePo: async (orderId, poData) => {
    set({ saving: true });
    try {
      const updated = await salesApi.raisePo(orderId, poData);
      set({ selected: updated, saving: false });
      // Other screens showing bookings must re-read too.
      invalidateBookingData();
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

registerSessionReset(() => useSalesStore.getState().reset());
registerStaleMarker(() => useSalesStore.setState({ fetchedAt: 0 }));
