import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Who is offered "Cancel booking" and "Cancel Indent".
 *
 * Staff only since 2026-10-27: a customer signed in to the portal sees neither
 * button, in Booking History or Indent History. Sales and Admin share those
 * screens and keep both. The server refuses a customer's cancel either way —
 * see backend/tests/booking-cancel-stock.test.js.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("../../services/api", () => ({
  api,
  describeRequestFailure: (_e, f) => f,
  refreshAccessToken: vi.fn(),
}));

import { OrderHistory } from "../../pages/OrderHistory/OrderHistory";
import { IndentDrawer } from "./IndentDrawer";
import { useUserStore } from "../../store/userStore";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useIndentHistoryStore } from "../../store/indentHistoryStore";
import { useCartStore } from "../../store/cartStore";
import { resetSessionStores } from "../../store/sessionReset";

const CUSTOMER = { _id: "c1", role: "Customer", permissions: ["create_order", "view_orders"] };
const SALES = { _id: "s1", role: "Sales", permissions: ["view_orders", "view_all_bookings", "manage_orders"] };
const ADMIN = { _id: "a1", role: "Admin", permissions: ["*"] };

const ORDERS = [
  { _id: "r1", orderId: "BO-2026-000001", skuCode: "SKU-1", brand: "Koken", company: "ABC Motors", status: "PO Received",
    createdAt: "2026-10-01T10:00:00Z", requestedQty: 5, bookedQty: 5, confirmedQty: 5, pendingQty: 0, poNumber: "-", user: "c1" },
];

const INDENT = {
  indentNumber: "PI-2026-000001",
  customer: "ABC Motors",
  status: "Pending",
  readyLines: 0,
  lines: [{ _id: "i1", status: "Pending", pendingQuantity: 3, product: { code: "SKU-1", availableStock: 0 } }],
};

const signIn = (user) => useUserStore.setState({ user, loading: false });

beforeEach(() => {
  resetSessionStores();
  api.get.mockImplementation((url) => {
    if (url === "/orders") return Promise.resolve({ data: { data: ORDERS } });
    if (url === "/reservations/pending") return Promise.resolve({ data: { data: [] } });
    if (url === "/reservations/cancelled-count") return Promise.resolve({ data: { data: { count: 0 } } });
    if (url.includes("/quantity-history")) return Promise.resolve({ data: { data: { entries: [] } } });
    if (url.includes("/timeline")) return Promise.resolve({ data: { data: { timeline: [] } } });
    return Promise.resolve({ data: { data: [] } });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Booking History: Cancel booking", () => {
  const openBooking = async () => {
    render(<MemoryRouter><OrderHistory /></MemoryRouter>);
    await waitFor(() => expect(useOrderHistoryStore.getState().allOrders.length).toBe(1));
    await waitFor(() => expect(useCartStore.getState().pendingLoaded).toBe(true));
    act(() => useOrderHistoryStore.getState().setSelectedOrder(useOrderHistoryStore.getState().allOrders[0]));
    await screen.findByText("Booking BO-2026-000001");
  };

  test("is not offered to a customer", async () => {
    signIn(CUSTOMER);
    await openBooking();
    expect(screen.queryByText("Cancel booking")).toBeNull();
  });

  test.each([["Sales", SALES], ["Admin", ADMIN]])("is still offered to %s", async (_name, user) => {
    signIn(user);
    await openBooking();
    expect(await screen.findByText("Cancel booking")).toBeTruthy();
  });
});

describe("Indent History: Cancel Indent", () => {
  const openIndent = () => {
    act(() => useIndentHistoryStore.setState({ selectedIndent: INDENT, fetchIndents: vi.fn() }));
    render(<MemoryRouter><IndentDrawer /></MemoryRouter>);
  };

  test("is not offered to a customer", async () => {
    signIn(CUSTOMER);
    openIndent();
    await screen.findByText("Indent PI-2026-000001");
    expect(screen.queryByText(/Cancel Indent/i)).toBeNull();
  });

  test.each([["Sales", SALES], ["Admin", ADMIN]])("is still offered to %s", async (_name, user) => {
    signIn(user);
    openIndent();
    expect(await screen.findByText(/Cancel Indent/i)).toBeTruthy();
  });
});
