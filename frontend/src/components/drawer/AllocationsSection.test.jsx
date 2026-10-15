import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { AllocationsSection } from "./AllocationsSection";
import { allocationBatches } from "../../utils/allocationBatches";

/**
 * Indents booked together are ONE inward allocation: two SKUs from two indents
 * allocated in the same run (same `at`) share one block, one status and one
 * pick list; a later run is allocation 2.
 */
const T1 = "2026-10-12T06:00:00.000Z";
const T2 = "2026-10-14T06:00:00.000Z";
const lines = [
  {
    lineId: "row-1", skuCode: "183H.35-8", bookedQty: 50, confirmedQty: 45, pendingQty: 5,
    allocations: [
      { seq: 1, quantity: 10, indentNumber: "PI-2026-001025", at: T1, status: "Dispatched" },
      { seq: 2, quantity: 5, indentNumber: "PI-2026-001025", at: T2, status: "PO Received" },
    ],
  },
  {
    lineId: "row-2", skuCode: "14300M-17", bookedQty: 20, confirmedQty: 8, pendingQty: 12,
    allocations: [{ seq: 1, quantity: 8, indentNumber: "PI-2026-001025", at: T1, status: "Dispatched" }],
  },
];

describe("allocationBatches", () => {
  test("groups what was allocated in one run, across lines, oldest first", () => {
    const batches = allocationBatches(lines);
    expect(batches.map((b) => [b.number, b.quantity, b.skuCount, b.status])).toEqual([
      [1, 18, 2, "Dispatched"],
      [2, 5, 1, "PO Received"],
    ]);
  });

  test("reports older data whose entries were moved separately as mixed", () => {
    const mixed = [{ ...lines[1], allocations: [{ ...lines[1].allocations[0], status: "PO Received" }] }, lines[0]];
    expect(allocationBatches(mixed)[0].status).toBe("mixed");
  });
});

describe("Indent-to-Booking Allocations", () => {
  test("renders nothing when no line has an allocation", () => {
    const { container } = render(<AllocationsSection lines={[{ ...lines[0], allocations: [] }]} />);
    expect(container.innerHTML).toBe("");
  });

  test("one block per batch, with every SKU and indent in it", () => {
    render(<AllocationsSection lines={lines} />);
    expect(screen.getByText("Inward allocation 1")).toBeTruthy();
    expect(screen.getByText("Inward allocation 2")).toBeTruthy();
    expect(screen.queryByText("Inward allocation 3")).toBeNull();
    expect(screen.getByText(/18 pcs across 2 SKUs/)).toBeTruthy();
    expect(screen.getAllByText("PI-2026-001025").length).toBe(3);
  });

  test("keeps the per-SKU summary", () => {
    render(<AllocationsSection lines={lines} />);
    const summary = screen.getAllByText("Initially confirmed", { exact: false })[0].parentElement.textContent;
    expect(summary).toContain("Booked 50");
    expect(summary).toContain("Initially confirmed 30");
    expect(summary).toContain("Allocated 15");
    expect(summary).toContain("Pending indent 5");
  });

  test("staff move a whole batch and open its one pick list", async () => {
    const onStatusChange = vi.fn().mockResolvedValue({ success: true });
    const onViewPicklist = vi.fn();
    render(<AllocationsSection lines={lines} onStatusChange={onStatusChange} onViewPicklist={onViewPicklist} />);

    const selects = screen.getAllByRole("combobox");
    expect(selects).toHaveLength(2); // one per batch, not per line
    fireEvent.change(selects[1], { target: { value: "Ready for Dispatch" } });
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ number: 2, at: T2 }), "Ready for Dispatch",
    ));

    const buttons = screen.getAllByText("View picklist");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(onViewPicklist).toHaveBeenCalledWith(expect.objectContaining({ number: 1, quantity: 18 }));
  });

  test("readers without the permission see the stage as text", () => {
    render(<AllocationsSection lines={lines} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Dispatched")).toBeTruthy();
    expect(screen.getAllByText("picklist after PO")).toHaveLength(2);
  });

  test("a batch released with its booking shows as released, with no stage control", () => {
    const released = [{
      ...lines[0],
      allocations: [{ seq: 1, quantity: 10, at: T1, status: "Cancelled", statusAt: "2026-10-20T00:00:00Z" }],
    }];
    render(<AllocationsSection lines={released} onStatusChange={vi.fn()} />);
    expect(screen.getByText("Cancelled — stock released")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
