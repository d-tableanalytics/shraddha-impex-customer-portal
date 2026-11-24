import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * Editing a SKU's MSIL code from Inventory Master.
 *
 * The code was shown in the panel header and in the list, but there was nowhere
 * to change it - the only ways in were the Fresh Inventory import and Add SKU.
 * The server had accepted `msilCode` on this endpoint all along (it is in
 * PLANNING_FIELDS, checked for a clash and registered on the booking
 * allowlist); the field simply was not on the form.
 *
 * What these tests pin is the CONTRACT WITH THAT SERVER, which is the part a
 * future edit could quietly break: the code must reach the save payload, an
 * emptied field must arrive as null rather than '', and a user without the
 * planning permission must not be offered the field at all.
 */

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("../../services/socketService", () => ({ onStockUpdated: () => () => {} }));

const ITEM = {
  skuCode: "14145M.150-14",
  brand: "Koken",
  msilCode: "MA0LW004000",
  description: "Socket 14mm",
  uom: "PCS",
  moq: 0,
  status: "Active",
  boxNo: "B-12",
  vendorName: "Ko-ken Japan",
  hasPlanningInputs: true,
  balances: { onHand: 10, reserved: 0, available: 10, inTransit: 0 },
  planning: {
    leadTime: 30,
    safetyFactor: 1.2,
    currentSeason: "Normal",
    dailyAvgConsumption: { low: 1, normal: 2, peak: 3 },
  },
};

const inventoryApi = vi.hoisted(() => {
  const listItems = vi.fn(async () => ({
    items: [], total: 0, pages: 1, catalogueTotal: 0,
  }));
  const getItem = vi.fn(async () => ({}));
  const updatePlanning = vi.fn(async (_sku, updates) => ({ ...ITEM, ...updates }));
  return new Proxy(
    { listItems, getItem, updatePlanning },
    { get: (t, name) => t[name] || (t[name] = vi.fn(async () => ({}))) },
  );
});
vi.mock("../../services/inventory", () => ({ inventoryApi }));

import { InventoryMaster } from "./InventoryMaster";
import { useUserStore } from "../../store/userStore";
import { useInventoryStore } from "../../store/inventoryStore";
import { resetSessionStores } from "../../store/sessionReset";

const grants = [{ module: "inventory", submodule: "master", actions: ["view", "edit"] }];

/** Holds MANAGE_INVENTORY_MASTER, so the planning form is editable. */
const MANAGER = {
  _id: "m1", role: "Inventory Manager", brandAccess: { koken: true },
  permissions: ["view_inventory", "manage_inventory_master"],
  grants,
};
/** May look, may not edit. */
const VIEWER = {
  _id: "v1", role: "Sales", brandAccess: { koken: true },
  permissions: ["view_inventory"],
  grants: [{ module: "inventory", submodule: "master", actions: ["view"] }],
};

const open = async (user) => {
  useUserStore.setState({ user, loading: false });
  const view = render(
    <MemoryRouter initialEntries={["/inventory/master"]}>
      <Routes>
        <Route path="/inventory/master" element={<InventoryMaster />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Inventory Master" });
  // Drive the panel through the store rather than clicking a row: the list is
  // stubbed empty, and what is under test is the panel, not the table.
  useInventoryStore.setState({ selected: ITEM, detailLoading: false });
  return view;
};

const msilField = () => screen.getByLabelText("MSIL Code");

beforeEach(() => {
  resetSessionStores();
  vi.clearAllMocks();
});

describe("editing the MSIL code", () => {
  test("the field is offered, and carries the SKU's current code", async () => {
    await open(MANAGER);
    await waitFor(() => expect(msilField()).toBeTruthy());
    expect(msilField().value).toBe("MA0LW004000");
    expect(msilField().disabled).toBe(false);
  });

  test("a changed code reaches the save payload", async () => {
    const user = userEvent.setup();
    await open(MANAGER);
    await waitFor(() => expect(msilField()).toBeTruthy());

    await user.clear(msilField());
    await user.type(msilField(), "MA0NEW12345");
    await user.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(inventoryApi.updatePlanning).toHaveBeenCalled());
    const [sku, updates] = inventoryApi.updatePlanning.mock.calls[0];
    expect(sku).toBe("14145M.150-14");
    expect(updates.msilCode).toBe("MA0NEW12345");
  });

  test("clearing the field sends null, not an empty string", async () => {
    // The server stores '' as-is if handed one; null is what "no code" means
    // everywhere else, and the two must not both exist in the column.
    const user = userEvent.setup();
    await open(MANAGER);
    await waitFor(() => expect(msilField()).toBeTruthy());

    await user.clear(msilField());
    await user.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(inventoryApi.updatePlanning).toHaveBeenCalled());
    expect(inventoryApi.updatePlanning.mock.calls[0][1].msilCode).toBeNull();
  });

  test("surrounding whitespace is trimmed off", async () => {
    const user = userEvent.setup();
    await open(MANAGER);
    await waitFor(() => expect(msilField()).toBeTruthy());

    await user.clear(msilField());
    await user.type(msilField(), "  MA0LW004000  ");
    await user.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(inventoryApi.updatePlanning).toHaveBeenCalled());
    expect(inventoryApi.updatePlanning.mock.calls[0][1].msilCode).toBe("MA0LW004000");
  });

  test("a viewer without the planning permission cannot edit it", async () => {
    await open(VIEWER);
    await waitFor(() => expect(msilField()).toBeTruthy());
    expect(msilField().disabled).toBe(true);
  });
});
