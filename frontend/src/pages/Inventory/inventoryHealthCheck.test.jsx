import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * The "Inventory Health Check" button on Inventory Master: one click to the
 * EXISTING Inventory Health route, offered only to a user the route would let in.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("../../services/socketService", () => ({ onStockUpdated: () => () => {} }));

const inventoryApi = vi.hoisted(() => new Proxy({}, {
  get: (_t, name) => (name === "listItems"
    ? vi.fn(async () => ({ items: [], total: 0, pages: 1, catalogueTotal: 0, missingPlanningCount: 0 }))
    : vi.fn(async () => ({}))),
}));
vi.mock("../../services/inventory", () => ({ inventoryApi }));

import {
  InventoryMaster, canOpenInventoryHealth, INVENTORY_HEALTH_PATH, canOpenBrands, BRANDS_PATH,
} from "./InventoryMaster";
import { useUserStore } from "../../store/userStore";
import { resetSessionStores } from "../../store/sessionReset";

const ADMIN = { _id: "a1", role: "Admin", permissions: ["*"], brandAccess: { koken: true } };
const WITH_HEALTH = {
  _id: "i1", role: "Inventory Manager", permissions: ["view_inventory", "manage_inventory_master", "export_inventory"],
  // The server derives a grant for every cell the permissions satisfy, so
  // export_inventory comes with the inventory.exports cell (ExportButton asks it).
  grants: [
    { module: "inventory", submodule: "health", actions: ["view"] },
    { module: "inventory", submodule: "master", actions: ["view"] },
    { module: "inventory", submodule: "exports", actions: ["view"] },
  ],
  brandAccess: { koken: true },
};
const WITHOUT_HEALTH = {
  ...WITH_HEALTH,
  grants: [
    { module: "inventory", submodule: "master", actions: ["view"] },
    { module: "inventory", submodule: "exports", actions: ["view"] },
  ],
};

const renderMaster = (user) => {
  useUserStore.setState({ user, loading: false });
  return render(
    <MemoryRouter initialEntries={["/inventory/master"]}>
      <Routes>
        <Route path="/inventory/master" element={<InventoryMaster />} />
        <Route path={INVENTORY_HEALTH_PATH} element={<div>Inventory Health page</div>} />
        <Route path={BRANDS_PATH} element={<div>Brands page</div>} />
      </Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => resetSessionStores());

describe("Inventory Health Check button", () => {
  test("sits in the header actions and opens the existing Inventory Health route", async () => {
    renderMaster(ADMIN);
    const button = await screen.findByRole("button", { name: /Inventory Health Check/ });
    // Beside the other actions, not somewhere else on the page.
    expect(button.closest("div")).toBe(screen.getByRole("button", { name: /^Import$/ }).closest("div"));
    fireEvent.click(button);
    expect(await screen.findByText("Inventory Health page")).toBeTruthy();
  });

  test("is offered exactly when the Inventory Health route would let the user in", async () => {
    expect(canOpenInventoryHealth(ADMIN)).toBe(true);
    expect(canOpenInventoryHealth(WITH_HEALTH)).toBe(true);
    expect(canOpenInventoryHealth(WITHOUT_HEALTH)).toBe(false);

    renderMaster(WITHOUT_HEALTH);
    await screen.findByRole("button", { name: /^Import$/ });
    expect(screen.queryByRole("button", { name: /Inventory Health Check/ })).toBeNull();
  });
});

describe("Add Brands and Export", () => {
  test("Add Brands takes Export's place in the header and opens the existing Brands page", async () => {
    renderMaster(ADMIN);
    const addBrands = await screen.findByRole("button", { name: /Add Brands/ });
    const header = screen.getByRole("button", { name: /^Import$/ }).closest("div");
    expect(addBrands.closest("div")).toBe(header);
    // Export is no longer in the header…
    expect(within(header).queryByRole("button", { name: /Export/ })).toBeNull();
    // …it is in the filter bar, with the filter controls.
    const filterBar = screen.getByDisplayValue("All Statuses").closest("div");
    expect(within(filterBar).getByRole("button", { name: /Export/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Export/ })).toHaveLength(1);

    fireEvent.click(addBrands);
    expect(await screen.findByText("Brands page")).toBeTruthy();
  });

  test("is offered exactly when the Brands route would let the user in", async () => {
    expect(canOpenBrands(ADMIN)).toBe(true);
    const brandsGrant = { ...WITH_HEALTH, grants: [...WITH_HEALTH.grants, { module: "inventory", submodule: "brands", actions: ["view"] }] };
    expect(canOpenBrands(brandsGrant)).toBe(true);
    expect(canOpenBrands(WITH_HEALTH)).toBe(false);
    // An older server sends no grants: the permission behind the cell decides.
    expect(canOpenBrands({ role: "Inventory Manager", permissions: ["view_inventory"] })).toBe(false);
    expect(canOpenBrands({ role: "X", permissions: ["configure_inventory"] })).toBe(true);

    renderMaster(WITH_HEALTH);
    await screen.findByRole("button", { name: /^Import$/ });
    expect(screen.queryByRole("button", { name: /Add Brands/ })).toBeNull();
    // Export stays available to them in the filter bar.
    expect(screen.getByRole("button", { name: /Export/ })).toBeTruthy();
  });
});
