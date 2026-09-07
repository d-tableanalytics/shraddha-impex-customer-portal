import { asPrice, lineAmount, labelForPriceType } from "../constants/pricing";

/**
 * The picklist / PO document, as one shape.
 *
 * TWO CALLERS BUILD IT AND ONE COMPONENT RENDERS IT. The sales desk holds a
 * shaped booking from /sales/bookings; the customer holds a grouped booking
 * from /orders. Those are different objects, and letting the document component
 * know about both would mean two layouts that drift — the customer eventually
 * seeing a subtly different paper from the one the desk approved.
 *
 * So the adapters below are the only code that knows either source, and they
 * produce the same fields. What differs between the two is not the layout but
 * WHAT IS IN IT:
 *
 *   priceTypeLabel   the desk's copy names the schedule; the customer's is
 *                    null, because naming their tier tells them other tiers
 *                    exist. They see the rate they were given, which is what
 *                    was agreed.
 *   boxNo            the desk's copy carries it; the customer's does not, and
 *                    on the customer's the server has already removed it.
 *
 * Neither adapter can invent a price: both read a rate that is already on the
 * data they were handed, and the server decides what that contains.
 */

const asText = (v) => {
  const s = String(v ?? "").trim();
  return s === "" || s === "-" ? null : s;
};

const poRaised = (booking) =>
  Boolean(booking?.locked)
  && asText(booking?.poNumber) !== null;

/** Rows to a document. Shared tail of both adapters. */
const assemble = ({
  audience, orderId, poNumber, poDate, date, status, customer,
  lines, priceTypeLabel, paymentTerm, promiseDate, showBoxNo,
}) => {
  const totalQuantity = lines.reduce((n, l) => n + (l.quantity || 0), 0);
  const priced = lines.filter((l) => l.unitPrice !== null);
  const totalAmount = priced.length
    ? Math.round(lines.reduce((n, l) => n + (l.amount || 0), 0) * 100) / 100
    : null;

  return {
    audience,
    orderId,
    poNumber,
    poDate,
    date,
    status,
    customer,
    paymentTerm,
    promiseDate,
    // Named only on the internal copy — see the note at the top of this file.
    priceTypeLabel: audience === "internal" ? priceTypeLabel : null,
    showBoxNo,
    lines: lines.map((l, i) => ({ ...l, sr: i + 1 })),
    totals: {
      quantity: totalQuantity,
      amount: totalAmount,
      pricedLines: priced.length,
      unpricedLines: lines.length - priced.length,
    },
  };
};

/**
 * The sales desk's copy, from a booking shaped by /sales/bookings.
 *
 * `showBoxNo` comes from canViewLineItemBoxNo() at the call site rather than
 * being assumed: the same desk screen is open to roles that may not see a box,
 * and the server has already withheld it from them.
 */
export const picklistFromSalesBooking = (booking, { showBoxNo = false } = {}) => {
  if (!booking) return null;
  const profile = booking.customerProfile || {};

  const lines = (booking.lines || []).map((l) => {
    const quantity = l.confirmedQty ?? 0;
    const unitPrice = asPrice(l.unitPrice);
    return {
      itemCode: asText(l.msilCode),
      skuCode: l.skuCode,
      boxNo: asText(l.boxNo),
      quantity,
      pendingQty: l.pendingQty || 0,
      unitPrice,
      // l.amount is what the server computed; recomputing from the rate keeps
      // the document consistent if only one of the two was sent.
      amount: l.amount ?? lineAmount(unitPrice, quantity),
    };
  });

  return assemble({
    audience: "internal",
    orderId: booking.orderId,
    poNumber: poRaised(booking) ? booking.poNumber : null,
    poDate: booking.poDate || null,
    date: booking.date || null,
    status: booking.status || null,
    customer: {
      name: profile.customerName || booking.customer || null,
      company: profile.company || null,
      phone: booking.phoneNumber || profile.phone || null,
      location: booking.shippingAddress || booking.location || profile.location || null,
      gstNumber: booking.gstCode || profile.gstNumber || null,
      shopNumber: booking.shopNumber || profile.shopNumber || null,
      vendorCode: booking.vendorCode || profile.vendorNumber || null,
    },
    lines,
    priceTypeLabel: booking.pricing?.priceTypeLabel
      || labelForPriceType(booking.pricing?.priceType),
    paymentTerm: booking.paymentTerm || null,
    promiseDate: booking.promiseDate || null,
    showBoxNo,
  });
};

/**
 * The customer's copy, from a booking grouped by services/orders.js.
 *
 * Returns null unless the PO has been raised: a picklist is a document about a
 * purchase order, and before one exists there is nothing to preview. The rate
 * is whatever survived the server's redaction, so an unpriced PO renders the
 * same document with no money columns rather than a broken one.
 */
export const picklistFromCustomerOrder = (order) => {
  if (!order || !poRaised(order)) return null;

  const source = (order.lineItems?.length ? order.lineItems : order.items || []).map((l) => {
    // lineItems and items are shaped differently; both appear here because
    // Booking History builds one and the drawer the other.
    const skuCode = l.skuCode || l.product?.code || null;
    const quantity = l.confirmedQty ?? l.orderQuantity ?? l.quantity ?? 0;
    const unitPrice = asPrice(l.unitPrice ?? l.product?.unitPrice);
    return {
      itemCode: asText(l.msilCode || l.product?.msilCode),
      skuCode,
      boxNo: null, // never on a customer's copy
      quantity,
      pendingQty: l.pendingQty || 0,
      unitPrice,
      amount: l.amount ?? lineAmount(unitPrice, quantity),
    };
  });

  return assemble({
    audience: "customer",
    orderId: order.orderNumber || order.orderId,
    poNumber: order.poNumber,
    poDate: order.poDate || null,
    date: order.date || null,
    status: order.status || null,
    customer: {
      name: order.customer || null,
      company: order.customerCompany || null,
      phone: order.customerPhone || order.phoneNumber || null,
      location: order.shippingAddress || order.customerLocation || order.location || null,
      gstNumber: order.gstCode || order.customerProfile?.gstNumber || null,
      shopNumber: order.shopNumber || order.customerProfile?.shopNumber || null,
      vendorCode: order.vendorCode || order.customerProfile?.vendorNumber || null,
    },
    lines: source,
    priceTypeLabel: null,
    paymentTerm: order.paymentTerm || null,
    promiseDate: order.promiseDate || order.supplyByDate || null,
    showBoxNo: false,
  });
};

export default { picklistFromSalesBooking, picklistFromCustomerOrder };
