import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * "No pricing" on the Sales Desk: the Price column of Booking Items becomes an
 * input per line, and the typed rates are saved to the booking.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("../../services/api", () => ({
  api,
  describeRequestFailure: (_e, f) => f,
  refreshAccessToken: vi.fn(),
}));

import { SalesBookingDrawer } from "./SalesBookingDrawer";
import { useSalesStore } from "../../store/salesStore";
import { useUserStore } from "../../store/userStore";

const booking = (over = {}) => ({
  orderId: "BO-2026-000001",
  company: "ABC Motors",
  status: "PO Received",
  poNumber: "-",
  locked: false,
  indent: { lines: [] },
  pricing: null,
  lines: [
    { id: "l1", skuCode: "SKU-1", confirmedQty: 2, pendingQty: 0, unitPrice: null, amount: null },
    { id: "l2", skuCode: "SKU-2", confirmedQty: 3, pendingQty: 0, unitPrice: null, amount: null },
  ],
  ...over,
});

const open = (b) => act(() => useSalesStore.setState({ selected: b, saving: false }));

describe("manual pricing on the Sales Desk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUserStore.setState({ user: { _id: "a1", role: "Admin", permissions: ["*"] }, loading: false });
    api.get.mockResolvedValue({ data: { data: [] } });
  });

  const renderDrawer = (b) => {
    render(<MemoryRouter><SalesBookingDrawer /></MemoryRouter>);
    open(b);
  };

  test("with no pricing, every line gets a price box, saved together", async () => {
    const saved = booking({
      pricing: { priceType: "manual", priceTypeLabel: "Manual", pricedLines: 2, unpricedLines: 0, totalAmount: 230 },
      lines: [
        { id: "l1", skuCode: "SKU-1", confirmedQty: 2, pendingQty: 0, unitPrice: 100, amount: 200 },
        { id: "l2", skuCode: "SKU-2", confirmedQty: 3, pendingQty: 0, unitPrice: 10, amount: 30 },
      ],
    });
    api.put.mockResolvedValue({ data: { success: true, data: saved, pricing: { priceType: "manual", pricedLines: 2, lines: 2 } } });
    renderDrawer(booking());

    fireEvent.change(screen.getByLabelText("Price for SKU-1"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Price for SKU-2"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /Save prices \(2\)/ }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      "/sales/bookings/BO-2026-000001/pricing/manual",
      { prices: { l1: 100, l2: 10 } },
    ));
    await waitFor(() => expect(screen.getByLabelText("Price for SKU-1").value).toBe("100"));
    expect(screen.queryByRole("button", { name: /Save prices/ })).toBeNull();
  });

  test("an invalid price blocks the save", () => {
    renderDrawer(booking());
    fireEvent.change(screen.getByLabelText("Price for SKU-1"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /Save prices/ }).disabled).toBe(true);
  });

  test("a booking on a price tier shows the rate, not a box", () => {
    renderDrawer(booking({
      pricing: { priceType: "trader", priceTypeLabel: "Trader", pricedLines: 1, unpricedLines: 1, totalAmount: 50 },
      lines: [
        { id: "l1", skuCode: "SKU-1", confirmedQty: 2, pendingQty: 0, unitPrice: 25, amount: 50 },
        { id: "l2", skuCode: "SKU-2", confirmedQty: 3, pendingQty: 0, unitPrice: null, amount: null },
      ],
    }));
    expect(screen.queryByLabelText("Price for SKU-1")).toBeNull();
    expect(screen.getByText("Not rated")).toBeTruthy();
  });
});
