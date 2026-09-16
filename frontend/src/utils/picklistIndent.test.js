import { describe, test, expect } from "vitest";

import { picklistFromSalesBooking, picklistFromCustomerOrder } from "./picklistDocument";
import { withGstParts, GST_RATE } from "../constants/pricing";

/**
 * The indent breakdown on the picklist, and the one property that makes it
 * worth printing: IT RECONCILES WITH THE SALES DESK.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE THREE FIGURES MEAN
 * ---------------------------------------------------------------------------
 *
 *   Grand Total     booked stock only. This is what the purchase order charges
 *                   for, and nothing about the indent may move it - widening it
 *                   would silently re-value every PO ever raised.
 *   Indent Total    the open indent, with its own GST, reported beside it.
 *   Order Value     the two added. It must equal the desk's Total Amount card
 *                   to the paisa, because the whole point of the breakdown is
 *                   that someone can check one against the other.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INDENT IS NOT SUMMED FROM THE LINES
 * ---------------------------------------------------------------------------
 *
 * `pendingQty` on an order row is the shortfall FROZEN at confirmation. It
 * drifts as stock arrives and auto-books, and a SKU that could not be fulfilled
 * at all never got an order row to carry it. The document therefore takes the
 * indent from the server's `value.indent` - the live reservation balance, which
 * is the same figure the card reads. The test below pins that it ignores
 * `pendingQty` even when the two disagree, because that disagreement is exactly
 * the state this breakdown exists to expose.
 */

const salesBooking = ({ indent = null, unitPrice = 250 } = {}) => ({
  orderId: "BO-2026-000042",
  poNumber: "PO-900",
  locked: true,
  customerProfile: { customerName: "Riya Sahu", category: null },
  pricing: { priceType: "trader", priceTypeLabel: "Trader" },
  lines: [
    // 12 confirmed at 250 = 3,000. pendingQty is deliberately WRONG relative to
    // the indent below, to prove which source the document trusts.
    { skuCode: "SKU-A", confirmedQty: 12, pendingQty: 99, unitPrice, amount: null },
    { skuCode: "SKU-B", confirmedQty: 8, pendingQty: 0, unitPrice, amount: null },
  ],
  value: {
    booking: { amount: 5000, pricedLines: 2, unpricedLines: 0 },
    indent,
    subtotal: indent?.amount != null ? 5000 + indent.amount : 5000,
  },
});

describe("the picklist's own total stays booked-only", () => {
  test("an indent does not move the Grand Total", () => {
    const without = picklistFromSalesBooking(salesBooking());
    const with_ = picklistFromSalesBooking(salesBooking({
      indent: { amount: 3000, quantity: 12, pricedSkus: 1, unpricedSkus: 0 },
    }));

    // 20 confirmed units x 250 = 5,000, + 18% = 5,900, on both.
    expect(without.totals.amount).toBe(5000);
    expect(without.totals.grandTotal).toBe(5900);
    expect(with_.totals.amount).toBe(5000);
    expect(with_.totals.grandTotal).toBe(5900);
  });

  test("with no indent, nothing is reported rather than a row of zeroes", () => {
    const doc = picklistFromSalesBooking(salesBooking());
    // `null`, not `{ amount: 0 }` - a zero would read as "the indent is worth
    // nothing" rather than "there isn't one".
    expect(doc.totals.indent).toBeNull();
  });
});

describe("the indent, reported beside it", () => {
  const doc = picklistFromSalesBooking(salesBooking({
    indent: { amount: 3000, quantity: 12, pricedSkus: 1, unpricedSkus: 0 },
  }));

  test("carries its own quantity, amount and GST", () => {
    expect(doc.totals.indent).toEqual({
      quantity: 12,
      amount: 3000,
      gstAmount: 540,      // 18% of 3,000
      grandTotal: 3540,
      unpricedSkus: 0,
    });
  });

  test("is taken from the server's indent, NOT from the lines' pendingQty", () => {
    // The fixture's rows carry pendingQty 99 + 0. If the document summed those
    // it would report 99 units; the live reservation balance is 12.
    const rowPending = salesBooking().lines.reduce((n, l) => n + l.pendingQty, 0);
    expect(rowPending).toBe(99);
    expect(doc.totals.indent.quantity).toBe(12);
  });

  test("the order value is the two halves added, tax included", () => {
    expect(doc.totals.orderValue).toEqual({
      subtotal: 8000,      // 5,000 booked + 3,000 indent
      gstAmount: 1440,     // 900 + 540, each rounded on its own side
      grandTotal: 9440,
    });
  });
});

describe("it reconciles with the desk's Total Amount card", () => {
  /**
   * The card and the document are two renderings of one calculation, so this
   * runs the card's own helper over the same inputs and demands equality. A
   * subtotal is picked that makes the two rounding strategies DISAGREE: taxing
   * 1.25 + 1.25 as one 2.50 gives 0.45, while taxing each 1.25 separately gives
   * 0.23 + 0.23 = 0.46. Both documents must land on the same one of those.
   */
  test("to the paisa, including where per-side rounding differs from the whole", () => {
    for (const [booked, indentAmount] of [
      [5000, 3000],
      [1.25, 1.25],
      [104624.37, 9876.54],
      [0.01, 0.01],
    ]) {
      const doc = picklistFromSalesBooking({
        ...salesBooking(),
        lines: [{ skuCode: "SKU-A", confirmedQty: 1, pendingQty: 0, unitPrice: booked, amount: booked }],
        value: {
          booking: { amount: booked, pricedLines: 1, unpricedLines: 0 },
          indent: { amount: indentAmount, quantity: 3, pricedSkus: 1, unpricedSkus: 0 },
          subtotal: booked + indentAmount,
        },
      });

      // Exactly what SalesBookingDrawer computes for its tile.
      const card = withGstParts({ booked, indent: indentAmount }).orderValue;

      expect(doc.totals.orderValue, `order value for ${booked} + ${indentAmount}`)
        .toEqual(card);
      // And the document's own halves still add to it.
      expect(
        Math.round((doc.totals.grandTotal + doc.totals.indent.grandTotal) * 100) / 100,
      ).toBe(card.grandTotal);
    }
  });

  test("1.25 + 1.25 is taxed per side, not on the combined 2.50", () => {
    const { orderValue } = withGstParts({ booked: 1.25, indent: 1.25 });
    // 0.23 each. Taxing 2.50 as one would give 0.45 and leave the picklist's
    // two halves adding up to a different number from the card.
    expect(orderValue.gstAmount).toBe(0.46);
    expect(orderValue.grandTotal).toBe(2.96);
  });
});

describe("the customer's copy", () => {
  const order = (value) => ({
    orderNumber: "BO-2026-000042",
    poNumber: "PO-900",
    locked: true,
    lineItems: [{ skuCode: "SKU-A", confirmedQty: 20, pendingQty: 4, unitPrice: 250 }],
    value,
  });

  test("shows the indent when the server sent one", () => {
    const doc = picklistFromCustomerOrder(order({
      booking: { amount: 5000 },
      indent: { amount: 1000, quantity: 4, unpricedSkus: 0 },
      subtotal: 6000,
    }));

    expect(doc.totals.grandTotal).toBe(5900);        // still booked-only
    expect(doc.totals.indent.grandTotal).toBe(1180); // 1,000 + 18%
    expect(doc.totals.orderValue.grandTotal).toBe(7080);
  });

  test("prints no indent section when the server withheld the value", () => {
    // A reader not entitled to money on this booking gets rows with no `value`
    // at all - the same gate the unit rate passes through.
    const doc = picklistFromCustomerOrder(order(undefined));
    expect(doc.totals.indent).toBeNull();
    expect(doc.totals.orderValue?.grandTotal).toBe(5900);
  });

  test("still names no price tier, indent or not", () => {
    const doc = picklistFromCustomerOrder(order({
      booking: { amount: 5000 },
      indent: { amount: 1000, quantity: 4, unpricedSkus: 0 },
      subtotal: 6000,
    }));
    expect(doc.priceTypeLabel).toBeNull();
  });
});

describe("an unpriced booking", () => {
  test("reports no money at all, even with an indent on it", () => {
    const doc = picklistFromSalesBooking({
      ...salesBooking({ unitPrice: null }),
      value: {
        booking: { amount: null, pricedLines: 0, unpricedLines: 2 },
        indent: { amount: null, quantity: 12, pricedSkus: 0, unpricedSkus: 1 },
        subtotal: null,
      },
    });

    expect(doc.totals.amount).toBeNull();
    expect(doc.totals.grandTotal).toBeNull();
    expect(doc.totals.indent.grandTotal).toBeNull();
    expect(doc.totals.orderValue).toBeNull();
    expect(doc.totals.gstRate).toBe(GST_RATE);
  });
});
