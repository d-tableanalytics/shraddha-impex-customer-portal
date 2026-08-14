import { create } from "zustand";
import { reservationsApi } from "../services/reservations";

// Indent statuses come from the Reservation lifecycle, not the Order lifecycle:
// 'Pending'            → nothing could be fulfilled, the whole line is awaiting stock
// 'Partially Confirmed'→ part of the line shipped, the remainder is awaiting stock
export const INDENT_STATUSES = ["Pending", "Partially Confirmed"];

// Groups the flat pending rows (one per SKU) that came from the same booking
// confirmation into a single indent, mirroring how a booking row in Booking
// History represents several underlying line items.
//
// Rows without an indentNumber are legacy/ungrouped and each stand alone.
const groupIndents = (items) => {
  const byIndent = new Map();
  const rows = [];

  for (const item of items) {
    if (!item.indentNumber) {
      rows.push({ indentNumber: null, lines: [item] });
      continue;
    }
    if (!byIndent.has(item.indentNumber)) byIndent.set(item.indentNumber, []);
    byIndent.get(item.indentNumber).push(item);
  }
  for (const [indentNumber, lines] of byIndent) rows.push({ indentNumber, lines });

  return rows.map(({ indentNumber, lines }) => {
    const primary = lines[0];
    const totalQuantity = lines.reduce((n, l) => n + (l.pendingQuantity || 0), 0);
    // A line can be restored once live stock covers its outstanding quantity.
    const readyLines = lines.filter(
      (l) => (l.product?.availableStock || 0) >= (l.pendingQuantity || 0),
    ).length;

    return {
      // Grouped rows key on the indent number; ungrouped ones fall back to the
      // reservation _id so selection and React keys stay unique either way.
      id: indentNumber || primary._id,
      indentNumber,
      poNumber: primary.poNumber || null,
      // The booking this indent was raised alongside, or null when it stands
      // alone. Server-reported — see the mapping above.
      bookingId: primary.bookingId || null,
      standalone: lines.every((l) => l.standalone),
      date: primary.updatedAt || null,
      customer: primary.customer?.name || "—",
      status: primary.status,
      lines,
      itemCount: lines.length,
      totalQuantity,
      readyLines,
      // Fully restorable indents are the ones an admin can action right now.
      allReady: readyLines === lines.length,
    };
  });
};

const computeMetrics = (rows) => {
  const lines = rows.flatMap((r) => r.lines);
  return {
    total: rows.length,
    lines: lines.length,
    totalQty: lines.reduce((n, l) => n + (l.pendingQuantity || 0), 0),
    pending: rows.filter((r) => r.status === "Pending").length,
    partial: rows.filter((r) => r.status === "Partially Confirmed").length,
    ready: rows.filter((r) => r.allReady).length,
  };
};

export const useIndentHistoryStore = create((set, get) => ({
  allIndents: [],
  indents: [],
  filters: { status: "all", customer: "all", dateOn: "", dateFrom: "", dateTo: "" },
  searchQuery: "",
  sortBy: "date",
  sortOrder: "desc",
  page: 1,
  limit: 10,
  selectedIndent: null,
  selectedIds: [],
  metrics: { total: 0, lines: 0, totalQty: 0, pending: 0, partial: 0, ready: 0 },
  // Starts true so the table paints skeleton rows rather than flashing
  // "no indents" before the first fetch resolves.
  loading: true,
  error: null,

  fetchIndents: async () => {
    set({ loading: true, error: null });
    try {
      const raw = await reservationsApi.getPending();
      // Reuse the same mapping the cart store applies to pending reservations.
      const items = raw.map((r) => {
        const p = r.productId || {};
        const c = r.customerId || {};
        return {
          _id: r._id,
          id: r.reservationId,
          status: r.status,
          indentNumber: r.indentNumber || null,
          poNumber: r.poNumber || null,
          // Reported by the server, which checks the orders collection. It is
          // null for a standalone indent — one raised with no booking behind
          // it — and must NOT be derived from the indent number here: the two
          // ids share a sequence whether or not a booking was ever created.
          bookingId: r.bookingId || null,
          standalone: r.standalone === true,
          pendingQuantity: r.quantity,
          updatedAt: r.updatedAt,
          // The promised availability date, so the drawer can show and edit it.
          scheduledDate: r.scheduledDate || null,
          scheduleNote: r.scheduleNote || null,
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

      const rows = groupIndents(items);
      set({ allIndents: rows, indents: rows, metrics: computeMetrics(rows), loading: false });
      get().applyFilters();
    } catch (err) {
      set({ error: err.message || "Failed to fetch indents", loading: false });
    }
  },

  applyFilters: () => {
    const { allIndents, filters, searchQuery, sortBy, sortOrder } = get();
    let result = [...allIndents];

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (r) =>
          String(r.indentNumber || "").toLowerCase().includes(q) ||
          String(r.bookingId || "").toLowerCase().includes(q) ||
          String(r.poNumber || "").toLowerCase().includes(q) ||
          String(r.customer || "").toLowerCase().includes(q) ||
          // Searching a SKU should surface the indent that contains it.
          r.lines.some((l) => String(l.product?.code || "").toLowerCase().includes(q)),
      );
    }

    if (filters.status !== "all") result = result.filter((r) => r.status === filters.status);
    if (filters.customer !== "all") result = result.filter((r) => r.customer === filters.customer);

    // Local-midnight boundary for a "YYYY-MM-DD" input; parsing the string with
    // new Date() would give UTC midnight and shift the day in some timezones.
    const dayStart = (ymd) => {
      const [y, m, d] = ymd.split("-").map(Number);
      return new Date(y, m - 1, d).getTime();
    };
    const DAY_MS = 24 * 60 * 60 * 1000;

    // A single-day filter takes precedence over the range when both are set.
    if (filters.dateOn) {
      const start = dayStart(filters.dateOn);
      result = result.filter((r) => {
        const t = new Date(r.date).getTime();
        return t >= start && t < start + DAY_MS;
      });
    } else {
      if (filters.dateFrom) {
        const start = dayStart(filters.dateFrom);
        result = result.filter((r) => new Date(r.date).getTime() >= start);
      }
      if (filters.dateTo) {
        const end = dayStart(filters.dateTo) + DAY_MS;
        result = result.filter((r) => new Date(r.date).getTime() < end);
      }
    }

    result.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "date") cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (sortBy === "qty") cmp = a.totalQuantity - b.totalQuantity;
      if (sortBy === "status") cmp = String(a.status || "").localeCompare(String(b.status || ""));
      return sortOrder === "asc" ? cmp : -cmp;
    });

    set({ indents: result, page: 1 });
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
  setSelectedIndent: (indent) => set({ selectedIndent: indent }),

  toggleSelectId: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((x) => x !== id)
        : [...state.selectedIds, id],
    })),
  toggleSelectAll: () =>
    set((state) => {
      const ids = state.indents.map((r) => r.id);
      const allSelected = ids.length > 0 && ids.every((id) => state.selectedIds.includes(id));
      return { selectedIds: allSelected ? [] : ids };
    }),
  clearSelection: () => set({ selectedIds: [] }),

  // Admin: move one indent line back into the customer's selection list.
  scheduleLines: async (items) => {
    try {
      const res = await reservationsApi.schedule(items);
      await get().fetchIndents();
      // Keep an open drawer in sync with the refreshed data.
      const open = get().selectedIndent;
      if (open) {
        const updated = get().allIndents.find((r) => r.id === open.id);
        set({ selectedIndent: updated || null });
      }
      return { success: true, message: res.message, data: res.data };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  // restoreLine() lived here to back the drawer's "To Selection List" action.
  // That action has been removed: an indent moves to the customer's selection
  // list automatically once stock covers it, so there is nothing left to
  // trigger by hand.

  refresh: async () => {
    set({
      filters: { status: "all", customer: "all", dateOn: "", dateFrom: "", dateTo: "" },
      searchQuery: "",
      sortBy: "date",
      sortOrder: "desc",
      page: 1,
    });
    await get().fetchIndents();
  },
}));
