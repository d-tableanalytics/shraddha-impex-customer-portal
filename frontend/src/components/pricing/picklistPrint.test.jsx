/**
 * Printing the picklist.
 *
 * jsdom cannot lay out a page, so this does not assert what the paper LOOKS
 * like. What it can assert is the thing that was actually broken: WHERE the
 * printed node lives in the DOM.
 *
 * The document used to be printed in place, inside a dialog card that is
 * `max-h-[92vh] overflow-hidden` and carries an inline framer-motion transform.
 * An ancestor clip cannot be undone by any rule on the descendant, so the
 * printout was truncated to about one screenful. The fix clones the document to
 * a direct child of <body>; these tests pin that it happens, that it happens for
 * Ctrl+P as well as the button, and that it is always cleaned up.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PicklistPreview } from "./PicklistPreview";

const doc = {
  audience: "internal",
  orderId: "BO-2026-000001",
  poNumber: "PO-441",
  poDate: "2026-09-10T00:00:00.000Z",
  date: "2026-09-01T00:00:00.000Z",
  status: "PO Received",
  paymentTerm: "30 days",
  promiseDate: "2026-09-25T00:00:00.000Z",
  priceTypeLabel: null,
  showBoxNo: false,
  showMsilCode: false,
  customer: {
    name: "Riya Sahu",
    company: "ABC Company Pvt. Ltd.",
    phone: "9876543210",
    location: "Pune",
    gstNumber: "22AAAAA0000A1Z5",
    shopNumber: "14",
    vendorCode: null,
    shippingAddress: "Plot 14, MIDC Phase II\nPune 411057",
    billingAddress: "501 Trade Centre\nMumbai 400001",
  },
  lines: [
    { sr: 1, skuCode: "SKU-A", msilCode: null, boxNo: null, quantity: 5, unitPrice: null, amount: null },
    { sr: 2, skuCode: "SKU-B", msilCode: null, boxNo: null, quantity: 3, unitPrice: null, amount: null },
  ],
  totals: { quantity: 8, amount: null, gstRate: null, gstAmount: null, grandTotal: null, pricedLines: 0 },
};

const printRoot = () => document.getElementById("picklist-print-root");

beforeEach(() => {
  // jsdom implements neither, and calling window.print() unstubbed logs
  // "Not implemented" noise.
  vi.stubGlobal("print", vi.fn());
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  printRoot()?.remove();
});

describe("printing the picklist", () => {
  test("nothing is added to the body until a print is asked for", () => {
    render(<PicklistPreview doc={doc} onClose={() => {}} />);
    expect(printRoot()).toBeNull();
  });

  test("the Print button lifts the document OUT of the dialog", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PicklistPreview doc={doc} onClose={() => {}} />);

    await user.click(screenPrintButton());

    const root = printRoot();
    expect(root).not.toBeNull();
    // THE POINT: a direct child of <body>, so no ancestor can clip it.
    expect(root.parentElement).toBe(document.body);
    expect(window.print).toHaveBeenCalled();
  });

  test("the clone carries the whole document, not the visible part", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PicklistPreview doc={doc} onClose={() => {}} />);
    await user.click(screenPrintButton());

    const text = printRoot().textContent;
    // Content from the top, middle and bottom of the document.
    expect(text).toContain("Riya Sahu");
    expect(text).toContain("Shipping Address");
    expect(text).toContain("Billing Address");
    expect(text).toContain("SKU-A");
    expect(text).toContain("SKU-B");
    // And the heading removed earlier must not come back.
    expect(text).not.toContain("Place of supply");
  });

  test("the dialog's layout classes are stripped, or the clone scrolls on paper", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PicklistPreview doc={doc} onClose={() => {}} />);
    await user.click(screenPrintButton());

    const root = printRoot();
    expect(root.className).toBe("");
    // `overflow-y-auto` on the printed node would reintroduce the scroll box
    // whose visible portion was all that printed before.
    expect(root.className).not.toContain("overflow-y-auto");
    expect(root.className).not.toContain("flex-1");
  });

  test("Ctrl+P works too — the browser's own print fires the same path", () => {
    render(<PicklistPreview doc={doc} onClose={() => {}} />);
    expect(printRoot()).toBeNull();

    window.dispatchEvent(new Event("beforeprint"));
    expect(printRoot()).not.toBeNull();
    expect(printRoot().parentElement).toBe(document.body);

    window.dispatchEvent(new Event("afterprint"));
    expect(printRoot()).toBeNull();
  });

  test("printing twice never leaves two copies", () => {
    render(<PicklistPreview doc={doc} onClose={() => {}} />);
    window.dispatchEvent(new Event("beforeprint"));
    window.dispatchEvent(new Event("beforeprint"));
    expect(document.querySelectorAll("#picklist-print-root")).toHaveLength(1);
  });

  test("closing the preview leaves no clone behind", () => {
    const { unmount } = render(<PicklistPreview doc={doc} onClose={() => {}} />);
    window.dispatchEvent(new Event("beforeprint"));
    expect(printRoot()).not.toBeNull();

    unmount();
    expect(printRoot()).toBeNull();
  });

  test("a print dialog dismissed without printing still cleans up", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PicklistPreview doc={doc} onClose={() => {}} />);
    await user.click(screenPrintButton());
    expect(printRoot()).not.toBeNull();

    // No `afterprint` — the Safari case, and the cancelled-dialog case.
    vi.advanceTimersByTime(1500);
    expect(printRoot()).toBeNull();
  });
});

/** The Print button, found by its label rather than by DOM position. */
function screenPrintButton() {
  return [...document.querySelectorAll("button")].find((b) =>
    b.textContent.trim().toLowerCase().startsWith("print"),
  );
}
