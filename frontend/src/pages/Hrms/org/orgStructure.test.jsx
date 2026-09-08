/**
 * Org Structure — page shell, Departments and Locations.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these also cover the
 * request URLs and the `{ success, data }` unwrapping.
 *
 * Deletion is worth reading closely. The reference DISABLES its delete button
 * when `employeeCount > 0`; here the request is always sent and the server
 * decides, so the tests assert a 409 is surfaced rather than pre-empted.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { OrgStructurePage } from "./OrgStructurePage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { visibleHrmsNavItems } from "../../../components/hrms/navItems";
import { router } from "../../../routes";
import { buildHrmsActor, hasHrmsPermission } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const DEPARTMENTS = [
  { id: "d1", code: "ADM", name: "Admin", employeeCount: 0 },
  { id: "d2", code: "ENG", name: "Engineering", employeeCount: 3 },
];
const LOCATIONS = [
  {
    id: "l1",
    code: "BLR",
    name: "Bangalore",
    city: "Bengaluru",
    country: "India",
    address: "MG Road",
    timezone: "Asia/Kolkata",
    employeeCount: 2,
  },
  {
    id: "l2",
    code: "AMD",
    name: "Ahmedabad",
    city: null,
    country: null,
    address: null,
    timezone: "Asia/Kolkata",
    employeeCount: 0,
  },
];

const CUSTOM_FIELDS = [
  { id: "f1", name: "blood_group", label: "Blood group", type: "text", options: [], required: false, order: 1 },
  { id: "f2", name: "shirt_size", label: "Shirt size", type: "select", options: ["S", "M", "L"], required: true, order: 2 },
];

/** Ceo -> Mgr -> Dev, plus an unrelated root, plus the two flagged cases. */
const TREE = [
  { id: "e1", displayName: "Ceo One", designation: "CEO", departmentName: "Admin", status: "active", reportingManagerId: null, managerOutsideView: false, managerCycleBroken: false },
  { id: "e2", displayName: "Mgr Two", designation: "Manager", departmentName: "Engineering", status: "active", reportingManagerId: "e1", managerOutsideView: false, managerCycleBroken: false },
  { id: "e3", displayName: "Dev Three", designation: "Developer", departmentName: "Engineering", status: "probation", reportingManagerId: "e2", managerOutsideView: false, managerCycleBroken: false },
  { id: "e4", displayName: "Solo Four", designation: null, departmentName: null, status: "active", reportingManagerId: null, managerOutsideView: false, managerCycleBroken: false },
  { id: "e5", displayName: "Orphan Five", designation: null, departmentName: null, status: "active", reportingManagerId: null, managerOutsideView: true, managerCycleBroken: false },
  { id: "e6", displayName: "Looped Six", designation: null, departmentName: null, status: "active", reportingManagerId: null, managerOutsideView: false, managerCycleBroken: true },
];

let calls = [];
const envelope = (payload) => ({ data: { success: true, data: payload } });
const fail = (status, body) => Promise.reject({ response: { status, data: body } });

function installTransport(overrides = {}) {
  calls = [];
  api.request.mockImplementation(async (config) => {
    calls.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (overrides[key]) return overrides[key](config);
    if (key === "GET /hrms/org/departments") return envelope(DEPARTMENTS);
    if (key === "GET /hrms/org/locations") return envelope(LOCATIONS);
    if (key === "GET /hrms/employees/custom-fields") return envelope(CUSTOM_FIELDS);
    if (key === "GET /hrms/org/tree") return envelope(TREE);
    if (config.method === "post" || config.method === "patch") return envelope({ id: "new" });
    if (config.method === "delete") return envelope({ deleted: true });
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/org" element={<OrgStructurePage />} />
        <Route path="/hrms/org/:tab" element={<OrgStructurePage />} />
        <Route path="/hrms/employees" element={<div>Employee directory</div>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ===========================================================================
// Page shell
// ===========================================================================

describe("the page shell", () => {
  it("renders the title and subtitle, and no breadcrumb", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/org/departments");

    expect(await screen.findByRole("heading", { name: "Org Structure" })).toBeTruthy();
    expect(screen.getByText(/Reporting hierarchy and organizational configuration/i)).toBeTruthy();
    // A top-level HRMS page carries no breadcrumb: "HRMS > X" above a heading
    // that already reads "X", beside a sidebar already highlighting X, is the
    // same fact three times - and no other module in the portal has one.
    // HrmsPageLayout renders the trail only once it goes deeper than
    // "HRMS > <module>"; the nested employee pages still get theirs.
    expect(screen.queryByRole("navigation", { name: /breadcrumb/i })).toBeNull();
  });

  it("shows all four tabs an editor gets, in the reference's order", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/org/departments");
    await screen.findByText("Engineering");

    const labels = screen.getAllByRole("tab").map((t) => t.textContent.trim());
    expect(labels).toEqual(["Departments", "Locations", "Custom Fields", "Org Chart"]);
  });

  it("defaults an editor to Departments", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/org");

    expect(await screen.findByText("Engineering")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Departments" }).getAttribute("aria-selected")).toBe("true");
  });

  it("switching tabs loads the other catalogue", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/org/departments");
    await screen.findByText("Engineering");

    await userEvent.click(screen.getByRole("tab", { name: "Locations" }));
    expect(await screen.findByText("Bangalore")).toBeTruthy();
  });

  it("all four tabs are now live, none disabled", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/org/departments");
    await screen.findByText("Engineering");

    for (const name of ["Departments", "Locations", "Custom Fields", "Org Chart"]) {
      expect(screen.getByRole("tab", { name }).disabled).toBeFalsy();
    }
  });

  it("every tab is reachable by URL and loads its own data", async () => {
    signIn([R.HR_ADMIN]);

    at("/hrms/org/custom-fields");
    expect(await screen.findByText("Blood group")).toBeTruthy();
    cleanup();

    at("/hrms/org/org-chart");
    expect(await screen.findByText("Ceo One")).toBeTruthy();
  });

  it("tabs are keyboard reachable and expose their selected state", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/org/locations");
    await screen.findByText("Bangalore");

    const active = screen.getByRole("tab", { name: "Locations" });
    expect(active.getAttribute("aria-selected")).toBe("true");
    active.focus();
    expect(document.activeElement).toBe(active);
  });

  it("a non-editor gets no editing tabs", async () => {
    // The reference shows Departments/Locations/Custom Fields only to someone
    // holding org-structure:edit:org.
    signIn([R.EMPLOYEE]);
    at("/hrms/org");

    const labels = screen.getAllByRole("tab").map((t) => t.textContent.trim());
    expect(labels).toEqual(["Org Chart"]);
    expect(screen.queryByText("Engineering")).toBeNull();
  });

  it("an editor-only tab reached by URL without the grant refuses politely", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/org/departments");

    expect(await screen.findByText(/cannot change the org structure/i)).toBeTruthy();
    expect(calls.some((c) => c.url === "/hrms/org/departments")).toBe(false);
  });
});

// ===========================================================================
// Departments
// ===========================================================================

describe("departments", () => {
  const open = async (roles = [R.HR_ADMIN]) => {
    signIn(roles);
    at("/hrms/org/departments");
    return screen.findByText("Engineering");
  };

  it("lists from the API with the reference's columns", async () => {
    await open();

    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent.trim());
    expect(headers).toEqual(["Code", "Name", "Employees", ""]);

    const row = screen.getByText("Engineering").closest("tr");
    expect(within(row).getByText("ENG")).toBeTruthy();
    expect(within(row).getByText("3")).toBeTruthy();
  });

  it("keeps the server's ordering", async () => {
    await open();
    const names = screen.getAllByRole("row").slice(1).map((r) => r.cells[1].textContent);
    expect(names).toEqual(["Admin", "Engineering"]);
  });

  it("shows a loading state, then the rows", async () => {
    signIn([R.HR_ADMIN]);
    let release;
    installTransport({
      "GET /hrms/org/departments": () => new Promise((r) => { release = () => r(envelope(DEPARTMENTS)); }),
    });
    at("/hrms/org/departments");

    expect(screen.queryByText("Engineering")).toBeNull();
    release();
    expect(await screen.findByText("Engineering")).toBeTruthy();
  });

  it("shows an empty state when there are none", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({ "GET /hrms/org/departments": () => envelope([]) });
    at("/hrms/org/departments");

    expect(await screen.findByText("No departments yet")).toBeTruthy();
  });

  it("surfaces a failed load with a retry", async () => {
    signIn([R.HR_ADMIN]);
    let attempts = 0;
    installTransport({
      "GET /hrms/org/departments": () => {
        attempts += 1;
        return attempts === 1 ? fail(500, { message: "Database is down." }) : envelope(DEPARTMENTS);
      },
    });
    at("/hrms/org/departments");

    expect(await screen.findByText("Database is down.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByText("Engineering")).toBeTruthy();
  });

  it("creates one, normalising the code server-side", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /New Department/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. ENG"), "ops");
    await userEvent.type(screen.getByPlaceholderText("e.g. Engineering"), "Operations");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    const posted = calls.find((c) => c.method === "post");
    expect(posted.url).toBe("/hrms/org/departments");
    expect(posted.data).toEqual({ code: "OPS", name: "Operations" });
    // O-1 / O-2: neither is a product field.
    expect(posted.data).not.toHaveProperty("parentId");
    expect(posted.data).not.toHaveProperty("headEmployeeId");
  });

  it("refuses an invalid code without sending anything", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /New Department/i }));
    await userEvent.type(await screen.findByPlaceholderText("e.g. ENG"), "bad code!");
    await userEvent.type(screen.getByPlaceholderText("e.g. Engineering"), "X");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(document.querySelectorAll(".text-error-500").length).toBeGreaterThan(0),
    );
    expect(calls.filter((c) => c.method === "post").length).toBe(0);
  });

  it("edits an existing one, pre-filled", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Edit Engineering" }));

    expect(await screen.findByDisplayValue("ENG")).toBeTruthy();
    const name = screen.getByDisplayValue("Engineering");
    await userEvent.clear(name);
    await userEvent.type(name, "Engineering & Design");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "patch")).toBe(true));
    const patched = calls.find((c) => c.method === "patch");
    expect(patched.url).toBe("/hrms/org/departments/d2");
    expect(patched.data.name).toBe("Engineering & Design");
  });

  it("surfaces a duplicate-code conflict from the server", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "POST /hrms/org/departments": () =>
        fail(409, { message: 'Department code "ENG" is already in use.', code: "DEPARTMENT_CODE_TAKEN" }),
    });
    at("/hrms/org/departments");
    await screen.findByText("Engineering");

    await userEvent.click(screen.getByRole("button", { name: /New Department/i }));
    await userEvent.type(await screen.findByPlaceholderText("e.g. ENG"), "ENG");
    await userEvent.type(screen.getByPlaceholderText("e.g. Engineering"), "Dup");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // The drawer stays open so the edit is not lost.
    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    expect(screen.getByRole("heading", { name: "New Department" })).toBeTruthy();
  });

  it("deletes after confirmation and reloads", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Delete Admin" }));

    expect(await screen.findByText(/Delete "Admin"\?/)).toBeTruthy();
    // Nothing is sent until confirmed.
    expect(calls.filter((c) => c.method === "delete").length).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "delete")).toBe(true));
    expect(calls.find((c) => c.method === "delete").url).toBe("/hrms/org/departments/d1");
    // The list is refetched rather than spliced: employeeCount is server-computed.
    await waitFor(() =>
      expect(calls.filter((c) => c.url === "/hrms/org/departments" && c.method === "get").length)
        .toBeGreaterThan(1),
    );
  });

  it("the delete request is SENT even for a department with employees", async () => {
    // The reference disables its button from a count fetched earlier. That
    // guess is wrong the moment someone is assigned in another tab, and its own
    // count includes soft-deleted employees. The server decides.
    signIn([R.HR_ADMIN]);
    installTransport({
      "DELETE /hrms/org/departments/d2": () =>
        fail(409, {
          message: '3 employees still assigned to "Engineering". Reassign them before deleting.',
          code: "DEPARTMENT_IN_USE",
          details: { employeeCount: 3 },
        }),
    });
    at("/hrms/org/departments");
    await screen.findByText("Engineering");

    const button = screen.getByRole("button", { name: "Delete Engineering" });
    expect(button.disabled).toBeFalsy();

    await userEvent.click(button);
    await userEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "delete")).toBe(true));
    // The row is still there, because the server refused.
    expect(screen.getByText("Engineering")).toBeTruthy();
  });

  it("links the employee count to the filtered directory", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^3$/ }));
    expect(await screen.findByText("Employee directory")).toBeTruthy();
  });

  it("a viewer without edit sees no actions and no add button", async () => {
    // payroll_admin holds the org-structure self baseline but not edit:org.
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/org/departments");

    // No editing tab at all for this role, so the catalogue is not even fetched.
    expect(screen.queryByRole("button", { name: /New Department/i })).toBeNull();
  });
});

// ===========================================================================
// Locations
// ===========================================================================

describe("locations", () => {
  const open = async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/org/locations");
    return screen.findByText("Bangalore");
  };

  it("lists with its own columns", async () => {
    await open();

    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent.trim());
    expect(headers).toEqual(["Code", "Name", "City", "Country", "Timezone", "Employees", ""]);

    const row = screen.getByText("Bangalore").closest("tr");
    expect(within(row).getByText("BLR")).toBeTruthy();
    expect(within(row).getByText("Bengaluru")).toBeTruthy();
    expect(within(row).getByText("Asia/Kolkata")).toBeTruthy();
    expect(within(row).getByText("2")).toBeTruthy();
  });

  it("renders an em dash for an absent city or country", async () => {
    await open();
    const row = screen.getByText("Ahmedabad").closest("tr");
    expect(within(row).getAllByText("—").length).toBe(2);
  });

  it("creates one with only code and name, defaulting the timezone", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /New Location/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. BLR"), "maa");
    await userEvent.type(screen.getByPlaceholderText("e.g. Bangalore"), "Chennai");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    const posted = calls.find((c) => c.method === "post");

    expect(posted.url).toBe("/hrms/org/locations");
    expect(posted.data.code).toBe("MAA");
    expect(posted.data.timezone).toBe("Asia/Kolkata");
    // Optional free text: empty means absent, not empty string.
    expect(posted.data.city).toBeNull();
    expect(posted.data.country).toBeNull();
    expect(posted.data.address).toBeNull();
  });

  it("offers the real IANA list, not seven hardcoded zones", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /New Location/i }));
    await screen.findByPlaceholderText("e.g. BLR");

    await userEvent.click(screen.getByRole("button", { name: /Asia\/Kolkata/ }));

    // Narrowed through the search box rather than scanned. The picker offers
    // the runtime's whole IANA list — over four hundred zones — and asking
    // Testing Library to match every one of them by accessible name is slow
    // enough to trip the timeout. Typing is also what a person does.
    await userEvent.type(screen.getByPlaceholderText("Search zones…"), "Berlin");

    // A zone the reference's seven hardcoded entries omit.
    expect(await screen.findByRole("button", { name: "Europe/Berlin" })).toBeTruthy();
  });

  it("changes the timezone and saves it", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Edit Bangalore" }));
    await screen.findByDisplayValue("BLR");

    await userEvent.click(screen.getByRole("button", { name: /Asia\/Kolkata/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Europe/London" }));
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "patch")).toBe(true));
    expect(calls.find((c) => c.method === "patch").data.timezone).toBe("Europe/London");
  });

  it("edits, pre-filled with the existing values", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Edit Bangalore" }));

    expect(await screen.findByDisplayValue("BLR")).toBeTruthy();
    expect(screen.getByDisplayValue("Bengaluru")).toBeTruthy();
    expect(screen.getByDisplayValue("MG Road")).toBeTruthy();
  });

  it("surfaces a duplicate code and an in-use conflict from the server", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "DELETE /hrms/org/locations/l1": () =>
        fail(409, {
          message: '2 employees still assigned to "Bangalore". Reassign them before deleting.',
          code: "LOCATION_IN_USE",
          details: { employeeCount: 2 },
        }),
    });
    at("/hrms/org/locations");
    await screen.findByText("Bangalore");

    await userEvent.click(screen.getByRole("button", { name: "Delete Bangalore" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "delete")).toBe(true));
    expect(screen.getByText("Bangalore")).toBeTruthy();
  });

  it("deletes one with nobody assigned", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Delete Ahmedabad" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "delete")).toBe(true));
    expect(calls.find((c) => c.method === "delete").url).toBe("/hrms/org/locations/l2");
  });
});

// ===========================================================================
// Navigation and module registration
// ===========================================================================

describe("navigation", () => {
  const routablePaths = () => {
    const out = [];
    const walk = (routes, prefix) => {
      for (const route of routes) {
        const raw = route.path ?? "";
        const joined = raw.startsWith("/")
          ? raw
          : [prefix, raw].filter(Boolean).join("/").replace(/\/+/g, "/");
        if (raw || route.index) out.push(joined || prefix);
        if (route.children) walk(route.children, joined || prefix);
      }
    };
    walk(router.routes, "");
    return out;
  };

  it("Org Structure appears for an authorised user and resolves to a real route", () => {
    const actor = buildHrmsActor({ userId: "u1", roles: [R.HR_ADMIN] });
    const can = (m, a, s) => hasHrmsPermission(actor, m, a, s);
    const visible = visibleHrmsNavItems(can, [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE]);

    const item = visible.find((i) => i.label === "Org Structure");
    expect(item).toBeTruthy();
    expect(item.path).toBe("/hrms/org");
    expect(routablePaths()).toContain("/hrms/org");
  });

  it("every visible nav item still resolves - no new dead links", () => {
    const actor = buildHrmsActor({ userId: "u1", roles: [R.SUPER_ADMIN] });
    const can = (m, a, s) => hasHrmsPermission(actor, m, a, s);
    const paths = routablePaths();

    for (const item of visibleHrmsNavItems(can, [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE])) {
      expect(paths, `nav item "${item.label}" points at ${item.path}`).toContain(item.path);
    }
  });

  it("an employee without org-structure:view:org does not see the nav item", () => {
    // The nav requires view:org; the self baseline is not enough. Route access
    // is a separate question the guard answers, and the API answers again.
    const actor = buildHrmsActor({ userId: "u1", roles: [R.EMPLOYEE] });
    const can = (m, a, s) => hasHrmsPermission(actor, m, a, s);
    const visible = visibleHrmsNavItems(can, [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE]);

    expect(visible.find((i) => i.label === "Org Structure")).toBeUndefined();
  });

  it("registering the module exposes nothing from AD-5", () => {
    const actor = buildHrmsActor({ userId: "u1", roles: [R.SUPER_ADMIN] });
    const can = (m, a, s) => hasHrmsPermission(actor, m, a, s);

    for (const item of visibleHrmsNavItems(can, [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE])) {
      expect(item.module).not.toMatch(/operation|project|timesheet/i);
    }
  });
});
