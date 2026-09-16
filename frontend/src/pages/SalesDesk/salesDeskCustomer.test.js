import { describe, test, expect } from "vitest";

import { customerNameOf, companyNameOf } from "./SalesDesk";

/**
 * The Customer Name / Company Name split on the Sales Desk.
 *
 * The desk showed ONE column, "Customer", filled from `booking.customer` —
 * which is `Order.company`, the value stamped on the order from
 * `req.user.company` when it was placed. `User.company` defaults to null, so a
 * customer onboarded without a company recorded showed a dash on every booking
 * they had ever made, while Booking History showed their name perfectly well.
 *
 * These pin the same rule `services/customerName.test.js` pins for Booking
 * History, because it is the rule that is easy to get wrong in the helpful
 * direction: THE CUSTOMER NAME NEVER FALLS BACK TO THE COMPANY. Filling that
 * slot with a company makes two customers at one company identical, and the
 * failure looks filled in, so nobody reports it.
 */

const booking = (over = {}) => ({
  orderId: "BO-2026-000042",
  // The booking's own stamped company, which is what the column used to show.
  customer: "ABC Motors Pvt Ltd",
  ...over,
});

describe("the Customer Name column", () => {
  test("uses the Customer Master name when there is one", () => {
    const b = booking({
      customerProfile: { customerName: "ABC Motors — Pune", company: "ABC Motors Pvt Ltd" },
    });
    expect(customerNameOf(b)).toBe("ABC Motors — Pune");
  });

  test("🔴 falls back to the CONTACT person, never to the company", () => {
    const b = booking({
      customerProfile: {
        customerName: null,
        contactName: "Rajesh Kumar",
        company: "ABC Motors Pvt Ltd",
      },
    });
    expect(customerNameOf(b)).toBe("Rajesh Kumar");
    expect(customerNameOf(b)).not.toBe("ABC Motors Pvt Ltd");
  });

  test("🔴 is null when the master record has neither — even though the booking has a company", () => {
    const b = booking({ customerProfile: { customerName: null, contactName: null } });
    // Null so the cell can show a dash. The company IS available on the row and
    // is deliberately not used: it has its own column, and borrowing it here is
    // the original defect.
    expect(customerNameOf(b)).toBeNull();
    expect(companyNameOf(b)).toBe("ABC Motors Pvt Ltd");
  });

  test("is null for a booking whose customer account has been deleted", () => {
    // No profile at all: `attachCustomerDetails` skips a row whose user is gone.
    expect(customerNameOf(booking())).toBeNull();
  });
});

describe("the Company Name column", () => {
  test("prefers the customer's CURRENT company over the booking's snapshot", () => {
    const b = booking({
      customer: "ABC Motors",
      customerProfile: { customerName: "X", company: "ABC Motors Pvt Ltd" },
    });
    // The profile is read live, so a company corrected in User Management shows
    // on past bookings — the whole point of attachCustomerDetails.
    expect(companyNameOf(b)).toBe("ABC Motors Pvt Ltd");
  });

  test("falls back to the booking's stamped company when there is no profile", () => {
    // The only value available for a deleted customer account, and the reason
    // the column is not simply dropped.
    expect(companyNameOf(booking())).toBe("ABC Motors Pvt Ltd");
  });

  test("is null when neither exists", () => {
    expect(companyNameOf(booking({ customer: null }))).toBeNull();
  });
});
