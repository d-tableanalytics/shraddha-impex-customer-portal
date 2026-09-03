import { api } from "./api";
import { bookingStatusOf } from "../constants/bookingLifecycle";

export const mapOrder = (order) => {
  if (!order) return null;
  
  // Adapt single-product MongoDB schema to frontend's expected items array
  const items = order.items || [{
    product: {
      id: order.skuCode,
      code: order.skuCode,
      name: order.brand ? `${order.brand} Product` : order.skuCode,
      // The Order document carries the MSIL code, but it was never mapped
      // through, so every MSIL display in the drawer rendered blank.
      msilCode: order.msilCode || null,
      // The box this line is picked from, stamped onto the order row when the
      // booking was created. Shown on the line items to Sales and Admin only —
      // see canViewLineItemBoxNo().
      boxNo: order.boxNo || null,
      warehouse: 'Default',
      availableStock: order.requestedQty || 0,
      unit: 'PCS'
    },
    orderQuantity: order.requestedQty || 0,
    // The Order row this line came from. Carried so Booking History can edit
    // the quantity through the same sales endpoint the desk uses, which
    // addresses lines by row id.
    lineId: order._id,
    // Raw quantities, kept apart because three different things move them:
    // bookedQty is what the customer asked for, confirmedQty is what stock
    // covered and what a desk edit changes, pendingQty is the indent remainder.
    bookedQty: order.bookedQty ?? order.requestedQty ?? 0,
    confirmedQty: order.confirmedQty ?? order.requestedQty ?? 0,
    pendingQty: order.pendingQty ?? 0,
  }];

  const totalQuantity = order.requestedQty || items.reduce((sum, item) => sum + (item.orderQuantity || item.quantity || 0), 0);
  
  /**
   * The customer's CURRENT master details, from User Management.
   *
   * Attached by the server on every booking response, read live from the user
   * record rather than from the booking — so a detail an admin fills in after a
   * booking was placed still shows on it. `...order` would carry it anyway;
   * naming it here is what tells the next reader it exists and where it comes
   * from.
   *
   * Distinct from `order.location` / `order.phoneNumber`, which are the
   * BOOKING's own snapshot and may differ on purpose once a PO is raised.
   */
  const customerProfile = order.customerProfile || null;

  return {
    ...order,
    id: order._id,
    orderNumber: order.orderId || order.orderNumber || order._id,
    customerProfile,
    // The name to show. The Customer Master name is the legal entity we trade
    // with, so it leads; `company` is what the booking itself was stamped with
    // and is the fallback for accounts registered before the master details.
    customer: customerProfile?.customerName || order.company || order.customer || 'Unknown',
    // Kept separately so a screen can show both when they differ, rather than
    // silently picking one.
    customerCompany: customerProfile?.company || order.company || null,
    // Contact pair for display. The profile is the customer's registered pair;
    // the booking's own snapshot is the fallback and is what a raised PO used.
    customerPhone: customerProfile?.phone || order.phoneNumber || null,
    customerLocation: customerProfile?.location || order.location || null,
    date: order.createdAt || order.date || new Date().toISOString(),
    workflowStage: order.status, 
    items,
    totalQuantity,
    priority: order.priority || 'Medium',
    createdDate: order.createdAt || order.date || new Date().toISOString(),
    auditLogs: (order.auditLogs || []).map((log) => ({
      id: log._id || Math.random().toString(),
      action: log.action,
      user: log.user,
      role: log.role,
      timestamp: log.timestamp,
      ip: log.ip
    })),
    comments: (order.comments || []).map((c) => ({
      id: c._id || Math.random().toString(),
      user: c.user,
      role: c.role,
      text: c.text,
      timestamp: c.timestamp
    }))
  };
};

// The backend stores one flat Order document per line item, sharing a single
// orderId (booking id) across every item confirmed together. Group them back
// into one booking with a combined items array so Order History shows one
// row per booking instead of one row per line item.
const groupIntoBookings = (rawOrders) => {
  const byBookingId = new Map();
  for (const raw of rawOrders) {
    const key = raw.orderId || raw._id;
    if (!byBookingId.has(key)) byBookingId.set(key, []);
    byBookingId.get(key).push(raw);
  }

  return [...byBookingId.values()].map((rows) => {
    // The booking's stage is the LEAST advanced stage any live line sits at —
    // the same rule the server applies (utils/bookingLifecycle.js), so the
    // stage shown here is always the one the customer was emailed about.
    // Previously this preferred the MOST advanced row, which showed a booking
    // as dispatched while some of its lines were still being prepared.
    const status = bookingStatusOf(rows);
    const primary = rows.find((r) => r.status === status) || rows[0];
    const mapped = { ...mapOrder(primary), status, workflowStage: status };
    const items = rows.flatMap((r) => mapOrder(r).items);
    const totalQuantity = items.reduce(
      (sum, item) => sum + (item.orderQuantity || item.quantity || 0),
      0,
    );
    // Per-SKU line detail (raw quantity fields) for the detailed export.
    const lineItems = rows.map((r) => ({
      id: r._id,
      skuCode: r.skuCode,
      msilCode: r.msilCode || null,
      boxNo: r.boxNo || null,
      bookedQty: r.bookedQty ?? r.requestedQty ?? 0,   // originally booked
      confirmedQty: r.confirmedQty ?? r.requestedQty ?? 0, // fulfilled from stock
      pendingQty: r.pendingQty ?? 0,                    // indent (unfulfilled)
    }));

    return {
      ...mapped,
      lineItemIds: rows.map((r) => r._id),
      items,
      lineItems,
      totalQuantity,
      // What the CUSTOMER originally asked for across the booking, indent
      // included. Distinct from totalQuantity, which is what the booking holds
      // now — the two differ when stock was short or the desk amended a line.
      totalBookedQuantity: rows.reduce((n, r) => n + (r.bookedQty ?? r.requestedQty ?? 0), 0),
      // Still awaiting stock on the indent raised alongside this booking.
      totalIndentQuantity: rows.reduce((n, r) => n + (r.pendingQty ?? 0), 0),
      // Mirrors isBookingLocked() on the server: a booking is frozen once any
      // row carries a real PO number. '-' and blank are the "not raised yet"
      // placeholders. The server re-checks this on every write.
      locked: rows.some((r) => {
        const po = String(r.poNumber ?? '').trim();
        return Boolean(r.poGeneratedAt) || (po !== '' && po !== '-');
      }),
      // Whether any row still holds reserved stock, which is what makes the
      // booking cancellable. Taken across ALL rows rather than the primary one:
      // a booking is only fully settled when every line is, and reading one row
      // would hide stock still held by the others.
      hasReservedStock: rows.some((r) => (r.stockState ?? 'reserved') === 'reserved'),
      // Raised automatically when a waiting indent came back into stock. Shown
      // so a customer is not puzzled by a booking they do not remember making.
      autoBooked: rows.some((r) => /^Auto-booked from indent/.test(r.remarks || '')),
      // The indent it came from, pulled out here rather than re-parsed in the
      // component — the remarks string is a backend detail and only one place
      // should know its shape.
      autoBookedFrom: rows
        .map((r) => /^Auto-booked from indent (\S+)/.exec(r.remarks || '')?.[1])
        .find(Boolean) || null,
    };
  });
};

export const ordersApi = {
  /**
   * Amend the line quantities of a booking.
   *
   * ONE route for both audiences. The server decides what the caller may do:
   * staff get the full desk edit, a customer is confined to the quantity of
   * lines that already exist on their own booking. Pointing the customer at a
   * '/sales/' URL, or adding a second handler for them, would have meant two
   * code paths for one operation.
   *
   * lines: [{ id, skuCode, quantity }] — every line of the booking.
   */
  updateBookingItems: async (orderId, lines) => {
    const res = await api.put(
      `/orders/booking/${encodeURIComponent(orderId)}/items`,
      { lines },
    );
    return res.data;
  },

  /** Who changed the quantities on this booking, when, and to what. */
  getQuantityHistory: async (orderId) => {
    const res = await api.get(
      `/orders/booking/${encodeURIComponent(orderId)}/quantity-history`,
    );
    return res.data.data || { entries: [], changedByCustomer: false, changedByStaff: false };
  },

  getAll: async () => {
    const response = await api.get('/orders');
    return groupIntoBookings(response.data.data || []);
  },

  getById: async (id) => {
    const response = await api.get(`/orders/${id}`);
    return mapOrder(response.data.data);
  },

  create: async (orderData) => {
    const payload = {
      customer: orderData.customer,
      poNumber: orderData.poNumber,
      deliveryLocation: orderData.deliveryLocation,
      remarks: orderData.remarks,
      items: orderData.items.map((item) => ({
        productId: item.product.id || item.product._id,
        quantity: item.orderQuantity
      })),
      priority: orderData.priority || 'Medium',
    };
    const response = await api.post('/orders', payload);
    return mapOrder(response.data.data);
  },

  // A "booking" spans multiple underlying line-item Order documents that share
  // one orderId. This used to fire one request per line item, which moved the
  // rows correctly but sent the customer one email per SKU. One booking-level
  // request now moves every line, records a single timeline entry and sends
  // exactly one notification.
  //
  // Returns the server's verdict: `changed` is false when the booking was
  // already at that status (no email), and `notified` reports whether the
  // customer's email actually went.
  updateStatus: async (orderNumber, status, remarks) => {
    const response = await api.put(`/orders/booking/${orderNumber}/status`, { status, remarks });
    return response.data;
  },

  // The booking's lifecycle history. Staff additionally receive the per-event
  // notification log; a customer gets the stages and their timestamps only.
  getTimeline: async (orderNumber) => {
    const response = await api.get(`/orders/booking/${orderNumber}/timeline`);
    return response.data.data;
  },

  // Retry a status email that never reached the customer. Staff only.
  resendStatusEmail: async (eventId) => {
    const response = await api.post(`/orders/booking/status-events/${eventId}/resend`);
    return response.data;
  },

  updatePO: async (orderNumber, poNumber) => {
    const response = await api.put(`/orders/${orderNumber}/po`, { poNumber });
    return response.data;
  },

  // Cancel a whole booking and hand its reserved stock back. Takes the booking
  // id, not a row id: a booking is every row sharing one orderId, and releasing
  // some rows while leaving others reserved would strand stock.
  cancel: async (orderNumber, reason) => {
    const response = await api.post(`/orders/${orderNumber}/cancel`, { reason });
    return response.data;
  }
};
