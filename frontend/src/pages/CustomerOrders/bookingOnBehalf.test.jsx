import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * Create Booking for a Sales Person or Admin: the mandatory Select Customer
 * field, and that everything they then do is done FOR that customer.
 *
 * A customer's own Create Booking has no such field and sends no customer id —
 * their flow is pinned here too, so it cannot quietly pick one up.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("../../services/api", () => ({
  api,
  describeRequestFailure: (_e, f) => f,
  refreshAccessToken: vi.fn(),
}));

import { CustomerOrders } from "./CustomerOrders";
import { useUserStore } from "../../store/userStore";
import { useCartStore } from "../../store/cartStore";
import { resetSessionStores } from "../../store/sessionReset";

const CUSTOMER = { _id: "c1", role: "Customer", moq: "SKIP", permissions: ["create_order", "view_orders"] };
const SALES = { _id: "s1", role: "Sales", user: "Sales Person A", permissions: ["create_order", "view_orders", "view_all_bookings", "manage_orders"] };

const ABC = { _id: "cust-abc", customerName: "Customer ABC", company: "ABC Industries", email: "abc@example.com", moq: "SKIP", customerCategory: "Customer" };
const XYZ = { _id: "cust-xyz", customerName: "XYZ Tools", company: "XYZ Pvt Ltd", email: "xyz@example.com", moq: "SKIP", customerCategory: "MSIL" };

const RESERVATIONS = [{
  _id: "r1", reservationId: "RES-1", skuCode: "SKU-1", quantity: 4, status: "Reserved",
  reservationDate: "2026-11-01T10:00:00Z", expiryDate: "2026-11-08T10:00:00Z",
  productId: { _id: "p1", availableForSale: 10, moq: 1 },
}];

const getCalls = (url) => api.get.mock.calls.filter(([u]) => u === url);

const renderAt = (user, path = "/orders/new") => {
  useUserStore.setState({ user, loading: false });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/orders/new" element={<CustomerOrders />} />
        <Route path="/admin/customers" element={<div>Customer Management page</div>} />
      </Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  resetSessionStores();
  api.get.mockImplementation((url, config = {}) => {
    if (url === "/reservations") return Promise.resolve({ data: { data: config.params?.customerId ? RESERVATIONS : [] } });
    if (url === "/users/customers") {
      const { id, search = "" } = config.params || {};
      if (id) return Promise.resolve({ data: { data: [ABC, XYZ].filter((c) => c._id === id) } });
      const term = search.toLowerCase();
      return Promise.resolve({ data: { data: [ABC, XYZ].filter((c) => !term || `${c.customerName} ${c.company}`.toLowerCase().includes(term)) } });
    }
    return Promise.resolve({ data: { data: [] } });
  });
  api.post.mockResolvedValue({
    data: { success: true, data: { orderId: "BO-2026-000009", outcome: "booking", totals: { totalConfirmed: 4, totalPending: 0 }, customer: { name: "Customer ABC" } } },
  });
});
afterEach(() => vi.clearAllMocks());

describe("Select Customer (Sales / Admin)", () => {
  test("a customer's Create Booking has no customer field and sends no customer id", async () => {
    renderAt(CUSTOMER);
    await screen.findByText("CONFIRM BOOKING");
    expect(screen.queryByLabelText(/Select Customer/)).toBeNull();
    expect(screen.queryByText("+ Add Customer")).toBeNull();
    await waitFor(() => expect(getCalls("/reservations")).toHaveLength(1));
    expect(getCalls("/reservations")[0][1]).toEqual({ params: {} });
  });

  test("a salesperson must pick a customer before anything can be added or confirmed", async () => {
    renderAt(SALES);
    const picker = await screen.findByLabelText(/Select Customer/);
    expect(screen.getByText("+ Add Customer")).toBeTruthy();
    // No list is read for nobody.
    expect(getCalls("/reservations")).toHaveLength(0);
    expect(screen.getByPlaceholderText("Select a customer first").disabled).toBe(true);
    expect(screen.getByText("CONFIRM BOOKING").closest("button").disabled).toBe(true);
    expect(screen.getByTestId("selection-list-for").textContent).toMatch(/Select a customer/);

    // Searching by company name, as typed, reaches the customer lookup.
    fireEvent.change(picker, { target: { value: "xyz pvt" } });
    await waitFor(() => expect(getCalls("/users/customers").at(-1)[1].params.search).toBe("xyz pvt"));
    expect(await screen.findByText("XYZ Tools")).toBeTruthy();
    expect(screen.queryByText("Customer ABC")).toBeNull();
  });

  test("choosing a customer loads THEIR list, books under their id, and can be changed", async () => {
    renderAt(SALES);
    fireEvent.focus(await screen.findByLabelText(/Select Customer/));
    fireEvent.click(await screen.findByText("Customer ABC"));

    expect(screen.getByTestId("selected-customer").textContent).toMatch(/Customer ABC/);
    expect(screen.getByTestId("selected-customer").textContent).toMatch(/ABC Industries/);
    await waitFor(() => expect(getCalls("/reservations").at(-1)[1]).toEqual({ params: { customerId: "cust-abc" } }));
    expect(screen.getByTestId("selection-list-for").textContent).toMatch(/For Customer ABC/);
    // The product field is live again, and the list for that customer is shown.
    expect(screen.queryByPlaceholderText("Select a customer first")).toBeNull();
    expect((await screen.findAllByText("SKU-1")).length).toBeGreaterThan(0);
    expect(useCartStore.getState().customer._id).toBe("cust-abc");

    // Confirm (the popup) books for that customer.
    const button = screen.getByText("CONFIRM BOOKING").closest("button");
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByTestId("review-booking-for")).toBeTruthy();
    expect(screen.getByTestId("review-booking-for").textContent).toMatch(/Customer ABC/);
    fireEvent.click(screen.getAllByRole("button", { name: /Confirm Booking/i }).at(-1));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/reservations/confirm", expect.objectContaining({ customerId: "cust-abc" })));

    // Changing the customer drops the list and reads the new one.
    fireEvent.click(screen.getByLabelText("Change customer"));
    expect(screen.queryByTestId("selected-customer")).toBeNull();
    expect(useCartStore.getState().customer).toBeNull();
  });

  test("+ Add Customer goes to Customer Management with a way back, and the new customer is selected on return", async () => {
    renderAt(SALES);
    await screen.findByLabelText(/Select Customer/);
    fireEvent.click(screen.getByText("+ Add Customer"));
    expect(await screen.findByText("Customer Management page")).toBeTruthy();

    // Back from Customer Management with the created account's id.
    resetSessionStores();
    renderAt(SALES, "/orders/new?customer=cust-xyz");
    await waitFor(() => expect(screen.getByTestId("selected-customer").textContent).toMatch(/XYZ Tools/));
    await waitFor(() => expect(getCalls("/reservations").at(-1)[1]).toEqual({ params: { customerId: "cust-xyz" } }));
  });
});
