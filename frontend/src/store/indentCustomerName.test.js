import { describe, test, expect } from "vitest";

import { groupIndents } from "./indentHistoryStore";

/**
 * The Customer Name / Company Name split in Indent History.
 *
 * The companion to `services/customerName.test.js`, which pins the same rule on
 * the booking side. Both exist because of one bug, reported once and latent
 * twice: a Customer Name column that falls back to the company shows the
 * company for every account whose master record has no Customer Name, and two
 * customers at one company then look identical.
 *
 * Indent History carried exactly that fallback — its `customer` string resolves
 * `name || company || email` — so the fix is not "add a column" but "add a
 * column that resolves the name differently from the one already there". These
 * pin the difference, in both directions:
 *
 *   the new column NEVER falls back to the company, and
 *   the old `customer` string still does, because the customer FILTER matches
 *     on it and changing it would silently change what a filter selects.
 */

/** One pending reservation row, in the shape `groupIndents` consumes. */
const line = (over = {}) => ({
  _id: "r1",
  id: "RSV-1",
  status: "Pending",
  indentNumber: "IND-2026-000007",
  bookingId: "BO-2026-000042",
  pendingQuantity: 5,
  updatedAt: "2026-09-12T00:00:00.000Z",
  customer: { name: "ABC Motors Pvt Ltd" },
  customerProfile: null,
  product: { code: "SKU-1", availableStock: 10 },
  ...over,
});

const first = (over) => groupIndents([line(over)])[0];

describe("customerName on an indent", () => {
  test("uses the Customer Master name when there is one", () => {
    const indent = first({
      customerProfile: { customerName: "ABC Motors — Pune", company: "ABC Motors Pvt Ltd" },
    });

    expect(indent.customerName).toBe("ABC Motors — Pune");
    expect(indent.customerCompany).toBe("ABC Motors Pvt Ltd");
  });

  test("falls back to the CONTACT name, never the company", () => {
    const indent = first({
      customerProfile: {
        customerName: null,
        contactName: "Rajesh Kumar",
        company: "ABC Motors Pvt Ltd",
      },
    });

    // A person's name is what tells two customers at one company apart.
    expect(indent.customerName).toBe("Rajesh Kumar");
    expect(indent.customerName).not.toBe("ABC Motors Pvt Ltd");
  });

  test("is null when the master record has neither, so the cell shows a dash", () => {
    const indent = first({
      customerProfile: { customerName: null, contactName: null, company: "ABC Motors Pvt Ltd" },
    });

    // An honest blank tells the admin the master record needs filling in; a
    // company name in a Customer Name column does not.
    expect(indent.customerName).toBeNull();
    expect(indent.customerCompany).toBe("ABC Motors Pvt Ltd");
  });

  test("is null when there is no profile at all", () => {
    expect(first({ customerProfile: null }).customerName).toBeNull();
  });

  test("the company is kept even when it equals the name", () => {
    const indent = first({
      customerProfile: { customerName: "ABC Motors Pvt Ltd", company: "ABC Motors Pvt Ltd" },
    });

    // Suppressing it as "duplicate" is what made the booking table look like it
    // showed nothing but company names. A blank would read as "no company
    // recorded", which is a different fact.
    expect(indent.customerCompany).toBe("ABC Motors Pvt Ltd");
  });

  test("carries the contact pair the name cell prints beneath it", () => {
    const indent = first({
      customerProfile: {
        customerName: "ABC Motors — Pune",
        location: "Pune",
        phone: "9876543210",
      },
    });

    expect(indent.customerLocation).toBe("Pune");
    expect(indent.customerPhone).toBe("9876543210");
  });
});

describe("the customer string the filter matches on", () => {
  test("is left alone, company fallback and all", () => {
    /*
     * Deliberately NOT changed. The toolbar's customer dropdown and the search
     * box both key on `customer`, so making it resolve like `customerName`
     * would silently change which indents a chosen filter selects — a
     * regression with no error message attached.
     */
    const indent = first({
      customer: { name: "ABC Motors Pvt Ltd" },
      customerProfile: { customerName: null, contactName: "Rajesh Kumar", company: "ABC Motors Pvt Ltd" },
    });

    expect(indent.customer).toBe("ABC Motors Pvt Ltd");
    // The whole point of the split: these two answer different questions.
    expect(indent.customerName).toBe("Rajesh Kumar");
  });

  test("falls back to a dash rather than undefined", () => {
    expect(first({ customer: null }).customer).toBe("—");
  });
});

describe("grouping is unaffected", () => {
  test("lines sharing an indent number stay one row, with the customer resolved once", () => {
    const profile = { customerName: "ABC Motors — Pune", company: "ABC Motors Pvt Ltd" };
    const rows = groupIndents([
      line({ _id: "a", customerProfile: profile, product: { code: "SKU-1", availableStock: 4 } }),
      line({ _id: "b", customerProfile: profile, product: { code: "SKU-2", availableStock: 0 } }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].lines).toHaveLength(2);
    expect(rows[0].customerName).toBe("ABC Motors — Pune");
  });
});
