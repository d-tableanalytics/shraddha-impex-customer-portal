import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The glue that puts the Employee Portal's FMS screens inside this portal.
 *
 * The screens themselves are covered by their own tests, ported verbatim
 * (src/fms/pages/O2d/*.test.jsx). What only this portal has — and so only this
 * file can test — is how it decides whether to offer FMS at all, how it talks
 * to the Employee API, and where FMS lands in the rail.
 */

vi.mock("../services/api", () => ({ refreshAccessToken: vi.fn() }));

import { refreshAccessToken } from "../services/api";
import { api as fmsApi } from "./services/api";
import { useUserStore as useFmsUserStore } from "./store/userStore";
import { fmsNavGroup, withFmsGroup } from "./navigation";
import { useUserStore as usePortalUserStore } from "../store/userStore";
import { useUIStore } from "../store/uiStore";
import { useCartStore } from "../store/cartStore";
import { Sidebar } from "../components/layout/Sidebar";
import { FmsSession } from "./FmsSession";

const FMS_STAFF = { _id: "u1", user: "A Seller", role: "Sales", permissions: ["view_o2d", "create_o2d_order"] };

beforeEach(() => {
  vi.restoreAllMocks();
  refreshAccessToken.mockReset();
  useFmsUserStore.getState().clear();
  localStorage.setItem("token", "portal-token");
});

describe("the FMS session", () => {
  test("is read from the Employee API's /auth/me, as that server resolves the user", async () => {
    const get = vi.spyOn(fmsApi, "get").mockResolvedValue({ data: { data: FMS_STAFF } });

    await useFmsUserStore.getState().load({ _id: "u1", role: "Sales" });

    expect(get).toHaveBeenCalledWith("/auth/me");
    expect(useFmsUserStore.getState().user.permissions).toContain("view_o2d");
    expect(useFmsUserStore.getState().loading).toBe(false);
  });

  test("is never requested for a customer account", async () => {
    const get = vi.spyOn(fmsApi, "get");
    await useFmsUserStore.getState().load({ _id: "c1", role: "Customer" });
    expect(get).not.toHaveBeenCalled();
    expect(useFmsUserStore.getState().user).toBeNull();
    expect(useFmsUserStore.getState().loading).toBe(false);
  });

  test("an unreachable Employee API leaves FMS off, and throws nothing", async () => {
    vi.spyOn(fmsApi, "get").mockRejectedValue(new Error("Network Error"));
    await useFmsUserStore.getState().load({ _id: "u1", role: "Sales" });
    expect(useFmsUserStore.getState().user).toBeNull();
    expect(useFmsUserStore.getState().error).toBe("unreachable");
  });

  test("an answer about a different account is discarded", async () => {
    vi.spyOn(fmsApi, "get").mockResolvedValue({ data: { data: { ...FMS_STAFF, _id: "someone-else" } } });
    await useFmsUserStore.getState().load({ _id: "u1", role: "Sales" });
    expect(useFmsUserStore.getState().user).toBeNull();
  });

  test("a new portal user drops the previous FMS access before their own arrives", async () => {
    useFmsUserStore.setState({ user: FMS_STAFF, forUserId: "u1", loading: false });
    let resolve;
    vi.spyOn(fmsApi, "get").mockReturnValue(new Promise((r) => { resolve = r; }));

    const pending = useFmsUserStore.getState().load({ _id: "u2", role: "Billing" });
    expect(useFmsUserStore.getState().user).toBeNull();

    resolve({ data: { data: { ...FMS_STAFF, _id: "u2", role: "Billing" } } });
    await pending;
    expect(useFmsUserStore.getState().user._id).toBe("u2");
  });

  test("<FmsSession/> follows the portal user, and clears when the shell unmounts", async () => {
    vi.spyOn(fmsApi, "get").mockResolvedValue({ data: { data: FMS_STAFF } });
    usePortalUserStore.setState({ user: { _id: "u1", role: "Sales" } });

    const { unmount } = render(<FmsSession />);
    await waitFor(() => expect(useFmsUserStore.getState().user?._id).toBe("u1"));

    unmount();
    expect(useFmsUserStore.getState().user).toBeNull();
  });
});

describe("the Employee API transport", () => {
  test("sends this portal's token as a Bearer header, and no cookies", async () => {
    let seen;
    const res = await fmsApi.get("/auth/me", {
      adapter: async (config) => {
        seen = config;
        return { data: {}, status: 200, statusText: "OK", headers: {}, config };
      },
    });
    expect(res.status).toBe(200);
    expect(seen.headers.Authorization).toBe("Bearer portal-token");
    expect(seen.withCredentials).toBe(false);
  });

  test("a 401 refreshes through this portal's single flight, then retries once", async () => {
    refreshAccessToken.mockImplementation(async () => {
      localStorage.setItem("token", "fresh-token");
      return "fresh-token";
    });
    const tokens = [];
    const adapter = async (config) => {
      tokens.push(config.headers.Authorization);
      if (tokens.length === 1) {
        const error = new Error("401");
        error.config = config;
        error.response = { status: 401, data: {}, config };
        throw error;
      }
      return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config };
    };

    const res = await fmsApi.get("/o2d/tasks", { adapter });
    expect(res.data.ok).toBe(true);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(["Bearer portal-token", "Bearer fresh-token"]);
  });

  test("a second 401 is FMS refusing us — it rejects, and signs nobody out", async () => {
    refreshAccessToken.mockResolvedValue("portal-token");
    const adapter = async (config) => {
      const error = new Error("401");
      error.config = config;
      error.response = { status: 401, data: {}, config };
      throw error;
    };

    await expect(fmsApi.get("/o2d/tasks", { adapter })).rejects.toThrow("401");
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("token")).toBe("portal-token");
  });
});

describe("the FMS group in the rail", () => {
  test("is offered only with view_o2d, and Analytics only with view_o2d_analytics", () => {
    expect(fmsNavGroup(null)).toBeNull();
    expect(fmsNavGroup({ permissions: ["view_orders"] })).toBeNull();

    const basic = fmsNavGroup({ permissions: ["view_o2d"] });
    expect(basic.items.map((i) => i.path)).toEqual([
      "/fms/o2d/tasks", "/fms/o2d/orders", "/fms/o2d/stages", "/fms/o2d/history", "/fms/o2d/exits",
    ]);
    const full = fmsNavGroup({ permissions: ["view_o2d", "view_o2d_analytics"] });
    expect(full.items.at(-1).path).toBe("/fms/o2d/analytics");
  });

  test("sits after the Sales Desk, ahead of Inventory", () => {
    const g = (key) => ({ key, items: [] });
    const fms = fmsNavGroup({ permissions: ["view_o2d"] });
    expect(withFmsGroup([g("customer_portal"), g("sales"), g("inventory")], fms).map((x) => x.key))
      .toEqual(["customer_portal", "sales", "o2d", "inventory"]);
    expect(withFmsGroup([g("customer_portal"), g("inventory")], fms).map((x) => x.key))
      .toEqual(["customer_portal", "o2d", "inventory"]);
    expect(withFmsGroup([g("sales")], null).map((x) => x.key)).toEqual(["sales"]);
  });

  const drawSidebar = () => {
    useUIStore.setState({ sidebarOpen: true, collapsedNavGroups: [] });
    useCartStore.setState({ items: [] });
    usePortalUserStore.setState({
      user: {
        _id: "u1", user: "A Seller", role: "Sales", permissions: ["view_all_bookings"], status: "Active",
        menu: [{ key: "sales", label: "Sales Desk", icon: "FileCheck2",
          items: [{ key: "bookings", label: "Booking Desk", path: "/sales", icon: "FileCheck2" }] }],
      },
    });
    return render(<MemoryRouter initialEntries={["/fms/o2d/tasks"]}><Sidebar /></MemoryRouter>);
  };

  test("appears in the Sidebar for a user the Employee API grants FMS", () => {
    useFmsUserStore.setState({ user: FMS_STAFF, loading: false });
    drawSidebar();
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByText("FMS")).toBeTruthy();
    expect(within(nav).getByRole("link", { name: /My Tasks/ }).getAttribute("href")).toBe("/fms/o2d/tasks");
  });

  test("is absent from the Sidebar when FMS is not offered", () => {
    drawSidebar();
    expect(screen.queryByText("FMS")).toBeNull();
    // The rest of the rail is untouched: a one-item group renders as one row.
    expect(screen.getByRole("link", { name: /Sales Desk/ })).toBeTruthy();
  });
});
