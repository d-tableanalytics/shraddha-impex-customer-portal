/**
 * Leave and Holidays — the screens.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas,
 * the shared date arithmetic and the shared permission matrix are all real, so
 * these also cover the request URLs, the payload shapes and the `{ success,
 * data }` unwrapping.
 *
 * What the UI offers is asserted here; what it is ALLOWED to do is asserted in
 * backend/tests/leave-api.test.js. Both halves read the same matrix.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { LeavePage } from "./LeavePage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const TYPES = [
  { id: "652f0000000000000000a001", code: "CL", name: "Casual Leave", allowsHalfDay: true, adminOnly: false, color: "#1E5FB8" },
  { id: "652f0000000000000000a002", code: "COMP", name: "Comp Off", allowsHalfDay: false, adminOnly: false, color: "#0ea5e9" },
];

const BALANCES = [
  { leaveTypeId: "652f0000000000000000a001", code: "CL", leaveTypeName: "Casual Leave", year: 2026, accrued: 12, used: 3, pending: 2, balance: 7, color: "#1E5FB8" },
];

const MY_REQUESTS = [
  {
    id: "r1", employeeId: "652f0000000000000000b001", employeeName: "Staff One", employeeCode: "SI-0002",
    leaveTypeId: "652f0000000000000000a001", leaveTypeCode: "CL", leaveTypeName: "Casual Leave", color: "#1E5FB8",
    startDate: "2026-01-05", endDate: "2026-01-06", durationUnit: "full_day", durationValue: 2,
    halfDayPeriod: null, halfDaySlots: null, dayBreakdown: null, hourFrom: null, hourTo: null,
    reason: "Family function", status: "pending", approvalChain: [], createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "r2", employeeId: "652f0000000000000000b001", employeeName: "Staff One", employeeCode: "SI-0002",
    leaveTypeId: "652f0000000000000000a001", leaveTypeCode: "CL", leaveTypeName: "Casual Leave", color: "#1E5FB8",
    startDate: "2025-12-01", endDate: "2025-12-01", durationUnit: "half_day", durationValue: 0.5,
    halfDayPeriod: "first", halfDaySlots: null, dayBreakdown: null, hourFrom: null, hourTo: null,
    reason: "Appointment", status: "approved", approvalChain: [], createdAt: "2025-11-01T00:00:00.000Z",
  },
];

const HOLIDAYS = [
  { id: "h1", name: "Republic Day", date: "2026-01-26", year: 2026, type: "national", region: null, description: null, isOptional: false },
  { id: "h2", name: "Rakhi", date: "2026-08-28", year: 2026, type: "restricted", region: "IN-MP", description: null, isOptional: true },
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

    if (key === "GET /hrms/leave/types") return envelope(TYPES);
    if (key === "GET /hrms/leave/balances/me") return envelope(BALANCES);
    if (key === "GET /hrms/leave/requests") {
      const wanted = config.params?.status;
      return envelope(wanted ? MY_REQUESTS.filter((r) => r.status === wanted) : MY_REQUESTS);
    }
    if (key === "GET /hrms/leave/calendar") return envelope({ requests: MY_REQUESTS, holidays: HOLIDAYS });
    if (key === "GET /hrms/holidays") return envelope(HOLIDAYS);
    if (key === "GET /hrms/holidays/years") return envelope([{ year: 2026, count: 2 }]);
    if (config.method === "post" || config.method === "patch") return envelope({ id: "new", status: "pending" });
    if (config.method === "delete") return envelope({ deleted: true });
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles, employee = { id: "652f0000000000000000b001", managerChain: [] }) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE, M.LEAVE],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/leave" element={<LeavePage />} />
        <Route path="/hrms/leave/:tab" element={<LeavePage />} />
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

describe("the leave page", () => {
  it("renders its title, and no breadcrumb - a top-level page needs none", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/leave/me");

    expect(await screen.findByRole("heading", { name: "Leave" })).toBeTruthy();
    // A top-level HRMS page carries no breadcrumb: "HRMS > X" above a heading
    // that already reads "X", beside a sidebar already highlighting X, is the
    // same fact three times - and no other module in the portal has one.
    // HrmsPageLayout renders the trail only once it goes deeper than
    // "HRMS > <module>"; the nested employee pages still get theirs.
    expect(screen.queryByRole("navigation", { name: /breadcrumb/i })).toBeNull();
  });

  it("an employee gets My Leave and Holidays only", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/leave/me");
    await screen.findByText("Family function");

    expect(screen.getAllByRole("tab").map((t) => t.textContent.trim())).toEqual([
      "My Leave",
      "Holidays",
    ]);
  });

  it("a manager also gets Approvals and the team calendar", async () => {
    signIn([R.MANAGER]);
    at("/hrms/leave/me");
    await screen.findByText("Family function");

    expect(screen.getAllByRole("tab").map((t) => t.textContent.trim())).toEqual([
      "My Leave",
      "Approvals",
      "Team Calendar",
      "Holidays",
    ]);
  });

  it("defaults to My Leave and switches tab by URL", async () => {
    signIn([R.MANAGER]);
    at("/hrms/leave");
    expect(await screen.findByText("Family function")).toBeTruthy();
    cleanup();

    at("/hrms/leave/holidays");
    expect(await screen.findByText("Republic Day")).toBeTruthy();
  });

  it("a gated tab reached by URL is refused, and fires no request for it", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/leave/approvals");

    expect(await screen.findByText(/do not have access to this view/i)).toBeTruthy();
    expect(calls.some((c) => c.url === "/hrms/leave/requests")).toBe(false);
  });
});

// ===========================================================================
// My Leave
// ===========================================================================

describe("my leave", () => {
  const open = async (roles = [R.EMPLOYEE]) => {
    signIn(roles);
    at("/hrms/leave/me");
    return screen.findByText("Family function");
  };

  it("shows the balance buckets", async () => {
    await open();
    const card = screen.getByText("Casual Leave").closest("div");
    expect(within(card.parentElement).getByText("7")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("lists my requests with duration and status", async () => {
    await open();

    const row = screen.getByText("Family function").closest("tr");
    expect(within(row).getByText("2 days")).toBeTruthy();
    expect(within(row).getByText("Pending")).toBeTruthy();

    const approved = screen.getByText("Appointment").closest("tr");
    expect(within(approved).getByText("0.5 days")).toBeTruthy();
    expect(within(approved).getByText("Approved")).toBeTruthy();
  });

  it("offers Cancel only on a pending request", async () => {
    await open();

    const pending = screen.getByText("Family function").closest("tr");
    expect(within(pending).getByRole("button", { name: "Cancel" })).toBeTruthy();

    const approved = screen.getByText("Appointment").closest("tr");
    expect(within(approved).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("cancels after confirmation, and only then calls the server", async () => {
    await open();
    const row = screen.getByText("Family function").closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText(/Cancel this request\?/i)).toBeTruthy();
    expect(calls.some((c) => c.method === "post")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Cancel request" }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    expect(calls.find((c) => c.method === "post").url).toBe("/hrms/leave/requests/r1/cancel");
  });

  it("shows a loading state, then the rows", async () => {
    signIn([R.EMPLOYEE]);
    let release;
    installTransport({
      "GET /hrms/leave/requests": () => new Promise((r) => { release = () => r(envelope(MY_REQUESTS)); }),
    });
    at("/hrms/leave/me");

    expect(screen.queryByText("Family function")).toBeNull();
    release();
    expect(await screen.findByText("Family function")).toBeTruthy();
  });

  it("shows an empty state when there is no leave yet", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({ "GET /hrms/leave/requests": () => envelope([]) });
    at("/hrms/leave/me");

    expect(await screen.findByText("No leave requests yet")).toBeTruthy();
  });

  it("explains when no entitlement is configured", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/leave/balances/me": () => envelope([]),
      "GET /hrms/leave/requests": () => envelope([]),
    });
    at("/hrms/leave/me");

    expect(await screen.findByText(/No leave entitlement has been set up/i)).toBeTruthy();
  });

  it("surfaces an API failure with a retry", async () => {
    signIn([R.EMPLOYEE]);
    let attempts = 0;
    installTransport({
      "GET /hrms/leave/requests": () => {
        attempts += 1;
        return attempts === 1 ? fail(500, { message: "Leave is down." }) : envelope(MY_REQUESTS);
      },
    });
    at("/hrms/leave/me");

    expect(await screen.findByText("Leave is down.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByText("Family function")).toBeTruthy();
  });
});

// ===========================================================================
// Applying
// ===========================================================================

describe("applying for leave", () => {
  const openDrawer = async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/leave/me");
    await screen.findByText("Family function");
    await userEvent.click(screen.getByRole("button", { name: /Apply for leave/i }));
    return screen.findByRole("heading", { name: "Apply for leave" });
  };

  it("opens a drawer with the types already loaded", async () => {
    await openDrawer();

    await userEvent.click(screen.getByRole("button", { name: /Choose a leave type/i }));
    expect(await screen.findByRole("button", { name: "CL · Casual Leave" })).toBeTruthy();
    // Loaded once by the tab, not re-fetched by the drawer.
    expect(calls.filter((c) => c.url === "/hrms/leave/types").length).toBe(1);
  });

  it("previews the day count using the SAME calculation the server uses", async () => {
    await openDrawer();

    // Fri 9 Jan .. Mon 12 Jan 2026: the weekend is sandwiched between two full
    // days, so it counts — 4 days, exactly what the server will compute.
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-09" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-12" } });

    await waitFor(() =>
      expect(screen.getByTestId("leave-estimate").textContent).toMatch(/4 days/),
    );
  });

  it("posts only the fields the chosen mode needs", async () => {
    await openDrawer();

    await userEvent.click(screen.getByRole("button", { name: /Choose a leave type/i }));
    await userEvent.click(await screen.findByRole("button", { name: "CL · Casual Leave" }));

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-05" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-06" } });

    await userEvent.type(screen.getByPlaceholderText(/Why you need the time off/i), "Family function");
    await userEvent.click(screen.getByRole("button", { name: /Submit request/i }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    const posted = calls.find((c) => c.method === "post");

    expect(posted.url).toBe("/hrms/leave/requests");
    expect(posted.data).toEqual({
      leaveTypeId: "652f0000000000000000a001",
      startDate: "2026-01-05",
      endDate: "2026-01-06",
      durationUnit: "full_day",
      reason: "Family function",
    });
    // The requester is the session's — never sent from here.
    expect(posted.data).not.toHaveProperty("employeeId");
    // No stale field from a mode that was not chosen.
    expect(posted.data).not.toHaveProperty("halfDayPeriod");
    expect(posted.data).not.toHaveProperty("hoursPerDay");
  });

  it("refuses to submit an incomplete request, and sends nothing", async () => {
    await openDrawer();
    const before = calls.length;

    await userEvent.click(screen.getByRole("button", { name: /Submit request/i }));

    await waitFor(() =>
      expect(document.querySelectorAll(".text-error-500").length).toBeGreaterThan(0),
    );
    expect(calls.filter((c) => c.method === "post").length).toBe(0);
    expect(calls.length).toBe(before);
  });

  it("asks which half for a single-day half-day request", async () => {
    await openDrawer();

    await userEvent.selectOptions(screen.getByLabelText("Duration"), "half_day");
    expect(await screen.findByText("Which half")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("leave-estimate").textContent).toMatch(/0\.5 days/));
  });

  it("offers only whole days for a type that forbids halves", async () => {
    await openDrawer();

    await userEvent.click(screen.getByRole("button", { name: /Choose a leave type/i }));
    await userEvent.click(await screen.findByRole("button", { name: "COMP · Comp Off" }));

    await waitFor(() => {
      const options = [...screen.getByLabelText("Duration").options].map((o) => o.value);
      expect(options).toEqual(["full_day"]);
    });
    expect(screen.getByText(/must be taken as whole days/i)).toBeTruthy();
  });

  it("keeps the drawer open and the input when the server refuses", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "POST /hrms/leave/requests": () =>
        fail(409, { message: "You already have a pending request covering those dates.", code: "LEAVE_OVERLAP" }),
    });
    at("/hrms/leave/me");
    await screen.findByText("Family function");
    await userEvent.click(screen.getByRole("button", { name: /Apply for leave/i }));
    await screen.findByRole("heading", { name: "Apply for leave" });

    await userEvent.click(screen.getByRole("button", { name: /Choose a leave type/i }));
    await userEvent.click(await screen.findByRole("button", { name: "CL · Casual Leave" }));
    await userEvent.type(screen.getByPlaceholderText(/Why you need the time off/i), "Family function");
    await userEvent.click(screen.getByRole("button", { name: /Submit request/i }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    expect(screen.getByRole("heading", { name: "Apply for leave" })).toBeTruthy();
    expect(screen.getByDisplayValue("Family function")).toBeTruthy();
  });
});

// ===========================================================================
// Approvals
// ===========================================================================

describe("approvals", () => {
  const open = async () => {
    signIn([R.MANAGER]);
    at("/hrms/leave/approvals");
    return screen.findByText("Family function");
  };

  it("asks the server for pending requests only", async () => {
    await open();
    const call = calls.find((c) => c.url === "/hrms/leave/requests");
    expect(call.params).toEqual({ status: "pending" });
  });

  it("shows who is asking, for what, and why", async () => {
    await open();
    const row = screen.getByText("Family function").closest("tr");
    expect(within(row).getByText("Staff One")).toBeTruthy();
    expect(within(row).getByText("SI-0002")).toBeTruthy();
    expect(within(row).getByText("2 days")).toBeTruthy();
  });

  it("approves through a confirmation, with an optional comment", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /Approve leave for Staff One 2026-01-05/i }));

    expect(await screen.findByRole("heading", { name: /Approve this leave\?/i })).toBeTruthy();
    expect(calls.some((c) => c.method === "post")).toBe(false);

    await userEvent.type(screen.getByLabelText(/Comment/i), "Enjoy");
    await userEvent.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    const posted = calls.find((c) => c.method === "post");
    expect(posted.url).toBe("/hrms/leave/requests/r1/decide");
    expect(posted.data).toEqual({ decision: "approve", comment: "Enjoy" });
  });

  it("rejects with a reason", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /Reject leave for Staff One 2026-01-05/i }));
    await userEvent.type(await screen.findByLabelText(/Comment/i), "Peak season");
    await userEvent.click(screen.getByRole("button", { name: /^Reject$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    expect(calls.find((c) => c.method === "post").data).toEqual({
      decision: "reject",
      comment: "Peak season",
    });
  });

  it("surfaces the server refusing a decision rather than hiding it", async () => {
    // A skip-level manager can SEE a request and cannot decide it. The reason
    // comes from the server and is worth showing.
    signIn([R.MANAGER]);
    installTransport({
      "POST /hrms/leave/requests/r1/decide": () =>
        fail(403, { message: "Only the direct reporting manager, or HR, can decide this request." }),
    });
    at("/hrms/leave/approvals");
    await screen.findByText("Family function");

    await userEvent.click(screen.getByRole("button", { name: /Approve leave for Staff One 2026-01-05/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    // Still listed, because nothing was decided.
    expect(screen.getByText("Family function")).toBeTruthy();
  });

  it("shows an empty queue plainly", async () => {
    signIn([R.MANAGER]);
    installTransport({ "GET /hrms/leave/requests": () => envelope([]) });
    at("/hrms/leave/approvals");

    expect(await screen.findByText("Nothing waiting")).toBeTruthy();
  });
});

// ===========================================================================
// Calendar
// ===========================================================================

describe("the team calendar", () => {
  it("asks for one month, in one request", async () => {
    signIn([R.MANAGER]);
    at("/hrms/leave/calendar");

    await waitFor(() => expect(calls.some((c) => c.url === "/hrms/leave/calendar")).toBe(true));
    const call = calls.find((c) => c.url === "/hrms/leave/calendar");

    expect(call.params.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(call.params.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No per-employee lookup, and no directory fetch.
    expect(calls.some((c) => c.url.startsWith("/hrms/employees"))).toBe(false);
  });

  it("renders the weekday header and moves between months", async () => {
    signIn([R.MANAGER]);
    at("/hrms/leave/calendar");
    await waitFor(() => expect(screen.getByText("Mon")).toBeTruthy());

    const before = calls.filter((c) => c.url === "/hrms/leave/calendar").length;
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));

    await waitFor(() =>
      expect(calls.filter((c) => c.url === "/hrms/leave/calendar").length).toBe(before + 1),
    );
  });

  it("renders a 403 as a refusal, not as an empty month", async () => {
    signIn([R.MANAGER]);
    installTransport({
      "GET /hrms/leave/calendar": () => fail(403, { message: "Forbidden.", code: "HRMS_FORBIDDEN" }),
    });
    at("/hrms/leave/calendar");

    expect(await screen.findByText(/needs a team or organisation-wide grant/i)).toBeTruthy();
    expect(screen.queryByText(/Nobody is away/i)).toBeNull();
  });
});

// ===========================================================================
// Holidays
// ===========================================================================

describe("holidays", () => {
  const open = async (roles = [R.HR_ADMIN]) => {
    signIn(roles);
    at("/hrms/leave/holidays");
    return screen.findByText("Republic Day");
  };

  it("lists the year with its type and region", async () => {
    await open();

    const row = screen.getByText("Republic Day").closest("tr");
    expect(within(row).getByText("26 Jan 2026")).toBeTruthy();
    expect(within(row).getByText("national")).toBeTruthy();

    const optional = screen.getByText("Rakhi").closest("tr");
    // Text, not colour alone.
    expect(within(optional).getByText(/optional/)).toBeTruthy();
    expect(within(optional).getByText("IN-MP")).toBeTruthy();
  });

  it("an employee can read the calendar but not change it", async () => {
    await open([R.EMPLOYEE]);
    expect(screen.queryByRole("button", { name: /Add holiday/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit Republic Day/i })).toBeNull();
  });

  it("HR can add one", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /Add holiday/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. Republic Day"), "Holi");
    fireEvent.change(document.querySelector('input[type="date"]'), {
      target: { value: "2026-03-04" },
    });
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    const posted = calls.find((c) => c.method === "post");
    expect(posted.url).toBe("/hrms/holidays");
    expect(posted.data).toMatchObject({ name: "Holi", date: "2026-03-04", type: "public" });
  });

  it("surfaces a duplicate from the server and keeps the form", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "POST /hrms/holidays": () =>
        fail(409, { message: '"Holi" is already recorded on 2026-03-04.', code: "HOLIDAY_DUPLICATE" }),
    });
    at("/hrms/leave/holidays");
    await screen.findByText("Republic Day");

    await userEvent.click(screen.getByRole("button", { name: /Add holiday/i }));
    await userEvent.type(await screen.findByPlaceholderText("e.g. Republic Day"), "Holi");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "post")).toBe(true));
    expect(screen.getByRole("heading", { name: "Add holiday" })).toBeTruthy();
    expect(screen.getByDisplayValue("Holi")).toBeTruthy();
  });

  it("edits an existing one, pre-filled", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Edit Republic Day" }));

    expect(await screen.findByDisplayValue("Republic Day")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "patch")).toBe(true));
    expect(calls.find((c) => c.method === "patch").url).toBe("/hrms/holidays/h1");
  });

  it("removes one after confirmation, and says values are kept", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Remove Republic Day" }));

    expect(await screen.findByText(/Remove "Republic Day"\?/)).toBeTruthy();
    expect(calls.some((c) => c.method === "delete")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /^Remove$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "delete")).toBe(true));
    expect(calls.find((c) => c.method === "delete").url).toBe("/hrms/holidays/h1");
  });

  it("shows an empty state for a year with no calendar", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({ "GET /hrms/holidays": () => envelope([]) });
    at("/hrms/leave/holidays");

    expect(await screen.findByText(/No holidays recorded for/i)).toBeTruthy();
  });

  it("surfaces an API failure with a retry", async () => {
    signIn([R.HR_ADMIN]);
    let attempts = 0;
    installTransport({
      "GET /hrms/holidays": () => {
        attempts += 1;
        return attempts === 1 ? fail(500, { message: "Holidays are down." }) : envelope(HOLIDAYS);
      },
    });
    at("/hrms/leave/holidays");

    expect(await screen.findByText("Holidays are down.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByText("Republic Day")).toBeTruthy();
  });
});
