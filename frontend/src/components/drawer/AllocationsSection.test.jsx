import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { AllocationsSection } from "./AllocationsSection";

const line = {
  lineId: "row-1",
  skuCode: "183H.35-8",
  bookedQty: 50,
  confirmedQty: 45,
  pendingQty: 5,
  allocations: [
    { seq: 1, quantity: 10, indentNumber: "PI-2026-001025", at: "2026-10-12T00:00:00Z", status: "Dispatched" },
    { seq: 2, quantity: 5, indentNumber: "PI-2026-001025", at: "2026-10-14T00:00:00Z", status: "PO Received" },
  ],
};

describe("Indent-to-Booking Allocations", () => {
  test("renders nothing when no line has an allocation", () => {
    const { container } = render(<AllocationsSection lines={[{ ...line, allocations: [] }]} />);
    expect(container.innerHTML).toBe("");
  });

  test("one sub-line per inward allocation, with the line's breakdown", () => {
    render(<AllocationsSection lines={[line]} />);
    expect(screen.getByText("Indent-to-Booking Allocations")).toBeTruthy();
    expect(screen.getByText("Inward allocation 1")).toBeTruthy();
    expect(screen.getByText("Inward allocation 2")).toBeTruthy();
    // Booked 50 · initially confirmed 30 · allocated 15 · pending 5
    const summary = screen.getByText("Initially confirmed", { exact: false }).parentElement.textContent;
    expect(summary).toContain("Booked 50");
    expect(summary).toContain("Initially confirmed 30");
    expect(summary).toContain("Allocated 15");
    expect(summary).toContain("Pending indent 5");
  });

  test("staff move an allocation's status and open its pick list", async () => {
    const onStatusChange = vi.fn().mockResolvedValue({ success: true });
    const onViewPicklist = vi.fn();
    render(<AllocationsSection lines={[line]} onStatusChange={onStatusChange} onViewPicklist={onViewPicklist} />);

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1], { target: { value: "Ready for Dispatch" } });
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith("row-1", 2, "Ready for Dispatch"));

    fireEvent.click(screen.getAllByText("View picklist")[0]);
    expect(onViewPicklist).toHaveBeenCalledWith(line, line.allocations[0]);
  });

  test("readers without the permission see the stage as text", () => {
    render(<AllocationsSection lines={[line]} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Dispatched")).toBeTruthy();
    expect(screen.getAllByText("after PO")).toHaveLength(2);
  });
});
