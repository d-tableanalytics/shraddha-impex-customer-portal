import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * The UI follows the Admin's Roles & Permissions matrix.
 *
 *  - one Unauthorized panel for every refusal (not a silent trip home),
 *  - ModuleRoute fails CLOSED once the session is loaded, falling back to the
 *    cell's permission keys when the server sent no grants,
 *  - screens and buttons follow cells, not role names.
 */

vi.mock("../../services/inventory", () => ({ inventoryApi: { runExport: vi.fn() } }));

import { Unauthorized } from "./Unauthorized";
import { NotFound } from "./NotFound";
import { ModuleRoute } from "../layout/ModuleRoute";
import { PredicateRoute } from "../layout/PredicateRoute";
import { OrderingRoute } from "../layout/OrderingRoute";
import { ExportButton } from "../inventory/ExportButton";
import { useUserStore } from "../../store/userStore";
import {
  canManageRoles, canUseInventoryMaster, canViewBoxNo, canViewLineItemBoxNo, canManageAccount,
} from "../../utils/permissions";
import { canCell } from "../../utils/cellKeys";

const PANEL = /don.t have access to this screen/;
const cell = (module, submodule, actions = ["view"]) => ({ module, submodule, actions });

const at = (user, element, { path = "/x", loading = false } = {}) => {
  useUserStore.setState({ user, loading });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<p>Home page</p>} />
        <Route path={path} element={element} />
      </Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => useUserStore.setState({ user: null, loading: false }));

describe("Unauthorized", () => {
  test("explains the refusal and links to the user's own home", () => {
    at({ role: "Import Team", permissions: ["view_inventory"] }, <Unauthorized />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(PANEL)).toBeTruthy();
    expect(screen.getByText(/ask an administrator/)).toBeTruthy();
    // Import Team's home is the inventory dashboard (homePathFor), not "/".
    expect(screen.getByRole("link", { name: /home screen/ }).getAttribute("href")).toBe("/inventory/dashboard");
  });

  test("Not Found is a different answer from Unauthorized", () => {
    at({ role: "Customer", permissions: [] }, <NotFound />);
    expect(screen.getByText("Page not found")).toBeTruthy();
    expect(screen.queryByText(PANEL)).toBeNull();
  });
});

describe("ModuleRoute", () => {
  const sales = (user) => at(user, <ModuleRoute module="sales" submodule="bookings"><p>Booking desk</p></ModuleRoute>);

  test("stays permissive while the session is still loading", () => {
    useUserStore.setState({ user: null, loading: true });
    render(
      <MemoryRouter><ModuleRoute module="sales" submodule="bookings"><p>Booking desk</p></ModuleRoute></MemoryRouter>,
    );
    expect(screen.getByText("Booking desk")).toBeTruthy();
  });

  test("grants decide when the server sent them", () => {
    sales({ role: "HR", permissions: [], grants: [cell("sales", "bookings")] });
    expect(screen.getByText("Booking desk")).toBeTruthy();
  });

  test("a loaded user without the cell gets the Unauthorized panel, not a redirect", () => {
    sales({ role: "Sales", permissions: ["view_all_bookings"], grants: [cell("inventory", "master")] });
    expect(screen.queryByText("Booking desk")).toBeNull();
    expect(screen.queryByText("Home page")).toBeNull();
    expect(screen.getByText(PANEL)).toBeTruthy();
  });

  test("without grants it falls back to the cell's keys: allowed", () => {
    sales({ role: "Sales", permissions: ["view_all_bookings"] });
    expect(screen.getByText("Booking desk")).toBeTruthy();
  });

  test("without grants it falls back to the cell's keys: refused (no longer fails open)", () => {
    sales({ role: "Customer", permissions: ["view_dashboard", "create_order"] });
    expect(screen.queryByText("Booking desk")).toBeNull();
    expect(screen.getByText(PANEL)).toBeTruthy();
  });

  test("a cell this bundle does not know, without grants, is left to the API", () => {
    at({ role: "Sales", permissions: [] }, <ModuleRoute module="future" submodule="screen"><p>New screen</p></ModuleRoute>);
    expect(screen.getByText("New screen")).toBeTruthy();
  });

  test("a loaded session with no user is refused", () => {
    sales(null);
    expect(screen.getByText(PANEL)).toBeTruthy();
  });
});

describe("other guards render the same panel", () => {
  test("PredicateRoute (/admin/permissions) refuses without manage_roles", () => {
    at({ role: "Sales", permissions: ["manage_customer_users"], grants: [] },
      <PredicateRoute allow={canManageRoles}><p>Roles screen</p></PredicateRoute>);
    expect(screen.queryByText("Roles screen")).toBeNull();
    expect(screen.getByText(PANEL)).toBeTruthy();
  });

  test("PredicateRoute opens with manage_roles", () => {
    at({ role: "HR", permissions: ["manage_roles"], grants: [] },
      <PredicateRoute allow={canManageRoles}><p>Roles screen</p></PredicateRoute>);
    expect(screen.getByText("Roles screen")).toBeTruthy();
  });

  test("OrderingRoute shows the panel instead of silently sending the user home", () => {
    useUserStore.setState({ user: { role: "Import Team", permissions: ["view_inventory"] }, loading: false });
    render(
      <MemoryRouter initialEntries={["/orders/history"]}>
        <Routes>
          <Route path="/" element={<p>Home page</p>} />
          <Route element={<OrderingRoute />}>
            <Route path="/orders/history" element={<p>Booking history</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText("Booking history")).toBeNull();
    expect(screen.queryByText("Home page")).toBeNull();
    expect(screen.getByText(PANEL)).toBeTruthy();
  });
});

describe("cells, not role names", () => {
  test("Inventory Master follows the matrix for a BUILT-IN role", () => {
    // Was isAdmin || INVENTORY_ROLES: the matrix was only read for custom roles.
    expect(canUseInventoryMaster({ role: "HR", permissions: [], grants: [cell("inventory", "master")] })).toBe(true);
    expect(canUseInventoryMaster({ role: "Inventory Manager", permissions: ["view_inventory"], grants: [] })).toBe(false);
    // No grants: the cell's key decides.
    expect(canUseInventoryMaster({ role: "Billing", permissions: ["view_inventory"] })).toBe(true);
    expect(canUseInventoryMaster({ role: "Customer", permissions: ["view_catalogue"] })).toBe(false);
  });

  test("box numbers follow inventory.master / the sales desk cell", () => {
    const hr = { role: "HR", permissions: ["view_all_bookings"], grants: [cell("inventory", "master")] };
    expect(canViewBoxNo(hr)).toBe(true);
    expect(canViewLineItemBoxNo(hr)).toBe(true);
    const sales = { role: "Sales", permissions: ["view_dashboard"], grants: [] };
    expect(canViewBoxNo(sales)).toBe(false);
    expect(canViewLineItemBoxNo(sales)).toBe(false);
  });

  test("canCell: grants first, then the cell's keys (ANY of them)", () => {
    expect(canCell({ role: "X", permissions: ["post_stock_in"] }, "inventory", "imports", "create")).toBe(true);
    expect(canCell({ role: "X", permissions: ["post_stock_in"], grants: [] }, "inventory", "imports", "create")).toBe(false);
    expect(canCell({ role: "Super Admin", permissions: ["*"] }, "anything", "at_all", "view")).toBe(true);
  });
});

describe("gated actions", () => {
  test("Export is offered only with the export cell", () => {
    useUserStore.setState({ user: { role: "Sales", permissions: ["view_inventory"], grants: [cell("inventory", "health")] } });
    const { unmount } = render(<ExportButton exportType="stock-health" />);
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
    unmount();

    useUserStore.setState({ user: { role: "Sales", permissions: [], grants: [cell("inventory", "exports")] } });
    render(<ExportButton exportType="stock-health" />);
    expect(screen.getByRole("button", { name: /Export/ })).toBeTruthy();
  });

  test("Suspend (which deletes the account) needs the DELETE cell, not edit", () => {
    const customer = { role: "Customer" };
    const desk = {
      role: "Sales", permissions: ["manage_customer_users"],
      grants: [cell("administration", "customers", ["view", "create", "edit"])],
    };
    expect(canManageAccount(desk, customer, "edit")).toBe(true);
    expect(canManageAccount(desk, customer, "delete")).toBe(false);
    // Without grants: customers.delete is manage_users, which the desk lacks.
    expect(canManageAccount({ role: "Sales", permissions: ["manage_customer_users"] }, customer, "delete")).toBe(false);
    expect(canManageAccount({ role: "Admin", permissions: ["*"] }, customer, "delete")).toBe(true);
  });
});
