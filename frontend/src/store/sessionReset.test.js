import { describe, test, expect, vi } from "vitest";

/**
 * Data kept on screen across refreshes must not survive a change of account.
 *
 * The stores used to blank to skeletons on every fetch, which hid the previous
 * account's rows by accident. Now that they keep their data during a refresh,
 * signing out (or in as someone else) has to clear it explicitly.
 */

const usersApi = vi.hoisted(() => ({ logout: vi.fn(async () => {}), login: vi.fn(), getCurrentUser: vi.fn() }));
vi.mock("../services/users", () => ({ usersApi }));
vi.mock("../services/socketService", () => ({ refreshSocketAuth: vi.fn() }));
vi.mock("../services/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

import { useUserStore } from "./userStore";
import { useSalesStore } from "./salesStore";
import { useOrderHistoryStore } from "./orderHistoryStore";
import { useCartStore } from "./cartStore";
import { queryClient } from "../lib/queryClient";
import { queryKeys } from "../lib/queryKeys";

const fillStores = () => {
  useSalesStore.setState({ bookings: [{ orderId: "BO-1" }], loading: false, appliedSearch: "x" });
  useOrderHistoryStore.setState({ allOrders: [{ orderNumber: "BO-1" }], orders: [{ orderNumber: "BO-1" }], loading: false });
  useCartStore.setState({ pendingItems: [{ _id: "p1" }], pendingLoaded: true, pendingFetchedAt: Date.now() });
  queryClient.setQueryData(queryKeys.dashboard.stats(), { totalOrders: 9 });
};

const expectEmpty = () => {
  expect(useSalesStore.getState().bookings).toEqual([]);
  expect(useSalesStore.getState().loading).toBe(true);
  expect(useOrderHistoryStore.getState().allOrders).toEqual([]);
  expect(useOrderHistoryStore.getState().loading).toBe(true);
  expect(useCartStore.getState().pendingItems).toEqual([]);
  expect(useCartStore.getState().pendingFetchedAt).toBe(0);
  expect(queryClient.getQueryData(queryKeys.dashboard.stats())).toBeUndefined();
};

describe("changing account", () => {
  test("logout clears every store that keeps data across refreshes", async () => {
    fillStores();
    useUserStore.setState({ user: { _id: "u1" } });
    await useUserStore.getState().logout();
    expect(useUserStore.getState().user).toBeNull();
    expectEmpty();
  });

  test("logging in clears what the previous account left behind", async () => {
    fillStores();
    usersApi.login.mockResolvedValue({ token: "t" });
    usersApi.getCurrentUser.mockResolvedValue({ _id: "u2" });
    await useUserStore.getState().login({ email: "b@x", password: "p" });
    expect(useUserStore.getState().user).toEqual({ _id: "u2" });
    expectEmpty();
  });
});
