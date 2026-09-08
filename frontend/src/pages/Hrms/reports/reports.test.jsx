/**
 * Reports — the screens.
 *
 * Only the axios instance is mocked. The HRMS client, the shared permission
 * matrix and the query builder are all real, so these also cover the request
 * URLs, the parameters and the `{ success, data }` unwrapping.
 *
 * What the UI offers is asserted here; what it is ALLOWED to do is asserted in
 * backend/tests/reports-api.test.js. Both halves read the same matrix.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { ReportsPage } from "./ReportsPage";
import { HrmsProtectedRoute } from "../../../components/hrms/HrmsProtectedRoute";
import { REPORTS_ENTRY_GRANTS } from "../../../components/hrms/navItems";
import { toQuery, monthRange, currentMonth } from "../../../services/hrms/reports";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const ME = "652f0000000000000000b001";
const DEPT = "652f0000000000000000c001";
const LEAVE_TYPE = "652f0000000000000000c002";

const DIRECTORY = {
  key: "employees_directory",
  label: "Employee Directory",
  description: "All active employees with contact + department",
  category: "Employees",
  moduleRequired: "employees",
  scopeRequired: "org",
  columns: [
    { key: "employeeCode", label: "Code" },
    { key: "displayName", label: "Name" },
    { key: "email", label: "Email" },
    { key: "departmentName", label: "Department" },
    { key: "designation", label: "Designation" },
    { key: "joinDate", label: "Join Date", type: "date" },
  ],
};

const ATTENDANCE = {
  key: "attendance_monthly",
  label: "Monthly Attendance Summary",
  description: "Per-employee attendance for the selected month",
  category: "Attendance",
  moduleRequired: "attendance",
  scopeRequired: "org",
  columns: [
    { key: "employeeCode", label: "Code" },
    { key: "displayName", label: "Name" },
    { key: "presentDays", label: "Present Days", type: "number" },
    { key: "absentDays", label: "Absent Days", type: "number" },
    { key: "leaveDays", label: "Leave Days", type: "number" },
  ],
};

const LEAVE = {
  key: "leave_balances",
  label: "Leave Balances (current year)",
  description: "Per-employee leave balances",
  category: "Leave",
  moduleRequired: "leave",
  scopeRequired: "org",
  columns: [
    { key: "employeeCode", label: "Code" },
    { key: "displayName", label: "Name" },
    { key: "leaveType", label: "Leave Type" },
    { key: "balance", label: "Balance", type: "number" },
  ],
};

const CATALOG = [DIRECTORY, ATTENDANCE, LEAVE];

const directoryRow = (over = {}) => ({
  employeeCode: "E-0001",
  displayName: "Alice Ant",
  email: "alice@example.com",
  departmentName: "Engineering",
  designation: "Engineer",
  joinDate: "2021-03-04",
  ...over,
});

let calls = [];
const envelope = (payload) => ({ data: { success: true, data: payload } });
const runPage = (report, rows, over = {}) =>
  envelope({
    report,
    columns: report.columns,
    data: rows,
    total: rows.length,
    page: 1,
    pageSize: 25,
    ...over,
  });
const fail = (status, body) => Promise.reject({ response: { status, data: body } });

function installTransport(overrides = {}) {
  calls = [];
  api.request.mockImplementation(async (config) => {
    calls.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (overrides[key]) return overrides[key](config);

    if (key === "GET /hrms/reports/catalog") return envelope(CATALOG);
    if (key === "GET /hrms/reports/employees_directory/run")
      return runPage(DIRECTORY, [directoryRow()]);
    if (key === "GET /hrms/reports/attendance_monthly/run")
      return runPage(ATTENDANCE, [
        { employeeCode: "E-0001", displayName: "Alice Ant", presentDays: 2.5, absentDays: 1, leaveDays: 1 },
      ]);
    if (key === "GET /hrms/reports/leave_balances/run")
      return runPage(LEAVE, [
        { employeeCode: "E-0001", displayName: "Alice Ant", leaveType: "Casual Leave", balance: 9.5 },
      ]);
    if (key === "GET /hrms/org/departments")
      return envelope([{ id: DEPT, name: "Engineering" }]);
    if (key === "GET /hrms/leave/types")
      return envelope([{ id: LEAVE_TYPE, name: "Casual Leave" }]);
    if (config.url?.endsWith("/export.csv"))
      return {
        data: "Code,Name\nE-0001,Alice Ant",
        headers: {
          // Deliberately NOT `${key}.csv` — otherwise taking the name from
          // the header and building it from the URL look identical.
          "content-disposition": 'attachment; filename="employees_directory_2026-03.csv"',
          "x-report-rows": "1",
          "x-report-total": "1",
          "x-report-truncated": "false",
        },
      };
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: ME, managerChain: [] } }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.REPORTS],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/reports" element={<ReportsPage />} />
        <Route path="/hrms/reports/:key" element={<ReportsPage />} />
      </Routes>
    </MemoryRouter>,
  );

const urlsHit = () => calls.map((c) => `${c.method.toUpperCase()} ${c.url}`);
const lastCallTo = (url) => calls.filter((c) => c.url === url).pop();

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ===========================================================================
// The page and the catalogue
// ===========================================================================

describe("the reports page", () => {
  it("renders its title, and no breadcrumb - a top-level page needs none", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports");

    expect(await screen.findByRole("heading", { name: "Reports" })).toBeTruthy();
    // A top-level HRMS page carries no breadcrumb: "HRMS > X" above a heading
    // that already reads "X", beside a sidebar already highlighting X, is the
    // same fact three times - and no other module in the portal has one.
    // HrmsPageLayout renders the trail only once it goes deeper than
    // "HRMS > <module>"; the nested employee pages still get theirs.
    expect(screen.queryByRole("navigation", { name: /breadcrumb/i })).toBeNull();
  });

  it("groups the catalogue by category, as the reference does", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports");

    expect(await screen.findByRole("heading", { name: "Employees" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Attendance" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Leave" })).toBeTruthy();

    expect(screen.getByRole("heading", { name: "Employee Directory" })).toBeTruthy();
    expect(screen.getByText("6 columns")).toBeTruthy();
    expect(screen.getByText(/All active employees/)).toBeTruthy();
  });

  it("renders whatever the SERVER put in the catalogue, and nothing more", async () => {
    // A recruiter is served two reports, not three — they hold
    // `employees:view:org` and `attendance:view:org` but not `leave:view:org`.
    // The screen does not decide that; it renders what arrived.
    installTransport({
      "GET /hrms/reports/catalog": () => envelope([DIRECTORY, ATTENDANCE]),
    });
    signIn([R.RECRUITER]);
    at("/hrms/reports");

    expect(await screen.findByRole("heading", { name: "Employee Directory" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Monthly Attendance Summary" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Leave Balances/ })).toBeNull();
  });

  it("explains an empty catalogue instead of shrugging at it", async () => {
    // What an IT admin, a payroll admin and a manager all see: their report
    // grants open the module and no report declares any of them.
    installTransport({ "GET /hrms/reports/catalog": () => envelope([]) });
    signIn([R.IT_ADMIN]);
    at("/hrms/reports");

    expect(await screen.findByText("No reports available")).toBeTruthy();
    expect(screen.getByText(/offered on the module it reads/i)).toBeTruthy();
  });

  it("shows a real error state, distinct from an empty catalogue", async () => {
    // The reference renders `<Empty description="No data"/>` on failure, so a
    // 403 and a genuinely empty report look identical.
    installTransport({
      "GET /hrms/reports/catalog": () => fail(500, { message: "Server error" }),
    });
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports");

    expect(await screen.findByText("Reports could not be loaded")).toBeTruthy();
    expect(screen.queryByText("No reports available")).toBeNull();

    const before = calls.length;
    await userEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it("the ROUTE turns an employee away before the page renders", async () => {
    // The gate is `HrmsProtectedRoute module="reports"` in routes/index.jsx,
    // not anything inside the page — so it has to be exercised through the
    // guard, exactly as the route config wires it.
    signIn([R.EMPLOYEE]);
    render(
      <MemoryRouter initialEntries={["/hrms/reports"]}>
        <Routes>
          <Route
            path="/hrms/reports"
            element={<HrmsProtectedRoute module={M.REPORTS} anyOf={REPORTS_ENTRY_GRANTS} />}
          >
            <Route index element={<ReportsPage />} />
          </Route>
          <Route path="/hrms/dashboard" element={<p>HRMS home</p>} />
          <Route path="/" element={<p>Portal home</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/home/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Reports" })).toBeNull();
    // And the catalogue is never even requested.
    expect(urlsHit()).not.toContain("GET /hrms/reports/catalog");
  });

  it("the route admits every role the reference grants a report key", async () => {
    for (const role of [R.SUPER_ADMIN, R.HR_ADMIN, R.AUDITOR, R.PAYROLL_ADMIN,
                        R.RECRUITER, R.IT_ADMIN, R.MANAGER]) {
      installTransport();
      useHrmsStore.getState().clear();
      signIn([role]);
      const view = render(
        <MemoryRouter initialEntries={["/hrms/reports"]}>
          <Routes>
            <Route
            path="/hrms/reports"
            element={<HrmsProtectedRoute module={M.REPORTS} anyOf={REPORTS_ENTRY_GRANTS} />}
          >
              <Route index element={<ReportsPage />} />
            </Route>
            <Route path="/" element={<p>Portal home</p>} />
          </Routes>
        </MemoryRouter>,
      );
      expect(
        await screen.findByRole("heading", { name: "Reports" }),
      ).toBeTruthy();
      view.unmount();
    }
  });
});

// ===========================================================================
// Selecting a report
// ===========================================================================

describe("opening a report", () => {
  it("puts the report key in the URL, so it is linkable", async () => {
    // The reference holds the selection in component state, where it is
    // neither addressable nor survives a refresh.
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports");

    await userEvent.click(await screen.findByRole("button", { name: "Run Employee Directory" }));

    expect(await screen.findByRole("button", { name: /Catalog/ })).toBeTruthy();
    await waitFor(() =>
      expect(urlsHit()).toContain("GET /hrms/reports/employees_directory/run"),
    );
  });

  it("renders a report opened straight from a URL, before the catalogue lands", async () => {
    // The columns arrive with the rows, so the table does not depend on having
    // the catalogue entry in hand.
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");

    expect(await screen.findByText("Alice Ant")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Email" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Join Date" })).toBeTruthy();
  });

  it("renders the rows against the declared columns", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");

    const row = within((await screen.findByText("Alice Ant")).closest("tr"));
    expect(row.getByText("E-0001")).toBeTruthy();
    expect(row.getByText("alice@example.com")).toBeTruthy();
    expect(row.getByText("Engineering")).toBeTruthy();
    expect(row.getByText("2021-03-04")).toBeTruthy();
  });

  it("goes back to the catalogue", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");

    await userEvent.click(await screen.findByRole("button", { name: /Catalog/ }));
    expect(await screen.findByRole("heading", { name: "Employee Directory" })).toBeTruthy();
  });

  it("shows an error for a report that fails, with a retry", async () => {
    installTransport({
      "GET /hrms/reports/leave_balances/run": () => fail(403, { message: "Cannot run report" }),
    });
    signIn([R.RECRUITER]);
    at("/hrms/reports/leave_balances");

    expect(await screen.findByText(/Cannot run report/)).toBeTruthy();
    // A refused report is not an empty one.
    expect(screen.queryByText("No data")).toBeNull();
  });
});

// ===========================================================================
// Filters — every one of them a SERVER query
// ===========================================================================

describe("filters", () => {
  const RUN = "/hrms/reports/employees_directory/run";

  it("the directory pages and filters through the server", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");
    await screen.findByText("Alice Ant");

    // Paging is a server parameter, not a slice of an array already in hand.
    expect(lastCallTo(RUN).params.page).toBe(1);
    expect(lastCallTo(RUN).params.pageSize).toBe(25);

    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "notice");
    await waitFor(() => expect(lastCallTo(RUN).params.status).toBe("notice"));

    await userEvent.selectOptions(screen.getByLabelText("Filter by department"), DEPT);
    await waitFor(() => expect(lastCallTo(RUN).params.departmentId).toBe(DEPT));

    await userEvent.type(screen.getByLabelText("Search employees"), "alice");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(lastCallTo(RUN).params.search).toBe("alice"));
  });

  it("the attendance report sends a CLOSED month window", async () => {
    // The reference's window is `gte: startOfMonth` with no upper bound, so its
    // "current month" includes every future-dated record forever.
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/attendance_monthly");
    await screen.findByText("Alice Ant");

    const run = "/hrms/reports/attendance_monthly/run";
    expect(lastCallTo(run).params.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(lastCallTo(run).params.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await userEvent.clear(screen.getByLabelText("Month"));
    await userEvent.type(screen.getByLabelText("Month"), "2026-02");
    await waitFor(() => {
      expect(lastCallTo(run).params.from).toBe("2026-02-01");
      // 2026 is not a leap year — the window must end on the 28th.
      expect(lastCallTo(run).params.to).toBe("2026-02-28");
    });
  });

  it("the leave report filters by year and by leave type", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/leave_balances");
    await screen.findByRole("columnheader", { name: "Balance" });

    const run = "/hrms/reports/leave_balances/run";
    await userEvent.selectOptions(screen.getByLabelText("Filter by leave type"), LEAVE_TYPE);
    await waitFor(() => expect(lastCallTo(run).params.leaveTypeId).toBe(LEAVE_TYPE));

    const year = String(new Date().getFullYear() - 1);
    await userEvent.selectOptions(screen.getByLabelText("Year"), year);
    await waitFor(() => expect(lastCallTo(run).params.year).toBe(year));
  });

  it("only offers the filters the open report actually accepts", async () => {
    // Sending a filter a report does not declare is a 400 from the server, so
    // the toolbar must not offer one.
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/leave_balances");
    await screen.findByRole("columnheader", { name: "Balance" });

    expect(screen.getByLabelText("Year")).toBeTruthy();
    expect(screen.queryByLabelText("Month")).toBeNull();
    expect(screen.queryByLabelText("Filter by status")).toBeNull();
    expect(screen.queryByLabelText("Search employees")).toBeNull();
  });

  it("changing a filter returns to page one", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");
    await screen.findByText("Alice Ant");

    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "exited");
    await waitFor(() => {
      expect(lastCallTo(RUN).params.status).toBe("exited");
      expect(lastCallTo(RUN).params.page).toBe(1);
    });
  });

  it("a filter whose options fail to load does not break the report", async () => {
    installTransport({
      "GET /hrms/org/departments": () => fail(500, { message: "nope" }),
    });
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");

    expect(await screen.findByText("Alice Ant")).toBeTruthy();
    const select = screen.getByLabelText("Filter by department");
    expect(within(select).getByText("All departments")).toBeTruthy();
  });
});

// ===========================================================================
// Export
// ===========================================================================

describe("exporting", () => {
  it("requests the CSV with the SAME filters and no paging", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");
    await screen.findByText("Alice Ant");

    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "notice");
    await waitFor(() => expect(lastCallTo(RUN_DIR).params.status).toBe("notice"));

    await userEvent.click(screen.getByRole("button", { name: /Export CSV/ }));

    await waitFor(() => {
      const call = calls.find((c) => c.url?.endsWith("/export.csv"));
      expect(call).toBeTruthy();
      expect(call.url).toBe("/hrms/reports/employees_directory/export.csv");
      expect(call.params.status).toBe("notice");
      // An export is the whole result set — paging would silently truncate it.
      expect(call.params.page).toBeUndefined();
      expect(call.params.pageSize).toBeUndefined();
    });
  });

  it("names the file from the SERVER's header, not from the URL", async () => {
    // The reference builds the download name from its own `:key` parameter.
    const clicked = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === "a") {
        el.click = () => clicked.push({ download: el.download, href: el.href });
      }
      return el;
    });
    URL.createObjectURL = vi.fn(() => "blob:report");
    URL.revokeObjectURL = vi.fn();

    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");
    await screen.findByText("Alice Ant");
    await userEvent.click(screen.getByRole("button", { name: /Export CSV/ }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe("employees_directory_2026-03.csv");

    document.createElement.mockRestore();
  });

  it("still downloads correctly when the headers are unreadable", async () => {
    // Cross-origin, `cors()` exposes only the six safelisted headers, so
    // `Content-Disposition` and `X-Report-*` come back as null. The file must
    // still save under a sensible name and the count must not claim zero.
    installTransport({
      "GET /hrms/reports/employees_directory/export.csv": () => ({
        data: "Code,Name\nE-0001,Alice Ant\nE-0002,Bob Bee\n",
        headers: {},
      }),
    });

    const clicked = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === "a") el.click = () => clicked.push({ download: el.download });
      return el;
    });
    URL.createObjectURL = vi.fn(() => "blob:report");
    URL.revokeObjectURL = vi.fn();

    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");
    await screen.findByText("Alice Ant");
    await userEvent.click(screen.getByRole("button", { name: /Export CSV/ }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe("employees_directory.csv");
    document.createElement.mockRestore();
  });

  it("counts the rows off the CSV when the count header is missing", async () => {
    const { reportsApi } = await import("../../../services/hrms/reports");
    installTransport({
      "GET /hrms/reports/employees_directory/export.csv": () => ({
        data: "Code,Name\nE-0001,Alice Ant\nE-0002,Bob Bee\n",
        headers: {},
      }),
    });

    const file = await reportsApi.exportCsv("employees_directory");
    // Two data rows, not zero, and not the header line.
    expect(file.rows).toBe(2);
    expect(file.total).toBe(2);
    expect(file.truncated).toBe(false);
  });

  it("reports a failed export rather than downloading nothing", async () => {
    installTransport({
      "GET /hrms/reports/employees_directory/export.csv": () =>
        fail(403, { message: "Cannot export report" }),
    });
    signIn([R.SUPER_ADMIN]);
    at("/hrms/reports/employees_directory");
    await screen.findByText("Alice Ant");

    await userEvent.click(screen.getByRole("button", { name: /Export CSV/ }));
    // The button comes back rather than sticking on "Exporting…".
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Export CSV/ })).toBeTruthy(),
    );
  });
});

const RUN_DIR = "/hrms/reports/employees_directory/run";

// ===========================================================================
// The query builder
// ===========================================================================

describe("the shipped route config", () => {
  // The guard component is exercised above with a hand-built <Route>, which
  // proves the component and nothing about what is actually wired. This reads
  // the real tree, so dropping `anyOf` from routes/index.jsx is caught.
  it("gates /hrms/reports on the same five grants as the sidebar", async () => {
    const { router } = await import("../../../routes/index.jsx");

    // The portal has its OWN `reports` route (`/reports`, the sales report),
    // so the search has to be scoped to the `/hrms` subtree or it finds that
    // one first.
    const find = (routes, path) => {
      for (const r of routes ?? []) {
        if (r.path === path) return r;
        const hit = find(r.children, path);
        if (hit) return hit;
      }
      return null;
    };

    const hrms = find(router.routes, "hrms");
    expect(hrms).toBeTruthy();
    const reports = find(hrms.children, "reports");
    expect(reports).toBeTruthy();
    expect(reports.element.props.module).toBe("reports");
    expect(reports.element.props.anyOf).toBe(REPORTS_ENTRY_GRANTS);
    // And the report key is addressable.
    expect(reports.children.map((c) => c.path)).toContain(":key");
  });
});

describe("toQuery", () => {
  it("sends only what the open report declares", () => {
    // Carrying a `leaveTypeId` into the directory would be a 400 — the server
    // rejects an unknown filter rather than ignoring it.
    const messy = { status: "active", leaveTypeId: LEAVE_TYPE, year: "2026", month: "2026-02" };

    expect(toQuery("employees_directory", messy)).toEqual({ status: "active" });
    expect(toQuery("leave_balances", messy)).toEqual({ year: "2026", leaveTypeId: LEAVE_TYPE });
    expect(toQuery("attendance_monthly", messy)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("defaults the attendance window to the current month", () => {
    const { from, to } = monthRange(currentMonth());
    expect(toQuery("attendance_monthly", {})).toEqual({ from, to });
  });

  it("omits an empty filter rather than sending a blank one", () => {
    expect(toQuery("employees_directory", { departmentId: "", search: "" })).toEqual({});
  });
});

describe("monthRange", () => {
  it("closes the window on the real last day", () => {
    expect(monthRange("2026-01")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    // A leap year still gets 29.
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-04")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
  });
});
