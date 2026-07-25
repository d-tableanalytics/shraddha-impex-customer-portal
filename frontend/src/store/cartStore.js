import { create } from "zustand";
import { reservationsApi } from "../services/reservations";

const initialHeader = {
  customer: "",
  poNumber: "",
  deliveryLocation: "",
  expectedDeliveryDate: "",
  remarks: "",
};

export const useCartStore = create((set, get) => ({
  items: [], // Stores reservation objects
  pendingItems: [], // Backordered quantities awaiting stock
  // Starts true so the Indent History table shows skeleton rows on first paint
  // rather than a "no pending indents" flash before the first fetch resolves.
  pendingLoading: true,
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
            price: p.price || 0,
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

  fetchPendingReservations: async () => {
    set({ pendingLoading: true });
    try {
      const dbPending = await reservationsApi.getPending();
      const pendingItems = dbPending.map((r) => {
        const p = r.productId || {};
        const c = r.customerId || {};
        return {
          _id: r._id,
          id: r.reservationId,
          status: r.status,
          indentNumber: r.indentNumber || null, // PI-YYYY-###### (display id)
          poNumber: r.poNumber || null,          // links this indent to its booking
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
      set({ pendingItems, pendingLoading: false });
    } catch {
      // Non-blocking: pending backorders are supplementary info.
      set({ pendingItems: [], pendingLoading: false });
    }
  },

  // Admin: move a pending backorder back into the customer's selection list
  // (emails + notifies the customer to confirm from their dashboard).
  restorePending: async (reservationId) => {
    try {
      await reservationsApi.restore(reservationId);
      await get().fetchPendingReservations();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || err.message };
    }
  },

  addItem: async (product, quantity) => {
    set({ loading: true, error: null });
    try {
      const productId = product.id || product._id;
      const { merged } = await reservationsApi.create(productId, quantity);
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

  getEstimatedValue: () =>
    get().items.reduce(
      (total, item) => total + (item.product.price || 0) * item.orderQuantity,
      0,
    ),

  getTax: () => get().getEstimatedValue() * 0.18, // 18% standard tax

  getGrandTotal: () => get().getEstimatedValue() + get().getTax(),
}));
