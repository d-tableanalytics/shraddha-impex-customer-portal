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

  /**
   * Omit poNumber to have the server generate PO-YYYY-######. Accepts string or poDetails object.
   *
   * `poData.priceType` is one of the keys in constants/pricing.js. The RATE is
   * never sent — the server looks it up from the product master, so what the
   * customer is charged cannot be decided by the browser.
   */
  raisePo: async (orderId, poData) => {
    const payload = typeof poData === "string" ? (poData ? { poNumber: poData } : {}) : (poData || {});
    const res = await api.post(`/sales/bookings/${encodeURIComponent(orderId)}/po`, payload);
    return res.data.data;
  },

  /**
   * Every tier price for this booking, and what each tier totals.
   *
   * The one request in the app that returns more than one price for a SKU. It
   * is behind view_pricing on the server, so a caller without it gets a 403
   * rather than a filtered answer — call it only when canViewPricing(user).
   */
  getPricing: async (orderId) => {
    const res = await api.get(`/sales/bookings/${encodeURIComponent(orderId)}/pricing`);
    return res.data.data;
  },

  /**
   * Rearrange the booking's lines to match the customer's actual PO.
   *
   * Sends the line ids in the order they should appear. The server requires a
   * permutation of this booking's own lines, so a stale copy is refused rather
   * than silently dropping whichever line the browser has forgotten about.
   */
  reorderLines: async (orderId, lineIds) => {
    const res = await api.put(
      `/sales/bookings/${encodeURIComponent(orderId)}/line-order`,
      { lineIds },
    );
    return res.data.data;
  },

  /**
   * Correct the customer/order details after submission. Admin only.
   *
   * Send ONLY the fields being changed - the endpoint treats an absent field as
   * "leave it alone" and an empty string as "clear it", so spreading a whole
   * form object in would rewrite fields the admin never touched.
   */
  updateDetails: async (orderId, patch) => {
    const res = await api.patch(
      `/sales/bookings/${encodeURIComponent(orderId)}/details`,
      patch,
    );
    return res.data.data;
  },

  /** Set, change or clear (priceType: null) the rate a booking is offered at. */
  setPricing: async (orderId, priceType) => {
    const res = await api.put(
      `/sales/bookings/${encodeURIComponent(orderId)}/pricing`,
      { priceType: priceType || null },
    );
    return res.data;
  },
};

export default salesApi;
