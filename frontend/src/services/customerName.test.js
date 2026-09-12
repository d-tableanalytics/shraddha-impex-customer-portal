import { describe, test, expect } from "vitest";

import { mapOrder } from "./orders";

/**
 * The Customer Name / Company Name split in Booking History.
 *
 * The reported bug was that Booking History "displays only the Company Name".
 * The cause is a fallback chain, not a missing field: `customer` falls back to
 * `order.company`, so an account whose master record has no Customer Name got
 * the company in that slot — and the secondary "…and the company" line was then
 * suppressed for being identical to it. Two customers at one company looked the
 * same.
 *
 * These pin the rule that fixes it: the Customer Name never falls back to the
 * company.
 */

const order = (over = {}) => ({
  _id: "1",
  orderId: "BO-2026-000042",
  company: "ABC Motors Pvt Ltd",
  createdAt: "2026-09-12T00:00:00.000Z",
  ...over,
});

describe("customerName on a booking", () => {
  test("uses the Customer Master name when there is one", () => {
    const o = mapOrder(order({
      customerProfile: { customerName: "ABC Motors — Pune", company: "ABC Motors Pvt Ltd" },
    }));
    expect(o.customerName).toBe("ABC Motors — Pune");
    expect(o.customerCompany).toBe("ABC Motors Pvt Ltd");
  });

  test("falls back to the CONTACT name, never the company", () => {
    const o = mapOrder(order({
      customerProfile: { customerName: null, contactName: "Rajesh Kumar", company: "ABC Motors Pvt Ltd" },
    }));
    // A person's name is what tells two customers at one company apart.
    expect(o.customerName).toBe("Rajesh Kumar");
    expect(o.customerName).not.toBe("ABC Motors Pvt Ltd");
  });

  test("is null when the master record has neither", () => {
    const o = mapOrder(order({ customerProfile: { customerName: null, contactName: null } }));
    // Null so the screen can show a dash. A company name here would be the
    // original bug, and it is the kind nobody reports because it looks filled in.
    expect(o.customerName).toBeNull();
  });

  test("is null when the customer account is gone entirely", () => {
    const o = mapOrder(order({ customerProfile: null }));
    expect(o.customerName).toBeNull();
    // The company still comes off the booking's own snapshot.
    expect(o.customerCompany).toBe("ABC Motors Pvt Ltd");
  });

  test("two customers at one company are distinguishable", () => {
    const a = mapOrder(order({
      customerProfile: { customerName: "ABC Motors — Pune", company: "ABC Motors Pvt Ltd" },
    }));
    const b = mapOrder(order({
      orderId: "BO-2026-000043",
      customerProfile: { customerName: "ABC Motors — Nashik", company: "ABC Motors Pvt Ltd" },
    }));

    // The whole point of the requirement.
    expect(a.customerName).not.toBe(b.customerName);
    expect(a.customerCompany).toBe(b.customerCompany);
  });

  test("the existing `customer` field is left alone", () => {
    const o = mapOrder(order({
      customerProfile: { customerName: "ABC Motors — Pune", company: "ABC Motors Pvt Ltd" },
    }));
    // Search, the customer filter dropdown and the exports all read this.
    // Changing its fallback chain would quietly change all three.
    expect(o.customer).toBe("ABC Motors — Pune");
  });
});
