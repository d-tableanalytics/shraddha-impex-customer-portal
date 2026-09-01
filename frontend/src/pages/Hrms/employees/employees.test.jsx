/**
 * Employee Master screens.
 *
 * Only the axios instance is mocked, at `services/api`. Everything above it is
 * real: the HRMS client, the employees service, the shared Zod schemas and the
 * shared permission matrix. So these tests also cover the request URLs, the
 * dropping of empty query params and the `{ success, data }` unwrapping — the
 * places a screen and its API usually drift apart.
 *
 * What is asserted about permissions here is only what the UI OFFERS. Every one
 * of these operations is independently enforced server-side; those tests are in
 * backend/tests/employee-master.test.js.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({
  api: { request: vi.fn() },
}));

import { api } from "../../../services/api";
import { EmployeesPage } from "./EmployeesPage";
import { EmployeeProfilePage } from "./EmployeeProfilePage";
import { EmployeeEditPage } from "./EmployeeEditPage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

// ---------------------------------------------------------------------------
// Fixtures and the fake transport
// ---------------------------------------------------------------------------

const PRIYA = {
  id: "652f000000000000000000a1",
  employeeCode: "SI-001",
  displayName: "Priya Sharma",
  firstName: "Priya",
  lastName: "Sharma",
  email: "priya@shraddha.test",
  personalEmail: null,
  phone: "9876543210",
  phone2: null,
  designation: "Accounts Executive",
  employmentType: "full_time",
  status: "active",
  dateOfJoining: "2023-04-01",
  dateOfBirth: null,
  reportingManagerId: "652f000000000000000000a2",
  reportingManagerName: "Rahul Verma",
  departmentId: null,
  locationId: null,
  fatherName: "Suresh Sharma",
  motherName: null,
  permanentAddress: null,
  temporaryAddress: null,
  emergencyContacts: [],
  dependents: [],
  customFieldValues: {},
  // Presence only — the API never returns the values themselves.
  panNumber: true,
  bankAccountNumber: true,
  bankIfsc: null,
  aadhaarNumber: null,
  uanNumber: null,
  esiNumber: null,
  passportNumber: null,
};

const RAHUL = {
  ...PRIYA,
  id: "652f000000000000000000a2",
  employeeCode: "SI-002",
  displayName: "Rahul Verma",
  firstName: "Rahul",
  lastName: "Verma",
  email: "rahul@shraddha.test",
  phone: null,
  designation: "Accounts Manager",
  reportingManagerId: null,
  reportingManagerName: null,
  panNumber: null,
  bankAccountNumber: null,
};

/** Every request the transport saw, so a test can assert on params. */
let calls = [];

const listEnvelope = (rows) => ({
  data: { success: true, data: { data: rows, total: rows.length, page: 1, pageSize: 25 } },
});
const envelope = (payload) => ({ data: { success: true, data: payload } });

/**
 * Route by method and URL rather than by call order: the directory fires its
 * page query and its manager-options query concurrently, so an order-based
 * stub would be answering whichever landed first.
 */
function installTransport(overrides = {}) {
  calls = [];
  api.request.mockImplementation(async (config) => {
    calls.push(config);
    const { method, url, params } = config;
    const key = `${method.toUpperCase()} ${url}`;

    if (overrides[key]) return overrides[key](config);

    if (key === "GET /hrms/employees/custom-fields") return envelope([]);
    if (key === "GET /hrms/employees") {
      // The manager picker asks for active employees only.
      if (params?.pageSize === 200) return listEnvelope([RAHUL]);
      return listEnvelope([PRIYA, RAHUL]);
    }
    if (key === `GET /hrms/employees/${PRIYA.id}`) return envelope(PRIYA);

    throw new Error(`unstubbed request: ${key}`);
  });
}

const signIn = (roles, employee = null) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path, ui) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/employees" element={ui} />
        <Route path="/hrms/employees/:id" element={ui} />
        <Route path="/hrms/employees/:id/edit" element={ui} />
      </Routes>
    </MemoryRouter>,
  );

/** The parameters of the most recent directory query. */
const lastListParams = () =>
  [...calls].reverse().find((c) => c.url === "/hrms/employees" && c.params?.pageSize !== 200)
    ?.params;

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

describe("employee directory", () => {
  it("renders a row per employee, with the reference's columns", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/employees", <EmployeesPage />);

    expect(await screen.findByText("Priya Sharma")).toBeTruthy();

    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent.trim());
    expect(headers).toEqual([
      "Employee",
      "Email",
      "Phone",
      "Designation",
      "Reporting manager",
      "Status",
    ]);

    const row = screen.getByText("Priya Sharma").closest("tr");
    expect(within(row).getByText("SI-001")).toBeTruthy();
    expect(within(row).getByText("priya@shraddha.test")).toBeTruthy();
    expect(within(row).getByText("Accounts Executive")).toBeTruthy();
    expect(within(row).getByText("Rahul Verma")).toBeTruthy();
    expect(within(row).getByText(/active/i)).toBeTruthy();
  });

  it("shows an em dash where a value is genuinely absent", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/employees", <EmployeesPage />);

    const row = (await screen.findByText("Rahul Verma", { selector: "div" })).closest("tr");
    // Rahul has no phone and no manager. Printing "null" or leaving the cell
    // blank both read as a rendering bug rather than as missing data.
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("asks the server for the page — it does not fetch everything and slice", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/employees", <EmployeesPage />);
    await screen.findByText("Priya Sharma");

    expect(lastListParams()).toMatchObject({ page: 1, pageSize: 25 });
  });

  it("renders the empty state rather than a bare table", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({ "GET /hrms/employees": () => listEnvelope([]) });
    at("/hrms/employees", <EmployeesPage />);

    expect(await screen.findByText("No employees yet")).toBeTruthy();
    expect(screen.getByText(/Add the first employee/i)).toBeTruthy();
  });

  it("surfaces a failed load with a retry, and retrying re-queries", async () => {
    signIn([R.HR_ADMIN]);
    let attempts = 0;
    installTransport({
      "GET /hrms/employees": (config) => {
        if (config.params?.pageSize === 200) return listEnvelope([]);
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject({ response: { status: 500, data: { message: "Database is down." } } });
        }
        return listEnvelope([PRIYA]);
      },
    });

    at("/hrms/employees", <EmployeesPage />);
    expect(await screen.findByText("Database is down.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByText("Priya Sharma")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Search and filters
// ---------------------------------------------------------------------------

describe("search and filters", () => {
  it("sends the search term to the server, debounced", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/employees", <EmployeesPage />);
    await screen.findByText("Priya Sharma");

    await userEvent.type(screen.getByRole("searchbox"), "priya");

    await waitFor(() => expect(lastListParams()?.search).toBe("priya"));

    // Debounced: five keystrokes must not be five round trips.
    const searchCalls = calls.filter((c) => c.params?.search);
    expect(searchCalls.length).toBeLessThan(5);
  });

  it("filters by status and resets to page 1", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/employees", <EmployeesPage />);
    await screen.findByText("Priya Sharma");

    await userEvent.click(screen.getByRole("button", { name: /Status/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Probation" }));

    await waitFor(() => expect(lastListParams()?.status).toBe("probation"));
    expect(lastListParams()?.page).toBe(1);
  });

  it("drops a cleared filter from the query instead of sending an empty value", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/employees", <EmployeesPage />);
    await screen.findByText("Priya Sharma");

    await userEvent.click(screen.getByRole("button", { name: /Status/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Probation" }));
    await waitFor(() => expect(lastListParams()?.status).toBe("probation"));

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(lastListParams()).not.toHaveProperty("status"));
  });

  it("shows Department and Location disabled, because Org Structure is not built", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/employees", <EmployeesPage />);
    await screen.findByText("Priya Sharma");

    // Present but inert, rather than hidden: the directory is honest about the
    // filters the reference has, and about the ones this build cannot answer.
    expect(screen.getByRole("button", { name: /Department/ }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /Location/ }).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------

describe("add employee", () => {
  const openDrawer = async () => {
    at("/hrms/employees", <EmployeesPage />);
    await screen.findByText("Priya Sharma");
    await userEvent.click(screen.getByRole("button", { name: /Add employee/i }));
    const heading = await screen.findByRole("heading", { name: /Add employee/i });
    // The page trigger and the drawer's submit share a label, so queries are
    // scoped to the drawer panel rather than to the whole document.
    return heading.closest("div.relative");
  };

  /** The drawer's own submit button. */
  const submitButton = (drawer) =>
    within(drawer)
      .getAllByRole("button", { name: /^Add employee$/i })
      .at(-1);

  it("opens a drawer — the reference has no /employees/new route", async () => {
    signIn([R.HR_ADMIN]);
    await openDrawer();

    expect(screen.getByPlaceholderText("e.g. Priya")).toBeTruthy();
    for (const section of [/^Personal$/, /^Family$/, /^Address$/, /^Emergency Contacts/, /^Job/]) {
      expect(screen.getByRole("heading", { name: section })).toBeTruthy();
    }
  });

  it("lets employeeCode be set on creation, unlike on edit", async () => {
    signIn([R.HR_ADMIN]);
    await openDrawer();

    const code = screen.getByPlaceholderText("e.g. SI-0006");
    expect(code.disabled).toBeFalsy();
  });

  it("refuses to submit an incomplete form, and sends nothing", async () => {
    signIn([R.HR_ADMIN]);
    const drawer = await openDrawer();

    const before = calls.length;
    await userEvent.click(submitButton(drawer));

    // The server validates independently; this is about not sending a request
    // that is already known to be invalid.
    await waitFor(() =>
      expect(document.querySelectorAll(".text-error-500").length).toBeGreaterThan(0),
    );
    expect(calls.filter((c) => c.method === "post").length).toBe(0);
    expect(calls.length).toBe(before);
  });

  it("posts the new employee and shows the one-time password once", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "POST /hrms/employees": () =>
        envelope({ employee: { ...PRIYA, displayName: "Anita Rao" }, tempPassword: "Zx9-Qw2-Tr7" }),
    });

    const drawer = await openDrawer();

    await userEvent.type(screen.getByPlaceholderText("e.g. Priya"), "Anita");
    await userEvent.type(screen.getByPlaceholderText("e.g. Sharma"), "Rao");
    await userEvent.type(screen.getByPlaceholderText("name@company.com"), "anita@shraddha.test");
    await userEvent.type(screen.getByPlaceholderText("e.g. SI-0006"), "SI-003");

    await userEvent.click(submitButton(drawer));

    expect(await screen.findByText("Zx9-Qw2-Tr7")).toBeTruthy();

    const post = calls.find((c) => c.method === "post" && c.url === "/hrms/employees");
    expect(post.data).toMatchObject({
      firstName: "Anita",
      lastName: "Rao",
      email: "anita@shraddha.test",
      employeeCode: "SI-003",
    });
    // managerChain is derived on the server from reportingManagerId; a client
    // that could send it could rewrite who may approve its own leave.
    expect(post.data).not.toHaveProperty("managerChain");
    expect(post.data).not.toHaveProperty("__managerOptions");
  });

  it("is not offered at all to a role that cannot create", async () => {
    signIn([R.MANAGER]);
    at("/hrms/employees", <EmployeesPage />);
    await screen.findByText("Priya Sharma");

    expect(screen.queryByRole("button", { name: /Add employee/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

describe("employee profile", () => {
  const open = async (roles) => {
    signIn(roles);
    at(`/hrms/employees/${PRIYA.id}`, <EmployeeProfilePage />);
    return screen.findAllByText("Priya Sharma");
  };

  it("shows the job, contact and family details", async () => {
    await open([R.HR_ADMIN]);

    expect(screen.getByText("SI-001")).toBeTruthy();
    expect(screen.getByText("Accounts Executive")).toBeTruthy();
    expect(screen.getByText("priya@shraddha.test")).toBeTruthy();
    expect(screen.getByText("Suresh Sharma")).toBeTruthy();
    expect(screen.getByText("Rahul Verma")).toBeTruthy();
  });

  it("shows sensitive fields as present, never as values", async () => {
    await open([R.PAYROLL_ADMIN]);

    expect(screen.getByText("PAN")).toBeTruthy();
    expect(screen.getByText("Bank account number")).toBeTruthy();
    // Two on file, and nothing else listed: a field with no value must not
    // appear at all, or the page would leak which identifiers were collected.
    expect(screen.queryByText("Aadhaar")).toBeNull();
    expect(screen.getAllByText(/on file/).length).toBe(2);

    // Opening a profile fetches the employee and nothing else. If the values
    // arrived with the record, every page view would be a disclosure.
    expect(calls.filter((c) => c.method === "post").length).toBe(0);
    expect(document.body.textContent).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/); // a PAN
  });

  it("offers Reveal only with compensation access", async () => {
    await open([R.HR_ADMIN]);
    // The HR admin may create and edit this employee, and still may not read a
    // bank account number.
    expect(screen.queryByRole("button", { name: /Reveal/i })).toBeNull();
    expect(screen.getByText(/requires compensation access/i)).toBeTruthy();
  });

  it("reveals one field at a time, through its own audited request", async () => {
    signIn([R.PAYROLL_ADMIN]);
    installTransport({
      "POST /hrms/employees/652f000000000000000000a1/reveal": (c) =>
        envelope({ field: c.data.field, value: "ABCDE1234F" }),
    });
    at(`/hrms/employees/${PRIYA.id}`, <EmployeeProfilePage />);
    await screen.findAllByText("Priya Sharma");

    await userEvent.click(screen.getAllByRole("button", { name: /Reveal/i })[0]);

    expect(await screen.findByText("ABCDE1234F")).toBeTruthy();

    const reveal = calls.find((c) => c.url.endsWith("/reveal"));
    expect(reveal.data.field).toBe("panNumber");
    // One field per request — not "reveal everything on this record".
    expect(screen.getAllByText(/on file/).length).toBe(1);
  });

  it("gates Deactivate on delete permission, which an HR admin does not hold", async () => {
    await open([R.HR_ADMIN]);
    expect(screen.queryByRole("button", { name: /Deactivate/i })).toBeNull();

    cleanup();
    useHrmsStore.getState().clear();
    await open([R.SUPER_ADMIN]);
    expect(screen.getByRole("button", { name: /Deactivate/i })).toBeTruthy();
  });

  it("confirms before deactivating, and says what is kept", async () => {
    await open([R.SUPER_ADMIN]);
    await userEvent.click(screen.getByRole("button", { name: /Deactivate/i }));

    expect(await screen.findByText(/Deactivate this employee\?/i)).toBeTruthy();
    expect(screen.getByText(/Attendance, leave and payroll history stay intact/i)).toBeTruthy();
    // Nothing is sent until the dialog is confirmed.
    expect(calls.filter((c) => c.method === "delete").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

describe("edit employee", () => {
  const open = async (roles, actorEmployee = null) => {
    signIn(roles, actorEmployee);
    at(`/hrms/employees/${PRIYA.id}/edit`, <EmployeeEditPage />);
    return screen.findByDisplayValue("Priya");
  };

  it("loads the record into the form", async () => {
    await open([R.HR_ADMIN]);

    expect(screen.getByDisplayValue("Sharma")).toBeTruthy();
    expect(screen.getByDisplayValue("Accounts Executive")).toBeTruthy();
  });

  it("locks the two immutable identifiers", async () => {
    await open([R.HR_ADMIN]);

    expect(screen.getByDisplayValue("priya@shraddha.test").disabled).toBe(true);
    expect(screen.getByDisplayValue("SI-001").disabled).toBe(true);
    expect(screen.getByText(/cannot be changed here/i)).toBeTruthy();
  });

  it("never pre-fills a sensitive value", async () => {
    await open([R.SUPER_ADMIN]);

    // The record says a PAN and a bank account are on file. Neither may appear
    // in an input: a pre-filled form would put the plaintext back on the wire
    // on every save, and into the browser's autofill store.
    const values = Array.from(document.querySelectorAll("input")).map((i) => i.value);
    expect(values).not.toContain("true");
    expect(values.join(" ")).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/);
  });

  it("PATCHes only what actually changed", async () => {
    await open([R.HR_ADMIN]);

    const designation = screen.getByDisplayValue("Accounts Executive");
    await userEvent.clear(designation);
    await userEvent.type(designation, "Senior Accounts Executive");

    await userEvent.click(screen.getAllByRole("button", { name: /Save changes/i })[0]);

    await waitFor(() => expect(calls.some((c) => c.method === "patch")).toBe(true));
    const patch = calls.find((c) => c.method === "patch");

    expect(patch.data).toEqual({ designation: "Senior Accounts Executive" });
    // Sending the whole form would resubmit every field on every edit, which
    // both defeats the immutability of these two and widens what a self-edit
    // could reach.
    expect(patch.data).not.toHaveProperty("email");
    expect(patch.data).not.toHaveProperty("employeeCode");
  });

  it("sends nothing when nothing changed", async () => {
    await open([R.HR_ADMIN]);
    await userEvent.click(screen.getAllByRole("button", { name: /Save changes/i })[0]);

    // The toast itself needs a mounted <Toaster/>; what matters is that an
    // untouched form does not issue a write.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Save changes/i }).length)
      .toBeGreaterThan(0));
    expect(calls.filter((c) => c.method === "patch").length).toBe(0);
  });

  it("locks job details when an employee edits their own record", async () => {
    // `employees:edit:self` is in every role's baseline, so without this an
    // employee could change their own reporting manager — and with it, who
    // approves their leave.
    await open([R.EMPLOYEE], { id: PRIYA.id, managerChain: [] });

    expect(screen.getByText(/job details are read-only/i)).toBeTruthy();
    expect(screen.getByDisplayValue("Accounts Executive").disabled).toBe(true);
    // Personal details stay editable.
    expect(screen.getByDisplayValue("Priya").disabled).toBe(false);
  });

  it("leaves job details editable for HR, on someone else's record", async () => {
    await open([R.HR_ADMIN], { id: RAHUL.id, managerChain: [] });

    expect(screen.queryByText(/job details are read-only/i)).toBeNull();
    expect(screen.getByDisplayValue("Accounts Executive").disabled).toBe(false);
  });

  it("reports a rejected save instead of navigating away", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "PATCH /hrms/employees/652f000000000000000000a1": () =>
        Promise.reject({
          response: {
            status: 409,
            data: { message: "That would create a reporting cycle.", code: "MANAGER_CYCLE" },
          },
        }),
    });
    at(`/hrms/employees/${PRIYA.id}/edit`, <EmployeeEditPage />);
    await screen.findByDisplayValue("Priya");

    const designation = screen.getByDisplayValue("Accounts Executive");
    await userEvent.clear(designation);
    await userEvent.type(designation, "Manager");
    await userEvent.click(screen.getAllByRole("button", { name: /Save changes/i })[0]);

    await waitFor(() => expect(calls.some((c) => c.method === "patch")).toBe(true));
    // Still on the form, with the edit intact, so the change is not lost.
    expect(screen.getByDisplayValue("Manager")).toBeTruthy();
  });
});
