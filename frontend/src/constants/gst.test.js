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

  /**
   * The tax is the RIGHT number, not merely a self-consistent one.
   *
   * The "add up exactly" test above cannot catch a rounding fault, because it
   * builds its expectation with the same `Math.round(x * 100) / 100` the
   * implementation uses — two copies of one formula agree with each other
   * whether or not the formula is correct. It passed while `withGst` was
   * under-charging one subtotal in roughly 260.
   *
   * So the expectation here is computed a DIFFERENT WAY: in exact integer
   * paise, where 18% is the integer ratio 1800/10000 and nothing has a binary
   * fraction to lose. Half-up, which is what a rupee document rounds at.
   */
  const exactGstPaise = (rupees) => {
    const paise = Math.round(rupees * 100);
    return Math.floor((paise * 1800 + 5000) / 10000);
  };

  test("₹1.25 — the half-paisa boundary that float rounding gets wrong", () => {
    // 18% of 1.25 is exactly 0.225, so it rounds UP to 0.23. Computed as
    // `1.25 * 0.18 * 100` the product is 22.499999999999996 and Math.round
    // takes it DOWN to 0.22. This is the single case the whole fix is about.
    expect(withGst(1.25).gstAmount).toBe(0.23);
    expect(withGst(1.25).grandTotal).toBe(1.48);
  });

  test("matches exact integer-paise arithmetic across the realistic range", () => {
    const wrong = [];
    // Dense through small values, then sparse into order-sized ones. The old
    // implementation failed 810 of the first band alone.
    for (let paise = 1; paise <= 200000; paise += 1) {
      const subtotal = paise / 100;
      const { gstAmount } = withGst(subtotal);
      if (Math.round(gstAmount * 100) !== exactGstPaise(subtotal)) wrong.push(subtotal);
    }
    for (let paise = 200001; paise <= 20000000; paise += 7919) {
      const subtotal = paise / 100;
      const { gstAmount } = withGst(subtotal);
      if (Math.round(gstAmount * 100) !== exactGstPaise(subtotal)) wrong.push(subtotal);
    }

    expect(
      wrong.slice(0, 10),
      `${wrong.length} subtotal(s) taxed incorrectly, e.g. ${wrong.slice(0, 3).join(", ")}`,
    ).toEqual([]);
  });

  test("never rounds the tax DOWN — an error that only ever under-charges", () => {
    // The old fault was one-directional: it never over-charged, so it could not
    // be dismissed as noise that averages out. Pinned so a future change to the
    // rounding cannot quietly reintroduce a systematic under-statement.
    let under = 0;
    for (let paise = 1; paise <= 200000; paise += 1) {
      const subtotal = paise / 100;
      if (Math.round(withGst(subtotal).gstAmount * 100) < exactGstPaise(subtotal)) under += 1;
    }
    expect(under).toBe(0);
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
