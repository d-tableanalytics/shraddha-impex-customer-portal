import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * Sales opening Inventory Master.
 *
 * The page used to admit Sales only through Manage Pricing. A Sales role saved
 * before that key existed does not carry it, and a saved role is the whole
 * answer on the server, so the page bounced Sales to Home while the sidebar and
 * the route both offered it. The screen now opens for anyone holding View
 * Inventory; what they can DO stays behind each action's own permission.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("../../services/socketService", () => ({ onStockUpdated: () => () => {} }));

const inventoryApi = vi.hoisted(() => {
  const listItems = vi.fn(async () => ({
    // Access and buttons are under test, not rows.
    items: [], total: 0, pages: 1, catalogueTotal: 0,
  }));
  return new Proxy({ listItems }, { get: (t, name) => t[name] || (t[name] = vi.fn(async () => ({}))) });
});
vi.mock("../../services/inventory", () => ({ inventoryApi }));

import { InventoryMaster } from "./InventoryMaster";
import { useUserStore } from "../../store/userStore";
import { resetSessionStores } from "../../store/sessionReset";
import { canOpenInventoryMaster } from "../../utils/permissions";

const masterView = { module: "inventory", submodule: "master", actions: ["view"] };

/** A Sales role saved before Manage Pricing existed: View Inventory, no pricing. */
const STALE_SALES = {
  _id: "s1", role: "Sales", brandAccess: { koken: true },
  permissions: ["view_dashboard", "view_all_bookings", "raise_po", "view_inventory"],
  grants: [masterView],
};
const CUSTOMER = {
  _id: "c1", role: "Customer", brandAccess: { koken: true },
  permissions: ["view_dashboard", "view_catalogue", "create_order", "view_orders"],
  grants: [],
};

const open = (user) => {
  useUserStore.setState({ user, loading: false });
  return render(
    <MemoryRouter initialEntries={["/inventory/master"]}>
      <Routes>
        <Route path="/inventory/master" element={<InventoryMaster />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  resetSessionStores();
  vi.clearAllMocks();
});

describe("Sales on Inventory Master", () => {
  test("opens for Sales even when the saved role has no Manage Pricing", async () => {
    open(STALE_SALES);
    expect(await screen.findByRole("heading", { name: "Inventory Master" })).toBeTruthy();
    expect(screen.queryByText("Home")).toBeNull();
    expect(inventoryApi.listItems).toHaveBeenCalled();
  });

  test("is read-only for that Sales user: no Add SKU and no Export", async () => {
    open(STALE_SALES);
    await screen.findByRole("heading", { name: "Inventory Master" });
    expect(screen.queryByRole("button", { name: /Add SKU/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
  });

  test("a customer is still refused, now with the Unauthorized panel", async () => {
    open(CUSTOMER);
    expect(await screen.findByText(/don.t have access to this screen/)).toBeTruthy();
    expect(screen.queryByText("Home")).toBeNull();
  });

  test("the rule: View Inventory opens it, the catalogue alone does not", () => {
    expect(canOpenInventoryMaster(STALE_SALES)).toBe(true);
    expect(canOpenInventoryMaster(CUSTOMER)).toBe(false);
    // Without grants (an older server), the permission decides.
    expect(canOpenInventoryMaster({ role: "Sales", permissions: ["view_inventory"] })).toBe(true);
    expect(canOpenInventoryMaster({ role: "Customer", permissions: ["view_catalogue"] })).toBe(false);
  });
});
