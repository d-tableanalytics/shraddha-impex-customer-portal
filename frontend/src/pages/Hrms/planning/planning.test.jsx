/**
 * Planning — the page shell, tab gating, and both tabs' workflows.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these cover the request
 * URLs, the `{ success, data }` unwrapping, the permission gating and the form
 * validation as well as the rendering.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { PlanningPage } from "./PlanningPage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const headcountPlan = (over = {}) => ({
  id: "h1",
  financialYear: "FY2026",
  departmentId: "507f1f77bcf86cd799439011",
  departmentName: "ENG Department",
  orgWide: false,
  plannedHeadcount: 10,
  actualHeadcount: 7,
  budgetPerHead: 1200000,
  totalBudget: 12000000,
  notes: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  ...over,
});

const HEADCOUNT = {
  data: [
    headcountPlan(),
    headcountPlan({
      id: "h2",
      departmentId: null,
      departmentName: null,
      orgWide: true,
      plannedHeadcount: 40,
      actualHeadcount: 44,
      budgetPerHead: null,
      totalBudget: null,
    }),
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

/**
 * Deliberately NOT the sum of the two rows above: the year has more plans than
 * this page shows. A client-side reduce would produce 50 and ₹1,20,00,000, so
 * these values only appear if the tiles come from the server.
 */
const SUMMARY = {
  financialYear: "FY2026",
  planCount: 3,
  plannedHeadcount: 55,
  actualHeadcount: 48,
  totalBudget: 13200000,
};

const hiringPlan = (over = {}) => ({
  id: "p1",
  role: "Senior Backend Engineer",
  plannedByDate: "2026-06-30",
  actualByDate: null,
  status: "planned",
  statusLabel: "Planned",
  overdue: false,
  departmentId: "507f1f77bcf86cd799439011",
  departmentName: "ENG Department",
  requisitionId: null,
  requisitionTitle: null,
  notes: null,
  allowedTransitions: ["in_progress", "delayed", "cancelled"],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  ...over,
});

const HIRING = {
  data: [
    hiringPlan(),
    hiringPlan({
      id: "p2",
      role: "Finance Analyst",
      status: "completed",
      statusLabel: "Completed",
      actualByDate: "2026-05-20",
      allowedTransitions: [],
    }),
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const DEPARTMENTS = [{ id: "507f1f77bcf86cd799439011", code: "ENG", name: "ENG Department" }];

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

    if (key === "GET /hrms/planning/headcount") return envelope(HEADCOUNT);
    if (key === "GET /hrms/planning/headcount/summary") return envelope(SUMMARY);
    if (key === "GET /hrms/planning/headcount/years") return envelope(["FY2026", "FY2025"]);
    if (key === "GET /hrms/planning/hiring") return envelope(HIRING);
    if (key === "GET /hrms/planning/hiring/summary")
      return envelope({ total: 2, byStatus: {}, overdue: 0 });
    if (key === "GET /hrms/org/departments") return envelope(DEPARTMENTS);
    if (key === "GET /hrms/hiring/requisitions")
      return envelope({ data: [], total: 0, page: 1, pageSize: 100 });

    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: [M.DASHBOARD, M.PLANNING],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/planning" element={<PlanningPage />} />
        <Route path="/hrms/planning/:tab" element={<PlanningPage />} />
      </Routes>
    </MemoryRouter>,
  );

/** The overlay a Drawer portals into, found by its heading. */
const panelTitled = (title) => {
  const panel = screen
    .getAllByRole("heading", { name: title })
    .map((h) => h.closest("div.fixed"))
    .find(Boolean);
  if (!panel) throw new Error(`No open panel titled ${title}`);
  return panel;
};

const calledWith = (method, url) =>
  calls.find((c) => c.method.toUpperCase() === method && c.url === url);

beforeEach(() => {
  vi.clearAllMocks();
  installTransport();
  signIn([R.HR_ADMIN]);
});

// ===========================================================================

describe("PlanningPage", () => {
  it("shows both tabs and the reference's own subtitle", async () => {
    at("/hrms/planning/headcount");

    expect(await screen.findByRole("heading", { name: "Planning" })).toBeTruthy();
    expect(
      screen.getByText(
        "Headcount forecasting per department, budgeting, and hiring plans vs pipeline.",
      ),
    ).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Headcount", "Hiring Plan"]);
  });

  it("puts the tab in the URL, so a tab is linkable — the reference keeps it in state", async () => {
    at("/hrms/planning/hiring");

    // The hiring list loads, not the headcount one.
    await waitFor(() => expect(calledWith("GET", "/hrms/planning/hiring")).toBeTruthy());
    expect(calledWith("GET", "/hrms/planning/headcount")).toBeFalsy();
  });
});

// ===========================================================================

describe("Headcount tab", () => {
  it("renders a department plan and labels a null department Org-wide", async () => {
    at("/hrms/planning/headcount");

    expect(await screen.findByText("ENG Department")).toBeTruthy();
    // 🔴 The reference's own label for a plan with no department — which it
    // then hardcodes to zero actual headcount.
    expect(screen.getByText("Org-wide")).toBeTruthy();
  });

  it("renders the three summary tiles from the SERVER's totals", async () => {
    at("/hrms/planning/headcount");

    await screen.findByText("ENG Department");
    // Neither figure is derivable from the two visible rows — see the fixture.
    expect(screen.getByText("55")).toBeTruthy();
    // ₹1,32,00,000 — Indian grouping, no decimals, as the reference renders it.
    expect(screen.getByText("₹1,32,00,000")).toBeTruthy();

    // Summed server-side over the whole year, not reduced over the page.
    expect(calledWith("GET", "/hrms/planning/headcount/summary")).toBeTruthy();
  });

  it("shows utilization as a progress bar, over 100% included", async () => {
    at("/hrms/planning/headcount");

    await screen.findByText("ENG Department");
    const bars = screen.getAllByRole("progressbar");
    // 7 of 10, 44 of 40, and the Actual Headcount tile's own bar.
    expect(bars.some((b) => b.getAttribute("aria-label") === "7 of 10 planned")).toBe(true);
    expect(bars.some((b) => b.getAttribute("aria-label") === "44 of 40 planned")).toBe(true);
  });

  it("filters by a financial year the server offers, not free text", async () => {
    at("/hrms/planning/headcount");

    await screen.findByText("ENG Department");
    expect(calledWith("GET", "/hrms/planning/headcount/years")).toBeTruthy();

    const request = calls.find((c) => c.url === "/hrms/planning/headcount");
    expect(request.params.financialYear).toMatch(/^FY\d{4}$/);
  });

  it("creates a plan through the shared schema", async () => {
    const user = userEvent.setup();
    const created = vi.fn(async () => envelope(headcountPlan({ id: "h3" })));
    installTransport({ "POST /hrms/planning/headcount": created });

    at("/hrms/planning/headcount");
    await screen.findByText("ENG Department");

    await user.click(screen.getByRole("button", { name: /New plan/i }));
    const panel = panelTitled("New headcount plan");

    await user.clear(within(panel).getByLabelText("Financial year"));
    await user.type(within(panel).getByLabelText("Financial year"), "FY2027");
    await user.type(within(panel).getByLabelText("Planned headcount"), "12");
    await user.type(within(panel).getByLabelText("Budget per head"), "1500000");
    await user.click(within(panel).getByRole("button", { name: "Create plan" }));

    await waitFor(() => expect(created).toHaveBeenCalled());
    const body = created.mock.calls[0][0].data;
    expect(body.financialYear).toBe("FY2027");
    expect(body.plannedHeadcount).toBe(12);
    // Money leaves as a STRING, so no precision is lost before Decimal128.
    expect(body.budgetPerHead).toBe("1500000");
    expect(body.departmentId).toBe(null);
  });

  it("refuses a malformed financial year in the form, using the server's own rule", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    installTransport({ "POST /hrms/planning/headcount": created });

    at("/hrms/planning/headcount");
    await screen.findByText("ENG Department");

    await user.click(screen.getByRole("button", { name: /New plan/i }));
    const panel = panelTitled("New headcount plan");

    await user.clear(within(panel).getByLabelText("Financial year"));
    await user.type(within(panel).getByLabelText("Financial year"), "next year");
    await user.type(within(panel).getByLabelText("Planned headcount"), "12");
    await user.click(within(panel).getByRole("button", { name: "Create plan" }));

    expect(await within(panel).findByRole("alert")).toBeTruthy();
    expect(created).not.toHaveBeenCalled();
  });

  it("🔴 a plan can be corrected — the reference offers no way to edit one", async () => {
    const user = userEvent.setup();
    const updated = vi.fn(async () => envelope(headcountPlan({ plannedHeadcount: 14 })));
    installTransport({ "PATCH /hrms/planning/headcount/h1": updated });

    at("/hrms/planning/headcount");
    await screen.findByText("ENG Department");

    await user.click(screen.getByRole("button", { name: /Edit the plan for ENG Department/i }));
    const panel = panelTitled("Edit headcount plan");

    await user.clear(within(panel).getByLabelText("Planned headcount"));
    await user.type(within(panel).getByLabelText("Planned headcount"), "14");
    await user.click(within(panel).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updated).toHaveBeenCalled());
    expect(updated.mock.calls[0][0].data.plannedHeadcount).toBe(14);
  });

  it("a read-only planner sees the table and no write controls", async () => {
    // Nobody in the baseline matrix holds view without edit, so the actor is
    // built with the read grant alone to prove the UI gates on the permission
    // rather than on the role.
    useHrmsStore.setState({
      actor: {
        ...buildHrmsActor({ userId: "u1", roles: [R.HR_ADMIN], employee: { id: "e1" } }),
        permissions: [{ module: M.PLANNING, action: "view", scope: "org" }],
      },
      implementedModules: [M.DASHBOARD, M.PLANNING],
      loaded: true,
      loading: false,
      error: null,
    });

    at("/hrms/planning/headcount");

    await screen.findByText("ENG Department");
    expect(screen.queryByRole("button", { name: /New plan/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit the plan/i })).toBeNull();
  });
});

// ===========================================================================

describe("Hiring Plan tab", () => {
  it("renders the role, both dates and the status", async () => {
    at("/hrms/planning/hiring");

    const row = (await screen.findByText("Senior Backend Engineer")).closest("tr");
    expect(within(row).getByText("30 Jun 2026")).toBeTruthy();
    // Nothing has been filled yet, so the actual date is the em dash.
    expect(within(row).getByText("—")).toBeTruthy();
    expect(within(row).getByText("Planned")).toBeTruthy();

    const done = screen.getByText("Finance Analyst").closest("tr");
    // 🔴 An actual date the reference has a column for and can never fill.
    expect(within(done).getByText("20 May 2026")).toBeTruthy();
    expect(within(done).getByText("Completed")).toBeTruthy();
  });

  it("offers only the moves the SERVER says are legal", async () => {
    const user = userEvent.setup();
    at("/hrms/planning/hiring");

    await screen.findByText("Senior Backend Engineer");
    // The completed plan has no transitions left, so it gets no controls.
    expect(screen.getAllByRole("button", { name: "Move" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Move" }));
    const panel = panelTitled("Move Senior Backend Engineer");

    await user.click(within(panel).getByRole("button", { name: /Pick a status/i }));
    expect(within(panel).getByRole("button", { name: "In progress" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Delayed" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Cancelled" })).toBeTruthy();
    // planned -> completed is not a legal move, so it is not offered.
    expect(within(panel).queryByRole("button", { name: "Completed" })).toBeNull();
  });

  it("moves a plan, and asks for the filled-on date only when completing", async () => {
    const user = userEvent.setup();
    const moved = vi.fn(async () => envelope(hiringPlan({ status: "in_progress" })));
    installTransport({ "PATCH /hrms/planning/hiring/p1/status": moved });

    at("/hrms/planning/hiring");
    await screen.findByText("Senior Backend Engineer");

    await user.click(screen.getByRole("button", { name: "Move" }));
    const panel = panelTitled("Move Senior Backend Engineer");

    await user.click(within(panel).getByRole("button", { name: /Pick a status/i }));
    await user.click(within(panel).getByRole("button", { name: "In progress" }));

    // Not completing, so there is nothing to date.
    expect(within(panel).queryByLabelText("Filled on")).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Move plan" }));

    await waitFor(() => expect(moved).toHaveBeenCalled());
    expect(moved.mock.calls[0][0].data.status).toBe("in_progress");
  });

  it("creates a hiring plan with a DAY, not an instant", async () => {
    const user = userEvent.setup();
    const created = vi.fn(async () => envelope(hiringPlan({ id: "p3" })));
    installTransport({ "POST /hrms/planning/hiring": created });

    at("/hrms/planning/hiring");
    await screen.findByText("Senior Backend Engineer");

    await user.click(screen.getByRole("button", { name: /New hiring plan/i }));
    const panel = panelTitled("New hiring plan");

    await user.type(within(panel).getByLabelText("Role"), "Data Engineer");
    await user.type(within(panel).getByLabelText("Planned by"), "2026-09-30");
    await user.click(within(panel).getByRole("button", { name: "Create plan" }));

    await waitFor(() => expect(created).toHaveBeenCalled());
    const body = created.mock.calls[0][0].data;
    expect(body.role).toBe("Data Engineer");
    // 🔴 A day. The reference sends an ISO datetime into a SQL Date column.
    expect(body.plannedByDate).toBe("2026-09-30");
  });

  it("filters by status server-side", async () => {
    const user = userEvent.setup();
    at("/hrms/planning/hiring");

    await screen.findByText("Senior Backend Engineer");

    await user.click(screen.getByRole("button", { name: /All statuses/i }));
    await user.click(screen.getByRole("button", { name: "Delayed" }));

    await waitFor(() => {
      const request = [...calls].reverse().find((c) => c.url === "/hrms/planning/hiring");
      expect(request.params.status).toBe("delayed");
    });
  });

  it("surfaces a server refusal rather than swallowing it", async () => {
    const user = userEvent.setup();
    installTransport({
      "PATCH /hrms/planning/hiring/p1/status": async () => {
        const error = new Error("A planned plan cannot become completed.");
        error.response = {
          status: 409,
          data: { success: false, message: "A planned plan cannot become completed.", code: "HRMS_CONFLICT" },
        };
        throw error;
      },
    });

    at("/hrms/planning/hiring");
    await screen.findByText("Senior Backend Engineer");

    await user.click(screen.getByRole("button", { name: "Move" }));
    const panel = panelTitled("Move Senior Backend Engineer");

    await user.click(within(panel).getByRole("button", { name: /Pick a status/i }));
    await user.click(within(panel).getByRole("button", { name: "In progress" }));
    await user.click(within(panel).getByRole("button", { name: "Move plan" }));

    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toContain("cannot become completed");
  });

  it("a read-only planner sees no Move or Edit control", async () => {
    useHrmsStore.setState({
      actor: {
        ...buildHrmsActor({ userId: "u1", roles: [R.HR_ADMIN], employee: { id: "e1" } }),
        permissions: [{ module: M.PLANNING, action: "view", scope: "org" }],
      },
      implementedModules: [M.DASHBOARD, M.PLANNING],
      loaded: true,
      loading: false,
      error: null,
    });

    at("/hrms/planning/hiring");

    await screen.findByText("Senior Backend Engineer");
    expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New hiring plan/i })).toBeNull();
  });
});
