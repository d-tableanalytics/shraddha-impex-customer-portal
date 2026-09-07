/**
 * Custom Fields tab (step 5B).
 *
 * The definitions belong to Employee Master; only the screen is new. These
 * tests therefore also pin the boundary: the tab must call the EXISTING
 * `/hrms/employees/custom-fields` endpoints and nothing else, because a second
 * custom-field API is the one outcome this step must not produce.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { OrgStructurePage } from "./OrgStructurePage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const FIELDS = [
  { id: "f1", name: "blood_group", label: "Blood group", type: "text", options: [], required: false, order: 1 },
  { id: "f2", name: "shirt_size", label: "Shirt size", type: "select", options: ["S", "M", "L"], required: true, order: 2 },
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
    if (key === "GET /hrms/employees/custom-fields") return envelope(FIELDS);
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

const at = (path = "/hrms/org/custom-fields") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/org/:tab" element={<OrgStructurePage />} />
      </Routes>
    </MemoryRouter>,
  );

const open = async (roles = [R.HR_ADMIN]) => {
  signIn(roles);
  at();
  return screen.findByText("Blood group");
};

/** Open the drawer for a new field. */
const openCreate = async () => {
  await userEvent.click(screen.getByRole("button", { name: /New Field/i }));
  return screen.findByRole("heading", { name: "New Custom Field" });
};

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe("it reuses Employee Master's API", () => {
  it("reads from /hrms/employees/custom-fields, not a new endpoint", async () => {
    await open();

    const urls = calls.map((c) => c.url);
    expect(urls).toContain("/hrms/employees/custom-fields");
    // No parallel org-scoped custom-field endpoint may appear.
    expect(urls.some((u) => u.includes("/org/custom-fields"))).toBe(false);
  });

  it("unwraps the standard envelope", async () => {
    await open();
    // Two rows rendered from `data`, so nothing was spread beside it.
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe("the list", () => {
  it("shows the reference's columns in its order", async () => {
    await open();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent.trim());
    expect(headers).toEqual(["Order", "Label", "Name (key)", "Type", "Required", ""]);
  });

  it("renders the key, a readable type label and the required marker", async () => {
    await open();

    const row = screen.getByText("Shirt size").closest("tr");
    expect(within(row).getByText("shirt_size")).toBeTruthy();
    expect(within(row).getByText("Select (single)")).toBeTruthy();
    // Text, not just a colour - the required state must survive greyscale.
    expect(within(row).getByText("Required")).toBeTruthy();

    const optional = screen.getByText("Blood group").closest("tr");
    expect(within(optional).getByText("—")).toBeTruthy();
  });

  it("keeps the server's ordering", async () => {
    await open();
    const labels = screen.getAllByRole("row").slice(1).map((r) => r.cells[1].textContent);
    expect(labels).toEqual(["Blood group", "Shirt size"]);
  });

  it("shows a loading state before the rows arrive", async () => {
    signIn([R.HR_ADMIN]);
    let release;
    installTransport({
      "GET /hrms/employees/custom-fields": () =>
        new Promise((r) => { release = () => r(envelope(FIELDS)); }),
    });
    at();

    expect(screen.queryByText("Blood group")).toBeNull();
    release();
    expect(await screen.findByText("Blood group")).toBeTruthy();
  });

  it("shows an empty state when none are defined", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({ "GET /hrms/employees/custom-fields": () => envelope([]) });
    at();

    expect(await screen.findByText("No custom fields yet")).toBeTruthy();
  });

  it("surfaces an API error with a retry", async () => {
    signIn([R.HR_ADMIN]);
    let attempts = 0;
    installTransport({
      "GET /hrms/employees/custom-fields": () => {
        attempts += 1;
        return attempts === 1 ? fail(500, { message: "Server exploded." }) : envelope(FIELDS);
      },
    });
    at();

    expect(await screen.findByText("Server exploded.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByText("Blood group")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe("creating a field", () => {
  it("posts the definition, seeding the next order", async () => {
    await open();
    await openCreate();

    await userEvent.type(screen.getByPlaceholderText("e.g. Blood group"), "Shoe size");
    await userEvent.type(screen.getByPlaceholderText("e.g. blood_group"), "shoe_size");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    const posted = calls.find((c) => c.method === "post");

    expect(posted.url).toBe("/hrms/employees/custom-fields");
    expect(posted.data).toMatchObject({
      name: "shoe_size",
      label: "Shoe size",
      type: "text",
      required: false,
      order: 3, // list length + 1, as the reference seeds it
    });
  });

  it("refuses a key that is not snake_case, and sends nothing", async () => {
    await open();
    await openCreate();

    await userEvent.type(screen.getByPlaceholderText("e.g. Blood group"), "Bad");
    await userEvent.type(screen.getByPlaceholderText("e.g. blood_group"), "Shoe Size");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(document.querySelectorAll(".text-error-500").length).toBeGreaterThan(0),
    );
    expect(calls.filter((c) => c.method === "post").length).toBe(0);
  });

  it("shows the options editor only for a choice type", async () => {
    await open();
    await openCreate();

    expect(screen.queryByLabelText("Add an option")).toBeNull();

    await userEvent.selectOptions(screen.getByRole("combobox"), "select");
    expect(await screen.findByLabelText("Add an option")).toBeTruthy();

    await userEvent.selectOptions(screen.getByRole("combobox"), "boolean");
    await waitFor(() => expect(screen.queryByLabelText("Add an option")).toBeNull());
  });

  it("collects options with Enter and removes them individually", async () => {
    await open();
    await openCreate();

    await userEvent.type(screen.getByPlaceholderText("e.g. Blood group"), "Size");
    await userEvent.type(screen.getByPlaceholderText("e.g. blood_group"), "size");
    await userEvent.selectOptions(screen.getByRole("combobox"), "multiselect");

    const options = await screen.findByLabelText("Add an option");
    await userEvent.type(options, "Small{Enter}");
    await userEvent.type(options, "Large{Enter}");
    expect(screen.getByText("Small")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Remove option Small" }));
    await waitFor(() => expect(screen.queryByText("Small")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    expect(calls.find((c) => c.method === "post").data.options).toEqual(["Large"]);
  });

  it("keeps the drawer open and the typed values when the save fails", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "POST /hrms/employees/custom-fields": () =>
        fail(409, { message: "A field named shoe_size already exists.", code: "HRMS_CONFLICT" }),
    });
    at();
    await screen.findByText("Blood group");
    await openCreate();

    await userEvent.type(screen.getByPlaceholderText("e.g. Blood group"), "Shoe size");
    await userEvent.type(screen.getByPlaceholderText("e.g. blood_group"), "shoe_size");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    // Losing what the user typed because the server said no is its own bug.
    expect(screen.getByRole("heading", { name: "New Custom Field" })).toBeTruthy();
    expect(screen.getByDisplayValue("Shoe size")).toBeTruthy();
    expect(screen.getByDisplayValue("shoe_size")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

describe("editing a field", () => {
  it("pre-fills, and locks the key", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Edit Shirt size" }));

    expect(await screen.findByDisplayValue("Shirt size")).toBeTruthy();
    const key = screen.getByDisplayValue("shirt_size");
    expect(key.disabled).toBe(true);
    expect(screen.getByText(/Immutable/i)).toBeTruthy();
    // Its stored options come back for editing.
    expect(screen.getByText("M")).toBeTruthy();
  });

  it("PATCHes without `name`, which the strict update schema would reject", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Edit Blood group" }));

    const label = await screen.findByDisplayValue("Blood group");
    await userEvent.clear(label);
    await userEvent.type(label, "Blood type");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "patch")).toBe(true));
    const patched = calls.find((c) => c.method === "patch");

    expect(patched.url).toBe("/hrms/employees/custom-fields/f1");
    expect(patched.data.label).toBe("Blood type");
    expect(patched.data).not.toHaveProperty("name");
  });

  it("reloads the list after a successful save", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Edit Blood group" }));
    await screen.findByDisplayValue("Blood group");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(calls.filter((c) => c.url === "/hrms/employees/custom-fields" && c.method === "get").length)
        .toBeGreaterThan(1),
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("removing a field", () => {
  it("confirms, says values are kept, and only then calls the server", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Remove Blood group" }));

    expect(await screen.findByText(/Remove field "Blood group"\?/)).toBeTruthy();
    // The definition goes; recorded values stay on the employee record.
    expect(screen.getByText(/Values already recorded on employee records are kept/i)).toBeTruthy();
    expect(calls.filter((c) => c.method === "delete").length).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: /^Remove$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "delete")).toBe(true));
    expect(calls.find((c) => c.method === "delete").url).toBe("/hrms/employees/custom-fields/f1");
  });

  it("surfaces a failed delete instead of pretending it worked", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "DELETE /hrms/employees/custom-fields/f1": () => fail(500, { message: "Could not remove." }),
    });
    at();
    await screen.findByText("Blood group");

    await userEvent.click(screen.getByRole("button", { name: "Remove Blood group" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Remove$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "delete")).toBe(true));
    expect(screen.getByText("Blood group")).toBeTruthy();
  });

  it("offers no deactivate control, because the model has no such state", async () => {
    await open();
    expect(screen.queryByRole("button", { name: /deactivate|archive|disable/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe("permissions", () => {
  it("a recruiter holds employees:edit:org but not org-structure:edit:org, so the tab is not theirs", async () => {
    signIn([R.RECRUITER]);
    at();

    expect(await screen.findByText(/cannot change the org structure/i)).toBeTruthy();
    // And crucially, no protected request was attempted.
    expect(calls.length).toBe(0);
  });

  it("an ordinary employee reaching the URL directly is refused and fetches nothing", async () => {
    signIn([R.EMPLOYEE]);
    at();

    expect(await screen.findByText(/cannot change the org structure/i)).toBeTruthy();
    expect(calls.length).toBe(0);
  });

  it("a super admin gets the full set of actions", async () => {
    await open([R.SUPER_ADMIN]);
    expect(screen.getByRole("button", { name: /New Field/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Blood group" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Blood group" })).toBeTruthy();
  });
});
