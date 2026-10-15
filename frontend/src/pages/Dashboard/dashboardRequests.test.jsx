import { describe, test, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";

/**
 * The dashboard asks for its statistics ONCE.
 *
 * Four widgets used to call `/dashboard/stats` themselves — three identical
 * requests, plus the chart's `?range=6m`, which is the server's default range.
 * Each of those runs ~19 queries server-side, so a dashboard load cost four
 * times what it needed. These pin the shared request, the chart reusing it for
 * its default range, and the per-range fetch for any other range.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../services/api", () => ({ api }));

import { Dashboard } from "./Dashboard";
import { useUserStore } from "../../store/userStore";
import { queryClient } from "../../lib/queryClient";
import { queryKeys } from "../../lib/queryKeys";

beforeAll(() => {
  // recharts' ResponsiveContainer needs it; jsdom has none.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

const trend6m = [{ name: "May", booked: 10, confirmed: 8, unfulfilled: 2, orders: 3, qty: 8 }];
const trend3m = [{ name: "Aug", booked: 4, confirmed: 4, unfulfilled: 0, orders: 1, qty: 4 }];
const stats = (monthlyTrend = trend6m) => ({
  data: {
    data: {
      totalProducts: 8594, lowStockAlerts: 12, totalOrders: 124, bookedOrders: 31,
      dispatchedOrders: 5, deliveredOrders: 80, activeUsers: 30,
      totalIndentCount: 7, totalIndentQty: 410, totalIndentLines: 35,
      totalBooked: 1000, totalConfirmed: 800, totalPending: 150, totalReserved: 50, conversionRate: 80,
      monthlyTrend,
      recentOrders: [{ _id: "o1", orderId: "BO-2026-000001", status: "Delivered", skuCode: "SKU-1", createdAt: "2026-10-01T00:00:00Z" }],
    },
  },
});

const statsCalls = () => api.get.mock.calls.filter(([url]) => url === "/dashboard/stats");

const renderDashboard = () => render(
  <QueryClientProvider client={queryClient}><MemoryRouter><Dashboard /></MemoryRouter></QueryClientProvider>,
);

describe("dashboard statistics", () => {
  beforeEach(() => {
    queryClient.clear();
    useUserStore.setState({ user: { _id: "u1", role: "Admin", permissions: ["*"] }, loading: false });
    api.get.mockImplementation((url, config) =>
      Promise.resolve(config?.params?.range === "3m" ? stats(trend3m) : stats()));
  });

  test("one request feeds every widget, with the values it always showed", async () => {
    renderDashboard();
    expect(await screen.findByText((8594).toLocaleString())).toBeTruthy(); // KPI tile
    expect(screen.getByText("80%")).toBeTruthy();                          // conversion
    expect(screen.getByText("BO-2026-000001")).toBeTruthy();               // activity feed
    expect(statsCalls()).toHaveLength(1);
    // The shared request asks for the server's default range, which is the
    // chart's default — so the chart did not need one of its own.
    expect(statsCalls()[0][1]?.params).toBeUndefined();
  });

  test("another range is fetched once, and the default range reuses the shared payload", async () => {
    renderDashboard();
    await screen.findByText((8594).toLocaleString());
    const select = screen.getByRole("combobox");

    fireEvent.change(select, { target: { value: "3m" } });
    await waitFor(() => expect(statsCalls()).toHaveLength(2));
    expect(statsCalls()[1][1].params).toEqual({ range: "3m" });

    fireEvent.change(select, { target: { value: "6m" } });
    fireEvent.change(select, { target: { value: "3m" } });
    // Back to the default, then to a range already loaded: no new requests.
    await new Promise((r) => setTimeout(r, 20));
    expect(statsCalls()).toHaveLength(2);
  });

  test("a revisit within the stale window is answered from cache, with no request", async () => {
    const first = renderDashboard();
    await screen.findByText((8594).toLocaleString());
    first.unmount();
    renderDashboard();
    expect(screen.getByText((8594).toLocaleString())).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(statsCalls()).toHaveLength(1);
  });

  test("after a booking change the figures stay on screen while they are re-read", async () => {
    const first = renderDashboard();
    await screen.findByText((8594).toLocaleString());
    first.unmount();
    const { invalidateBookingData } = await import("../../store/invalidation");
    invalidateBookingData();

    let resolve;
    api.get.mockImplementation(() => new Promise((r) => { resolve = r; }));
    renderDashboard();
    expect(screen.getByText((8594).toLocaleString())).toBeTruthy();
    await waitFor(() => expect(statsCalls()).toHaveLength(2));
    resolve(stats());
  });

  test("a failed load leaves the widgets in their existing empty states", async () => {
    api.get.mockRejectedValue(new Error("down"));
    renderDashboard();
    // A failure with no answer is retried once; then the empty states show.
    expect(await screen.findByText("No bookings yet", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("No order data available yet")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(statsCalls()).toHaveLength(2);
  });

  test("a refusal from the server is not retried", async () => {
    api.get.mockRejectedValue({ response: { status: 403 } });
    renderDashboard();
    expect(await screen.findByText("No bookings yet")).toBeTruthy();
    expect(statsCalls()).toHaveLength(1);
  });

  test("signing out clears the figures, so the next account never sees them", async () => {
    renderDashboard();
    await screen.findByText((8594).toLocaleString());
    const { resetSessionStores } = await import("../../store/sessionReset");
    resetSessionStores();
    expect(queryClient.getQueryData(queryKeys.dashboard.stats())).toBeUndefined();
  });
});

describe("the Inventory dashboard's own store", () => {
  // Two stores share the word "dashboard". The home page's is homeDashboardStore;
  // store/dashboardStore.js belongs to the Inventory dashboard (IMS M5) and must
  // keep its own API — an earlier draft of this change overwrote it.
  test("still offers what InventoryDashboard.jsx uses", async () => {
    const { useDashboardStore } = await import("../../store/dashboardStore");
    const s = useDashboardStore.getState();
    expect(typeof s.fetchDashboard).toBe("function");
    expect(typeof s.fetchCategories).toBe("function");
    expect(typeof s.setFilters).toBe("function");
  });
});
