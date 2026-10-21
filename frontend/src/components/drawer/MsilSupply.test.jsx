import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../services/sales", () => ({
  salesApi: {
    setSupplyDate: vi.fn(),
    convertHeldIndent: vi.fn(),
    cancelHeldIndent: vi.fn(),
  },
}));

import { salesApi } from "../../services/sales";
import { MsilSupplyDateBar, HeldIndentStatus, isMsilBooking, toInput, fmt } from "./MsilSupply";

/**
 * The Sales Desk controls for the MSIL supply check. The rule itself is the
 * server's; these only have to send the right request and show the verdict.
 */

beforeEach(() => vi.clearAllMocks());

describe("isMsilBooking", () => {
  test("is decided by the customer's category", () => {
    expect(isMsilBooking({ customerProfile: { customerCategory: "MSIL" } })).toBe(true);
    expect(isMsilBooking({ customerProfile: { customerCategory: "Customer" } })).toBe(false);
    expect(isMsilBooking({})).toBe(false);
  });
});

describe("dates are Indian business days", () => {
  test("the stored instant (IST midnight) reads back as the same day, in any browser zone", () => {
    // 25 Oct IST starts at 24 Oct 18:30 UTC.
    expect(toInput("2026-10-24T18:30:00.000Z")).toBe("2026-10-25");
    expect(fmt("2026-10-24T18:30:00.000Z")).toBe("25 Oct 2026");
  });
});

describe("MsilSupplyDateBar", () => {
  const booking = { orderId: "BO-2026-000001", msilSupplyDate: null, poDeadlineDays: 7 };

  test("saves the picked date and refreshes the booking", async () => {
    salesApi.setSupplyDate.mockResolvedValue({ msilSupplyDate: "2026-10-29T18:30:00.000Z", convertedLines: 1, awaitingLines: 0 });
    const onSaved = vi.fn();
    render(<MsilSupplyDateBar booking={booking} canEdit onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("MSIL Supply Date"), { target: { value: "2026-10-30" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(salesApi.setSupplyDate).toHaveBeenCalledWith("BO-2026-000001", "2026-10-30");
  });

  test("Clear sends null", async () => {
    salesApi.setSupplyDate.mockResolvedValue({});
    render(<MsilSupplyDateBar booking={{ ...booking, msilSupplyDate: "2026-10-29T18:30:00.000Z" }} canEdit />);
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => expect(salesApi.setSupplyDate).toHaveBeenCalledWith("BO-2026-000001", null));
  });

  test("read-only for someone who may not set it", () => {
    render(<MsilSupplyDateBar booking={booking} canEdit={false} />);
    expect(screen.queryByLabelText("MSIL Supply Date")).toBeNull();
    expect(screen.getByText("Not set")).toBeTruthy();
  });
});

describe("HeldIndentStatus", () => {
  const held = {
    reservationId: "RES-1", skuCode: "SKU-1", quantity: 8,
    supplyCheck: { status: "Awaiting decision", reason: "Not converted automatically: stock arrived after the Supply Date." },
  };

  test("a held line shows its reason with Convert and Cancel", async () => {
    salesApi.convertHeldIndent.mockResolvedValue({ message: "8 unit(s) converted." });
    const onDone = vi.fn();
    render(<HeldIndentStatus line={held} canDecide onDone={onDone} />);

    expect(screen.getByText("Awaiting decision")).toBeTruthy();
    expect(screen.getByText(/after the Supply Date/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /convert/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(salesApi.convertHeldIndent).toHaveBeenCalledWith("RES-1");
  });

  test("Cancel asks first, then sends the reason", async () => {
    salesApi.cancelHeldIndent.mockResolvedValue({});
    const onDone = vi.fn();
    render(<HeldIndentStatus line={held} canDecide onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(salesApi.cancelHeldIndent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/no longer needs/i), { target: { value: "Sourced elsewhere" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel indent line/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(salesApi.cancelHeldIndent).toHaveBeenCalledWith("RES-1", "Sourced elsewhere");
  });

  test("no buttons without the permission, and none once decided", () => {
    const { rerender } = render(<HeldIndentStatus line={held} canDecide={false} />);
    expect(screen.queryByRole("button", { name: /convert/i })).toBeNull();

    rerender(<HeldIndentStatus line={{ ...held, supplyCheck: { status: "Auto-converted" } }} canDecide />);
    expect(screen.getByText("Auto-converted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /convert/i })).toBeNull();
  });

  test("renders nothing for a line the check never applied to", () => {
    const { container } = render(<HeldIndentStatus line={{ ...held, supplyCheck: null }} canDecide />);
    expect(container.textContent).toBe("");
  });
});
