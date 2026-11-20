import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Who sees the "Are you sure?" booking review popup.
 *
 * Sales only (2026-11-03). A customer's Confirm Booking books the Selection
 * List straight away; a salesperson's opens the review popup and books nothing
 * until its own Confirm Booking is pressed.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("../../services/api", () => ({
  api,
  describeRequestFailure: (_e, f) => f,
  refreshAccessToken: vi.fn(),
}));

import toast from "react-hot-toast";
import { CustomerOrders } from "./CustomerOrders";
import { useUserStore } from "../../store/userStore";
import { resetSessionStores } from "../../store/sessionReset";

const CUSTOMER = { _id: "c1", role: "Customer", moq: "SKIP", permissions: ["create_order", "view_orders"] };
const SALES = { _id: "s1", role: "Sales", permissions: ["create_order", "view_orders", "view_all_bookings", "manage_orders"] };

const RESERVATIONS = [{
  _id: "r1", reservationId: "RES-1", skuCode: "SKU-1", quantity: 4, status: "Reserved",
  reservationDate: "2026-11-01T10:00:00Z", expiryDate: "2026-11-08T10:00:00Z",
  productId: { _id: "p1", availableForSale: 10, moq: 1 },
}];

const confirmCalls = () => api.post.mock.calls.filter(([url]) => url === "/reservations/confirm");

// The customer a salesperson books FOR — Select Customer is optional, but
// these cases choose one so the popup has a named customer to show.
const ABC = { _id: "cust-abc", customerName: "Customer ABC", company: "ABC Industries", email: "abc@example.com", moq: "SKIP" };

const renderAs = async (user) => {
  useUserStore.setState({ user, loading: false });
  render(<MemoryRouter><CustomerOrders /></MemoryRouter>);
  if (user.role === "Sales") {
    fireEvent.focus(screen.getByLabelText(/Select Customer/));
    fireEvent.click(await screen.findByText("Customer ABC"));
  }
  // Enabled once the Selection List has loaded (it is disabled while empty).
  const button = (await screen.findByText("CONFIRM BOOKING")).closest("button");
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
};

beforeEach(() => {
  resetSessionStores();
  api.get.mockImplementation((url) => {
    if (url === "/reservations") return Promise.resolve({ data: { data: RESERVATIONS } });
    if (url === "/users/customers") return Promise.resolve({ data: { data: [ABC] } });
    return Promise.resolve({ data: { data: [] } });
  });
  api.post.mockResolvedValue({
    data: { success: true, data: { orderId: "BO-2026-000009", outcome: "booking", totals: { totalConfirmed: 4, totalPending: 0 } } },
  });
});
afterEach(() => vi.clearAllMocks());

describe("Confirm Booking", () => {
  test("a customer books straight away, without the popup", async () => {
    const button = await renderAs(CUSTOMER);
    fireEvent.click(button);

    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(screen.queryByText(/Are you sure you want to confirm this booking/)).toBeNull();
    // No review split was shown, so none is claimed to the server.
    expect(confirmCalls()[0][1].reviewed).toBeUndefined();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      expect.stringMatching(/BO-2026-000009/), expect.anything(),
    ));
  });

  test("a salesperson gets the popup, and nothing is booked until it is confirmed", async () => {
    const button = await renderAs(SALES);
    fireEvent.click(button);

    expect(await screen.findByText(/Are you sure you want to confirm this booking/)).toBeTruthy();
    expect(confirmCalls()).toHaveLength(0);

    const confirm = screen.getAllByRole("button", { name: /Confirm Booking/i }).at(-1);
    fireEvent.click(confirm);
    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(confirmCalls()[0][1].reviewed).toEqual([{ id: "r1", quantity: 4, bookable: 4 }]);
    // Booked for the chosen customer, not the salesperson's own account.
    expect(confirmCalls()[0][1].customerId).toBe("cust-abc");
  });
});
