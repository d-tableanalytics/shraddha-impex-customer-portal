import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The booking drawer's indent list.
 *
 * Opening a booking used to download every pending indent in the system again,
 * on every click, although Booking History had loaded the same list seconds
 * earlier. The drawer now reuses a recent list — and still re-reads it after any
 * action taken from the drawer that can change indents.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("../../services/api", () => ({
  api,
  describeRequestFailure: (_e, f) => f,
  refreshAccessToken: vi.fn(),
}));

import { OrderHistory } from "../../pages/OrderHistory/OrderHistory";
import { useUserStore } from "../../store/userStore";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useCartStore, PENDING_FRESH_MS } from "../../store/cartStore";
import { resetSessionStores } from "../../store/sessionReset";

const ORDERS = [
  { _id: "r1", orderId: "BO-2026-000001", skuCode: "SKU-1", brand: "Koken", company: "ABC Motors", status: "PO Received",
    createdAt: "2026-10-01T10:00:00Z", requestedQty: 5, bookedQty: 5, confirmedQty: 5, pendingQty: 0, poNumber: "-", user: "c1" },
  { _id: "r2", orderId: "BO-2026-000002", skuCode: "SKU-2", brand: "Koken", company: "ABC Motors", status: "PO Received",
    createdAt: "2026-10-02T10:00:00Z", requestedQty: 5, bookedQty: 5, confirmedQty: 5, pendingQty: 0, poNumber: "-", user: "c1" },
];

const pendingCalls = () => api.get.mock.calls.filter(([url]) => url === "/reservations/pending");
const booking = (id) => useOrderHistoryStore.getState().allOrders.find((o) => o.orderNumber === id);
const open = (id) => act(() => useOrderHistoryStore.getState().setSelectedOrder(booking(id)));
const close = () => act(() => useOrderHistoryStore.getState().setSelectedOrder(null));

describe("the booking drawer's indents", () => {
  let now;

  beforeEach(() => {
    resetSessionStores();
    now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    useUserStore.setState({ user: { _id: "a1", role: "Admin", permissions: ["*"] }, loading: false });
    api.get.mockImplementation((url) => {
      if (url === "/orders") return Promise.resolve({ data: { data: ORDERS } });
      if (url === "/reservations/pending") return Promise.resolve({ data: { data: [] } });
      if (url === "/reservations/cancelled-count") return Promise.resolve({ data: { data: { count: 0 } } });
      if (url.includes("/quantity-history")) return Promise.resolve({ data: { data: { entries: [] } } });
      if (url.includes("/timeline")) return Promise.resolve({ data: { data: { timeline: [] } } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    api.post.mockResolvedValue({ data: { success: true, message: "Cancelled" } });
  });
  afterEach(() => vi.restoreAllMocks());

  const renderPage = async () => {
    render(<MemoryRouter><OrderHistory /></MemoryRouter>);
    await waitFor(() => expect(booking("BO-2026-000002")).toBeTruthy());
    await waitFor(() => expect(useCartStore.getState().pendingLoaded).toBe(true));
  };

  test("opening bookings reuses the list the page just loaded", async () => {
    await renderPage();
    expect(pendingCalls()).toHaveLength(1); // the page's own load

    open("BO-2026-000001");
    close();
    open("BO-2026-000002");
    close();
    open("BO-2026-000001");
    await new Promise((r) => setTimeout(r, 20));
    expect(pendingCalls()).toHaveLength(1);
  });

  test("a list older than the freshness window is read again on open", async () => {
    await renderPage();
    now += PENDING_FRESH_MS + 1;
    open("BO-2026-000001");
    await waitFor(() => expect(pendingCalls()).toHaveLength(2));
  });

  test("cancelling a booking from the drawer re-reads the indents", async () => {
    await renderPage();
    open("BO-2026-000001");
    fireEvent.click(await screen.findByText("Cancel booking"));
    const confirm = (await screen.findAllByText("Cancel booking")).at(-1);
    fireEvent.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/orders/BO-2026-000001/cancel", expect.anything(),
    ));
    await waitFor(() => expect(pendingCalls()).toHaveLength(2));
  });

  test("a failed refresh keeps the indents already on screen", async () => {
    await renderPage();
    useCartStore.setState({ pendingItems: [{ _id: "p1", indentNumber: "PI-2026-000001" }] });
    api.get.mockImplementation((url) =>
      url === "/reservations/pending" ? Promise.reject(new Error("down")) : Promise.resolve({ data: { data: [] } }));
    await useCartStore.getState().fetchPendingReservations();
    expect(useCartStore.getState().pendingItems).toHaveLength(1);
    // ...and it is marked stale, so the next open tries again.
    expect(useCartStore.getState().pendingFetchedAt).toBe(0);
    await useCartStore.getState().fetchPendingReservations();
    expect(useCartStore.getState().pendingItems).toHaveLength(1);
  });

  test("callers asking at the same moment share one request", async () => {
    await renderPage();
    now += PENDING_FRESH_MS + 1;
    const { ensurePendingReservations } = useCartStore.getState();
    await Promise.all([ensurePendingReservations(), ensurePendingReservations(), ensurePendingReservations()]);
    expect(pendingCalls()).toHaveLength(2);
  });
});
