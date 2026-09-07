/**
 * Onboarding — the page shell, tab gating, and each tab's workflow.
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
import { OnboardingPage } from "./OnboardingPage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEMPLATES = {
  data: [
    {
      id: "t1",
      name: "Engineering onboarding",
      appliesToRoleKey: "software_engineer",
      appliesToDepartmentId: null,
      appliesToDepartmentName: null,
      active: true,
      taskCount: 2,
      checklistCount: 3,
      tasks: [
        { id: "tt1", title: "Collect ID proof", description: "Aadhaar and PAN", dueDays: 1, assignTo: "hr", order: 0 },
        { id: "tt2", title: "Issue laptop", description: null, dueDays: 2, assignTo: "it", order: 1 },
      ],
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "t2",
      name: "Sales onboarding",
      appliesToRoleKey: null,
      appliesToDepartmentId: null,
      appliesToDepartmentName: null,
      active: false,
      taskCount: 1,
      checklistCount: 0,
      tasks: [{ id: "tt3", title: "Shadow a rep", description: null, dueDays: 5, assignTo: "manager", order: 0 }],
      createdAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const task = (over = {}) => ({
  id: "k1",
  taskTemplateId: "tt1",
  title: "Collect ID proof",
  description: "Aadhaar and PAN",
  assigneeEmployeeId: "hr1",
  assigneeName: "Hema Rao",
  assignTo: "hr",
  dueDate: "2026-09-03",
  status: "pending",
  notes: null,
  order: 0,
  completedAt: null,
  ...over,
});

const CHECKLIST = {
  id: "c1",
  employeeId: "e9",
  employeeName: "Asha Menon",
  templateId: "t1",
  templateName: "Engineering onboarding",
  status: "active",
  startedAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  tasks: [
    task(),
    task({ id: "k2", title: "Read the handbook", assignTo: "new_hire", assigneeEmployeeId: "e1", assigneeName: "Me", order: 1 }),
    task({ id: "k3", title: "Issue laptop", assignTo: "it", assigneeEmployeeId: null, assigneeName: null, status: "completed", order: 2 }),
  ],
  progress: { total: 3, completed: 1 },
};

const CHECKLISTS = { data: [CHECKLIST], total: 1, page: 1, pageSize: 25 };

const OFFERS = {
  data: [
    {
      id: "o1",
      employeeId: "e9",
      employeeName: "Asha Menon",
      ctc: 1800000,
      joiningDate: "2026-10-01",
      designation: "Senior Engineer",
      hasDocument: true,
      state: "draft",
      sentAt: null,
      acceptedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      signature: null,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

const MY_OFFER = {
  ...OFFERS.data[0],
  id: "o2",
  employeeId: "e1",
  state: "sent",
  sentAt: "2026-09-02T09:30:00.000Z",
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

    if (key === "GET /hrms/onboarding/templates") return envelope(TEMPLATES);
    if (key === "GET /hrms/onboarding/checklists") return envelope(CHECKLISTS);
    if (key === "GET /hrms/onboarding/checklists/mine") return envelope(CHECKLIST);
    if (key === "GET /hrms/onboarding/offers") return envelope(OFFERS);
    if (key === "GET /hrms/onboarding/offers/mine") return envelope([MY_OFFER]);
    if (key === "GET /hrms/employees") return envelope({ data: [], total: 0, page: 1, pageSize: 25 });

    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: [M.DASHBOARD, M.ONBOARDING],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/onboarding" element={<OnboardingPage />} />
        <Route path="/hrms/onboarding/:tab" element={<OnboardingPage />} />
      </Routes>
    </MemoryRouter>,
  );

/** The overlay a Modal or Drawer portals into, found by its heading. */
const panelTitled = (title) =>
  screen.getByRole("heading", { name: title }).closest("div.fixed");

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ===========================================================================
// Shell and gating
// ===========================================================================

describe("the page shell", () => {
  it("renders the title and subtitle", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/portal");
    expect(await screen.findByRole("heading", { name: "Onboarding" })).toBeTruthy();
    expect(screen.getByText(/Template-driven task lists/i)).toBeTruthy();
  });

  it("gives HR every tab, in the reference's order", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/portal");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "My onboarding",
      "Checklists",
      "Templates",
      "Offer letters",
    ]);
  });

  it("gives a manager the portal and Checklists, but not Templates or Offers", async () => {
    signIn([R.MANAGER]);
    at("/hrms/onboarding/portal");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["My onboarding", "Checklists"]);
  });

  it("gives an ordinary employee only their own portal", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/onboarding/portal");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["My onboarding"]);
  });

  it("redirects a tab the viewer has no grant for, without firing its request", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/onboarding/templates");
    await screen.findByText("My onboarding");
    expect(calls.some((c) => String(c.url).includes("/onboarding/templates"))).toBe(false);
  });

  it("defaults the bare module path to the new hire's own portal", async () => {
    signIn([R.HR_ADMIN]);
    render(
      <MemoryRouter initialEntries={["/hrms/onboarding"]}>
        <Routes>
          <Route path="/hrms/onboarding" element={<OnboardingPage />} />
          <Route path="/hrms/onboarding/:tab" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("My onboarding")).toBeTruthy();
    expect(calls.some((c) => c.url === "/hrms/onboarding/checklists/mine")).toBe(true);
  });
});

// ===========================================================================
// Templates
// ===========================================================================

describe("templates", () => {
  it("lists templates with what they apply to, their task count and usage", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/templates");

    const row = (await screen.findByText("Engineering onboarding")).closest("tr");
    expect(within(row).getByText("Role: software_engineer")).toBeTruthy();
    expect(within(row).getByText("Active")).toBeTruthy();

    const other = screen.getByText("Sales onboarding").closest("tr");
    expect(within(other).getByText("All hires")).toBeTruthy();
    expect(within(other).getByText("Inactive")).toBeTruthy();
  });

  it("🔴 a template that has been used cannot be deleted — the reference orphans its checklists", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/templates");

    const used = (await screen.findByText("Engineering onboarding")).closest("tr");
    expect(within(used).getByRole("button", { name: /Delete Engineering onboarding/ }).disabled).toBe(true);

    const unused = screen.getByText("Sales onboarding").closest("tr");
    expect(within(unused).getByRole("button", { name: /Delete Sales onboarding/ }).disabled).toBe(false);
  });

  it("expands a template to show its task templates", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/templates");

    await userEvent.click(await screen.findByRole("button", { name: /Show tasks in Engineering onboarding/ }));
    const panel = await screen.findByRole("region", { name: /Tasks in Engineering onboarding/ });
    expect(within(panel).getByText("Collect ID proof")).toBeTruthy();
    expect(within(panel).getByText("Issue laptop")).toBeTruthy();
    expect(within(panel).getByText("HR")).toBeTruthy();
    expect(within(panel).getByText("IT")).toBeTruthy();
  });

  it("🔴 refuses a template with no usable task — the reference allows an empty one", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/templates");

    await userEvent.click(await screen.findByRole("button", { name: /New template/ }));
    const drawer = panelTitled("New onboarding template");
    // A name but a blank task title.
    await userEvent.type(within(drawer).getByLabelText("Name"), "Empty-ish");
    await userEvent.click(within(drawer).getByRole("button", { name: "Create" }));

    expect(await within(drawer).findByRole("alert")).toBeTruthy();
    expect(calls.some((c) => c.method === "post" && c.url === "/hrms/onboarding/templates")).toBe(false);
  });

  it("posts the whole task list, ordered, when the form is valid", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({ "POST /hrms/onboarding/templates": () => envelope({ id: "new" }) });
    at("/hrms/onboarding/templates");

    await userEvent.click(await screen.findByRole("button", { name: /New template/ }));
    const drawer = panelTitled("New onboarding template");
    await userEvent.type(within(drawer).getByLabelText("Name"), "Ops onboarding");
    await userEvent.type(within(drawer).getByLabelText("Task 1 title"), "Sign the handbook");
    await userEvent.click(within(drawer).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/onboarding/templates");
      expect(post.data.name).toBe("Ops onboarding");
      expect(post.data.tasks).toEqual([
        { title: "Sign the handbook", dueDays: 1, assignTo: "hr", order: 0 },
      ]);
    });
  });

  it("the last task row cannot be removed", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/templates");
    await userEvent.click(await screen.findByRole("button", { name: /New template/ }));
    const drawer = panelTitled("New onboarding template");
    expect(within(drawer).getByRole("button", { name: /Remove task 1/ }).disabled).toBe(true);

    await userEvent.click(within(drawer).getByRole("button", { name: /Add task/ }));
    expect(within(drawer).getByRole("button", { name: /Remove task 1/ }).disabled).toBe(false);
  });
});

// ===========================================================================
// Checklists
// ===========================================================================

describe("checklists", () => {
  it("lists each onboarding with its template, progress and status", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/checklists");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    expect(within(row).getByText("Engineering onboarding")).toBeTruthy();
    expect(within(row).getByText("active")).toBeTruthy();
    expect(within(row).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(within(row).getByText("1 / 3")).toBeTruthy();
  });

  it("expands a checklist to reveal its tasks and their assignees", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/checklists");

    await userEvent.click(await screen.findByRole("button", { name: /Show tasks for Asha Menon/ }));
    const panel = await screen.findByRole("region", { name: /Tasks for Asha Menon/ });
    expect(within(panel).getByText("Hema Rao")).toBeTruthy();
    // A role nobody holds is a visible gap, not a silent fallback to HR.
    expect(within(panel).getByText("Unassigned")).toBeTruthy();
  });

  it("moves a task through the API, and offers only legal transitions", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "PATCH /hrms/onboarding/checklists/c1/tasks/k1": () => envelope(CHECKLIST),
    });
    at("/hrms/onboarding/checklists");

    await userEvent.click(await screen.findByRole("button", { name: /Show tasks for Asha Menon/ }));
    const panel = await screen.findByRole("region", { name: /Tasks for Asha Menon/ });
    const pendingRow = within(panel).getByText("Collect ID proof").closest("tr");

    await userEvent.click(within(pendingRow).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      const patch = calls.find((c) => c.url === "/hrms/onboarding/checklists/c1/tasks/k1");
      expect(patch.data).toEqual({ status: "completed" });
    });

    // 🔴 A closed task offers only Reopen — the reference offers every status.
    const closedRow = within(panel).getByText("Issue laptop").closest("tr");
    expect(within(closedRow).getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(within(closedRow).queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("a manager sees the list but no HR-only actions", async () => {
    signIn([R.MANAGER]);
    at("/hrms/onboarding/checklists");

    await screen.findByText("Asha Menon");
    expect(screen.queryByRole("button", { name: /Start onboarding/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Show tasks for Asha Menon/ }));
    const panel = await screen.findByRole("region", { name: /Tasks for Asha Menon/ });
    expect(within(panel).queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("will not cancel an onboarding without a reason", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/checklists");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: /Cancel/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel onboarding" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Say why/i);
    expect(calls.some((c) => String(c.url).includes("/cancel"))).toBe(false);
  });

  it("validates the start form against the shared schema before posting", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/checklists");

    await userEvent.click(await screen.findByRole("button", { name: /Start onboarding/ }));
    const drawer = panelTitled("Start onboarding");
    await userEvent.click(within(drawer).getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "post" && c.url === "/hrms/onboarding/checklists")).toBe(false),
    );
  });
});

// ===========================================================================
// Offer letters
// ===========================================================================

describe("offer letters", () => {
  it("🔴 a draft shows BOTH the letter and Send — the reference's Send can never render", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/onboarding/offers");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    expect(within(row).getByText("Draft")).toBeTruthy();
    expect(within(row).getByRole("button", { name: /Letter/ })).toBeTruthy();
    expect(within(row).getByRole("button", { name: /Send/ })).toBeTruthy();
    expect(within(row).getByText("₹ 18,00,000")).toBeTruthy();
  });

  it("never puts a storage key in the listing — it asks for a URL on click", async () => {
    signIn([R.HR_ADMIN]);
    const open = vi.fn();
    vi.stubGlobal("open", open);
    installTransport({
      "GET /hrms/onboarding/offers/o1/document-url": () =>
        envelope({ url: "https://s3.example.com/signed", expiresInSeconds: 300 }),
    });
    at("/hrms/onboarding/offers");

    await screen.findByText("Asha Menon");
    expect(calls.some((c) => String(c.url).includes("document-url"))).toBe(false);

    const row = screen.getByText("Asha Menon").closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: /Letter/ }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/onboarding/offers/o1/document-url")).toBe(true),
    );
    expect(open).toHaveBeenCalledWith(
      "https://s3.example.com/signed",
      "_blank",
      "noopener,noreferrer",
    );
    vi.unstubAllGlobals();
  });

  it("sending goes through the API and surfaces a refusal", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "POST /hrms/onboarding/offers/o1/send": () =>
        Promise.reject({
          response: {
            status: 409,
            data: { success: false, message: "This offer letter has already been sent." },
          },
        }),
    });
    at("/hrms/onboarding/offers");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: /Send/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/already been sent/i);
  });

  it("an accepted offer shows who signed it and offers no Send", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "GET /hrms/onboarding/offers": () =>
        envelope({
          ...OFFERS,
          data: [
            {
              ...OFFERS.data[0],
              state: "accepted",
              sentAt: "2026-09-02T09:30:00.000Z",
              acceptedAt: "2026-09-03T10:00:00.000Z",
              signature: { name: "Asha Menon", signedAt: "2026-09-03T10:00:00.000Z" },
            },
          ],
        }),
    });
    at("/hrms/onboarding/offers");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    expect(within(row).getByText("Accepted")).toBeTruthy();
    expect(within(row).getByText(/Signed by Asha Menon/)).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Send/ })).toBeNull();
  });
});

// ===========================================================================
// The new-hire portal
// ===========================================================================

describe("the new-hire portal", () => {
  it("asks for the caller's own checklist and offers, with no id on the wire", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/onboarding/portal");

    await screen.findByRole("heading", { name: "My onboarding" });
    const urls = calls.map((c) => c.url);
    expect(urls).toContain("/hrms/onboarding/checklists/mine");
    expect(urls).toContain("/hrms/onboarding/offers/mine");
    expect(urls.some((u) => u.includes("e1"))).toBe(false);
  });

  it("splits my tasks from the ones other people own", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/onboarding/portal");

    await screen.findByRole("heading", { name: "My onboarding" });
    expect(screen.getByText("My tasks")).toBeTruthy();
    expect(screen.getByText(/Handled by HR, IT or your manager/)).toBeTruthy();

    // The new_hire task is actionable...
    expect(screen.getByRole("button", { name: "Mark done" })).toBeTruthy();
    // ...and somebody else's is listed read-only.
    expect(screen.getByText(/Collect ID proof/)).toBeTruthy();
  });

  it("marks a task done through the API", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "PATCH /hrms/onboarding/checklists/c1/tasks/k2": () => envelope(CHECKLIST),
    });
    at("/hrms/onboarding/portal");

    await userEvent.click(await screen.findByRole("button", { name: "Mark done" }));
    await waitFor(() => {
      const patch = calls.find((c) => c.url === "/hrms/onboarding/checklists/c1/tasks/k2");
      expect(patch.data).toEqual({ status: "completed" });
    });
  });

  it("shows a sent offer awaiting signature, with its terms", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/onboarding/portal");

    expect(
      await screen.findByRole("heading", { name: /waiting for your signature/i }),
    ).toBeTruthy();
    expect(screen.getAllByText("Senior Engineer").length).toBeGreaterThan(0);
    expect(screen.getByText("₹ 18,00,000")).toBeTruthy();
    expect(screen.getByText("01 Oct 2026")).toBeTruthy();
  });

  it("requires a typed name before recording an acceptance", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "POST /hrms/onboarding/offers/o2/sign": () => envelope({ ...MY_OFFER, state: "accepted" }),
    });
    at("/hrms/onboarding/portal");

    await userEvent.click(await screen.findByRole("button", { name: "Accept and sign" }));
    const dialog = panelTitled("Sign your offer letter");
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign and accept" }));

    expect(await within(dialog).findByText(/Type your full name to sign/i)).toBeTruthy();
    expect(calls.some((c) => c.method === "post" && String(c.url).includes("/sign"))).toBe(false);

    await userEvent.type(within(dialog).getByLabelText("Full legal name"), "Asha Menon");
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign and accept" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/onboarding/offers/o2/sign");
      expect(post.data).toEqual({ signatureName: "Asha Menon" });
      // 🔴 And no base64 signature image goes with it.
      expect(post.data.signatureImage).toBeUndefined();
    });
  });

  it("declining warns that it is final and posts the optional reason", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "POST /hrms/onboarding/offers/o2/reject": () => envelope({ ...MY_OFFER, state: "rejected" }),
    });
    at("/hrms/onboarding/portal");

    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
    const dialog = panelTitled("Decline this offer?");
    expect(within(dialog).getByText(/final/i)).toBeTruthy();

    await userEvent.type(within(dialog).getByLabelText(/Anything you would like us to know/), "Took another role");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm decline" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/onboarding/offers/o2/reject");
      expect(post.data).toEqual({ reason: "Took another role" });
    });
  });

  it("says so plainly when there is no checklist yet", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/onboarding/checklists/mine": () => envelope(null),
      "GET /hrms/onboarding/offers/mine": () => envelope([]),
    });
    at("/hrms/onboarding/portal");

    expect(await screen.findByText("No onboarding checklist yet")).toBeTruthy();
    expect(screen.getByText("None yet.")).toBeTruthy();
  });
});
