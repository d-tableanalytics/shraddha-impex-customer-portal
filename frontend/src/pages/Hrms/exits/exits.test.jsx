/**
 * Exits — the screens.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these also cover the
 * request URLs, the payload shapes and the `{ success, data }` unwrapping.
 *
 * What the UI offers is asserted here; what it is ALLOWED to do is asserted in
 * backend/tests/exits-api.test.js. Both halves read the same matrix.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { ExitsPage } from "./ExitsPage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const ME = "652f0000000000000000b001";
const OTHER = "652f0000000000000000b002";
const EXIT_ID = "652f0000000000000000e001";

/** A day well in the future, so the schema's lower bound is never the reason. */
const futureDay = (days = 30) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const clearance = (over = {}) => ({
  id: "652f0000000000000000c001",
  area: "it",
  assigneeEmployeeId: OTHER,
  assigneeName: "Ivan Person",
  status: "pending",
  completedAt: null,
  notes: null,
  ...over,
});

const exitRow = (over = {}) => ({
  id: EXIT_ID,
  employeeId: ME,
  employeeName: "Sam Person",
  isOwnExit: true,
  initiatedByEmployeeId: ME,
  initiatedAt: "2026-01-02T00:00:00.000Z",
  reason: "Moving to another city.",
  reasonCategory: "resignation",
  requestedLastDay: "2026-03-01",
  actualLastDay: null,
  status: "initiated",
  managerApprovedAt: null,
  hrApprovedAt: null,
  closedAt: null,
  cancelledAt: null,
  replacementEmployeeId: null,
  replacementEmployeeName: null,
  transferNotes: null,
  clearances: [],
  fullAndFinal: null,
  relievingLetter: null,
  createdAt: "2026-01-02T00:00:00.000Z",
  ...over,
});

const settlement = (over = {}) => ({
  gross: "112500.00",
  deductions: "3287.67",
  netPayable: "109212.33",
  earnings: [
    { code: "FINAL_MONTH", label: "Final month salary (28 of 31 days)", amount: "90322.58" },
    { code: "LEAVE_ENCASHMENT", label: "Leave encashment (5.0 days)", amount: "22177.42" },
  ],
  deductionLines: [
    { code: "NOTICE_SHORTFALL", label: "Notice shortfall (10 of 30 days)", amount: "3287.67" },
  ],
  leaveEncashment: "22177.42",
  gratuity: null,
  noticeAdjustment: "-3287.67",
  computedAt: "2026-02-01T00:00:00.000Z",
  disbursedAt: null,
  payrollRunId: null,
  ...over,
});

let calls = [];
const envelope = (payload) => ({ data: { success: true, data: payload } });
const page = (rows) => envelope({ data: rows, total: rows.length, page: 1, pageSize: 15 });
const fail = (status, body) => Promise.reject({ response: { status, data: body } });

function installTransport(overrides = {}) {
  calls = [];
  api.request.mockImplementation(async (config) => {
    calls.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (overrides[key]) return overrides[key](config);

    if (key === "GET /hrms/exits/me") return envelope(null);
    if (key === "GET /hrms/exits") return page([]);
    if (key === "GET /hrms/employees") return page([]);
    if (config.method === "post" || config.method === "patch") return envelope(exitRow());
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles, employee = { id: ME, managerChain: [] }) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.LEAVE, M.EXPENSES, M.EXITS],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/exits" element={<ExitsPage />} />
        <Route path="/hrms/exits/:tab" element={<ExitsPage />} />
      </Routes>
    </MemoryRouter>,
  );

const urlsHit = () => calls.map((c) => `${c.method.toUpperCase()} ${c.url}`);

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ===========================================================================
// Page shell and gating
// ===========================================================================

describe("the exits page", () => {
  it("renders its title and breadcrumb", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    expect(await screen.findByRole("heading", { name: "Exits" })).toBeTruthy();
    expect(screen.getByText("HRMS")).toBeTruthy();
  });

  it("an employee gets My Exit and the Clearance Queue only", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    expect(await screen.findByRole("tab", { name: "My Exit" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Clearance Queue" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Exit Requests" })).toBeNull();
  });

  it("a manager also gets Exit Requests", async () => {
    signIn([R.MANAGER]);
    at("/hrms/exits/mine");

    expect(await screen.findByRole("tab", { name: "Exit Requests" })).toBeTruthy();
  });

  it("HR gets all three", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/exits/mine");

    expect(await screen.findByRole("tab", { name: "Exit Requests" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Clearance Queue" })).toBeTruthy();
  });

  it("a gated tab reached by URL is refused WITHOUT firing its request", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/requests");

    expect(await screen.findByText(/do not have access to this view/i)).toBeTruthy();
    expect(urlsHit()).not.toContain("GET /hrms/exits");
  });
});

// ===========================================================================
// My exit
// ===========================================================================

describe("my exit", () => {
  it("offers to initiate when there is nothing filed", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    expect(await screen.findByText(/no active exit request/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Initiate resignation/i })).toBeTruthy();
    // One row, from a dedicated endpoint — not the whole list filtered locally.
    expect(urlsHit()).toContain("GET /hrms/exits/me");
    expect(urlsHit()).not.toContain("GET /hrms/exits");
  });

  it("shows the progress chain and the details of a live exit", async () => {
    installTransport({ "GET /hrms/exits/me": () => envelope(exitRow()) });
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    expect(await screen.findByText("My exit request")).toBeTruthy();
    expect(screen.getByText("Moving to another city.")).toBeTruthy();
    expect(screen.getByText("1 Mar 2026")).toBeTruthy();
    expect(screen.getByText("Not confirmed yet")).toBeTruthy();

    // Seven steps, not the reference's eight — its `hr_approved` is unreachable.
    const chain = screen.getByLabelText("Exit progress");
    expect(within(chain).getAllByRole("listitem")).toHaveLength(7);
    expect(within(chain).queryByText(/HR approved/i)).toBeNull();
  });

  it("withdraws after confirming, and not before", async () => {
    installTransport({ "GET /hrms/exits/me": () => envelope(exitRow()) });
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    await userEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText(/Withdraw your exit request\?/i)).toBeTruthy();
    expect(urlsHit().some((u) => u.includes("/cancel"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    await waitFor(() =>
      expect(urlsHit()).toContain(`POST /hrms/exits/${EXIT_ID}/cancel`),
    );
  });

  it("does not offer withdrawal once the clearances are done", async () => {
    installTransport({
      "GET /hrms/exits/me": () => envelope(exitRow({ status: "cleared" })),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    expect(await screen.findByText(/ask HR to withdraw this/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("shows the clearance progress", async () => {
    installTransport({
      "GET /hrms/exits/me": () =>
        envelope(
          exitRow({
            status: "clearance_pending",
            clearances: [
              clearance({ id: "c1", area: "it", status: "completed" }),
              clearance({ id: "c2", area: "hr", status: "pending" }),
            ],
          }),
        ),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    expect(await screen.findByText("1 of 2 cleared")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Clearance progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
  });

  it("shows the settlement with money to two decimal places", async () => {
    installTransport({
      "GET /hrms/exits/me": () =>
        envelope(exitRow({ status: "f_and_f_pending", fullAndFinal: settlement() })),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    expect(await screen.findByText("₹ 1,09,212.33")).toBeTruthy();
    expect(screen.getByText("₹ 1,12,500.00")).toBeTruthy();
    expect(screen.getByText(/Awaiting disbursement/i)).toBeTruthy();
  });

  it("a cancelled exit shows no progress track and lets a new one be filed", async () => {
    installTransport({
      "GET /hrms/exits/me": () =>
        envelope(exitRow({ status: "cancelled", cancelledAt: "2026-01-05T00:00:00.000Z" })),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    expect(await screen.findByText(/previous exit request/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Initiate resignation/i })).toBeTruthy();
  });

  it("fetches a short-lived URL for the relieving letter rather than linking at it", async () => {
    const opened = [];
    vi.spyOn(window, "open").mockImplementation((url) => opened.push(url));

    installTransport({
      "GET /hrms/exits/me": () =>
        envelope(
          exitRow({
            status: "closed",
            actualLastDay: "2026-03-01",
            closedAt: "2026-03-02T00:00:00.000Z",
            relievingLetter: { generatedAt: "2026-03-02T00:00:00.000Z" },
          }),
        ),
      [`GET /hrms/exits/${EXIT_ID}/relieving-letter/url`]: () =>
        envelope({ url: "https://signed.example/letter", expiresInSeconds: 300 }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    const view = await screen.findByRole("button", { name: /View letter/i });
    expect(view.tagName).toBe("BUTTON");
    await userEvent.click(view);

    await waitFor(() => expect(opened).toContain("https://signed.example/letter"));
    window.open.mockRestore();
  });

  it("renders an error with a retry that refetches", async () => {
    installTransport({
      "GET /hrms/exits/me": () => fail(500, { message: "Server error" }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/mine");

    const retry = await screen.findByRole("button", { name: /try again|retry/i });
    const before = calls.length;
    await userEvent.click(retry);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });
});

// ===========================================================================
// Initiating
// ===========================================================================

describe("the initiate drawer", () => {
  const openDrawer = async (roles = [R.EMPLOYEE]) => {
    signIn(roles);
    at("/hrms/exits/mine");
    await userEvent.click(
      await screen.findByRole("button", { name: /Initiate resignation/i }),
    );
    return screen.findByLabelText("Reason");
  };

  it("does NOT offer termination as a self-service category", async () => {
    // The reference hides it too — but its schema accepts it from anyone, so an
    // employee could post a self-termination. The server refuses that here.
    await openDrawer();

    const select = screen.getByLabelText("Category");
    expect(within(select).getByText("Resignation")).toBeTruthy();
    expect(within(select).getByText("Retirement")).toBeTruthy();
    expect(within(select).queryByText("Termination")).toBeNull();
  });

  it("refuses to post an incomplete request", async () => {
    await openDrawer();
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(urlsHit().filter((u) => u === "POST /hrms/exits")).toHaveLength(0),
    );
  });

  it("refuses a backdated last working day, in the browser", async () => {
    await openDrawer();

    await userEvent.type(screen.getByLabelText("Reason"), "Relocating.");
    const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const dateField = screen.getByLabelText("Requested last working day");
    await userEvent.clear(dateField);
    await userEvent.type(dateField, past);
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(urlsHit().filter((u) => u === "POST /hrms/exits")).toHaveLength(0),
    );
  });

  it("never sends an employeeId for a self-service resignation", async () => {
    await openDrawer();

    await userEvent.type(screen.getByLabelText("Reason"), "Moving to another city.");
    await userEvent.type(
      screen.getByLabelText("Requested last working day"),
      futureDay(45),
    );
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/exits");
      expect(post).toBeTruthy();
      // The server resolves whose exit it is from the signed-in actor.
      expect(post.data.employeeId).toBeUndefined();
      expect(post.data.reasonCategory).toBe("resignation");
      expect(post.data.reason).toBe("Moving to another city.");
    });
  });

  it("caps the date picker at today or later, in the VIEWER's calendar", async () => {
    await openDrawer();
    // Local getters, not `toISOString()`. The drawer computes today in the
    // viewer's own calendar deliberately — a last working day is a day, not an
    // instant — and UTC disagrees with it for the first 5.5 hours of every
    // day in IST. Asserting in UTC made this test fail between midnight and
    // 05:30 local, every night.
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    expect(
      screen.getByLabelText("Requested last working day").getAttribute("min"),
    ).toBe(today);
  });
});

// ===========================================================================
// Exit requests (HR / manager)
// ===========================================================================

describe("the exit requests tab", () => {
  const openRequests = async (roles = [R.HR_ADMIN], row = exitRow({ isOwnExit: false })) => {
    installTransport({
      "GET /hrms/exits": () => page([row]),
      "GET /hrms/exits/me": () => envelope(null),
    });
    signIn(roles);
    at("/hrms/exits/requests");
    return screen.findByText("Sam Person");
  };

  it("lists requests from the server, scoped and paged", async () => {
    await openRequests();

    const listCall = calls.find((c) => c.url === "/hrms/exits");
    expect(listCall.params.page).toBe(1);
    expect(listCall.params.pageSize).toBe(15);
  });

  it("filters by status through the SERVER", async () => {
    await openRequests();
    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "in_notice");

    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(last.params.status).toBe("in_notice");
    });
  });

  it("offers only the action the current state allows", async () => {
    await openRequests([R.HR_ADMIN], exitRow({ isOwnExit: false, status: "in_notice" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));

    // `in_notice` → open clearances. Nothing else.
    expect(await screen.findByRole("button", { name: /Open clearances/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Compute settlement/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /HR approve/i })).toBeNull();
  });

  it("offers NO approval on the approver's own exit", async () => {
    await openRequests([R.HR_ADMIN], exitRow({ isOwnExit: true, status: "initiated" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));

    expect(await screen.findByText(/This is your own exit/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve as manager/i })).toBeNull();
  });

  it("a manager is not offered the HR-only steps", async () => {
    await openRequests(
      [R.MANAGER],
      exitRow({ isOwnExit: false, status: "manager_approved" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));

    // Wait for the drawer itself before asserting on what it does NOT contain.
    expect(await screen.findByText(/Exit — Sam Person/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /HR approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open clearances/i })).toBeNull();
    // And no handover editor either — that is HR's.
    expect(screen.queryByRole("button", { name: /Save handover/i })).toBeNull();
  });

  it("HR approves and the list refreshes", async () => {
    await openRequests([R.HR_ADMIN], exitRow({ isOwnExit: false, status: "manager_approved" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));
    await userEvent.click(await screen.findByRole("button", { name: /HR approve/i }));

    await waitFor(() =>
      expect(urlsHit()).toContain(`POST /hrms/exits/${EXIT_ID}/hr-approve`),
    );
  });

  it("the settlement preview is fetched with a GET and changes nothing", async () => {
    installTransport({
      "GET /hrms/exits": () => page([exitRow({ isOwnExit: false, status: "cleared" })]),
      "GET /hrms/exits/me": () => envelope(null),
      [`GET /hrms/exits/${EXIT_ID}/fnf/preview`]: () =>
        envelope({ ...settlement(), notes: [], computable: true }),
    });
    signIn([R.HR_ADMIN]);
    at("/hrms/exits/requests");

    await userEvent.click(await screen.findByRole("button", { name: "Manage" }));
    expect(await screen.findByText("Settlement preview")).toBeTruthy();
    expect(screen.getByText(/Nothing is saved until you compute/i)).toBeTruthy();

    // The reference's preview shares its computation with the create path and
    // zeroes loan balances. Ours is a GET, and only a GET.
    const previewCalls = calls.filter((c) => c.url?.includes("/fnf/preview"));
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0].method).toBe("get");
    expect(urlsHit().some((u) => u === `POST /hrms/exits/${EXIT_ID}/fnf`)).toBe(false);
  });

  it("says so when a settlement cannot be computed", async () => {
    installTransport({
      "GET /hrms/exits": () => page([exitRow({ isOwnExit: false, status: "cleared" })]),
      "GET /hrms/exits/me": () => envelope(null),
      [`GET /hrms/exits/${EXIT_ID}/fnf/preview`]: () =>
        envelope({
          ...settlement(),
          computable: false,
          notes: ["This employee has no active compensation record."],
        }),
    });
    signIn([R.HR_ADMIN]);
    at("/hrms/exits/requests");

    await userEvent.click(await screen.findByRole("button", { name: "Manage" }));
    expect(await screen.findByText(/no active compensation record/i)).toBeTruthy();
  });

  it("saves the handover pair — replacement and transfer notes", async () => {
    installTransport({
      "GET /hrms/exits": () => page([exitRow({ isOwnExit: false, status: "in_notice" })]),
      "GET /hrms/exits/me": () => envelope(null),
      "GET /hrms/employees": () =>
        page([{ id: OTHER, firstName: "Successor", lastName: "Person", employeeCode: "SI-9" }]),
    });
    signIn([R.HR_ADMIN]);
    at("/hrms/exits/requests");

    await userEvent.click(await screen.findByRole("button", { name: "Manage" }));
    const notes = await screen.findByLabelText("Transfer notes");
    await userEvent.type(notes, "Handing over the Indore accounts.");
    await userEvent.click(screen.getByRole("button", { name: /Save handover/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "patch" && c.url === `/hrms/exits/${EXIT_ID}`);
      expect(patch).toBeTruthy();
      expect(patch.data.transferNotes).toBe("Handing over the Indore accounts.");
    });
  });

  it("a closed exit shows the handover read-only", async () => {
    await openRequests(
      [R.HR_ADMIN],
      exitRow({ isOwnExit: false, status: "closed", transferNotes: "All done." }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));

    expect(await screen.findByText(/can no longer be edited/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save handover/i })).toBeNull();
  });

  it("renders the empty state", async () => {
    installTransport({ "GET /hrms/exits": () => page([]) });
    signIn([R.HR_ADMIN]);
    at("/hrms/exits/requests");

    expect(await screen.findByText("No exit requests")).toBeTruthy();
  });
});

// ===========================================================================
// Clearance queue
// ===========================================================================

describe("the clearance queue", () => {
  const queueFor = (rows) => ({
    "GET /hrms/exits": (config) =>
      config.params?.status === "clearance_pending" ? page(rows) : page([]),
    "GET /hrms/exits/me": () => envelope(null),
  });

  it("asks the server only for exits awaiting clearance", async () => {
    installTransport(queueFor([]));
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/clearances");

    await screen.findByText("Nothing awaiting you");
    const listCall = calls.find((c) => c.url === "/hrms/exits");
    expect(listCall.params.status).toBe("clearance_pending");
  });

  it("shows only the clearances assigned to me, and only outstanding ones", async () => {
    installTransport(
      queueFor([
        exitRow({
          isOwnExit: false,
          employeeName: "Leaver One",
          status: "clearance_pending",
          clearances: [
            clearance({ id: "mine-pending", area: "it", assigneeEmployeeId: ME }),
            clearance({
              id: "mine-done",
              area: "hr",
              assigneeEmployeeId: ME,
              status: "completed",
            }),
            clearance({ id: "someone-else", area: "finance", assigneeEmployeeId: OTHER }),
          ],
        }),
      ]),
    );
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/clearances");

    expect(await screen.findByText("Leaver One")).toBeTruthy();
    expect(screen.getByText("IT")).toBeTruthy();
    // Already done, and somebody else's — neither belongs in the queue.
    expect(screen.queryByText("HR")).toBeNull();
    expect(screen.queryByText("Finance")).toBeNull();
  });

  it("never lists a clearance on my OWN exit", async () => {
    installTransport(
      queueFor([
        exitRow({
          isOwnExit: true,
          status: "clearance_pending",
          clearances: [clearance({ id: "own", area: "it", assigneeEmployeeId: ME })],
        }),
      ]),
    );
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/clearances");

    expect(await screen.findByText("Nothing awaiting you")).toBeTruthy();
  });

  it("starts, completes and waives a clearance", async () => {
    installTransport(
      queueFor([
        exitRow({
          isOwnExit: false,
          status: "clearance_pending",
          clearances: [clearance({ id: "mine", area: "it", assigneeEmployeeId: ME })],
        }),
      ]),
    );
    signIn([R.EMPLOYEE]);
    at("/hrms/exits/clearances");

    await userEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "patch");
      expect(patch.url).toBe(`/hrms/exits/${EXIT_ID}/clearances/mine`);
      expect(patch.data.status).toBe("in_progress");
    });
  });
});
