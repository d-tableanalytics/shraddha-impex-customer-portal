import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Back from "+ Add Customer" in Edit Details: the desk selects the booking and
 * leaves a `detailsIntent` in the same update. The drawer must open the form
 * with the new customer selected, AFTER its own reset of the form on a new
 * booking, and only for someone allowed to edit details.
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

const NEW_CUSTOMER = { _id: "64cccccccccccccccccccccc", customerName: "Zen Auto", company: "Zen Auto LLP", email: "orders@zen.example" };

const BOOKING = {
  orderId: "BO-2026-000101",
  user: "64aaaaaaaaaaaaaaaaaaaaaa",
  customer: "ABC Motors",
  customerProfile: { customerName: "ABC Motors Pvt Ltd", company: "ABC Motors", email: "buyer@abc.example" },
  createdBy: { id: "s1", name: "Priya Sales", role: "Sales" },
  status: "PO Received",
  poNumber: "-",
  locked: false,
  indent: { lines: [] },
  pricing: null,
  lines: [{ id: "l1", skuCode: "SKU-1", confirmedQty: 2, pendingQty: 0, unitPrice: null, amount: null }],
};

const arrive = () => act(() => useSalesStore.setState({
  selected: BOOKING,
  pricing: null,
  detailsIntent: { orderId: BOOKING.orderId, customerId: NEW_CUSTOMER._id },
}));

describe("Edit Details reopened after + Add Customer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSalesStore.getState().reset();
    api.get.mockImplementation(async (url, { params } = {}) => (
      url === "/users/customers" && params?.id === NEW_CUSTOMER._id
        ? { data: { data: [NEW_CUSTOMER] } }
        : { data: { data: [] } }
    ));
  });

  test("opens the form with the new customer selected and filled in", async () => {
    useUserStore.setState({ user: { _id: "a1", role: "Admin", permissions: ["*"] }, loading: false });
    render(<MemoryRouter><SalesBookingDrawer /></MemoryRouter>);
    arrive();

    expect(await screen.findByText(/Edit details — BO-2026-000101/)).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText(/company name/i).value).toBe("Zen Auto LLP"));
    expect(screen.getByLabelText(/si team/i).value).toBe("Priya Sales (Sales)");
    expect(useSalesStore.getState().detailsIntent).toBeNull();
  });

  test("someone who cannot edit details just sees the booking", async () => {
    useUserStore.setState({ user: { _id: "s2", role: "Sales", permissions: ["view_all_bookings"] }, loading: false });
    render(<MemoryRouter><SalesBookingDrawer /></MemoryRouter>);
    arrive();

    await waitFor(() => expect(useSalesStore.getState().detailsIntent).toBeNull());
    expect(screen.queryByText(/Edit details — /)).toBeNull();
  });
});
