import { describe, test, expect } from "vitest";

import {
  picklistFromSalesBooking,
  picklistFromCustomerOrder,
  allocationPicklistFromSalesBooking,
  allocationPicklistFromCustomerOrder,
} from "./picklistDocument";

/**
 * Pick lists when indent stock arrived later.
 *
 * Booking 50, 30 confirmed at booking time, then inward allocation 1 (10) and
 * allocation 2 (5). The line's confirmedQty is 45. The booking's own pick list
 * covers the 30; each allocation has its own, so no unit is picked twice.
 */
const line = {
  id: "row-1",
  skuCode: "183H.35-8",
  bookedQty: 50,
  confirmedQty: 45,
  pendingQty: 5,
  unitPrice: 100,
  amount: 4500, // the server's figure, covering the allocations too
  allocations: [
    { seq: 1, quantity: 10, at: "2026-10-12T00:00:00Z", status: "PO Received" },
    { seq: 2, quantity: 5, at: "2026-10-14T00:00:00Z", status: "PO Received" },
  ],
};
// A SKU with nothing confirmed at booking time, only an allocation.
const onlyAllocated = {
  id: "row-2", skuCode: "SKU-B", bookedQty: 12, confirmedQty: 4, pendingQty: 8, unitPrice: 50,
  allocations: [{ seq: 1, quantity: 4, at: "2026-10-12T00:00:00Z" }],
};

const salesBooking = { orderId: "BO-2026-001025", poNumber: "PO-1", locked: true, lines: [line, onlyAllocated], value: { indent: { quantity: 13 } } };
const customerOrder = { orderNumber: "BO-2026-001025", poNumber: "PO-1", locked: true, lineItems: [line, onlyAllocated] };

describe("the booking's own pick list", () => {
  test.each([
    ["sales desk", () => picklistFromSalesBooking(salesBooking)],
    ["customer", () => picklistFromCustomerOrder(customerOrder)],
  ])("%s copy prints what was confirmed at booking time", (_, build) => {
    const doc = build();
    expect(doc.lines.map((l) => [l.skuCode, l.quantity, l.amount])).toEqual([["183H.35-8", 30, 3000]]);
    expect(doc.allocationLabel).toBeNull();
  });
});

describe("an allocation's own pick list", () => {
  test("sales desk copy: that allocation only, labelled, no indent section", () => {
    const doc = allocationPicklistFromSalesBooking(salesBooking, line, line.allocations[0]);
    expect(doc.allocationLabel).toBe("Inward allocation 1");
    expect(doc.orderId).toBe("BO-2026-001025");
    expect(doc.poNumber).toBe("PO-1");
    expect(doc.lines.map((l) => [l.skuCode, l.quantity, l.amount, l.pendingQty])).toEqual([["183H.35-8", 10, 1000, 0]]);
    expect(doc.totals.indent).toBeNull();
  });

  test("customer copy: allocation 2", () => {
    const doc = allocationPicklistFromCustomerOrder(customerOrder, line, line.allocations[1]);
    expect(doc.allocationLabel).toBe("Inward allocation 2");
    expect(doc.lines.map((l) => [l.skuCode, l.quantity])).toEqual([["183H.35-8", 5]]);
  });

  test("a line that exists only for its allocation still gets one", () => {
    const doc = allocationPicklistFromSalesBooking(salesBooking, onlyAllocated, onlyAllocated.allocations[0]);
    expect(doc.lines.map((l) => [l.skuCode, l.quantity])).toEqual([["SKU-B", 4]]);
  });
});

describe("bookings without allocations", () => {
  test("are printed exactly as before", () => {
    const plain = { ...line, confirmedQty: 30, amount: 3000, allocations: [] };
    const doc = picklistFromSalesBooking({ ...salesBooking, lines: [plain] });
    expect(doc.lines.map((l) => [l.quantity, l.amount])).toEqual([[30, 3000]]);
  });
});
