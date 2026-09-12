import { describe, test, expect } from "vitest";

import { withGst, GST_RATE, GST_LABEL, formatRupees } from "./pricing";

/**
 * The GST math behind the Sales Desk's Total Amount tile.
 *
 * This helper already backed the picklist and the PDF, but nothing tested it
 * directly — the picklist suite only ever passed it a fixture of nulls. It now
 * also drives a headline figure the desk reads off the screen and quotes to a
 * customer, so the two properties that matter are pinned here:
 *
 *   1. A document's three printed numbers ADD UP. The helper rounds the tax to
 *      paise before adding it, precisely so subtotal + GST equals the grand
 *      total exactly. Computing the total from the unrounded tax leaves a
 *      document that contradicts itself by a paisa, which is the kind of thing
 *      an accounts department notices and nobody can explain.
 *
 *   2. NOTHING PRICED IS NULL, NOT ZERO. A booking with no rate owes no tax.
 *      Rendering it as ₹0.00 would state a fact — "this booking is worth
 *      nothing" — that is false and looks deliberate.
 */

describe("withGst", () => {
  test("applies the documented rate", () => {
    const { subtotal, gstAmount, grandTotal, gstRate } = withGst(1000);

    expect(gstRate).toBe(GST_RATE);
    expect(subtotal).toBe(1000);
    expect(gstAmount).toBe(180);
    expect(grandTotal).toBe(1180);
  });

  test("the three numbers always add up exactly", () => {
    // Deliberately awkward subtotals: each produces a tax with more than two
    // decimal places before rounding.
    for (const amount of [1, 3.33, 99.99, 1234.56, 104624.37, 7.07]) {
      const { subtotal, gstAmount, grandTotal } = withGst(amount);
      expect(
        Math.round((subtotal + gstAmount) * 100) / 100,
        `subtotal + GST must equal the grand total for ${amount}`,
      ).toBe(grandTotal);
    }
  });

  test("rounds the tax to paise rather than carrying fractions into the total", () => {
    // 18% of 3.33 is 0.5994 — it must print as 0.60 and be ADDED as 0.60.
    const { gstAmount, grandTotal } = withGst(3.33);
    expect(gstAmount).toBe(0.6);
    expect(grandTotal).toBe(3.93);
  });

  test("an unpriced booking yields nulls, never zeroes", () => {
    const { subtotal, gstAmount, grandTotal } = withGst(null);

    // The tile branches on `grandTotal == null` to show a dash. A zero here
    // would render ₹0.00 and read as a deliberate statement of worth.
    expect(subtotal).toBeNull();
    expect(gstAmount).toBeNull();
    expect(grandTotal).toBeNull();
  });

  test("treats zero as the ABSENCE of a price, not as a price of zero", () => {
    // `asPrice` is explicit about this: "Zero and below are NOT prices — they
    // are the absence of one." So a zero subtotal takes the same dash as an
    // unpriced booking rather than rendering a confident ₹0.00.
    //
    // Pinned because the tile's `grandTotal == null` branch depends on it, and
    // because it is the kind of rule a future "fix" would helpfully undo.
    expect(withGst(0).grandTotal).toBeNull();
    expect(withGst(-5).grandTotal).toBeNull();
  });

  test("the label is derived from the rate, so the two cannot disagree", () => {
    expect(GST_LABEL).toBe(`GST @ ${Math.round(GST_RATE * 1000) / 10}%`);
  });
});

describe("the figure as the tile renders it", () => {
  test("formats in Indian rupees", () => {
    const { grandTotal } = withGst(104624.37);
    const shown = formatRupees(grandTotal);

    expect(shown).toContain("₹");
    // en-IN grouping: 1,23,456 rather than 123,456.
    expect(shown).toMatch(/₹\s?1,23,456\.76/);
  });

  test("renders an unpriced booking as a dash", () => {
    expect(formatRupees(withGst(null).grandTotal)).toBe("—");
  });
});
