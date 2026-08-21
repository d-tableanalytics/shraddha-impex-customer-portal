import { api } from "./api";

export const salesApi = {
  /** status: 'pending' | 'generated' | 'all' */
  getBookings: async ({ status = "pending", search = "" } = {}) => {
    const params = new URLSearchParams({ status });
    if (search) params.set("search", search);
    const res = await api.get(`/sales/bookings?${params.toString()}`);
    return { data: res.data.data || [], meta: res.data.meta || {} };
  },

  getBooking: async (orderId) => {
    const res = await api.get(`/sales/bookings/${encodeURIComponent(orderId)}`);
    return res.data.data;
  },

  /** lines: [{ id?, skuCode, quantity }] — omit id to add a new line. */
  updateItems: async (orderId, lines) => {
    const res = await api.put(`/sales/bookings/${encodeURIComponent(orderId)}/items`, { lines });
    return res.data;
  },

  /** Omit poNumber to have the server generate PO-YYYY-######. Accepts string or poDetails object. */
  raisePo: async (orderId, poData) => {
    const payload = typeof poData === "string" ? (poData ? { poNumber: poData } : {}) : (poData || {});
    const res = await api.post(`/sales/bookings/${encodeURIComponent(orderId)}/po`, payload);
    return res.data.data;
  },
};

export default salesApi;
