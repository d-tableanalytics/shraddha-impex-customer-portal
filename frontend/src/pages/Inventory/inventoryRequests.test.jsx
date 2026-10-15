import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Inventory list requests.
 *
 * Changing the search from page 2 onwards used to fetch twice: once for the new
 * search on the OLD page (an effect reset the page only after that request had
 * gone), then again for page 1. And nothing stopped a slow answer for an older
 * page or term from replacing a newer one.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("../../services/socketService", () => ({ onStockUpdated: () => () => {} }));

const productsApi = vi.hoisted(() => ({ getInventory: vi.fn(), getInventoryExport: vi.fn() }));
vi.mock("../../services/products", () => ({ productsApi }));

import { Inventory } from "./Inventory";
import { useUserStore } from "../../store/userStore";
import { useProductStore } from "../../store/productStore";
import { resetSessionStores } from "../../store/sessionReset";

const pageOf = (params) => ({
  items: [{ id: `${params.search}-${params.page}`, code: `SKU-${params.search || "all"}-${params.page}`, brand: "Koken", availableStock: 1 }],
  total: 120, pages: 10, catalogueTotal: 8594, lowStockCount: 0,
});
const calls = () => productsApi.getInventory.mock.calls.map(([p]) => ({ search: p.search, page: p.page }));

describe("Inventory requests", () => {
  beforeEach(() => {
    resetSessionStores();
    useUserStore.setState({ user: { _id: "a1", role: "Admin", permissions: ["*"], brandAccess: { koken: true } }, loading: false });
    productsApi.getInventory.mockImplementation(async (params) => pageOf(params));
  });

  test("a new search from page 2 is one request, for page 1", async () => {
    render(<MemoryRouter><Inventory /></MemoryRouter>);
    await screen.findByText("SKU-all-1");
    fireEvent.click(screen.getByLabelText("Next page"));
    await screen.findByText("SKU-all-2");
    productsApi.getInventory.mockClear();

    fireEvent.change(screen.getByPlaceholderText(/Search by SKU/), { target: { value: "130" } });
    await screen.findByText("SKU-130-1", {}, { timeout: 2000 });
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(calls()).toEqual([{ search: "130", page: 1 }]);
  });

  test("a late answer for an older request cannot replace the newer one", async () => {
    let releaseOld;
    productsApi.getInventory
      .mockImplementationOnce((params) => new Promise((r) => { releaseOld = () => r(pageOf(params)); }))
      .mockImplementationOnce(async (params) => pageOf(params));
    const store = useProductStore.getState();
    const first = store.fetchInventory({ search: "", page: 1 });
    const second = store.fetchInventory({ search: "", page: 2 });
    await second;
    releaseOld();
    await first;
    expect(useProductStore.getState().inventory.items[0].code).toBe("SKU-all-2");
    // ...and the older request was abandoned when the newer one started.
    expect(productsApi.getInventory.mock.calls[0][1].signal.aborted).toBe(true);
  });

  test("signing out clears the list, so the next account never sees it", async () => {
    await useProductStore.getState().fetchInventory({ search: "", page: 1 });
    expect(useProductStore.getState().inventory.items).toHaveLength(1);
    resetSessionStores();
    await waitFor(() => expect(useProductStore.getState().inventory.items).toHaveLength(0));
  });
});
