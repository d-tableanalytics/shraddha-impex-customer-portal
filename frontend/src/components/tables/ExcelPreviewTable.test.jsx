import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ExcelPreviewTable } from "./ExcelPreviewTable";

/**
 * The Bulk Upload preview — the screen where the long-code problem was actually
 * reported.
 *
 * Unlike the read-only tables, SKU and MSIL here are editable `<input>`s, so the
 * wrapping fix used elsewhere is not available: an input is a single line and
 * can only scroll, and only once focused. The fix is therefore width plus a
 * `title`, and these tests pin both — a regression to `w-24` would restore the
 * exact bug (a code cut off mid-value in a field that still looks filled in).
 */

const LONG_SKU = "115G.100-1234-XL-REV2";
const LONG_MSIL = "MA0LL00M0-5512-A";

const rows = [
  {
    id: "r1",
    originalRowNumber: 2,
    skuCode: LONG_SKU,
    msilCode: LONG_MSIL,
    quantity: 20,
    status: "valid",
    product: { category: "Impact Sockets", availableStock: 85, unit: "PCS" },
  },
];

const renderTable = (over = {}) =>
  render(
    <ExcelPreviewTable
      rows={rows}
      showMsilCode
      onUpdateRow={vi.fn()}
      selectable={false}
      selectedIds={[]}
      {...over}
    />,
  );

describe("Bulk Upload preview — long SKU and MSIL codes", () => {
  test("shows the complete SKU code as the input's value", () => {
    renderTable();
    // The value is whole in the DOM; nothing is clipped in the data.
    expect(screen.getByDisplayValue(LONG_SKU)).toBeTruthy();
  });

  test("shows the complete MSIL code as the input's value", () => {
    renderTable();
    expect(screen.getByDisplayValue(LONG_MSIL)).toBeTruthy();
  });

  test("the SKU input is no longer a fixed narrow box", () => {
    renderTable();
    const input = screen.getByDisplayValue(LONG_SKU);

    // `w-24` (96px) was the reported bug: wide enough to look filled in, narrow
    // enough to hide the end of a code.
    expect(input.className).not.toContain("w-24");
    // Fills the column, whose width is set once on the <th>.
    expect(input.className).toContain("w-full");
  });

  test("the MSIL input is no longer a fixed narrow box", () => {
    renderTable();
    const input = screen.getByDisplayValue(LONG_MSIL);
    expect(input.className).not.toContain("w-24");
    expect(input.className).toContain("w-full");
  });

  test("both inputs carry the full value as a hover tooltip", () => {
    renderTable();
    // An input cannot wrap, so the tooltip is how the whole value is read
    // without focusing and scrolling through it.
    expect(screen.getByDisplayValue(LONG_SKU).getAttribute("title")).toBe(LONG_SKU);
    expect(screen.getByDisplayValue(LONG_MSIL).getAttribute("title")).toBe(LONG_MSIL);
  });

  test("codes are monospaced with tabular figures so mismatches line up", () => {
    renderTable();
    const sku = screen.getByDisplayValue(LONG_SKU);
    expect(sku.className).toContain("font-mono");
    expect(sku.className).toContain("tabular-nums");
  });

  test("a row with no MSIL code still renders, with an empty input", () => {
    renderTable({
      rows: [{ ...rows[0], msilCode: "-" }],
    });
    // '-' is the sheet's placeholder for "none" and must not be shown as if it
    // were a code.
    const inputs = screen.getAllByRole("textbox");
    expect(inputs.some((i) => i.value === "")).toBe(true);
  });
});
