import { describe, test, expect } from "vitest";
import { quantityText, isSigned, signedQty } from "./stockActivity";

/**
 * The sign rule.
 *
 * A + or a − on a stock screen is a claim that goods moved. The ledger stores a
 * booking confirmation as RESERVE +4 — honest about the BOOKED count, which did
 * go up by four — but printed bold on a row whose own caption reads "stock
 * unchanged", it says the opposite of the caption and wins the glance.
 *
 * So the sign belongs to physical stock and nothing else. These tests exist
 * because that is a rule nobody would infer from the data: the quantity field
 * is signed either way, and only `balanceKind` says what the sign means.
 */

describe("only physical stock carries a sign", () => {
  test("a receipt keeps its +", () => {
    expect(quantityText(50, "onHand")).toBe("+50");
  });

  test("an issue keeps its −", () => {
    expect(quantityText(-20, "onHand")).toBe("-20");
  });

  test("a booking shows a plain count, never +4", () => {
    expect(quantityText(4, "booked")).toBe("4");
    expect(quantityText(4, "booked")).not.toContain("+");
  });

  test("a release shows a plain count, never −4", () => {
    // Negative in the ledger, because the booked total fell. Nothing left the
    // building, so nothing is subtracted on screen.
    expect(quantityText(-4, "booked")).toBe("4");
    expect(quantityText(-4, "booked")).not.toContain("-");
  });

  test("an indent — which has no balance at all — shows a plain count", () => {
    expect(quantityText(30, null)).toBe("30");
  });

  test("the rule itself", () => {
    expect(isSigned("onHand")).toBe(true);
    expect(isSigned("booked")).toBe(false);
    expect(isSigned(null)).toBe(false);
    expect(isSigned(undefined)).toBe(false);
  });
});

describe("signedQty, which the rule gates", () => {
  test("always shows a sign, and an em dash for nothing", () => {
    expect(signedQty(5)).toBe("+5");
    expect(signedQty(-5)).toBe("-5");
    expect(signedQty(null)).toBe("—");
    expect(signedQty(undefined)).toBe("—");
  });
});
