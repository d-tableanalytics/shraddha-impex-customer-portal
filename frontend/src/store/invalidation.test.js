import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Reusing recent data on revisit — and never past a booking change.
 *
 * Booking History, the Sales Desk and the indent list now reuse what they loaded
 * a few seconds ago when reopened, instead of downloading everything again on
 * each visit. That is only safe because any write that changes bookings marks
 * every one of them stale (store/invalidation.js), whichever screen made it.
 */

const ordersApi = vi.hoisted(() => ({ getAll: vi.fn(), cancel: vi.fn() }));
const salesApi = vi.hoisted(() => ({ getBookings: vi.fn(), raisePo: vi.fn() }));
const reservationsApi = vi.hoisted(() => ({ getPending: vi.fn(), getAll: vi.fn(), confirm: vi.fn(), create: vi.fn() }));
vi.mock("../services/orders", () => ({ ordersApi }));
vi.mock("../services/sales", () => ({ salesApi }));
vi.mock("../services/reservations", () => ({ reservationsApi }));
vi.mock("../services/api", () => ({ api: { get: vi.fn() } }));

import { useOrderHistoryStore, ORDERS_FRESH_MS } from "./orderHistoryStore";
import { useSalesStore, BOOKINGS_FRESH_MS } from "./salesStore";
import { useCartStore } from "./cartStore";
import { invalidateBookingData } from "./invalidation";
import { resetSessionStores } from "./sessionReset";
import { queryClient } from "../lib/queryClient";
import { queryKeys } from "../lib/queryKeys";

describe("revisits and invalidation", () => {
  let now;
  beforeEach(() => {
    resetSessionStores();
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    ordersApi.getAll.mockResolvedValue([{ orderNumber: "BO-1", date: "2026-10-01", status: "PO Received" }]);
    salesApi.getBookings.mockResolvedValue({ data: [{ orderId: "BO-1" }], meta: {} });
    reservationsApi.getPending.mockResolvedValue([]);
    reservationsApi.getAll.mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  test("Booking History reopened within the window reuses its list", async () => {
    const s = useOrderHistoryStore.getState();
    await s.ensureOrders();
    await s.ensureOrders();
    now += ORDERS_FRESH_MS - 1;
    await s.ensureOrders();
    expect(ordersApi.getAll).toHaveBeenCalledTimes(1);
    now += 2;
    await s.ensureOrders();
    expect(ordersApi.getAll).toHaveBeenCalledTimes(2);
  });

  test("opening it twice at once (React Strict Mode) is one request", async () => {
    const s = useOrderHistoryStore.getState();
    await Promise.all([s.ensureOrders(), s.ensureOrders()]);
    expect(ordersApi.getAll).toHaveBeenCalledTimes(1);
  });

  test("the Sales Desk reuses its list only for the same scope and search", async () => {
    const s = useSalesStore.getState();
    await s.ensureBookings();
    await s.ensureBookings();
    expect(salesApi.getBookings).toHaveBeenCalledTimes(1);
    useSalesStore.setState({ scope: "pending" });
    await s.ensureBookings();
    expect(salesApi.getBookings).toHaveBeenCalledTimes(2);
    now += BOOKINGS_FRESH_MS + 1;
    await s.ensureBookings();
    expect(salesApi.getBookings).toHaveBeenCalledTimes(3);
  });

  test("a booking change anywhere makes every booking screen re-read on its next visit", async () => {
    await useOrderHistoryStore.getState().ensureOrders();
    await useSalesStore.getState().ensureBookings();
    await useCartStore.getState().ensurePendingReservations();
    queryClient.setQueryData(queryKeys.dashboard.stats(), { totalOrders: 1 });

    invalidateBookingData();

    await useOrderHistoryStore.getState().ensureOrders();
    await useSalesStore.getState().ensureBookings();
    await useCartStore.getState().ensurePendingReservations();
    expect(ordersApi.getAll).toHaveBeenCalledTimes(2);
    expect(salesApi.getBookings).toHaveBeenCalledTimes(2);
    expect(reservationsApi.getPending).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryState(queryKeys.dashboard.stats()).isInvalidated).toBe(true);
  });

  test("confirming a booking invalidates the other screens", async () => {
    await useOrderHistoryStore.getState().ensureOrders();
    reservationsApi.confirm.mockResolvedValue({ orderId: "BO-2" });
    await useCartStore.getState().confirmBooking();
    await useOrderHistoryStore.getState().ensureOrders();
    expect(ordersApi.getAll).toHaveBeenCalledTimes(2);
  });

  test("raising a PO on the desk invalidates Booking History", async () => {
    await useOrderHistoryStore.getState().ensureOrders();
    salesApi.raisePo.mockResolvedValue({ poNumber: "PO-1" });
    await useSalesStore.getState().raisePo("BO-1", {});
    await useOrderHistoryStore.getState().ensureOrders();
    expect(ordersApi.getAll).toHaveBeenCalledTimes(2);
  });

  test("cancelling from Booking History re-reads it at once and invalidates the desk", async () => {
    await useOrderHistoryStore.getState().ensureOrders();
    await useSalesStore.getState().ensureBookings();
    ordersApi.cancel.mockResolvedValue({ message: "ok" });
    useOrderHistoryStore.setState({ fetchTimeline: vi.fn() });
    await useOrderHistoryStore.getState().cancelBooking({ orderNumber: "BO-1" }, "x");
    expect(ordersApi.getAll).toHaveBeenCalledTimes(2); // its own immediate re-read
    await useSalesStore.getState().ensureBookings();
    expect(salesApi.getBookings).toHaveBeenCalledTimes(2);
  });

  test("changing the selection list refreshes only the dashboard figures", async () => {
    await useOrderHistoryStore.getState().ensureOrders();
    queryClient.setQueryData(queryKeys.dashboard.stats(), { totalOrders: 1 });
    reservationsApi.create.mockResolvedValue({ merged: false });
    await useCartStore.getState().addItem({ id: "p1" }, 2);
    expect(queryClient.getQueryState(queryKeys.dashboard.stats()).isInvalidated).toBe(true);
    await useOrderHistoryStore.getState().ensureOrders();
    expect(ordersApi.getAll).toHaveBeenCalledTimes(1);
  });
});
