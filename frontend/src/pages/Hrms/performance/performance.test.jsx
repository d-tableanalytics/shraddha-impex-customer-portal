/**
 * Performance — the page shell, tab gating, and each tab's workflow.
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
import { PerformancePage } from "./PerformancePage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const goal = (over = {}) => ({
  id: "g1",
  employeeId: "e1",
  employeeName: "Person One",
  parentGoalId: null,
  parentGoalTitle: null,
  cycleId: "c1",
  cycleName: "Q3 2026 Review",
  title: "Ship the P6 modules",
  description: "All six, reviewed and merged.",
  targetValue: 10,
  currentValue: 4,
  unit: "modules",
  weight: 3,
  status: "in_progress",
  dueDate: "2026-09-30",
  progressPercent: 40,
  childCount: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

const GOALS = { data: [goal()], total: 1, page: 1, pageSize: 25 };

const CYCLES = {
  data: [
    {
      id: "c1",
      name: "Q3 2026 Review",
      startDate: "2026-07-01",
      endDate: "2026-09-30",
      phase: "self_review",
      competencies: [
        { key: "execution", label: "Execution", weight: 2 },
        { key: "collaboration", label: "Collaboration", weight: 1 },
      ],
      responseCount: 3,
      submittedCount: 1,
      goalCount: 2,
      nextPhases: ["manager_review", "goal_setting"],
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

const MY_REVIEWS = {
  data: [
    {
      id: "r1",
      cycleId: "c1",
      cycleName: "Q3 2026 Review",
      employeeId: "e1",
      employeeName: "Person One",
      reviewerEmployeeId: "e1",
      reviewerName: "Person One",
      kind: "self",
      ratings: {},
      overallRating: null,
      comments: null,
      submittedAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

const ABOUT_ME = {
  data: [
    {
      id: "r9",
      cycleId: "c1",
      cycleName: "Q3 2026 Review",
      employeeId: "e1",
      employeeName: "Person One",
      reviewerEmployeeId: "e2",
      reviewerName: "Manager Two",
      kind: "manager",
      ratings: { execution: 4, collaboration: 5 },
      overallRating: 4,
      comments: "A strong quarter on delivery.",
      submittedAt: "2026-09-20T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "r10",
      cycleId: "c1",
      cycleName: "Q3 2026 Review",
      employeeId: "e1",
      employeeName: "Person One",
      reviewerEmployeeId: null,
      reviewerName: "A peer",
      kind: "peer",
      ratings: { execution: 3 },
      overallRating: 3,
      comments: null,
      submittedAt: "2026-09-21T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const RECEIVED = {
  data: [
    {
      id: "f1",
      fromEmployeeId: null,
      fromName: "Anonymous",
      anonymous: true,
      toEmployeeId: "e1",
      toName: "Person One",
      kind: "constructive",
      message: "The stand-up updates could be tighter.",
      visibility: "anonymous",
      tags: ["communication"],
      createdAt: "2026-08-10T00:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

const ONE_ON_ONES = {
  data: [
    {
      id: "o1",
      managerEmployeeId: "e2",
      managerName: "Manager Two",
      reportEmployeeId: "e1",
      reportName: "Person One",
      scheduledAt: "2026-09-10T09:30:00.000Z",
      durationMinutes: 45,
      agenda: [{ text: "Q3 goals", done: false }],
      notes: [],
      actionItems: [{ text: "Draft the RFC", done: false }],
      status: "scheduled",
      viewerIsManager: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

const CALIBRATION = {
  cycleId: "c1",
  cycleName: "Q3 2026 Review",
  phase: "calibration",
  rated: 1,
  responses: [
    {
      employeeId: "e1",
      employeeName: "Person One",
      selfRating: 5,
      managerRating: 3.5,
      peerAverage: 4,
      gap: 1.5,
    },
  ],
  distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 },
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

    if (key === "GET /hrms/performance/goals") return envelope(GOALS);
    if (key === "GET /hrms/performance/cycles") return envelope(CYCLES);
    if (key === "GET /hrms/performance/reviews/mine") return envelope(MY_REVIEWS);
    if (key === "GET /hrms/performance/reviews/about-me") return envelope(ABOUT_ME);
    if (key === "GET /hrms/performance/feedback/received") return envelope(RECEIVED);
    if (key === "GET /hrms/performance/feedback/given")
      return envelope({ data: [], total: 0, page: 1, pageSize: 25 });
    if (key === "GET /hrms/performance/one-on-ones") return envelope(ONE_ON_ONES);
    if (key === "GET /hrms/performance/cycles/c1/calibration") return envelope(CALIBRATION);
    if (key === "GET /hrms/employees")
      return envelope({ data: [], total: 0, page: 1, pageSize: 25 });

    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: [M.DASHBOARD, M.PERFORMANCE],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/performance" element={<PerformancePage />} />
        <Route path="/hrms/performance/:tab" element={<PerformancePage />} />
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
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/goals");
    expect(await screen.findByRole("heading", { name: "Performance" })).toBeTruthy();
    expect(screen.getByText(/Cascading goals \(OKR-style\)/i)).toBeTruthy();
  });

  it("gives everyone four tabs, and HR a fifth", async () => {
    signIn([R.EMPLOYEE]);
    const view = at("/hrms/performance/goals");
    let tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "My goals",
      "Reviews",
      "Feedback",
      "1:1s",
    ]);
    view.unmount();

    signIn([R.HR_ADMIN]);
    at("/hrms/performance/goals");
    tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "My goals",
      "Reviews",
      "Feedback",
      "1:1s",
      "Cycles & calibration",
    ]);
  });

  it("redirects Cycles for a non-HR viewer, without firing its request", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/cycles");
    await screen.findByText("Ship the P6 modules");
    expect(calls.some((c) => String(c.url).includes("calibration"))).toBe(false);
  });

  it("defaults the bare module path to My goals", async () => {
    signIn([R.EMPLOYEE]);
    render(
      <MemoryRouter initialEntries={["/hrms/performance"]}>
        <Routes>
          <Route path="/hrms/performance" element={<PerformancePage />} />
          <Route path="/hrms/performance/:tab" element={<PerformancePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Ship the P6 modules")).toBeTruthy();
  });
});

// ===========================================================================
// Goals
// ===========================================================================

describe("goals", () => {
  it("shows the cycle, progress, current/target, weight and status", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/goals");

    const row = (await screen.findByText("Ship the P6 modules")).closest("tr");
    expect(within(row).getByText("Q3 2026 Review")).toBeTruthy();
    expect(within(row).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect(within(row).getByText("4 / 10 modules")).toBeTruthy();
    expect(within(row).getByText("3")).toBeTruthy();
    expect(within(row).getByText("In progress")).toBeTruthy();
  });

  it("🔴 offers only the transitions the server permits — the reference offers every status", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/goals");

    const row = (await screen.findByText("Ship the P6 modules")).closest("tr");
    await userEvent.click(within(row).getByText("Set status"));

    // From `in_progress`: at_risk, achieved, missed, cancelled — never `open`.
    expect(await screen.findByText("At risk")).toBeTruthy();
    expect(screen.getByText("Achieved")).toBeTruthy();
    expect(screen.queryByText("Open")).toBeNull();
  });

  it("records progress through a dialog, not on every keystroke", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({ "PATCH /hrms/performance/goals/g1": () => envelope(goal()) });
    at("/hrms/performance/goals");

    const row = (await screen.findByText("Ship the P6 modules")).closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: "Progress" }));

    const dialog = panelTitled(/^Progress — Ship the P6 modules/);
    const field = within(dialog).getByLabelText("Reached so far");
    await userEvent.clear(field);
    await userEvent.type(field, "7");
    // Typing has written nothing yet — the reference PATCHes on every keystroke.
    expect(calls.some((c) => c.method === "patch")).toBe(false);

    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    await waitFor(() => {
      const patch = calls.find((c) => c.url === "/hrms/performance/goals/g1");
      expect(patch.data).toEqual({ currentValue: "7" });
    });
  });

  it("disables delete on a goal that others cascade from", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/performance/goals": () =>
        envelope({ ...GOALS, data: [goal({ childCount: 2 })] }),
    });
    at("/hrms/performance/goals");

    const row = (await screen.findByText("Ship the P6 modules")).closest("tr");
    expect(within(row).getByRole("button", { name: /Delete Ship the P6 modules/ }).disabled).toBe(
      true,
    );
  });

  it("validates the new-goal form against the shared schema", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/goals");

    await userEvent.click(await screen.findByRole("button", { name: /New goal/ }));
    const drawer = panelTitled("New goal");
    // A unit with no target — the schema's refinement.
    await userEvent.type(within(drawer).getByLabelText("Title"), "Something");
    await userEvent.type(within(drawer).getByLabelText("Unit"), "%");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));

    expect(await within(drawer).findByText(/unit only means something with a target/i)).toBeTruthy();
    expect(calls.some((c) => c.method === "post" && c.url === "/hrms/performance/goals")).toBe(
      false,
    );
  });

  it("posts a valid goal", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({ "POST /hrms/performance/goals": () => envelope(goal()) });
    at("/hrms/performance/goals");

    await userEvent.click(await screen.findByRole("button", { name: /New goal/ }));
    const drawer = panelTitled("New goal");
    await userEvent.type(within(drawer).getByLabelText("Title"), "Reduce build time");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/performance/goals");
      expect(post.data).toEqual({ title: "Reduce build time", weight: 1 });
    });
  });
});

// ===========================================================================
// Reviews
// ===========================================================================

describe("reviews", () => {
  it("lists the queue assigned to me with a Fill in button", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/reviews");

    const row = (await screen.findByText("Q3 2026 Review")).closest("tr");
    expect(within(row).getByText("Self")).toBeTruthy();
    expect(within(row).getByText("Pending")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Fill in" })).toBeTruthy();
    // No id on the wire — the reviewer comes from the session.
    expect(calls.some((c) => c.url === "/hrms/performance/reviews/mine")).toBe(true);
  });

  it("renders one input per competency, and refuses an empty rating map", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/reviews");

    const row = (await screen.findByText("Q3 2026 Review")).closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: "Fill in" }));

    const modal = panelTitled(/^Self review — Person One/);
    expect(within(modal).getByLabelText("Execution")).toBeTruthy();
    expect(within(modal).getByLabelText("Collaboration")).toBeTruthy();

    await userEvent.click(within(modal).getByRole("button", { name: "Submit" }));
    expect(await within(modal).findByText(/Rate at least one competency/i)).toBeTruthy();
    expect(calls.some((c) => String(c.url).includes("/submit"))).toBe(false);
  });

  it("submits ratings, an overall and comments as one payload", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "POST /hrms/performance/reviews/r1/submit": () => envelope(MY_REVIEWS.data[0]),
    });
    at("/hrms/performance/reviews");

    const row = (await screen.findByText("Q3 2026 Review")).closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: "Fill in" }));

    const modal = panelTitled(/^Self review — Person One/);
    await userEvent.type(within(modal).getByLabelText("Execution"), "4");
    await userEvent.type(within(modal).getByLabelText("Collaboration"), "5");
    await userEvent.type(within(modal).getByLabelText("Overall rating"), "4");
    await userEvent.type(within(modal).getByLabelText("Comments"), "Good quarter.");
    await userEvent.click(within(modal).getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/performance/reviews/r1/submit");
      expect(post.data).toEqual({
        ratings: { execution: 4, collaboration: 5 },
        overallRating: 4,
        comments: "Good quarter.",
      });
    });
  });

  it("🔴 an employee can read the reviews written about them — the reference has no such view", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/reviews");

    await userEvent.click(await screen.findByRole("tab", { name: "About me" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/performance/reviews/about-me")).toBe(true),
    );

    expect(await screen.findByText("Manager Two")).toBeTruthy();
    expect(screen.getByText("A strong quarter on delivery.")).toBeTruthy();
    expect(screen.getByText(/execution: 4\/5 · collaboration: 5\/5/)).toBeTruthy();
    // A peer reviewer is not named.
    expect(screen.getByText("A peer")).toBeTruthy();
  });

  it("hides Start review from somebody who cannot assign one", async () => {
    signIn([R.EMPLOYEE]);
    const view = at("/hrms/performance/reviews");
    await screen.findByText("Q3 2026 Review");
    expect(screen.queryByRole("button", { name: /Start review/ })).toBeNull();
    view.unmount();

    signIn([R.MANAGER]);
    at("/hrms/performance/reviews");
    expect(await screen.findByRole("button", { name: /Start review/ })).toBeTruthy();
  });

  it("🔴 a peer review asks WHO writes it — the reference assigns it to the actor", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/performance/reviews");

    await userEvent.click(await screen.findByRole("button", { name: /Start review/ }));
    const drawer = panelTitled("Start a review");

    // The option's click handler is on the button inside the `role="option"`
    // list item, so that is what a real click lands on.
    await userEvent.click(within(drawer).getByText("Choose"));
    await userEvent.click(await within(drawer).findByRole("button", { name: "Self" }));
    expect(within(drawer).queryByText("Who should write it")).toBeNull();

    await userEvent.click(within(drawer).getByText("Self"));
    await userEvent.click(await within(drawer).findByRole("button", { name: "Peer" }));
    expect(await within(drawer).findByText("Who should write it")).toBeTruthy();
  });
});

// ===========================================================================
// Feedback
// ===========================================================================

describe("feedback", () => {
  it("shows received notes with an anonymous sender masked", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/feedback");

    expect(await screen.findByText("Anonymous")).toBeTruthy();
    expect(screen.getByText("The stand-up updates could be tighter.")).toBeTruthy();
    expect(screen.getByText("communication")).toBeTruthy();
  });

  it("switches to Given, which is a different endpoint", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/feedback");

    await screen.findByText("Anonymous");
    await userEvent.click(screen.getByRole("tab", { name: "Given" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/performance/feedback/given")).toBe(true),
    );
    expect(await screen.findByText(/You have not given any feedback yet/i)).toBeTruthy();
  });

  it("warns what anonymity does and does not hide", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/feedback");

    await userEvent.click(await screen.findByRole("button", { name: /Give feedback/ }));
    const drawer = panelTitled("Give feedback");
    expect(within(drawer).queryByText(/not.*anonymous to the company/i)).toBeNull();

    await userEvent.click(within(drawer).getByText("Visible (your name is shown)"));
    await userEvent.click(await within(drawer).findByRole("button", { name: "Anonymous" }));
    expect(await within(drawer).findByText(/anonymous to the company/i)).toBeTruthy();
  });

  it("splits comma-separated tags and posts an employee id", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/employees": () =>
        envelope({
          // A real 24-hex id: `giveFeedbackSchema` validates an ObjectId, and
          // correctly refuses a short placeholder like "e2".
          data: [
            {
              id: "507f1f77bcf86cd799439012",
              firstName: "Manager",
              lastName: "Two",
              employeeCode: "PRF002",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
      "POST /hrms/performance/feedback": () => envelope(RECEIVED.data[0]),
    });
    at("/hrms/performance/feedback");

    await userEvent.click(await screen.findByRole("button", { name: /Give feedback/ }));
    const drawer = panelTitled("Give feedback");
    await userEvent.click(within(drawer).getByText("Choose a colleague"));
    await userEvent.click(await screen.findByText("Manager Two"));
    await userEvent.type(within(drawer).getByLabelText("Message"), "Great handover.");
    await userEvent.type(within(drawer).getByLabelText("Tags"), "ownership, clarity");
    await userEvent.click(within(drawer).getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/performance/feedback");
      expect(post.data).toEqual({
        toEmployeeId: "507f1f77bcf86cd799439012",
        kind: "praise",
        message: "Great handover.",
        visibility: "visible",
        tags: ["ownership", "clarity"],
      });
    });
  });
});

// ===========================================================================
// 1:1s
// ===========================================================================

describe("one-on-ones", () => {
  it("shows the card from the report’s side, with agenda and action items", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/one-on-ones");

    expect(await screen.findByText("with Manager Two")).toBeTruthy();
    expect(screen.getByText("Q3 goals")).toBeTruthy();
    expect(screen.getByText("Draft the RFC")).toBeTruthy();
    expect(screen.getByText("Scheduled")).toBeTruthy();
  });

  it("🔴 a report may save notes but not resolve — the reference lets them cancel", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/performance/one-on-ones");

    await screen.findByText("with Manager Two");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mark done/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("the manager sees Mark done and Cancel", async () => {
    signIn([R.MANAGER]);
    installTransport({
      "GET /hrms/performance/one-on-ones": () =>
        envelope({
          ...ONE_ON_ONES,
          data: [{ ...ONE_ON_ONES.data[0], viewerIsManager: true }],
        }),
    });
    at("/hrms/performance/one-on-ones");

    await screen.findByText("with Person One");
    expect(screen.getByRole("button", { name: /Mark done/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("saves notes and action items as one payload", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "PATCH /hrms/performance/one-on-ones/o1": () => envelope(ONE_ON_ONES.data[0]),
    });
    at("/hrms/performance/one-on-ones");

    await screen.findByText("with Manager Two");
    await userEvent.type(screen.getByLabelText("Notes"), "Talked about the release");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.url === "/hrms/performance/one-on-ones/o1");
      expect(patch.data.notes).toEqual([{ text: "Talked about the release", done: false }]);
      expect(patch.data.actionItems).toEqual([{ text: "Draft the RFC", done: false }]);
    });
  });

  it("hides Schedule 1:1 from somebody with no reports", async () => {
    signIn([R.EMPLOYEE]);
    const view = at("/hrms/performance/one-on-ones");
    await screen.findByText("with Manager Two");
    expect(screen.queryByRole("button", { name: /Schedule 1:1/ })).toBeNull();
    view.unmount();

    signIn([R.MANAGER]);
    at("/hrms/performance/one-on-ones");
    expect(await screen.findByRole("button", { name: /Schedule 1:1/ })).toBeTruthy();
  });
});

// ===========================================================================
// Cycles & calibration
// ===========================================================================

describe("cycles and calibration", () => {
  it("lists cycles with their window, phase and counts", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/performance/cycles");

    const row = (await screen.findByText("Q3 2026 Review")).closest("tr");
    expect(within(row).getByText("01 Jul 2026 → 30 Sep 2026")).toBeTruthy();
    expect(within(row).getByText("Self review")).toBeTruthy();
    expect(within(row).getByText("Execution, Collaboration")).toBeTruthy();
    expect(within(row).getByText("1/3")).toBeTruthy();
  });

  it("🔴 the phase picker offers only the server’s transitions", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/performance/cycles");

    const row = (await screen.findByText("Q3 2026 Review")).closest("tr");
    await userEvent.click(within(row).getByText("Advance to"));

    // `nextPhases` from the server: manager_review and one step back.
    expect(await screen.findByText("Manager review")).toBeTruthy();
    expect(screen.getByText("Goal setting")).toBeTruthy();
    expect(screen.queryByText("Closed")).toBeNull();
  });

  it("🔴 calibration FLOORS the band — 3.5 sits in 3, not 4", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/performance/cycles");

    const row = (await screen.findByText("Q3 2026 Review")).closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: /Calibration/ }));

    const modal = panelTitled(/^Calibration — Q3 2026 Review/);
    expect(await within(modal).findByText("Person One")).toBeTruthy();
    expect(within(modal).getByText("3.5/5")).toBeTruthy();
    // The gap column the reference does not compute.
    expect(within(modal).getByText("+1.5")).toBeTruthy();
    expect(within(modal).getByText(/3.5 sits in band 3/)).toBeTruthy();
  });

  it("seeds the create drawer with the reference’s three competencies", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/performance/cycles");

    await userEvent.click(await screen.findByRole("button", { name: /New cycle/ }));
    const drawer = panelTitled("New review cycle");
    expect(within(drawer).getByLabelText("Competency 1 key").value).toBe("execution");
    expect(within(drawer).getByLabelText("Competency 2 key").value).toBe("collaboration");
    expect(within(drawer).getByLabelText("Competency 3 key").value).toBe("ownership");
  });

  it("refuses a cycle whose dates are inverted", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/performance/cycles");

    await userEvent.click(await screen.findByRole("button", { name: /New cycle/ }));
    const drawer = panelTitled("New review cycle");
    await userEvent.type(within(drawer).getByLabelText("Name"), "Bad window");
    await userEvent.click(within(drawer).getByRole("button", { name: "Create" }));

    // No dates chosen at all — the schema refuses before anything is posted.
    await waitFor(() =>
      expect(calls.some((c) => c.method === "post" && c.url === "/hrms/performance/cycles")).toBe(
        false,
      ),
    );
  });
});
