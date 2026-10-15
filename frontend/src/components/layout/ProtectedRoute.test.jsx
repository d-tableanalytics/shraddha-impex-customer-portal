import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * The session guard, now that it starts fetching the page's code early.
 *
 * Fetching CODE while `/auth/me` is pending is the only change. Nothing protected
 * may render — and so no page data may be requested — before the session is
 * established, and a missing session still goes to the login screen.
 */

const chunks = vi.hoisted(() => ({ prefetchRoute: vi.fn() }));
vi.mock("../../routes/routeChunks", () => chunks);

import { ProtectedRoute } from "./ProtectedRoute";
import { useUserStore } from "../../store/userStore";

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/login" element={<div>login screen</div>} />
      <Route element={<ProtectedRoute />}>
        <Route path="/orders/history" element={<div>protected page</div>} />
      </Route>
    </Routes>
  </MemoryRouter>,
);

describe("ProtectedRoute", () => {
  beforeEach(() => {
    useUserStore.setState({ user: null, loading: false });
  });

  test("while the session is checked: spinner only, and the page's code starts downloading", () => {
    useUserStore.setState({ user: null, loading: true });
    renderAt("/orders/history");
    expect(screen.getByText("Loading portal credentials...")).toBeTruthy();
    expect(screen.queryByText("protected page")).toBeNull();
    expect(chunks.prefetchRoute).toHaveBeenCalledWith("/orders/history");
  });

  test("no session sends the user to login, and fetches nothing", () => {
    renderAt("/orders/history");
    expect(screen.getByText("login screen")).toBeTruthy();
    expect(screen.queryByText("protected page")).toBeNull();
    expect(chunks.prefetchRoute).not.toHaveBeenCalled();
  });

  test("an established session renders the page", () => {
    useUserStore.setState({ user: { _id: "u1", role: "Customer" }, loading: false });
    renderAt("/orders/history");
    expect(screen.getByText("protected page")).toBeTruthy();
  });
});

describe("pageForPath", async () => {
  const { pageForPath } = await vi.importActual("../../routes/routeChunks");
  test("maps the protected screens to their chunks", () => {
    expect(pageForPath("/")).toBe("Dashboard");
    expect(pageForPath("/orders/history")).toBe("OrderHistory");
    expect(pageForPath("/sales?tab=x")).toBe("SalesDesk");
    expect(pageForPath("/admin/users")).toBe("UserManagement");
  });

  test("leaves unknown paths and FMS alone", () => {
    expect(pageForPath("/nowhere")).toBeNull();
    expect(pageForPath("/fms/o2d/tasks")).toBeNull();
    expect(pageForPath("/orders/history/extra")).toBeNull();
  });
});
