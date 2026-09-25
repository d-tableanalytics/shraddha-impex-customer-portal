import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * Roles & Permissions, and the access rules around it.
 *
 * Only the admin API is mocked: the matrix rules (utils/roleMatrix.js), the
 * grant helpers and the permission helpers are real, so a pass here means they
 * agree with the server's registry payload shape.
 */

vi.mock("../../../services/admin", () => ({
  adminApi: {
    getRoles: vi.fn(),
    getUsers: vi.fn(),
    getModuleRegistry: vi.fn(),
    updateRole: vi.fn(),
    createRole: vi.fn(),
    deleteRole: vi.fn(),
  },
}));
vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { adminApi } from "../../../services/admin";
import { useAdminStore } from "../../../store/adminStore";
import { useUserStore } from "../../../store/userStore";
import { RolesPermissions } from "./RolesPermissions";
import { ModuleRoute } from "../../../components/layout/ModuleRoute";
import { buildNavigation } from "../../../utils/navigation";
import { initialDraft, draftToGrants, cellState, toggle } from "../../../utils/roleMatrix";

const RULES = {
  narrowed: { "administration.customers": { actions: ["view", "create", "edit"], key: "manage_customer_users" } },
  derived: { "customer_portal.create_booking": ["view"], "administration.overview": ["view"] },
};
const REGISTRY = {
  actions: ["view", "create", "edit", "delete", "approve"],
  rules: RULES,
  modules: [
    { key: "customer_portal", label: "Customer Portal", submodules: [
      { key: "create_booking", label: "New Booking", path: "/orders/new", actions: ["view", "create"] },
    ] },
    { key: "sales", label: "Sales Desk", submodules: [
      { key: "bookings", label: "Booking Desk", path: "/sales", actions: ["view", "create", "edit", "delete", "approve"] },
      { key: "pricing", label: "Customer Pricing", path: null, actions: ["view"] },
    ] },
    { key: "administration", label: "Administration", submodules: [
      { key: "customers", label: "Customer Management", path: "/admin/customers", actions: ["view", "create", "edit", "delete"] },
    ] },
  ],
};
const SALES = {
  _id: "r-sales", name: "Sales", isSystem: true, userCount: 2, updatedAt: "1",
  permissions: ["manage_customer_users"],
  grants: [
    { module: "sales", submodule: "bookings", actions: ["view", "edit", "approve"] },
    { module: "sales", submodule: "pricing", actions: ["view"] },
    { module: "o2d", submodule: "orders", actions: ["view"] }, // not this portal's: never shown, never sent
  ],
};
const SUPER = { _id: "r-super", name: "Super Admin", isSuperAdmin: true, isSystem: true, grants: [], permissions: [], userCount: 1 };
const CUSTOMER = { _id: "r-cust", name: "Customer", portalOnly: true, isSystem: true, grants: [], permissions: [], userCount: 9 };

const signIn = (over = {}) => useUserStore.setState({
  user: { _id: "u1", role: "Super Admin", permissions: ["*"], grants: [], ...over }, loading: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  useAdminStore.setState({ roles: [], users: [], registry: null, loading: true, error: null });
  adminApi.getRoles.mockResolvedValue([SUPER, SALES, CUSTOMER]);
  adminApi.getModuleRegistry.mockResolvedValue(REGISTRY);
  adminApi.getUsers.mockResolvedValue([]);
  signIn();
});

/** A role in the list: its row button ends "N user(s)" and carries the name. */
const roleButton = async (name) => {
  await screen.findByText("Roles");
  return screen.getAllByRole("button").find((b) => /users?$/.test(b.textContent) && b.textContent.includes(name));
};
const open = async (name) => {
  fireEvent.click(await roleButton(name));
  return screen.getByRole("region", { name: `${name} permissions` });
};
/** Expand a module row, if it is not already open. */
const expand = (region, label) => {
  const btn = within(region).getAllByRole("button")
    .find((b) => b.getAttribute("aria-expanded") !== null && b.textContent.startsWith(label));
  if (btn.getAttribute("aria-expanded") === "false") fireEvent.click(btn);
};
const box = (region, action, mod, sub) =>
  within(region).getByRole("checkbox", { name: `${action} — ${mod} / ${sub}` });
const openSales = async () => {
  render(<RolesPermissions />);
  const sales = await open("Sales");
  expand(sales, "Customer Portal");
  expand(sales, "Administration");
  return sales;
};

describe("the Roles & Permissions screen", () => {
  test("is refused without manage_roles", () => {
    signIn({ role: "Sales", permissions: ["view_all_bookings"] });
    render(<RolesPermissions />);
    expect(screen.getByText(/do not have permission to manage roles/)).toBeTruthy();
    expect(adminApi.getRoles).not.toHaveBeenCalled();
  });

  test("has the Employee Portal's layout: role list, header badge, tabs, copy-from", async () => {
    render(<RolesPermissions />);
    const sales = await open("Sales");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(within(sales).getByText("Built-in")).toBeTruthy();
    expect(within(sales).getByRole("tab", { name: "Permissions" })).toBeTruthy();
    expect(within(sales).getByRole("tab", { name: "Users (2)" })).toBeTruthy();
    expect(within(sales).getByRole("combobox", { name: "Copy permissions from another role" })).toBeTruthy();
    expect(within(sales).getByRole("button", { name: "Save Changes" })).toBeTruthy();
  });

  test("opens the modules the role was set up for, and shows only this portal's", async () => {
    render(<RolesPermissions />);
    const sales = await open("Sales");
    expect(within(sales).queryByText(/FMS|O2D|Work Queue/)).toBeNull();
    // Sales has explicit Sales Desk grants, so that module is open...
    expect(box(sales, "Approve", "Sales Desk", "Booking Desk").checked).toBe(true);
    expect(box(sales, "Create", "Sales Desk", "Booking Desk").checked).toBe(false);
    // ...and Customer Portal, where it has none stored, starts closed.
    expect(within(sales).queryByRole("checkbox", { name: "Create — Customer Portal / New Booking" })).toBeNull();
  });

  test("Customer Management shows ticked from the flat key, and its boxes move together", async () => {
    const sales = await openSales();
    expect(box(sales, "View", "Administration", "Customer Management").checked).toBe(true);
    fireEvent.click(box(sales, "Edit", "Administration", "Customer Management"));
    expect(box(sales, "View", "Administration", "Customer Management").checked).toBe(false);
    expect(box(sales, "Create", "Administration", "Customer Management").checked).toBe(false);
  });

  test("a derived box is shown but cannot be changed", async () => {
    const sales = await openSales();
    const view = box(sales, "View", "Customer Portal", "New Booking");
    expect(view.disabled).toBe(true);
    fireEvent.click(box(sales, "Create", "Customer Portal", "New Booking"));
    expect(view.checked).toBe(true); // follows Create
  });

  test("the module row ticks every changeable box in it, and skips locked ones", async () => {
    const sales = await openSales();
    fireEvent.click(within(sales).getByRole("checkbox", { name: "Create across all of Sales Desk" }));
    expect(box(sales, "Create", "Sales Desk", "Booking Desk").checked).toBe(true);
    // Customer Portal's only View box is derived, so its bulk control is off.
    expect(within(sales).getByRole("checkbox", { name: "View across all of Customer Portal" }).disabled).toBe(true);
  });

  test("Save sends this portal's cells only, with no derived action", async () => {
    adminApi.updateRole.mockImplementation(async (id, body) => ({ ...SALES, ...body, updatedAt: "2" }));
    const sales = await openSales();
    fireEvent.click(box(sales, "Create", "Customer Portal", "New Booking"));
    fireEvent.click(within(sales).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(adminApi.updateRole).toHaveBeenCalled());
    const [id, { grants }] = adminApi.updateRole.mock.calls[0];
    expect(id).toBe("r-sales");
    expect(grants.map((g) => `${g.module}.${g.submodule}`)).not.toContain("o2d.orders");
    expect(grants.find((g) => g.submodule === "create_booking").actions).toEqual(["create"]);
    expect(grants.find((g) => g.submodule === "customers").actions).toEqual(["view", "create", "edit"]);
  });

  test("Cancel restores the stored ticks, and Save is off until something changes", async () => {
    render(<RolesPermissions />);
    const sales = await open("Sales");
    const save = within(sales).getByRole("button", { name: "Save Changes" });
    expect(save.disabled).toBe(true);
    const create = box(sales, "Create", "Sales Desk", "Booking Desk");
    fireEvent.click(create);
    expect(within(sales).getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(within(sales).getByRole("button", { name: "Cancel" }));
    expect(create.checked).toBe(false);
  });

  test("Copy from role loads the source into the draft, unsaved", async () => {
    render(<RolesPermissions />);
    const sales = await open("Sales");
    fireEvent.change(within(sales).getByRole("combobox", { name: "Copy permissions from another role" }), {
      target: { value: "r-super" },
    });
    expect(box(sales, "Delete", "Sales Desk", "Booking Desk").checked).toBe(true);
    expect(within(sales).getByText("Unsaved changes")).toBeTruthy();
    expect(adminApi.updateRole).not.toHaveBeenCalled();
  });

  test("a full-access role is all ticked and locked; a portal-only role cannot be given staff modules", async () => {
    render(<RolesPermissions />);
    const sup = await open("Super Admin");
    expand(sup, "Sales Desk");
    expect(within(sup).getByText("Full access")).toBeTruthy();
    expect(box(sup, "Delete", "Sales Desk", "Booking Desk").checked).toBe(true);
    expect(box(sup, "Delete", "Sales Desk", "Booking Desk").disabled).toBe(true);

    const cust = await open("Customer");
    expand(cust, "Sales Desk");
    expand(cust, "Customer Portal");
    expect(box(cust, "View", "Sales Desk", "Booking Desk").disabled).toBe(true);
    expect(box(cust, "Create", "Customer Portal", "New Booking").disabled).toBe(false);
  });

  test("the Users tab lists who holds the role", async () => {
    adminApi.getUsers.mockResolvedValue([
      { _id: "a", user: "Asha Rao", email: "asha@example.com", role: "Sales", status: "Active" },
      { _id: "b", user: "A Shop", email: "shop@example.com", role: "Customer" },
    ]);
    render(<RolesPermissions />);
    const sales = await open("Sales");
    fireEvent.click(within(sales).getByRole("tab", { name: "Users (2)" }));
    expect(await within(sales).findByText("Asha Rao")).toBeTruthy();
    expect(within(sales).queryByText("A Shop")).toBeNull();
  });

  test("Edit Role cannot rename a built-in role", async () => {
    render(<RolesPermissions />);
    await open("Sales");
    fireEvent.click(screen.getByRole("button", { name: /Edit Role/ }));
    expect(screen.getByLabelText("Role name").disabled).toBe(true);
  });
});

describe("the matrix rules", () => {
  test("draftToGrants never carries a derived action", () => {
    const draft = initialDraft({ grants: [{ module: "customer_portal", submodule: "create_booking", actions: ["view", "create"] }] }, RULES);
    expect(draftToGrants(draft, RULES)).toEqual([{ module: "customer_portal", submodule: "create_booking", actions: ["create"] }]);
  });

  test("the narrowed note names the key it is saved as", () => {
    const state = cellState({ role: SALES, draft: initialDraft(SALES, RULES), rules: RULES, moduleKey: "administration", subKey: "customers", action: "view" });
    expect(state.reason).toMatch(/manage_customer_users/);
    expect(state.locked).toBe(false);
  });

  test("toggling a plain cell moves only that action", () => {
    const next = toggle(new Map(), RULES, "sales", "bookings", "edit");
    expect([...next.get("sales.bookings")]).toEqual(["edit"]);
  });
});

describe("screens are opened by their matrix cell", () => {
  const at = (user) => {
    useUserStore.setState({ user, loading: false });
    render(
      <MemoryRouter initialEntries={["/sales"]}>
        <Routes>
          <Route path="/sales" element={<ModuleRoute module="sales" submodule="bookings"><p>Booking desk</p></ModuleRoute>} />
        </Routes>
      </MemoryRouter>,
    );
  };

  test("opens for a role whose grants include the View cell", () => {
    at({ role: "Sales", permissions: [], grants: [{ module: "sales", submodule: "bookings", actions: ["view"] }] });
    expect(screen.getByText("Booking desk")).toBeTruthy();
  });

  test("is refused, with a panel rather than a redirect, without it", () => {
    at({ role: "Customer", permissions: [], grants: [{ module: "customer_portal", submodule: "dashboard", actions: ["view"] }] });
    expect(screen.queryByText("Booking desk")).toBeNull();
    expect(screen.getByText(/don.t have access to this screen/)).toBeTruthy();
  });

  test("steps aside when the server sent no grants at all", () => {
    at({ role: "Sales", permissions: ["view_all_bookings"] });
    expect(screen.getByText("Booking desk")).toBeTruthy();
  });
});

describe("the menu entry", () => {
  const MENU = [{ key: "sales", label: "Sales Desk", icon: "FileCheck2", items: [{ key: "bookings", label: "Booking Desk", path: "/sales" }] }];

  test("is added under Administration for someone who may manage roles", () => {
    const groups = buildNavigation({ role: "Super Admin", permissions: ["*"], menu: MENU });
    const admin = groups.find((g) => g.key === "administration");
    expect(admin.items.map((i) => i.path)).toContain("/admin/permissions");
  });

  test("is absent for everyone else", () => {
    const groups = buildNavigation({ role: "Sales", permissions: ["view_all_bookings"], menu: MENU });
    expect(groups.flatMap((g) => g.items).some((i) => i.path === "/admin/permissions")).toBe(false);
  });
});
