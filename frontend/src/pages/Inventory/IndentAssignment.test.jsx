import { describe, test, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const api = vi.hoisted(() => ({
  indentAssignmentQueue: vi.fn(),
  autoAssignIndents: vi.fn(),
  assignToIndent: vi.fn(),
  reassignAllocation: vi.fn(),
  setIndentAssignmentMode: vi.fn(),
}));
vi.mock("../../services/inventory", () => ({ inventoryApi: api }));

const userState = vi.hoisted(() => ({ user: { role: "Sales", permissions: ["assign_indent_stock"] } }));
vi.mock("../../store/userStore", () => ({ useUserStore: () => userState }));

import { IndentAssignment } from "./IndentAssignment";
import { queryClient } from "../../lib/queryClient";

// The queue is a TanStack Query; each test starts from an empty cache.
const render = (ui) => rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const queue = {
  mode: "manual",
  skus: [{
    skuCode: "183H.35-8",
    brand: "Koken",
    available: 5,
    indents: [
      { id: "i1", reservationId: "RES-1", indentNumber: "PI-2026-000009", bookingId: "BO-2026-000009", customer: "Nikita Traders", requested: 50, pending: 48, date: "2026-08-21", wholeOnly: false },
      { id: "i2", reservationId: "RES-2", indentNumber: "PI-2026-000072", bookingId: "BO-2026-000072", customer: "PT Enterprises", requested: 8, pending: 6, date: "2026-09-08", wholeOnly: false },
    ],
    reassignable: [],
  }],
};

describe("Indent Stock Assignment", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
    api.indentAssignmentQueue.mockResolvedValue(queue);
  });

  test("lists the waiting indents, oldest first, with the free stock", async () => {
    render(<IndentAssignment />);
    expect(await screen.findByText("Nikita Traders")).toBeTruthy();
    expect(screen.getByText("5 free")).toBeTruthy();
    expect(screen.getByText("next in FIFO")).toBeTruthy();
    expect(screen.getByText("Arriving stock is held for assignment")).toBeTruthy();
  });

  test("assigns the typed quantity to a chosen indent", async () => {
    api.assignToIndent.mockResolvedValue({ orderId: "BO-2026-000072", quantity: 3 });
    render(<IndentAssignment />);
    await screen.findByText("PT Enterprises");

    const input = screen.getByLabelText("Quantity for PT Enterprises");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Assign$/ })[1]);

    await waitFor(() => expect(api.assignToIndent).toHaveBeenCalledWith("i2", 3));
    await waitFor(() => expect(api.indentAssignmentQueue).toHaveBeenCalledTimes(2), "refreshes after");
  });

  test("will not offer more than is free", async () => {
    render(<IndentAssignment />);
    await screen.findByText("Nikita Traders");
    const input = screen.getByLabelText("Quantity for Nikita Traders");
    expect(input.value).toBe("5"); // capped at what is free, not the 48 it waits for
    fireEvent.change(input, { target: { value: "6" } });
    expect(screen.getAllByRole("button", { name: /Assign$/ })[0].disabled).toBe(true);
  });

  test("Auto-assign runs FIFO for the SKU", async () => {
    api.autoAssignIndents.mockResolvedValue({ booked: 1, bookings: 1 });
    render(<IndentAssignment />);
    await screen.findByText("Nikita Traders");
    fireEvent.click(screen.getByRole("button", { name: /Auto-assign \(FIFO\)/ }));
    await waitFor(() => expect(api.autoAssignIndents).toHaveBeenCalledWith(["183H.35-8"]));
  });

  test("only users who configure inventory see the mode switch", async () => {
    render(<IndentAssignment />);
    await screen.findByText("Nikita Traders");
    expect(screen.queryByText(/Switch to automatic/)).toBeNull();
  });

  test("a revisit shows the last queue at once and still re-reads it from the server", async () => {
    const first = render(<IndentAssignment />);
    expect(await screen.findByText("Nikita Traders")).toBeTruthy();
    first.unmount();

    let release;
    api.indentAssignmentQueue.mockImplementation(() => new Promise((r) => { release = () => r(queue); }));
    render(<IndentAssignment />);
    // No blank page while the queue is re-validated...
    expect(screen.getByText("Nikita Traders")).toBeTruthy();
    expect(screen.getByText("Refreshing…")).toBeTruthy();
    // ...but it IS re-validated: stock decisions are never made on the cached copy alone.
    await waitFor(() => expect(api.indentAssignmentQueue).toHaveBeenCalledTimes(2));
    release();
  });
});
