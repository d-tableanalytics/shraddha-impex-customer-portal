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

  // A booking row can represent several underlying line-item Order documents
  // (lineItemIds); the status change must apply to all of them together.
  updateOrderStatus: async (booking, status, remarks) => {
    const ids = booking?.lineItemIds?.length ? booking.lineItemIds : [booking?.id];
    try {
      await ordersApi.updateStatus(ids, status, remarks);
      await get().fetchOrders();
      // Keep the open drawer in sync with the refreshed booking.
      const updated = get().allOrders.find((o) => o.orderNumber === booking.orderNumber);
      if (updated) set({ selectedOrder: updated });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
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
