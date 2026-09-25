import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { O2dPage } from "./O2dPage";
import { O2dBell } from "./O2dBell";
import { useUserStore } from "../../store/userStore";
import { api } from "../../services/api";
import { PERMISSIONS } from "../../utils/permissions";
import { o2dRoute } from "@shared/constants/o2d.js";

/**
 * O2D screens.
 *
 * Only the AXIOS transport is mocked — the permission helpers, the shared
 * constants and the service layer are all real, so a test passing here means
 * those agree with each other. Assertions are behavioural and queried by role
 * or visible text, in the same style as the HRMS tests.
 */

vi.mock("../../services/api", () => ({ api: { request: vi.fn() } }));
vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const envelope = (payload) => ({ data: { success: true, data: payload } });
const page = (rows, extra = {}) =>
  envelope({ data: rows, total: rows.length, page: 1, pageSize: 25, ...extra });

const TASK = {
  _id: "s1",
  stageNumber: 2,
  stageName: "Submit PO to Billing",
  ownerRole: "Sales",
  status: "PENDING",
  plannedCompletion: "2026-09-14T05:05:00.000Z",
  bucket: "overdue",
  actionable: true,
  order: { _id: "o1", poNumber: "PO-4471", customerName: "ABC Industries" },
};

const ORDER_ROW = {
  _id: "o1",
  poNumber: "PO-4471",
  customerName: "ABC Industries",
  poDate: "2026-09-14T03:30:00.000Z",
  promiseDate: "2026-09-25T04:30:00.000Z",
  currentStage: 2,
  status: "OPEN",
  dispatchedAt: null,
};

/** Route table keyed "GET /o2d/tasks", mirroring the HRMS test helper. */
function installTransport(overrides = {}) {
  const routes = {
    "GET /o2d/tasks": page([TASK], { actionable: [2], watching: [] }),
    "GET /o2d/tasks/counts": envelope({
      total: 1, overdue: 1, dueSoon: 0, onTrack: 0, actionable: 1,
    }),
    "GET /o2d/orders": page([ORDER_ROW]),
    "GET /o2d/exit-register": page([]),
    ...overrides,
  };

  api.request.mockImplementation(async (config) => {
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (routes[key]) return routes[key];
    throw Object.assign(new Error(`Unrouted ${key}`), {
      response: { status: 404, data: { message: "Not found" } },
    });
  });
}

const signIn = (role, permissions) =>
  useUserStore.setState({ user: { _id: "u1", user: "Tester", role, permissions }, loading: false });

/**
 * Mounted at the REAL prefix, `/fms/o2d/:tab` (§1).
 *
 * Not `/o2d/:tab` with the paths hardcoded: `O2dPage` builds its tab links from
 * `o2dRoute`, so a test router mounted somewhere else would make every tab
 * click land on an unmatched route and render nothing — a failure that looks
 * like a broken component rather than a stale test.
 */
const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/fms/o2d/:tab" element={<O2dPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  installTransport();
  useUserStore.setState({ user: null, loading: false });
});

// ---------------------------------------------------------------------------

describe("My Tasks", () => {
  test("lists the caller's open stages with the order they belong to", async () => {
    signIn("Billing", [PERMISSIONS.VIEW_O2D, PERMISSIONS.WORK_O2D_STAGE]);
    at(o2dRoute("tasks"));

    expect(await screen.findByText("PO-4471")).toBeTruthy();
    expect(screen.getByText("ABC Industries")).toBeTruthy();
    expect(screen.getByText("2. Submit PO to Billing")).toBeTruthy();
  });

  test("says whether the row is the caller's to complete", async () => {
    signIn("Billing", [PERMISSIONS.VIEW_O2D, PERMISSIONS.WORK_O2D_STAGE]);
    at(o2dRoute("tasks"));

    expect(await screen.findByRole("button", { name: "Complete" })).toBeTruthy();
  });

  test("a stage the caller only WATCHES is labelled, not offered", async () => {
    // The distinction §5/§10 draws: Sales owns stage 2, Billing closes it.
    installTransport({
      "GET /o2d/tasks": page([{ ...TASK, actionable: false }], { actionable: [], watching: [2] }),
    });
    signIn("Sales", [PERMISSIONS.VIEW_O2D, PERMISSIONS.WORK_O2D_STAGE]);
    at(o2dRoute("tasks"));

    expect(await screen.findByText("Waiting on another team")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
  });

  test("shows the overdue count as a filter chip", async () => {
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("tasks"));

    expect(await screen.findByRole("button", { name: "Overdue 1" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("Order Tracker", () => {
  test("lists orders with their stage and status", async () => {
    signIn("Management", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("orders"));

    expect(await screen.findByText("PO-4471")).toBeTruthy();
    expect(screen.getByText("2 / 12")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
  });

  test("an order with no promise date reads as an override, not a blank", async () => {
    installTransport({
      "GET /o2d/orders": page([{ ...ORDER_ROW, promiseDate: null }]),
    });
    signIn("Management", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("orders"));

    // §27's exception must be visible on the tracker rather than inferred.
    expect(await screen.findByText("None — overridden")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("permission gating", () => {
  test("a role that cannot create orders is not offered the button", async () => {
    signIn("Import Team", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("orders"));

    await screen.findByText("PO-4471");
    expect(screen.queryByRole("button", { name: "New order" })).toBeNull();
  });

  test("a role that can create orders is", async () => {
    signIn("Sales", [PERMISSIONS.VIEW_O2D, PERMISSIONS.CREATE_O2D_ORDER]);
    at(o2dRoute("orders"));

    expect(await screen.findByRole("button", { name: "New order" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("the tab lives in the URL", () => {
  test("each tab renders its own screen", async () => {
    signIn("Management", [PERMISSIONS.VIEW_O2D]);

    at(o2dRoute("exits"));
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Exit Register" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });

  test("the exit register reports an empty state rather than looking broken", async () => {
    signIn("Management", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("exits"));

    expect(await screen.findByText("Nothing has left the workflow")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("the notification bell", () => {
  const bellRoutes = (rows, unread) => ({
    "GET /o2d/notifications": envelope({ data: rows, unread }),
  });

  const NOTE = {
    _id: "n1",
    title: "Warehouse Picking Request is ready on PO-4471",
    body: "It is now waiting on your team.",
    createdAt: "2026-09-14T05:05:00.000Z",
    readAt: null,
    order: "o1",
  };

  const renderBell = () =>
    render(
      <MemoryRouter>
        <O2dBell />
      </MemoryRouter>,
    );

  test("shows the unread count", async () => {
    installTransport(bellRoutes([NOTE], 1));
    signIn("Warehouse User", [PERMISSIONS.VIEW_O2D]);
    renderBell();

    expect(await screen.findByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();
  });

  test("renders nothing at all for an account without VIEW_O2D", async () => {
    installTransport(bellRoutes([NOTE], 1));
    signIn("Customer", []);
    const { container } = renderBell();

    // Not merely hidden — absent, so it never polls an endpoint it would be
    // refused from.
    expect(container.innerHTML).toBe("");
  });

  test("caps a runaway count rather than breaking the badge", async () => {
    installTransport(bellRoutes([NOTE], 250));
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    renderBell();

    expect(await screen.findByText("99+")).toBeTruthy();
  });

  test("lists the notifications when opened", async () => {
    installTransport(bellRoutes([NOTE], 1));
    signIn("Warehouse User", [PERMISSIONS.VIEW_O2D]);
    renderBell();

    const button = await screen.findByRole("button", { name: /Notifications/ });
    fireEvent.click(button);

    expect(
      await screen.findByText("Warehouse Picking Request is ready on PO-4471"),
    ).toBeTruthy();
  });

  test("an empty inbox says so instead of looking broken", async () => {
    installTransport(bellRoutes([], 0));
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("Nothing yet.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("the analytics tab", () => {
  const DASHBOARD = (over = {}) =>
    envelope({
      summary: { open: 4, onHold: 1, closed: 10, dispatched: 9, overdueStages: 2, total: 15 },
      sla: {
        onTimePercentage: 94,
        completed: 50,
        onTime: 47,
        late: 3,
        byStage: [
          {
            stageNumber: 3,
            stageName: "Send SOR + PI",
            ownerRole: "Billing",
            completed: 20,
            onTimePercentage: 95,
            averageDelayMinutes: 45,
          },
        ],
        coverage: {
          ordersInRange: 2615,
          ordersScored: 300,
          ordersExcluded: 2315,
          stagesSkipped: 4,
          complete: false,
          note: "2315 of 2615 order(s) are migrated history and carry actual dates only.",
        },
      },
      delays: { data: [], coverage: { complete: true } },
      roles: { data: [] },
      cycle: { medianHours: 48, averageHours: 61, count: 2400, includesMigrated: true, migratedCount: 2315 },
      customers: { data: [] },
      ...over,
    });

  const analyticsRoutes = (over) => ({ "GET /o2d/analytics": DASHBOARD(over) });

  const MANAGER = [PERMISSIONS.VIEW_O2D, PERMISSIONS.VIEW_O2D_ANALYTICS];

  test("is offered only to a role holding VIEW_O2D_ANALYTICS", async () => {
    installTransport();
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("orders"));

    await screen.findByText("PO-4471");
    expect(screen.queryByRole("tab", { name: "Analytics" })).toBeNull();
  });

  test("and is offered to one that does", async () => {
    installTransport();
    signIn("Management", MANAGER);
    at(o2dRoute("orders"));

    expect(await screen.findByRole("tab", { name: "Analytics" })).toBeTruthy();
  });

  test("renders the coverage caveat BESIDE the on-time figure, not as a footnote", async () => {
    installTransport(analyticsRoutes());
    signIn("Management", MANAGER);
    at(o2dRoute("analytics"));

    // The number...
    expect(await screen.findByText("94")).toBeTruthy();
    // ...and, unavoidably, what it actually covers.
    expect(screen.getByText("On-time figures cover 300 of 2615 orders.")).toBeTruthy();
    expect(
      screen.getByText(/migrated history and carry actual dates only/),
    ).toBeTruthy();
  });

  test("says out loud that cycle time uses a different denominator", async () => {
    installTransport(analyticsRoutes());
    signIn("Management", MANAGER);
    at(o2dRoute("analytics"));

    expect(
      await screen.findByText(/Includes 2315 migrated order\(s\)/),
    ).toBeTruthy();
  });

  test("shows no banner when every order in range can be scored", async () => {
    installTransport(
      analyticsRoutes({
        sla: {
          onTimePercentage: 100,
          completed: 10,
          onTime: 10,
          late: 0,
          byStage: [],
          coverage: { ordersInRange: 10, ordersScored: 10, ordersExcluded: 0, complete: true, note: null },
        },
      }),
    );
    signIn("Management", MANAGER);
    at(o2dRoute("analytics"));

    await screen.findByText("100");
    // A permanent "everything is included" banner is one people stop reading.
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("an unscorable range shows a dash, never 0%", async () => {
    installTransport(
      analyticsRoutes({
        sla: {
          onTimePercentage: null,
          completed: 0,
          onTime: 0,
          late: 0,
          byStage: [],
          coverage: { ordersInRange: 5, ordersScored: 0, ordersExcluded: 5, complete: false, note: "All migrated." },
        },
      }),
    );
    signIn("Management", MANAGER);
    at(o2dRoute("analytics"));

    // 0% would read as "everything was late" — a crisis that did not happen.
    expect(await screen.findByText("Nothing in this range could be scored.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("a task stays visible in the stages it has passed", () => {
  /** The same order, in a stage it finished AND the stage it is now in. */
  const PASSED = {
    ...TASK,
    _id: "s-done",
    stageNumber: 2,
    stageName: "Submit PO to Billing",
    status: "DONE_ON_TIME",
    completed: true,
    actionable: false,
    displayStatus: "DONE",
    actualCompletion: "2026-09-14T05:00:00.000Z",
  };
  const ACTIVE = {
    ...TASK,
    _id: "s-open",
    stageNumber: 3,
    stageName: "Send SOR + PI",
    status: "PENDING",
    completed: false,
    actionable: true,
    displayStatus: "IN_PROGRESS",
  };

  const bothRows = (over = {}) => ({
    "GET /o2d/tasks": page([ACTIVE, PASSED], { actionable: [3], watching: [] }),
    "GET /o2d/tasks/counts": envelope({
      total: 1, overdue: 0, dueSoon: 0, onTrack: 1, actionable: 1, completed: 1,
    }),
    ...over,
  });

  test("a finished stage reads Completed, not 'waiting on another team'", async () => {
    installTransport(bothRows());
    signIn("Billing", [PERMISSIONS.VIEW_O2D, PERMISSIONS.WORK_O2D_STAGE]);
    at(o2dRoute("tasks"));

    // The retained row is history. Labelling it as work waiting on somebody
    // else would be actively wrong about a stage this person finished.
    expect(await screen.findByText("Completed")).toBeTruthy();
  });

  test("the same order shows both where it has been and where it is", async () => {
    installTransport(bothRows());
    signIn("Billing", [PERMISSIONS.VIEW_O2D, PERMISSIONS.WORK_O2D_STAGE]);
    at(o2dRoute("tasks"));

    expect(await screen.findByText("2. Submit PO to Billing")).toBeTruthy();
    expect(screen.getByText("3. Send SOR + PI")).toBeTruthy();
    // One is finished, the other is the work.
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Complete" })).toBeTruthy();
  });

  test("the badge counts work to do, not the retained history", async () => {
    installTransport(bothRows());
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("tasks"));

    // "All 1", not "All 2" — a badge that counted history would show a
    // warehouse user hundreds of tasks when three are theirs.
    expect(await screen.findByRole("button", { name: "All 1" })).toBeTruthy();
  });

  test("offers a way back to the plain to-do list", async () => {
    installTransport(bothRows());
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("tasks"));

    expect(await screen.findByRole("button", { name: "To do only" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Including done 1" })).toBeTruthy();
  });

  test("a finished row carries no overdue badge", async () => {
    // Its deadline is no longer something anybody can act on; a red marker
    // there would be a permanent complaint about work already done.
    installTransport({
      "GET /o2d/tasks": page([{ ...PASSED, bucket: "overdue" }], { actionable: [], watching: [2] }),
      "GET /o2d/tasks/counts": envelope({
        total: 0, overdue: 0, dueSoon: 0, onTrack: 0, actionable: 0, completed: 1,
      }),
    });
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("tasks"));

    await screen.findByText("Completed");
    expect(screen.queryByText("Overdue")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("the Order History tab", () => {
  const DELIVERED = {
    ...ORDER_ROW,
    _id: "o-done",
    poNumber: "PO-DONE",
    status: "CLOSED",
    currentStage: 12,
    dispatchedAt: "2026-09-13T09:00:00.000Z",
    invoiceNumber: "INV-2026-0412",
  };
  const CANCELLED = {
    ...ORDER_ROW,
    _id: "o-cancelled",
    poNumber: "PO-CANCELLED",
    status: "CANCELLED",
    currentStage: 4,
    dispatchedAt: null,
    invoiceNumber: null,
  };

  test("is offered as its own tab", async () => {
    installTransport();
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("tasks"));

    expect(await screen.findByRole("tab", { name: "Order History" })).toBeTruthy();
  });

  test("lists finished and cancelled orders, which the tracker hides", async () => {
    installTransport({ "GET /o2d/orders": page([DELIVERED, CANCELLED]) });
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("history"));

    expect(await screen.findByText("PO-DONE")).toBeTruthy();
    expect(screen.getByText("PO-CANCELLED")).toBeTruthy();
  });

  test("asks the server for every status, not the live default", async () => {
    installTransport({ "GET /o2d/orders": page([DELIVERED]) });
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("history"));

    await screen.findByText("PO-DONE");
    // The tracker's OPEN + ON_HOLD default is exactly what makes a delivered
    // order unreachable, so the history must override it explicitly.
    const call = api.request.mock.calls
      .map(([c]) => c)
      .find((c) => c.url === "/o2d/orders" && c.params?.status);
    expect(call.params.status).toContain("CLOSED");
    expect(call.params.status).toContain("CANCELLED");
  });

  test("shows how far each order got", async () => {
    installTransport({ "GET /o2d/orders": page([DELIVERED, CANCELLED]) });
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("history"));

    // "where did it stop" is the question asked of a cancelled order more than
    // any other.
    expect(await screen.findByText("Stage 12")).toBeTruthy();
    expect(screen.getByText("Stage 4")).toBeTruthy();
  });

  test("a row opens the order, so its journey is reachable from here", async () => {
    installTransport({ "GET /o2d/orders": page([DELIVERED]) });
    signIn("Billing", [PERMISSIONS.VIEW_O2D]);
    at(o2dRoute("history"));

    fireEvent.click(await screen.findByText("PO-DONE"));

    // The tab's own responsibility is to request the order. What the drawer
    // then renders — all twelve stages with their status, actor and timestamps
    // — is the drawer's, and is covered where that fixture lives.
    await waitFor(() =>
      expect(
        api.request.mock.calls.some(([c]) => c.url === "/o2d/orders/o-done"),
      ).toBe(true),
    );
  });
});
