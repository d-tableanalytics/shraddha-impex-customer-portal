/**
 * The HRMS dashboard — layout, permission-shaped content, and its states.
 *
 * Only the axios instance is mocked. The HRMS client, the shared catalogue and
 * the shared permission matrix are all real, so these cover the request URLs,
 * the `{ success, data }` unwrapping and the role behaviour as well as the
 * rendering.
 *
 * The dashboard NEVER filters for authorization — the server sends a role its
 * own payload — so these assert that the page renders what it is given and
 * hides a card when the server sends nothing, which is the actual contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../services/api";
import { HrmsDashboard } from "./HrmsDashboard";
import { useHrmsStore } from "../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WIDGETS = {
  viewer: { firstName: "Meera", fullName: "Meera Rao", employeeCode: "DSH001" },
  upcomingHolidays: [
    { id: "h1", name: "Diwali", date: "2026-11-08", type: "public", isOptional: false, region: null },
    { id: "h2", name: "Founders Day", date: "2026-11-20", type: "optional", isOptional: true, region: null },
  ],
  announcements: [
    {
      id: "a1",
      title: "Office closed Friday",
      body: "The building is shut for maintenance.",
      publishedAt: "2026-09-01T09:00:00.000Z",
      createdByName: "Hema Rao",
    },
  ],
  polls: [
    { id: "p1", question: "Which day suits the offsite?", kind: "single", closesAt: null, hasResponded: false },
  ],
  onLeaveToday: [{ employeeId: "e9", name: "Sunil Patel", leaveTypeCode: "CL" }],
  mobileClockInsToday: [
    { employeeId: "e8", name: "Asha Nair", clockedInAt: "2026-09-04T04:05:00.000Z" },
  ],
  birthdays: [{ employeeId: "e7", name: "Ravi Kumar", daysUntil: 0 }],
  anniversaries: [{ employeeId: "e6", name: "Priya Shah", yearsCount: 5, daysUntil: 2 }],
  quickAccess: [
    { key: "clock", label: "Clock In / Out", icon: "Clock", path: "/attendance/me", tone: "primary" },
    { key: "applyLeave", label: "Apply for Leave", icon: "CalendarDays", path: "/leave/me", tone: "success" },
  ],
  scope: { team: true, org: true, audit: true },
};

const SUMMARY = {
  role: "org",
  kpis: [
    { key: "total", label: "Total headcount", value: 128, tone: "neutral", href: "/employees" },
    { key: "active", label: "Active", value: 120, tone: "positive", href: "/employees?status=active" },
  ],
  pendingActions: [
    { key: "leave", label: "Leave requests", value: 3, tone: "warning", href: "/leave/approvals" },
    { key: "attendance-corrections", label: "Attendance corrections", value: 0, tone: "neutral", href: "/attendance/corrections" },
  ],
  newHires: [{ employeeId: "e1", name: "Nikhil Rao", department: "Engineering", effectiveOn: "2026-08-20" }],
  exits: [{ employeeId: "e2", name: "Farah Khan", department: "Sales", effectiveOn: "2026-08-25" }],
  loginTrend: [
    { date: "2026-08-29", logins: 4 },
    { date: "2026-08-30", logins: 9 },
    { date: "2026-08-31", logins: 0 },
  ],
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let calls = [];
const envelope = (payload) => ({ data: { success: true, data: payload } });

function installTransport(overrides = {}) {
  calls = [];
  api.request.mockImplementation(async (config) => {
    calls.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (overrides[key]) return overrides[key](config);

    if (key === "GET /hrms/dashboard/widgets") return envelope(WIDGETS);
    if (key === "GET /hrms/dashboard/summary") return envelope(SUMMARY);

    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.LEAVE, M.ATTENDANCE, M.ENGAGE],
    loaded: true,
    loading: false,
    error: null,
  });

const at = () =>
  render(
    <MemoryRouter initialEntries={["/hrms/dashboard"]}>
      <Routes>
        <Route path="/hrms/dashboard" element={<HrmsDashboard />} />
      </Routes>
    </MemoryRouter>,
  );

const lastCall = (url) => [...calls].reverse().find((c) => c.url === url);

beforeEach(() => {
  vi.clearAllMocks();
  installTransport();
  signIn([R.HR_ADMIN]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================

describe("the hero", () => {
  it("greets by the name the SERVER resolved", async () => {
    at();
    expect(await screen.findByText("Hi, Meera")).toBeTruthy();
  });

  it("falls back to a neutral welcome when the actor has no employee record", async () => {
    installTransport({
      "GET /hrms/dashboard/widgets": async () =>
        envelope({ ...WIDGETS, viewer: null }),
    });
    at();
    expect(await screen.findByText("Welcome back")).toBeTruthy();
  });

  it("greets by time of day, on the reference's thresholds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 4, 9, 0, 0));
    at();
    await vi.waitFor(() => expect(screen.getByText("Good morning")).toBeTruthy());
  });
});

// ===========================================================================

describe("data loading", () => {
  it("issues exactly two reads, in parallel", async () => {
    at();
    await screen.findByText("Hi, Meera");

    const dashboardCalls = calls.filter((c) => c.url.startsWith("/hrms/dashboard"));
    expect(dashboardCalls).toHaveLength(2);
    expect(lastCall("/hrms/dashboard/widgets")).toBeTruthy();
    expect(lastCall("/hrms/dashboard/summary")).toBeTruthy();
  });

  it("shows skeletons before the data lands, not a blank page", async () => {
    let release;
    installTransport({
      "GET /hrms/dashboard/widgets": () => new Promise((r) => { release = () => r(envelope(WIDGETS)); }),
    });
    const { container } = at();

    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    release();
    await screen.findByText("Quick access");
  });

  it("surfaces a failure with a retry rather than an empty dashboard", async () => {
    installTransport({
      "GET /hrms/dashboard/widgets": async () => {
        const error = new Error("Dashboard is unavailable.");
        error.response = { status: 500, data: { success: false, message: "Dashboard is unavailable." } };
        throw error;
      },
    });
    at();
    expect(await screen.findByText(/Dashboard is unavailable/)).toBeTruthy();
  });
});

// ===========================================================================

describe("quick access", () => {
  it("renders what the server sent, and links to real routes", async () => {
    at();
    const clock = await screen.findByRole("link", { name: /Clock In \/ Out/ });
    expect(clock.getAttribute("href")).toBe("/hrms/attendance/me");
    expect(screen.getByRole("link", { name: /Apply for Leave/ }).getAttribute("href")).toBe(
      "/hrms/leave/me",
    );
  });

  it("shows only the tiles the server returned — the client never adds any", async () => {
    installTransport({
      "GET /hrms/dashboard/widgets": async () =>
        envelope({
          ...WIDGETS,
          quickAccess: [
            { key: "clock", label: "Clock In / Out", icon: "Clock", path: "/attendance/me", tone: "primary" },
          ],
        }),
    });
    at();

    await screen.findByRole("link", { name: /Clock In \/ Out/ });
    expect(screen.queryByRole("link", { name: /Run Payroll/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Settings/ })).toBeNull();
  });

  it("does not crash on an icon name it does not know", async () => {
    installTransport({
      "GET /hrms/dashboard/widgets": async () =>
        envelope({
          ...WIDGETS,
          quickAccess: [
            { key: "x", label: "Something New", icon: "NotARealIcon", path: "/leave/me", tone: "primary" },
          ],
        }),
    });
    at();
    expect(await screen.findByRole("link", { name: /Something New/ })).toBeTruthy();
  });
});

// ===========================================================================

describe("operational widgets", () => {
  it("renders holidays, announcements and polls", async () => {
    at();

    expect(await screen.findByText("Diwali")).toBeTruthy();
    expect(screen.getByText("Optional")).toBeTruthy();
    expect(screen.getByText("Office closed Friday")).toBeTruthy();
    expect(screen.getByText("Which day suits the offsite?")).toBeTruthy();
    expect(screen.getByText("Awaiting your answer")).toBeTruthy();
  });

  it("renders celebrations, soonest first, with the right wording", async () => {
    at();

    await screen.findByText("Ravi Kumar");
    expect(screen.getByText("Birthday · Today")).toBeTruthy();
    expect(screen.getByText("5 years · in 2 days")).toBeTruthy();
  });

  it("🔴 names the mobile card for what it measures, not 'Working Remotely'", async () => {
    at();
    expect(await screen.findByText("Clocked in from mobile")).toBeTruthy();
    expect(screen.queryByText(/Working Remotely/i)).toBeNull();
  });

  it("hides the team cards entirely when the server says there is no team scope", async () => {
    installTransport({
      "GET /hrms/dashboard/widgets": async () =>
        envelope({
          ...WIDGETS,
          onLeaveToday: [],
          mobileClockInsToday: [],
          scope: { team: false, org: false, audit: false },
        }),
      "GET /hrms/dashboard/summary": async () => envelope({ role: "self" }),
    });
    at();

    await screen.findByText("Quick access");
    expect(screen.queryByText("On leave today")).toBeNull();
    expect(screen.queryByText("Clocked in from mobile")).toBeNull();
    // Celebrations stay — they are org-wide for everyone by design.
    expect(screen.getByText("Celebrations")).toBeTruthy();
  });

  it("shows a per-widget empty state rather than a blank card", async () => {
    installTransport({
      "GET /hrms/dashboard/widgets": async () =>
        envelope({ ...WIDGETS, upcomingHolidays: [], announcements: [] }),
    });
    at();

    expect(await screen.findByText("No holidays ahead")).toBeTruthy();
    expect(screen.getByText("Nothing right now")).toBeTruthy();
    // Its neighbours still render — the server settles each widget alone.
    expect(screen.getByText("Which day suits the offsite?")).toBeTruthy();
  });
});

// ===========================================================================

describe("role-shaped content", () => {
  it("an HR payload renders metrics, pending actions, hires and exits", async () => {
    at();

    expect(await screen.findByText("Total headcount")).toBeTruthy();
    expect(screen.getByText("128")).toBeTruthy();
    expect(screen.getByText("Nikhil Rao")).toBeTruthy();
    expect(screen.getByText("Farah Khan")).toBeTruthy();

    const pending = screen.getByText("Leave requests").closest("a");
    expect(pending.getAttribute("href")).toBe("/hrms/leave/approvals");
  });

  it("a self payload renders no workforce figures at all", async () => {
    installTransport({
      "GET /hrms/dashboard/widgets": async () =>
        envelope({ ...WIDGETS, scope: { team: false, org: false, audit: false } }),
      "GET /hrms/dashboard/summary": async () => envelope({ role: "self" }),
    });
    at();

    await screen.findByText("Quick access");
    expect(screen.queryByText("Key metrics")).toBeNull();
    expect(screen.queryByText("Total headcount")).toBeNull();
    expect(screen.queryByText("New hires")).toBeNull();
    expect(screen.queryByText("Login activity")).toBeNull();
  });

  it("a manager payload renders their own team and no org headcount", async () => {
    installTransport({
      "GET /hrms/dashboard/widgets": async () =>
        envelope({ ...WIDGETS, scope: { team: true, org: false, audit: false } }),
      "GET /hrms/dashboard/summary": async () =>
        envelope({
          role: "team",
          team: { directReports: 6, onLeaveToday: 1, pendingApprovals: 2 },
          pendingActions: [
            { key: "leave", label: "Leave requests", value: 2, tone: "warning", href: "/leave/approvals" },
          ],
        }),
    });
    at();

    expect(await screen.findByText("Your team")).toBeTruthy();
    expect(screen.getByText("Direct reports")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.queryByText("Key metrics")).toBeNull();
    expect(screen.queryByText("New hires")).toBeNull();
  });
});

// ===========================================================================

describe("login activity", () => {
  it("renders the chart and switches range through the server", async () => {
    const user = userEvent.setup();
    at();

    await screen.findByText("Login activity");
    // 4 + 9 + 0
    expect(screen.getByText("13")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "30d" }));
    await waitFor(() => {
      expect(lastCall("/hrms/dashboard/summary").params.range).toBe("30d");
    });
  });

  it("🔴 is not rendered at all without the audit grant", async () => {
    installTransport({
      "GET /hrms/dashboard/widgets": async () =>
        envelope({ ...WIDGETS, scope: { team: true, org: true, audit: false } }),
      "GET /hrms/dashboard/summary": async () => envelope({ ...SUMMARY, loginTrend: [] }),
    });
    at();

    await screen.findByText("Total headcount");
    expect(screen.queryByText("Login activity")).toBeNull();
    // The rest of the HR dashboard is unaffected.
    expect(screen.getByText("Pending actions")).toBeTruthy();
  });
});
