import { describe, test, expect } from "vitest";

import {
  picklistFromSalesBooking,
  picklistFromCustomerOrder,
  allocationPicklistFromSalesBooking,
  allocationPicklistFromCustomerOrder,
} from "./picklistDocument";
import { allocationBatches } from "./allocationBatches";

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

describe("an inward allocation's pick list — every SKU booked in that batch", () => {
  // Batch 1 (12 Oct): 10 of 183H.35-8 and the 4 of SKU-B. Batch 2 (14 Oct): 5 of 183H.35-8.
  const [batch1, batch2] = allocationBatches([line, onlyAllocated]);

  test("sales desk copy: one document for the batch, every SKU in it, no indent section", () => {
    const doc = allocationPicklistFromSalesBooking(salesBooking, batch1);
    expect(doc.allocationLabel).toBe("Inward allocation 1");
    expect(doc.orderId).toBe("BO-2026-001025");
    expect(doc.poNumber).toBe("PO-1");
    expect(doc.lines.map((l) => [l.skuCode, l.quantity, l.amount, l.pendingQty])).toEqual([
      ["183H.35-8", 10, 1000, 0],
      ["SKU-B", 4, 200, 0],
    ]);
    expect(doc.totals.indent).toBeNull();
  });

  test("customer copy: a later batch is its own document", () => {
    const doc = allocationPicklistFromCustomerOrder(customerOrder, batch2);
    expect(doc.allocationLabel).toBe("Inward allocation 2");
    expect(doc.lines.map((l) => [l.skuCode, l.quantity])).toEqual([["183H.35-8", 5]]);
  });

  test("two indents of one SKU in a batch make one pick line", () => {
    const twice = {
      ...line,
      allocations: [
        { seq: 1, quantity: 10, indentNumber: "PI-A", at: "2026-10-12T00:00:00Z" },
        { seq: 2, quantity: 6, indentNumber: "PI-B", at: "2026-10-12T00:00:00Z" },
      ],
    };
    const [batch] = allocationBatches([twice]);
    const doc = allocationPicklistFromSalesBooking({ ...salesBooking, lines: [twice] }, batch);
    expect(doc.lines.map((l) => [l.skuCode, l.quantity])).toEqual([["183H.35-8", 16]]);
  });
});

describe("bookings without allocations", () => {
  test("are printed exactly as before", () => {
    const plain = { ...line, confirmedQty: 30, amount: 3000, allocations: [] };
    const doc = picklistFromSalesBooking({ ...salesBooking, lines: [plain] });
    expect(doc.lines.map((l) => [l.quantity, l.amount])).toEqual([[30, 3000]]);
  });
});
