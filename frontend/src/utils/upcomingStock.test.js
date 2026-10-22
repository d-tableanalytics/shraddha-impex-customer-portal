import { describe, test, expect } from "vitest";
import {
  cellToYmd, rowsFromSheet, indentLinesFor, indentSummary, reservationStatusFor, TEMPLATE_HEADERS,
} from "./upcomingStock";

describe("cellToYmd — the calendar day a sheet cell names", () => {
  test("typed dates are day-first, as written in India", () => {
    expect(cellToYmd("05/11/2026")).toBe("2026-11-05");
    expect(cellToYmd("5-11-26")).toBe("2026-11-05");
    expect(cellToYmd("2026-11-05")).toBe("2026-11-05");
  });
  test("an Excel serial date", () => {
    expect(cellToYmd(46331)).toBe("2026-11-05");
  });
  test("a Date cell keeps its own calendar day", () => {
    expect(cellToYmd(new Date(2026, 10, 5))).toBe("2026-11-05");
  });
  test("nothing that is not a real day", () => {
    expect(cellToYmd("31/02/2026")).toBe("");
    expect(cellToYmd("soon")).toBe("");
    expect(cellToYmd("")).toBe("");
  });
});

describe("rowsFromSheet", () => {
  test("maps the template's columns and skips blank rows; quantities are left for the server", () => {
    const { error, rows } = rowsFromSheet([
      TEMPLATE_HEADERS,
      ["14405M-10", "Koken", "", 250, "14/11/2026", "PO-1", "Koken Japan"],
      ["", "", "", "", "", "", ""],
      ["BIX-1", "", "", "TBC", "", "PO-2", ""],
    ]);
    expect(error).toBeNull();
    expect(rows).toEqual([
      { row: 2, skuCode: "14405M-10", brand: "Koken", product: "", qty: 250, eta: "2026-11-14", ref: "PO-1", supplier: "Koken Japan" },
      { row: 4, skuCode: "BIX-1", brand: "", product: "", qty: "TBC", eta: "", ref: "PO-2", supplier: "" },
    ]);
  });
  test("a sheet with only SKU and quantity columns is enough", () => {
    const { error, rows } = rowsFromSheet([["SKU Code", "Upcoming Qty"], ["14405M-10", 40]]);
    expect(error).toBeNull();
    expect(rows).toEqual([{ row: 2, skuCode: "14405M-10", brand: "", product: "", qty: 40, eta: "", ref: "", supplier: "" }]);
  });
  test("a date cell that is not a date is passed on as written, for the server to flag", () => {
    const { rows } = rowsFromSheet([["SKU Code", "Upcoming Qty", "Expected Arrival"], ["X", 1, "next week"]]);
    expect(rows[0].eta).toBe("next week");
  });
  test("a sheet without SKU and quantity columns is refused", () => {
    expect(rowsFromSheet([["Name", "Date"], ["x", "y"]]).error).toMatch(/SKU Code/);
  });
});

describe("indent lines", () => {
  // As the server's FIFO allocation sends them (allocateFifo).
  const item = {
    indents: [
      { lineId: "b", fifoPosition: 2, status: "Pending", requiredQty: 10, reservedQty: 3, shortQty: 7, raisedAt: "2026-10-02" },
      { lineId: "a", fifoPosition: 1, status: "Partially Confirmed", requiredQty: 5, reservedQty: 5, shortQty: 0, raisedAt: "2026-10-01" },
      { lineId: "c", fifoPosition: 3, status: "Confirmed", requiredQty: 5, reservedQty: 0, shortQty: 5, raisedAt: "2026-09-01" },
    ],
  };
  test("open indents only, in FIFO order, with what the allocation gives each", () => {
    const lines = indentLinesFor(item);
    expect(lines.map((l) => [l.lineId, l.reservedQty, l.outstanding, l.reservationStatus]))
      .toEqual([["a", 5, 0, "Fully Reserved"], ["b", 3, 7, "Partially Reserved"]]);
    expect(indentSummary(lines)).toEqual({ count: 2, required: 15, reserved: 8, open: 7, covered: 1 });
  });
  test("reservationStatusFor", () => {
    expect(reservationStatusFor(0, 10)).toBe("Not Reserved");
    expect(reservationStatusFor(3, 10)).toBe("Partially Reserved");
    expect(reservationStatusFor(10, 10)).toBe("Fully Reserved");
  });
});
