import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * Inventory Master → Inventory Health Check / Add Brands → Back to Inventory
 * Master, through the REAL destination pages, with the search and filters
 * still applied on return.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("../../services/socketService", () => ({ onStockUpdated: () => () => {} }));

const inventoryApi = vi.hoisted(() => {
  const listItems = vi.fn(async () => ({ items: [], total: 0, pages: 1, catalogueTotal: 0 }));
  const listHealth = vi.fn(async () => ({ items: [], total: 0, pages: 1, bandCounts: {} }));
  const listBrands = vi.fn(async () => []);
  return new Proxy({ listItems, listHealth, listBrands }, {
    get: (t, name) => t[name] || (t[name] = vi.fn(async () => ({}))),
  });
});
vi.mock("../../services/inventory", () => ({ inventoryApi }));

import { InventoryMaster } from "./InventoryMaster";
import { InventoryHealth } from "./InventoryHealth";
import { InventoryBrands } from "./InventoryBrands";
import { canReturnToInventoryMaster } from "../../components/inventory/BackToInventoryMaster";
import { useUserStore } from "../../store/userStore";
import { useInventoryStore } from "../../store/inventoryStore";
import { resetSessionStores } from "../../store/sessionReset";

const ADMIN = { _id: "a1", role: "Admin", permissions: ["*"], brandAccess: { koken: true } };

const renderApp = (user = ADMIN, at = "/inventory/master") => {
  useUserStore.setState({ user, loading: false });
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/inventory/master" element={<InventoryMaster />} />
        <Route path="/inventory/health" element={<InventoryHealth />} />
        <Route path="/inventory/brands" element={<InventoryBrands />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
};

const searchBox = () => screen.getByPlaceholderText("Search by SKU or MSIL code...");
const back = () => screen.getByRole("button", { name: /Back to Inventory Master/ });

const INITIAL_FILTERS = { ...useInventoryStore.getState().filters };

beforeEach(() => {
  resetSessionStores();
  // The inventory filters outlive the page by design (that is what is tested
  // here), so each case starts from the store's initial filters.
  useInventoryStore.setState({ filters: { ...INITIAL_FILTERS } });
  vi.clearAllMocks();
});

describe("Back to Inventory Master", () => {
  test.each([
    ["Inventory Health Check", "Inventory Health"],
    ["Add Brands", "Brands"],
  ])("%s → %s page → back, with the search and filters still applied", async (button, title) => {
    renderApp();
    await screen.findByRole("button", { name: new RegExp(button) });

    // Narrow the list: a search (debounced) and a status filter.
    fireEvent.change(searchBox(), { target: { value: "14405" } });
    await waitFor(() => expect(useInventoryStore.getState().filters.search).toBe("14405"));
    fireEvent.change(screen.getByDisplayValue("All Statuses"), { target: { value: "Inactive" } });

    fireEvent.click(screen.getByRole("button", { name: new RegExp(button) }));
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();

    fireEvent.click(back());
    await screen.findByRole("heading", { name: "Inventory Master" });
    // The box shows the search the list is filtered by, and the filter is kept.
    expect(searchBox().value).toBe("14405");
    expect(screen.getByDisplayValue("Inactive")).toBeTruthy();
    await waitFor(() => expect(inventoryApi.listItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "14405", status: "Inactive" }),
    ));
  });

  test("works when the page was opened directly, not from Inventory Master", async () => {
    renderApp(ADMIN, "/inventory/health");
    expect(await screen.findByRole("heading", { name: "Inventory Health" })).toBeTruthy();
    fireEvent.click(back());
    expect(await screen.findByRole("heading", { name: "Inventory Master" })).toBeTruthy();
  });

  test("is not offered to a user who cannot open Inventory Master", () => {
    expect(canReturnToInventoryMaster(ADMIN)).toBe(true);
    const healthOnly = {
      role: "X", permissions: ["view_inventory"],
      grants: [{ module: "inventory", submodule: "health", actions: ["view"] }],
    };
    expect(canReturnToInventoryMaster(healthOnly)).toBe(false);
  });

  test("Inventory Master itself has no back button", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Inventory Master" });
    expect(screen.queryByRole("button", { name: /Back to Inventory Master/ })).toBeNull();
  });
});
