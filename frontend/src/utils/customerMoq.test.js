import { describe, test, expect } from "vitest";

/**
 * The client half of the two rules this feature added, held to the server's
 * copy by test.
 *
 * The frontend mirrors `backend/utils/moq.js` by hand, and the two disagreeing
 * is not a cosmetic bug: the client either blocks a quantity the server would
 * have accepted, or offers one it will reject. The same applies to who may
 * amend a booking after its PO — the drawer hides a control the server would
 * have allowed, or shows one that 423s. So both files are imported here and
 * asked the same questions.
 */

import * as fe from "./moq";
import * as be from "../../../backend/utils/moq.js";
import { AMENDABLE_STATUSES as BE_AMENDABLE } from "../../../backend/utils/bookingLock.js";
import { AMENDABLE_STATUSES as FE_AMENDABLE } from "../constants/bookingLifecycle";
import { canAmendBookingItems, canEditBooking, PERMISSIONS } from "./permissions";

const PRODUCT = { skuCode: "SKU-1", moq: 10 };

const ACCOUNTS = {
  "MSIL": { customerCategory: "MSIL", email: "a@maruti.com" },
  "MSIL with a stale APPLICABLE on it": {
    customerCategory: "MSIL", email: "a@maruti.com", moqMode: "APPLICABLE", moqValue: 5,
  },
  "Customer, applicable": { customerCategory: "Customer", email: "a@acme.com", moqMode: "APPLICABLE" },
  "Customer, applicable with a value": {
    customerCategory: "Customer", email: "a@acme.com", moqMode: "APPLICABLE", moqValue: 25,
  },
  "Customer, not applicable": {
    customerCategory: "Customer", email: "a@acme.com", moqMode: "NOT_APPLICABLE",
  },
  "Customer, never configured": { customerCategory: "Customer", email: "a@acme.com" },
  "legacy SKIP override": { customerCategory: "Customer", email: "a@acme.com", moq: "SKIP" },
  "company staff": { email: "desk@shraddhaimpex.net" },
};

describe("the client MOQ rule agrees with the server's", () => {
  test.each(Object.entries(ACCOUNTS))("%s", (_label, user) => {
    expect(fe.moqAppliesTo(user)).toBe(be.moqAppliesTo(user));
    expect(fe.moqModeOf(user)).toBe(be.moqModeOf(user));
    expect(fe.effectiveMoq(user, PRODUCT)).toBe(be.effectiveMoq(user, PRODUCT));
    for (const q of [1, 7, 10, 15, 25, 50]) {
      // The wording differs (the server names the SKU); whether it refuses
      // must not.
      expect(Boolean(fe.moqError(user, PRODUCT, q)))
        .toBe(Boolean(be.moqError(user, PRODUCT, q)));
    }
  });
});

describe("the three behaviours the requirement names", () => {
  test("MSIL: no restriction", () => {
    expect(fe.moqAppliesTo(ACCOUNTS.MSIL)).toBe(false);
    expect(fe.moqError(ACCOUNTS.MSIL, PRODUCT, 3)).toBeNull();
  });

  test("Customer + applicable: enforced", () => {
    const user = ACCOUNTS["Customer, applicable"];
    expect(fe.moqError(user, PRODUCT, 15)).toMatch(/multiple of 10/);
    expect(fe.moqError(user, PRODUCT, 20)).toBeNull();
  });

  test("Customer + not applicable: no restriction", () => {
    const user = ACCOUNTS["Customer, not applicable"];
    expect(fe.moqError(user, PRODUCT, 7)).toBeNull();
  });

  test("a configured value overrides the product Multiple", () => {
    const user = ACCOUNTS["Customer, applicable with a value"];
    expect(fe.effectiveMoq(user, PRODUCT)).toBe(25);
    expect(fe.moqError(user, PRODUCT, 20)).toMatch(/multiple of 25/);
  });

  test("an unconfigured customer keeps the behaviour they already had", () => {
    const user = ACCOUNTS["Customer, never configured"];
    expect(user.moqMode).toBeUndefined();
    expect(fe.moqAppliesTo(user)).toBe(true);
    expect(fe.effectiveMoq(user, PRODUCT)).toBe(10);
  });
});

describe("the amendable statuses mirror the server's", () => {
  test("same list, so the screen and the server close at the same moment", () => {
    expect(FE_AMENDABLE).toEqual(BE_AMENDABLE);
  });
});

describe("who the drawer offers the item controls to", () => {
  const SALES = { role: "Sales", permissions: [PERMISSIONS.EDIT_BOOKING_PRE_PO, PERMISSIONS.AMEND_BOOKING_POST_PO] };
  const ADMIN = { role: "Super Admin", permissions: ["*"] };
  const CUSTOMER = { role: "Customer", permissions: ["create_order", "view_orders"] };

  const PENDING = { locked: false, amendable: true };
  const COMMITTED = { locked: true, amendable: true };
  const DISPATCHED = { locked: true, amendable: false, amendBlockedReason: "dispatched" };

  test("before the PO: Sales and Admin, not the customer", () => {
    expect(canAmendBookingItems(SALES, PENDING)).toBe(true);
    expect(canAmendBookingItems(ADMIN, PENDING)).toBe(true);
    expect(canAmendBookingItems(CUSTOMER, PENDING)).toBe(false);
  });

  test("after the PO: Sales may amend the items, and may NOT reopen the booking", () => {
    expect(canAmendBookingItems(SALES, COMMITTED)).toBe(true);
    // The wide question — reordering lines, correcting the details — stays
    // Admin-only, which is the separation of duties the permission split keeps.
    expect(canEditBooking(SALES, COMMITTED)).toBe(false);
    expect(canEditBooking(ADMIN, COMMITTED)).toBe(true);
  });

  test("a salesperson WITHOUT the new key loses nothing but gains nothing", () => {
    const old = { role: "Sales", permissions: [PERMISSIONS.EDIT_BOOKING_PRE_PO] };
    expect(canAmendBookingItems(old, PENDING)).toBe(true);
    expect(canAmendBookingItems(old, COMMITTED)).toBe(false);
  });

  test("once dispatched, nobody — the wildcard included", () => {
    expect(canAmendBookingItems(SALES, DISPATCHED)).toBe(false);
    expect(canAmendBookingItems(ADMIN, DISPATCHED)).toBe(false);
  });

  test("a payload from before `amendable` existed is treated as before", () => {
    // Undefined is 'no information', not 'blocked': an older cached response
    // must not silently disable the desk's controls.
    expect(canAmendBookingItems(ADMIN, { locked: true })).toBe(true);
    expect(canAmendBookingItems(SALES, { locked: false })).toBe(true);
  });
});
