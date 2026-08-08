import { api } from "./api";

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
      warehouse: 'Default',
      availableStock: order.requestedQty || 0,
      unit: 'PCS'
    },
    orderQuantity: order.requestedQty || 0
  }];

  const totalQuantity = order.requestedQty || items.reduce((sum, item) => sum + (item.orderQuantity || item.quantity || 0), 0);
  
  return {
    ...order,
    id: order._id,
    orderNumber: order.orderId || order.orderNumber || order._id,
    customer: order.company || order.customer || 'Unknown',
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
    // Prefer a row whose status reflects progress beyond the initial stage if
    // the group's rows ever diverge; otherwise use the first.
    const initialStages = ['PO Received', 'Booked'];
    const primary = rows.find((r) => !initialStages.includes(r.status)) || rows[0];
    const mapped = mapOrder(primary);
    const items = rows.flatMap((r) => mapOrder(r).items);
    const totalQuantity = items.reduce(
      (sum, item) => sum + (item.orderQuantity || item.quantity || 0),
      0,
    );
    // Per-SKU line detail (raw quantity fields) for the detailed export.
    const lineItems = rows.map((r) => ({
      skuCode: r.skuCode,
      msilCode: r.msilCode || null,
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
      // Whether any row still holds reserved stock, which is what makes the
      // booking cancellable. Taken across ALL rows rather than the primary one:
      // a booking is only fully settled when every line is, and reading one row
      // would hide stock still held by the others.
      hasReservedStock: rows.some((r) => (r.stockState ?? 'reserved') === 'reserved'),
      // Raised automatically when a waiting indent came back into stock. Shown
      // so a customer is not puzzled by a booking they do not remember making.
      autoBooked: rows.some((r) => /^Auto-booked from indent/.test(r.remarks || '')),
    };
  });
};

export const ordersApi = {
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

  // A "booking" spans multiple underlying line-item Order documents that
  // share one orderId — updating status must apply to every one of them.
  updateStatus: async (ids, status, remarks) => {
    const targets = Array.isArray(ids) ? ids : [ids];
    await Promise.all(
      targets.map((id) => api.put(`/orders/${id}/status`, { status, remarks })),
    );
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
