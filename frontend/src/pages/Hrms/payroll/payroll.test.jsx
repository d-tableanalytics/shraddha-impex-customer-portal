/**
 * Payroll — the page shell, tab gating, and each tab's rendering.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these cover the request
 * URLs, the `{ success, data }` unwrapping and the permission gating as well as
 * the rendering.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { PayrollPage } from "./PayrollPage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAYSLIP = {
  id: "ps1",
  runId: "run1",
  employeeId: "e1",
  month: 6,
  year: 2026,
  gross: 42000,
  netPay: 38400,
  totalDeductions: 3600,
  employerContributions: 3600,
  lopDays: 0,
  lines: [
    { componentCode: "BASIC", componentName: "Basic", type: "earning", amount: 30000, taxable: true },
    { componentCode: "HRA", componentName: "House Rent Allowance", type: "earning", amount: 12000, taxable: true },
    { componentCode: "PF_EE", componentName: "Provident Fund", type: "deduction", amount: 3600, taxable: false },
    { componentCode: "PF_ER", componentName: "PF (Employer)", type: "employer_contribution", amount: 3600, taxable: false },
  ],
  statutoryBreakdown: null,
  pdfKey: null,
  generatedAt: "2026-06-30T00:00:00.000Z",
};

const RUNS = {
  data: [
    {
      id: "run1",
      payGroupId: "pg1",
      payGroupName: "Main Payroll",
      month: 6,
      year: 2026,
      status: "review",
      totals: { gross: 42000, netPay: 38400, deductions: 3600, employerContributions: 3600, headcount: 1 },
      lockedAt: null,
      disbursedAt: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "run2",
      payGroupId: "pg1",
      payGroupName: "Main Payroll",
      month: 5,
      year: 2026,
      status: "disbursed",
      totals: { gross: 42000, netPay: 38400, deductions: 3600, employerContributions: 3600, headcount: 1 },
      lockedAt: "2026-05-30T00:00:00.000Z",
      disbursedAt: "2026-05-31T00:00:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const PAY_GROUPS = [
  { id: "pg1", code: "MAIN", name: "Main Payroll", legalEntityName: "Shraddha Impex Pvt Ltd", isDefault: true },
];

const COMPONENTS = [
  { id: "c1", code: "BASIC", name: "Basic", type: "earning", taxable: true, calculationType: "percent_of", formula: {}, statutoryLink: null, order: 1 },
  { id: "c2", code: "PF_EE", name: "Provident Fund", type: "deduction", taxable: false, calculationType: "statutory", formula: {}, statutoryLink: "pf", order: 10 },
];

const STRUCTURES = [
  {
    id: "st1",
    name: "Standard",
    payGroupId: "pg1",
    isDefault: true,
    components: [
      { componentId: "c1", order: 1, calculation: {}, component: COMPONENTS[0] },
      { componentId: "c2", order: 10, calculation: {}, component: COMPONENTS[1] },
    ],
  },
];

const STATUTORY = {
  id: "sc1",
  effectiveFrom: "2024-04-01",
  effectiveTo: null,
  note: null,
  config: {
    pf: { employeeRate: 0.12, employerRate: 0.12, wageCeiling: 15000, epsCap: 15000 },
    esi: { employeeRate: 0.0075, employerRate: 0.0325, grossThreshold: 21000 },
    pt: { MP: [{ maxMonthlyWage: null, tax: 208 }] },
    lwf: { MP: { periodicity: "monthly", employee: 10, employer: 30 } },
    tds: { regime: "new", old: { slabs: [], standardDeduction: 50000, chapter6AMax: 150000, hraExemption: true }, new: { slabs: [], standardDeduction: 75000 }, cess: 0.04 },
  },
  coveredStates: { pt: ["MP"], lwf: ["MP"] },
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let calls = [];
const envelope = (payload) => ({ data: { success: true, data: payload } });
const fail = (status, body) => Promise.reject({ response: { status, data: body } });

function installTransport(overrides = {}) {
  calls = [];
  api.request.mockImplementation(async (config) => {
    calls.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (overrides[key]) return overrides[key](config);

    if (key === "GET /hrms/payroll/payslips/mine") {
      return envelope({ data: [PAYSLIP], total: 1, page: 1, pageSize: 15 });
    }
    if (key === "GET /hrms/payroll/runs") return envelope(RUNS);
    if (key === "GET /hrms/payroll/pay-groups") return envelope(PAY_GROUPS);
    if (key === "GET /hrms/payroll/components") return envelope(COMPONENTS);
    if (key === "GET /hrms/payroll/structures") return envelope(STRUCTURES);
    if (key === "GET /hrms/payroll/statutory/effective") return envelope(STATUTORY);
    if (key === "GET /hrms/payroll/statutory") return envelope([STATUTORY]);
    if (key.startsWith("POST /hrms/payroll/runs/")) {
      return envelope({ run: { ...RUNS.data[0], status: "review" }, payslipsGenerated: 1, skipped: [] });
    }
    if (key === "POST /hrms/payroll/runs") return envelope({ id: "new" });
    if (key.includes("/preview")) {
      return envelope({
        structureId: "st1",
        monthlyGross: 42000,
        monthlyNet: 38400,
        monthlyDeductions: 3600,
        employerContributions: 3600,
        lines: [{ componentCode: "BASIC", componentName: "Basic", type: "earning", monthly: 30000, annual: 360000 }],
      });
    }
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: [M.DASHBOARD, M.PAYROLL, M.PAYROLL_STRUCTURE],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/payroll" element={<PayrollPage />} />
        <Route path="/hrms/payroll/:tab" element={<PayrollPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ===========================================================================
// Shell and tab gating
// ===========================================================================

describe("the page shell", () => {
  it("renders the title and subtitle", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/overview");
    expect(await screen.findByRole("heading", { name: "Payroll" })).toBeTruthy();
    expect(screen.getByText(/Salary structures, statutory compliance/i)).toBeTruthy();
  });

  it("shows an ordinary employee only Overview and Payslips", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/overview");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Overview", "Payslips"]);
  });

  it("shows a payroll admin every tab", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/overview");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Overview",
      "Payslips",
      "Runs",
      "Structures",
      "Pay Groups",
      "Statutory",
    ]);
  });

  it("shows an HR admin no Runs tab — hr_admin cannot run payroll", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/payroll/overview");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).not.toContain("Runs");
  });

  it("does not fire an admin request for a tab the actor cannot reach", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/runs");

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    // Guarded before mounting, so the request is never made.
    expect(calls.some((c) => c.url === "/hrms/payroll/runs")).toBe(false);
  });
});

// ===========================================================================
// Overview
// ===========================================================================

describe("overview", () => {
  it("shows the caller's latest payslip", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/overview");

    expect(await screen.findByText("Jun 2026")).toBeTruthy();
    expect(screen.getByText("₹ 38,400.00")).toBeTruthy();
  });

  it("does not request company runs without the org grant", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/overview");

    await screen.findByText("Jun 2026");
    expect(calls.some((c) => c.url === "/hrms/payroll/runs")).toBe(false);
  });

  it("shows the company summary to someone who can see payroll", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/overview");

    // "Runs in progress" is both a stat label and the section heading below it.
    expect((await screen.findAllByText("Runs in progress")).length).toBeGreaterThan(0);
    expect(screen.getByText("May 2026")).toBeTruthy(); // latest disbursed
  });

  it("renders an empty state when there are no payslips", async () => {
    installTransport({
      "GET /hrms/payroll/payslips/mine": () =>
        envelope({ data: [], total: 0, page: 1, pageSize: 15 }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/overview");

    expect(await screen.findByText("No payslips yet")).toBeTruthy();
  });

  it("renders an error state, not an empty one, when the request fails", async () => {
    installTransport({
      "GET /hrms/payroll/payslips/mine": () => fail(500, { message: "Database unavailable." }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/overview");

    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Database unavailable.")).toBeTruthy();
  });

  it("renders a refusal for a 403", async () => {
    installTransport({
      "GET /hrms/payroll/payslips/mine": () => fail(403, { message: "Forbidden." }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/overview");

    expect(await screen.findByText("You do not have access")).toBeTruthy();
  });
});

// ===========================================================================
// Payslips
// ===========================================================================

describe("payslips", () => {
  it("lists the caller's payslips with money in Indian format", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/payslips");

    expect(await screen.findByText("Jun 2026")).toBeTruthy();
    expect(screen.getByText("₹ 42,000.00")).toBeTruthy();
    expect(screen.getByText("₹ 38,400.00")).toBeTruthy();
  });

  it("opens a breakdown that separates employer contributions from net", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/payslips");

    await userEvent.click(await screen.findByRole("button", { name: /view/i }));

    expect(await screen.findByText(/Payslip — Jun 2026/i)).toBeTruthy();
    expect(screen.getByText("Earnings")).toBeTruthy();
    // Also a column header in the list behind the modal.
    expect(screen.getAllByText("Deductions").length).toBeGreaterThan(0);
    // The distinction that matters: employer cost is reported, never deducted.
    expect(screen.getByText(/Employer contributions \(not deducted from you\)/i)).toBeTruthy();
    // Also a column header in the list behind the modal.
    expect(screen.getAllByText("Net pay").length).toBeGreaterThan(0);
  });

  it("shows a loss-of-pay badge when the month had unpaid leave", async () => {
    installTransport({
      "GET /hrms/payroll/payslips/mine": () =>
        envelope({ data: [{ ...PAYSLIP, lopDays: 2 }], total: 1, page: 1, pageSize: 15 }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/payroll/payslips");

    expect(await screen.findByText("2 days")).toBeTruthy();
  });
});

// ===========================================================================
// Runs
// ===========================================================================

describe("runs", () => {
  it("lists runs with their status and totals", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/runs");

    expect(await screen.findByText("Jun 2026")).toBeTruthy();
    expect(screen.getByText("review")).toBeTruthy();
    expect(screen.getByText("disbursed")).toBeTruthy();
  });

  it("offers only the actions the run's state allows", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/runs");

    await screen.findByText("Jun 2026");
    // The review run offers compute, lock and roll back.
    expect(screen.getByRole("button", { name: /compute/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^lock/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /roll back/i })).toBeTruthy();
    // The disbursed run offers nothing — it is terminal.
    expect(screen.queryByRole("button", { name: /mark disbursed/i })).toBeNull();
  });

  it("computes a run and reports how many payslips were produced", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/runs");

    await userEvent.click(await screen.findByRole("button", { name: /compute/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/payroll/runs/run1/compute")).toBe(true),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("🔴 surfaces skipped employees after a compute", async () => {
    installTransport({
      "POST /hrms/payroll/runs/run1/compute": () =>
        envelope({
          run: RUNS.data[0],
          payslipsGenerated: 0,
          skipped: [{ employeeId: "e9", reason: "no state could be resolved" }],
        }),
    });
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/runs");

    await userEvent.click(await screen.findByRole("button", { name: /compute/i }));

    // Somebody skipped is somebody not being paid. It must be visible before
    // the run is locked.
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/1 employee\(s\) were skipped/i);
    expect(notice.textContent).toMatch(/no state could be resolved/i);
  });

  it("🔴 confirms before locking, because locking is one-way", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/runs");

    await userEvent.click(await screen.findByRole("button", { name: /^lock/i }));

    // Nothing sent yet.
    expect(calls.some((c) => c.url === "/hrms/payroll/runs/run1/lock")).toBe(false);
    expect(await screen.findByText(/Lock this payroll run\?/i)).toBeTruthy();
    expect(screen.getByText(/cannot be recomputed or rolled back/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^lock run$/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/payroll/runs/run1/lock")).toBe(true),
    );
  });

  it("surfaces a rejected transition rather than failing silently", async () => {
    installTransport({
      "POST /hrms/payroll/runs/run1/compute": () =>
        fail(409, {
          message: "A locked payroll run cannot be computed.",
          code: "PAYROLL_RUN_INVALID_TRANSITION",
        }),
    });
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/runs");

    await userEvent.click(await screen.findByRole("button", { name: /compute/i }));
    expect(await screen.findByText("A locked payroll run cannot be computed.")).toBeTruthy();
  });

  it("validates the new-run form before sending", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/runs");

    await userEvent.click(await screen.findByRole("button", { name: /new run/i }));
    await userEvent.click(await screen.findByRole("button", { name: /create run/i }));

    expect(await screen.findByText("Choose a pay group.")).toBeTruthy();
    expect(calls.some((c) => c.url === "/hrms/payroll/runs" && c.method === "post")).toBe(false);
  });
});

// ===========================================================================
// Structures
// ===========================================================================

describe("structures", () => {
  it("lists structures and their components", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/structures");

    expect(await screen.findByText("Standard")).toBeTruthy();
    expect(screen.getAllByText("Basic").length).toBeGreaterThan(0);
    expect(screen.getByText("PF")).toBeTruthy(); // the statutory link badge
  });

  it("previews a CTC through the SERVER engine", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/structures");

    await userEvent.click(await screen.findByRole("button", { name: /preview/i }));
    await userEvent.click(await screen.findByRole("button", { name: /compute/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/structures/st1/preview"))).toBe(true),
    );
    expect(await screen.findByText("₹ 38,400.00")).toBeTruthy();
  });

  it("explains why a preview failed rather than showing nothing", async () => {
    installTransport({
      "POST /hrms/payroll/structures/st1/preview": () =>
        fail(400, { message: "No statutory configuration is effective for that month." }),
    });
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/structures");

    await userEvent.click(await screen.findByRole("button", { name: /preview/i }));
    await userEvent.click(await screen.findByRole("button", { name: /compute/i }));

    expect(
      await screen.findByText("No statutory configuration is effective for that month."),
    ).toBeTruthy();
  });
});

// ===========================================================================
// Pay groups
// ===========================================================================

describe("pay groups", () => {
  it("lists groups and marks the default", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/pay-groups");

    expect(await screen.findByText("MAIN")).toBeTruthy();
    // "Default" is both the column header and the badge on the default row.
    expect(screen.getAllByText("Default").length).toBe(2);
  });

  it("validates with the shared schema before sending", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/pay-groups");

    await userEvent.click(await screen.findByRole("button", { name: /new pay group/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));

    expect(await screen.findByText("Code is required.")).toBeTruthy();
    expect(calls.some((c) => c.method === "post")).toBe(false);
  });

  it("surfaces a refusal to retire a group still in use", async () => {
    installTransport({
      "DELETE /hrms/payroll/pay-groups/pg1": () =>
        fail(409, { message: "2 employee(s) are still paid through this group." }),
    });
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/pay-groups");

    await userEvent.click(await screen.findByRole("button", { name: /retire/i }));
    expect(await screen.findByText(/still paid through this group/i)).toBeTruthy();
  });
});

// ===========================================================================
// Statutory
// ===========================================================================

describe("statutory", () => {
  it("shows the configuration in force and which states it covers", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/statutory");

    // The section heading and the badge on the live version both say it.
    expect((await screen.findAllByText("In force")).length).toBe(2);
    expect(screen.getAllByText("12.00%").length).toBeGreaterThan(0); // PF rates
    expect(screen.getByText("Provident fund")).toBeTruthy();
    expect(screen.getAllByText("MP").length).toBeGreaterThan(0);
  });

  it("🔴 explains that payroll cannot run when nothing is configured", async () => {
    installTransport({
      "GET /hrms/payroll/statutory/effective": () => envelope(null),
      "GET /hrms/payroll/statutory": () => envelope([]),
    });
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/payroll/statutory");

    expect(await screen.findByText("No statutory configuration is in force")).toBeTruthy();
    // AD-12: it blocks rather than computing every statutory line as zero, and
    // the screen has to say so.
    expect(screen.getByText(/Payroll cannot run until one exists/i)).toBeTruthy();
  });
});
