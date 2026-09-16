import { describe, test, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

import { PicklistPreview } from "./PicklistPreview";
import { picklistFromSalesBooking } from "../../utils/picklistDocument";

/**
 * The indent rows, as they reach the paper.
 *
 * utils/picklistIndent.test.js already pins the arithmetic. What this adds is
 * that the numbers are actually PRINTED, and printed in the right relationship
 * to each other - a document model that is right and a table that renders four
 * of its five figures is the same bug to the person holding the page.
 *
 * The order of the rows is asserted rather than just their presence: the whole
 * design depends on the indent sitting BELOW the Grand Total, so that a reader
 * scanning down sees what is charged before what is outstanding. Reversed, the
 * same figures would read as though the indent were part of the bill.
 */

const booking = {
  orderId: "BO-2026-000042",
  poNumber: "PO-900",
  poDate: "2026-09-10T00:00:00.000Z",
  date: "2026-09-01T00:00:00.000Z",
  status: "PO Received",
  locked: true,
  customerProfile: { customerName: "Riya Sahu", company: "ABC Company Pvt. Ltd." },
  pricing: { priceType: "trader", priceTypeLabel: "Trader" },
  lines: [{ skuCode: "SKU-A", confirmedQty: 20, pendingQty: 4, unitPrice: 250, amount: 5000 }],
  value: {
    booking: { amount: 5000, pricedLines: 1, unpricedLines: 0 },
    indent: { amount: 3000, quantity: 12, pricedSkus: 1, unpricedSkus: 0 },
    subtotal: 8000,
  },
};

const withoutIndent = { ...booking, value: { ...booking.value, indent: null } };

afterEach(cleanup);

const bodyText = () => document.body.textContent.replace(/\s+/g, " ");

describe("a booking with an open indent", () => {
  test("prints all five figures", () => {
    render(<PicklistPreview doc={picklistFromSalesBooking(booking)} onClose={() => {}} />);
    const text = bodyText();

    expect(text).toContain("5,000.00");  // subtotal, booked
    expect(text).toContain("900.00");    // GST on booked
    expect(text).toContain("5,900.00");  // Grand Total - what the PO charges
    expect(text).toContain("3,000.00");  // indent subtotal
    expect(text).toContain("540.00");    // GST on the indent
    expect(text).toContain("3,540.00");  // Indent Total
    expect(text).toContain("9,440.00");  // Order Value
  });

  test("labels each row, so no figure has to be guessed at", () => {
    render(<PicklistPreview doc={picklistFromSalesBooking(booking)} onClose={() => {}} />);

    expect(screen.getByText("Grand Total")).toBeTruthy();
    expect(screen.getByText("Indent Total")).toBeTruthy();
    expect(screen.getByText("Order Value (booked + indent)")).toBeTruthy();
    // The exact heading, not a loose /still on indent/ - that phrase also
    // appears in the closing note, and matching both makes the query ambiguous.
    expect(screen.getByText(/Not included above/i)).toBeTruthy();
    // The indent's quantity rides with its amount - "₹3,000" means nothing
    // without "12 units" beside it.
    expect(bodyText()).toContain("(12 units)");
  });

  test("the indent sits BELOW the Grand Total, not inside it", () => {
    render(<PicklistPreview doc={picklistFromSalesBooking(booking)} onClose={() => {}} />);
    const text = bodyText();

    const grand = text.indexOf("Grand Total");
    const indentHeading = text.indexOf("still on indent");
    const indentTotal = text.indexOf("Indent Total");
    const orderValue = text.indexOf("Order Value");

    expect(grand).toBeGreaterThan(-1);
    expect(indentHeading).toBeGreaterThan(grand);
    expect(indentTotal).toBeGreaterThan(indentHeading);
    expect(orderValue).toBeGreaterThan(indentTotal);
  });

  test("says on the page that the Grand Total excludes the indent", () => {
    render(<PicklistPreview doc={picklistFromSalesBooking(booking)} onClose={() => {}} />);
    expect(bodyText()).toMatch(/Grand Total covers the goods supplied against this order/i);
  });
});

describe("a booking with nothing outstanding", () => {
  test("prints no indent rows at all", () => {
    render(<PicklistPreview doc={picklistFromSalesBooking(withoutIndent)} onClose={() => {}} />);
    const text = bodyText();

    expect(text).toContain("5,900.00");          // the document still totals
    expect(screen.queryByText("Indent Total")).toBeNull();
    expect(screen.queryByText(/Not included above/i)).toBeNull();
    expect(screen.queryByText(/Order Value/i)).toBeNull();
    // And no zero pretending to be an indent.
    expect(text).not.toMatch(/On indent\s*\(0 units\)/i);
  });

  test("the closing note drops the indent sentence with it", () => {
    render(<PicklistPreview doc={picklistFromSalesBooking(withoutIndent)} onClose={() => {}} />);
    expect(bodyText()).not.toMatch(/still on indent/i);
  });
});
