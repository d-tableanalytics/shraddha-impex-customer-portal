import { api } from "./api";

export const reservationsApi = {
  getAll: async () => {
    const response = await api.get('/reservations');
    return response.data.data || [];
  },

  getPending: async () => {
    const response = await api.get('/reservations/pending');
    return response.data.data || [];
  },

  getCancelledCount: async () => {
    const response = await api.get('/reservations/cancelled-count');
    return response.data.data?.count ?? 0;
  },

  create: async (productId, quantity) => {
    const response = await api.post('/reservations', { productId, quantity });
    // 201 is a new line; 200 means the product was already in the selection
    // list and the quantity was merged into that existing line.
    return { reservation: response.data.data, merged: response.status === 200 };
  },

  updateQuantity: async (id, quantity) => {
    const response = await api.put(`/reservations/${id}`, { quantity });
    return response.data.data;
  },

  cancel: async (id) => {
    const response = await api.delete(`/reservations/${id}`);
    return response.data.data;
  },

  /**
   * Set the expected availability date for one or more indented SKUs.
   * Sends a LIST, so scheduling several lines is one save and one email.
   */
  schedule: async (items) => {
    const response = await api.post("/reservations/schedule", { items });
    return response.data;
  },

  // No restore() wrapper: the "To Selection List" action it served has been
  // removed from the UI. POST /reservations/:id/restore still exists on the
  // server for anything calling the API directly.

  confirm: async (deliveryLocation, remarks) => {
    const response = await api.post('/reservations/confirm', { deliveryLocation, remarks });
    return response.data.data;
  },

  /**
   * Book a set of lines outright, with no Selection List step.
   *
   * What "Continue to Booking" on the bulk upload screen calls. One request
   * reserves and confirms every line in a single transaction, so an uploaded
   * sheet either becomes a booking (plus an indent for anything short of stock)
   * or is not written at all — it can never half-book, and it never leaves rows
   * sitting in the customer's Selection List.
   *
   * Returns the same payload as confirm(): orderId, indentId, outcome, summary
   * and totals.
   *
   * @param {Array} items [{ productId, quantity }]
   */
  directBooking: async (items, { poNumber, deliveryLocation, remarks } = {}) => {
    const response = await api.post('/reservations/direct-booking', {
      items,
      poNumber,
      deliveryLocation,
      remarks,
    });
    return response.data.data;
  },
};

export const notificationsApi = {
  getAll: async () => {
    const response = await api.get('/notifications');
    return response.data.data || [];
  },

  markAllRead: async () => {
    const response = await api.put('/notifications/mark-read');
    return response.data;
  },

  markOneRead: async (id) => {
    const response = await api.patch(`/notifications/${id}/read`);
    return response.data.data;
  }
};
