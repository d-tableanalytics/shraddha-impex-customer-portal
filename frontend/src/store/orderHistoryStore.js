import { create } from "zustand";
import { ordersApi } from "../services/orders";
import { reservationsApi } from "../services/reservations";

const computeMetrics = (orders) => {
  const now = new Date();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  // Legacy 'Booked' records count as the first stage (PO Received).
  const isPoReceived = (s) => s === "PO Received" || s === "Booked";
  return {
    total: orders.length,
    poReceived: orders.filter((o) => isPoReceived(o.status)).length,
    ready: orders.filter((o) => o.status === "Ready for Dispatch").length,
    dispatched: orders.filter((o) => o.status === "Dispatched").length,
    completed: orders.filter((o) => o.status === "Delivered").length,
    today: orders.filter((o) => new Date(o.date).getTime() >= today).length,
    thisMonth: orders.filter((o) => new Date(o.date).getTime() >= thisMonth)
      .length,
  };
};

export const useOrderHistoryStore = create((set, get) => ({
  allOrders: [],
  orders: [],
  filters: { status: "all", customer: "all", dateOn: "", dateFrom: "", dateTo: "" },
  searchQuery: "",
  sortBy: "date",
  sortOrder: "desc",
  page: 1,
  limit: 10,
  selectedOrder: null,
  selectedIds: [], // booking orderNumbers selected for export
  metrics: {
    total: 0,
    poReceived: 0,
    ready: 0,
    dispatched: 0,
    completed: 0,
    cancelled: 0,
    today: 0,
    thisMonth: 0,
  },
  // Starts true: the history page fetches on mount, so the table should show
  // skeleton rows from first paint rather than a "no bookings" flash.
  loading: true,
  error: null,

  fetchOrders: async () => {
    set({ loading: true, error: null });
    try {
      const orders = await ordersApi.getAll();
      set((state) => ({
        allOrders: orders,
        orders,
        // Cancelled comes from reservations, not orders — carry it through.
        metrics: { ...computeMetrics(orders), cancelled: state.metrics.cancelled },
        loading: false,
      }));
      get().applyFilters();
    } catch (err) {
      set({ error: err.message || "Failed to fetch orders", loading: false });
    }
  },

  // Cancelled bookings never became orders: they either expired on the
  // selection list (7-day window) or were removed by the customer.
  fetchCancelledCount: async () => {
    try {
      const cancelled = await reservationsApi.getCancelledCount();
      set((state) => ({ metrics: { ...state.metrics, cancelled } }));
    } catch {
      // Non-blocking: leave the existing count in place.
    }
  },

  applyFilters: () => {
    const { allOrders, filters, searchQuery, sortBy, sortOrder } = get();

    let result = [...allOrders];

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (o) =>
          String(o.poNumber || '').toLowerCase().includes(q) ||
          String(o.orderNumber || '').toLowerCase().includes(q) ||
          String(o.customer || '').toLowerCase().includes(q),
      );
    }

    if (filters.status !== "all") {
      result = result.filter((o) => o.status === filters.status);
    }
    if (filters.customer !== "all") {
      result = result.filter((o) => o.customer === filters.customer);
    }

    // Local-midnight boundary for a "YYYY-MM-DD" date-input value. Parsing the
    // string with new Date() would give UTC midnight and shift the day in
    // some timezones, so build the Date from its parts instead.
    const dayStart = (ymd) => {
      const [y, m, d] = ymd.split("-").map(Number);
      return new Date(y, m - 1, d).getTime();
    };
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Single-day filter takes precedence over the range when both are set.
    if (filters.dateOn) {
      const start = dayStart(filters.dateOn);
      const end = start + DAY_MS;
      result = result.filter((o) => {
        const t = new Date(o.date).getTime();
        return t >= start && t < end;
      });
    } else {
      if (filters.dateFrom) {
        const start = dayStart(filters.dateFrom);
        result = result.filter((o) => new Date(o.date).getTime() >= start);
      }
      if (filters.dateTo) {
        const end = dayStart(filters.dateTo) + DAY_MS;
        result = result.filter((o) => new Date(o.date).getTime() < end);
      }
    }

    result.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "date")
        cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (sortBy === "status") cmp = String(a.status || "").localeCompare(String(b.status || ""));
      return sortOrder === "asc" ? cmp : -cmp;
    });

    set({ orders: result, page: 1 });
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
    get().applyFilters();
  },

  setFilters: (newFilters) => {
    set((state) => ({ filters: { ...state.filters, ...newFilters } }));
    get().applyFilters();
  },

  setSort: (sortBy, sortOrder) => {
    set({ sortBy, sortOrder });
    get().applyFilters();
  },

  setPage: (page) => set({ page }),
  setSelectedOrder: (order) => set({ selectedOrder: order }),

  savingLines: false,
  // Quantity-change history for the open booking, behind the "i" button.
  // Keyed by booking so reopening a drawer does not show the previous one's.
  quantityHistory: null,
  quantityHistoryFor: null,
  quantityHistoryLoading: false,

  fetchQuantityHistory: async (orderNumber) => {
    if (!orderNumber) return;
    set({ quantityHistoryLoading: true });
    try {
      const data = await ordersApi.getQuantityHistory(orderNumber);
      set({
        quantityHistory: data,
        quantityHistoryFor: orderNumber,
        quantityHistoryLoading: false,
      });
    } catch {
      set({ quantityHistory: null, quantityHistoryFor: orderNumber, quantityHistoryLoading: false });
    }
  },

  /**
   * Amend the line quantities of a booking from Booking History.
   *
   * Goes through the SAME handler the sales desk uses rather than a second
   * one of its own: it already re-checks the PO lock, moves the stock (raising
   * a quantity reserves more, lowering it returns the difference) and writes
   * the audit entry that both the quantity history and the PO email's Change
   * column are built from. A parallel write path would have to reproduce all
   * four, and would drift.
   *
   * Works for customers too — the server confines them to the quantities on
   * their own booking.
   *
   * `lines` is [{ id, skuCode, quantity }] — every line of the booking, since
   * the endpoint treats an unlisted row as removed.
   */
  saveLineQuantities: async (orderNumber, lines) => {
    set({ savingLines: true });
    try {
      const saved = await ordersApi.updateBookingItems(orderNumber, lines);
      await get().fetchOrders();
      // The edit just wrote an audit entry, so any history already on screen
      // is now one entry short.
      await get().fetchQuantityHistory(orderNumber);
      // Keep the open drawer on the refreshed booking rather than the stale copy.
      const updated = get().allOrders.find((o) => o.orderNumber === orderNumber);
      if (updated) set({ selectedOrder: updated });
      set({ savingLines: false });
      // `changes` carries any stock-short splits, so the caller can tell the
      // user part of an increase went to an indent instead of the booking.
      return { success: true, changes: saved?.changes || [] };
    } catch (err) {
      set({ savingLines: false });
      return {
        success: false,
        // 423 carries the lock message; surface the server's wording verbatim.
        error: err.response?.data?.message || err.message || "Could not save the quantities.",
        locked: err.response?.status === 423,
      };
    }
  },

  // Multi-select for export (keyed by booking orderNumber).
  toggleSelectId: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((x) => x !== id)
        : [...state.selectedIds, id],
    })),
  toggleSelectAll: () =>
    set((state) => {
      const ids = state.orders.map((o) => o.orderNumber);
      const allSelected = ids.length > 0 && ids.every((id) => state.selectedIds.includes(id));
      return { selectedIds: allSelected ? [] : ids };
    }),
  clearSelection: () => set({ selectedIds: [] }),

  // A booking row represents several underlying line-item Order documents, and
  // the status change applies to all of them — so it is sent as ONE
  // booking-level request. The server moves every line, writes one timeline
  // entry and emails the customer once.
  updateOrderStatus: async (booking, status, remarks) => {
    try {
      const res = await ordersApi.updateStatus(booking.orderNumber, status, remarks);
      await get().fetchOrders();
      // Keep the open drawer in sync with the refreshed booking.
      const updated = get().allOrders.find((o) => o.orderNumber === booking.orderNumber);
      if (updated) set({ selectedOrder: updated });
      // The timeline gained an entry, so the drawer's copy is now stale.
      await get().fetchTimeline(booking.orderNumber);
      return {
        success: true,
        changed: res?.changed !== false,
        message: res?.message,
        // 'sent' | 'failed' | 'skipped' — so the caller can tell the admin that
        // the status moved but the customer was not reached.
        notified: res?.notified?.state || null,
        notifyError: res?.notified?.error || res?.notified?.reason || null,
      };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  // ── Lifecycle timeline ───────────────────────────────────────────────────
  // Keyed by booking number so switching bookings in the drawer never shows
  // the previous booking's history while the new one loads.
  timelines: {},
  timelineLoading: false,
  resendingEventId: null,

  fetchTimeline: async (orderNumber) => {
    if (!orderNumber) return;
    set({ timelineLoading: true });
    try {
      const data = await ordersApi.getTimeline(orderNumber);
      set((state) => ({
        timelines: { ...state.timelines, [orderNumber]: data.timeline || [] },
        timelineLoading: false,
      }));
    } catch {
      // Non-blocking: the timeline still renders from the booking's current
      // status, just without the per-stage timestamps.
      set({ timelineLoading: false });
    }
  },

  resendStatusEmail: async (orderNumber, eventId) => {
    set({ resendingEventId: eventId });
    try {
      const res = await ordersApi.resendStatusEmail(eventId);
      await get().fetchTimeline(orderNumber);
      return { success: Boolean(res?.success), message: res?.message };
    } catch (err) {
      return { success: false, message: err.response?.data?.message || err.message };
    } finally {
      set({ resendingEventId: null });
    }
  },

  updateOrderPO: async (booking, poNumber) => {
    try {
      await ordersApi.updatePO(booking.orderNumber, poNumber);
      await get().fetchOrders();
      const updated = get().allOrders.find((o) => o.orderNumber === booking.orderNumber);
      if (updated) set({ selectedOrder: updated });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  // Cancel the booking and release its stock. The refreshed booking is pushed
  // back into the open drawer so the button it was clicked from immediately
  // reflects the cancelled state rather than inviting a second click.
  cancelBooking: async (booking, reason) => {
    try {
      const res = await ordersApi.cancel(booking.orderNumber, reason);
      await get().fetchOrders();
      const updated = get().allOrders.find((o) => o.orderNumber === booking.orderNumber);
      if (updated) set({ selectedOrder: updated });
      // Cancelling closes the lifecycle, which the timeline has to show.
      await get().fetchTimeline(booking.orderNumber);
      return { success: true, message: res?.message, units: res?.data?.units };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  refresh: async () => {
    set({
      filters: { status: "all", customer: "all", dateOn: "", dateFrom: "", dateTo: "" },
      searchQuery: "",
      sortBy: "date",
      sortOrder: "desc",
      page: 1,
    });
    await get().fetchOrders();
  },
}));
