import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { O2dPage } from "./O2dPage";
import { useUserStore } from "../../store/userStore";
import { api } from "../../services/api";
import { PERMISSIONS } from "../../utils/permissions";
import { o2dRoute } from "@shared/constants/o2d.js";

/**
 * The Stages view — one tab per workflow stage.
 *
 * The behaviours asserted are the ones the screen exists for: every stage has a
 * tab, the tab carries its load, clicking one narrows the list to that stage,
 * and the choice survives a link being pasted. Queried by role and visible text
 * so the markup can change without these needing to.
 */

vi.mock("../../services/api", () => ({ api: { request: vi.fn() } }));
vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const envelope = (payload) => ({ data: { success: true, data: payload } });
const page = (rows, extra = {}) =>
  envelope({ data: rows, total: rows.length, page: 1, pageSize: 25, ...extra });

/**
 * A twelve-row board, with work parked at stages 2 and 7.
 *
 * Stage 7 is deliberately the one with overdue work AND not the first non-empty
 * stage, so "opens on the first stage with work" and "overdue is highlighted"
 * cannot both be satisfied by accident.
 */
const BOARD = [
  { stageNumber: 1, key: "receive_order", name: "Receive Order", ownerRole: "Sales", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
  { stageNumber: 2, key: "submit_po", name: "Submit PO to Billing", ownerRole: "Sales", total: 3, overdue: 0, dueSoon: 1, onHold: 0 },
  { stageNumber: 3, key: "sor_pi", name: "Send SOR + PI to Customer", ownerRole: "Billing", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
  { stageNumber: 4, key: "advance_decision", name: "Advance Order Decision", ownerRole: "Billing", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
  { stageNumber: 5, key: "advance_payment", name: "Receive Advance Payment", ownerRole: "Accounts", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
  { stageNumber: 6, key: "order_list", name: "Create Order List", ownerRole: "Billing", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
  { stageNumber: 7, key: "picking", name: "Warehouse Picking Request", ownerRole: "Warehouse User", total: 2, overdue: 2, dueSoon: 0, onHold: 1 },
  { stageNumber: 8, key: "invoice", name: "Scan Material + Create Invoice", ownerRole: "Warehouse User", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
  { stageNumber: 9, key: "dispatch", name: "Pack & Dispatch", ownerRole: "Warehouse User", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
  { stageNumber: 10, key: "mark_sent", name: "Mark Sent in Zoho", ownerRole: "Billing", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
  { stageNumber: 11, key: "dispatch_details", name: "Send Dispatch Details", ownerRole: "Billing", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
  { stageNumber: 12, key: "close", name: "Upload AWB/LR + Close Order", ownerRole: "Billing", total: 0, overdue: 0, dueSoon: 0, onHold: 0 },
];

const ORDER_AT_2 = {
  _id: "o1", poNumber: "PO-4471", customerName: "ABC Industries",
  poDate: "2026-09-14T03:30:00.000Z", promiseDate: "2026-09-25T04:30:00.000Z",
  currentStage: 2, status: "OPEN", dispatchedAt: null,
};
const ORDER_AT_7 = {
  _id: "o2", poNumber: "PO-9002", customerName: "XYZ Traders",
  poDate: "2026-09-10T03:30:00.000Z", promiseDate: "2026-09-20T04:30:00.000Z",
  currentStage: 7, status: "OPEN", dispatchedAt: null,
};

/** Every request, so the stage parameter actually sent can be asserted. */
let sent;

function installTransport(overrides = {}) {
  sent = [];
  const routes = {
    "GET /o2d/stages/board": envelope(BOARD),
    "GET /o2d/tasks": page([]),
    "GET /o2d/tasks/counts": envelope({ total: 0, overdue: 0, dueSoon: 0, onTrack: 0, actionable: 0 }),
    ...overrides,
  };

  api.request.mockImplementation(async (config) => {
    sent.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;

    // The orders list answers according to the stage it was asked for, so a
    // test that clicks a tab sees a genuinely different result rather than the
    // same fixture twice.
    if (key === "GET /o2d/orders") {
      // The board now asks `stageReached` by default — what has PASSED through
      // a stage rather than what is sitting in it. `currentStage` is still sent
      // when the user switches to "Here now", so the fixture honours both.
      const stage = config.params?.stageReached ?? config.params?.currentStage;
      const rows = [ORDER_AT_2, ORDER_AT_7].filter((o) => o.currentStage === stage);
      return page(rows);
    }
    if (routes[key]) return routes[key];
    throw Object.assign(new Error(`Unrouted ${key}`), {
      response: { status: 404, data: { message: "Not found" } },
    });
  });
}

const signIn = () =>
  useUserStore.setState({
    user: { _id: "u1", user: "Tester", role: "Super Admin", permissions: [PERMISSIONS.VIEW_O2D] },
    loading: false,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/fms/o2d/:tab" element={<O2dPage />} />
      </Routes>
    </MemoryRouter>,
  );

const listCalls = () => sent.filter((c) => c.url === "/o2d/orders");

beforeEach(() => {
  installTransport();
  useUserStore.setState({ user: null, loading: false });
});

// ---------------------------------------------------------------------------

describe("the stage rail", () => {
  test("offers a tab for every one of the twelve stages", async () => {
    signIn();
    at(o2dRoute("stages"));

    const rail = await screen.findByRole("tablist", { name: /workflow stages/i });
    const tabs = await within(rail).findAllByRole("tab");
    expect(tabs).toHaveLength(12);
  });

  test("names the stages rather than numbering them generically", async () => {
    signIn();
    at(o2dRoute("stages"));

    expect(await screen.findByRole("tab", { name: /Warehouse Picking Request/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Upload AWB\/LR \+ Close Order/ })).toBeTruthy();
  });

  test("an empty stage still gets a tab", async () => {
    signIn();
    at(o2dRoute("stages"));

    // Stage 9 has nothing in it. Dropping it would make "no orders at Pack &
    // Dispatch" indistinguishable from "there is no such stage".
    expect(await screen.findByRole("tab", { name: /Pack & Dispatch/ })).toBeTruthy();
  });

  test("each tab carries its own count", async () => {
    signIn();
    at(o2dRoute("stages"));

    const tab = await screen.findByRole("tab", { name: /Submit PO to Billing/ });
    expect(tab.textContent).toMatch(/3/);
  });
});

describe("selecting a stage", () => {
  test("opens on the first stage that actually has work", async () => {
    signIn();
    at(o2dRoute("stages"));

    // Stage 1 is empty; stage 2 is the first with anything in it.
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls()[0].params.stageReached).toBe(2);
    expect(await screen.findByText("PO-4471")).toBeTruthy();
  });

  test("clicking a stage narrows the list to that stage", async () => {
    signIn();
    const user = userEvent.setup();
    at(o2dRoute("stages"));

    await user.click(await screen.findByRole("tab", { name: /Warehouse Picking Request/ }));

    await waitFor(() =>
      expect(listCalls().some((c) => c.params.stageReached === 7)).toBe(true),
    );
    expect(await screen.findByText("PO-9002")).toBeTruthy();
    expect(screen.queryByText("PO-4471")).toBeNull();
  });

  test("a pasted link opens the stage it names", async () => {
    signIn();
    at(`${o2dRoute("stages")}?stage=7`);

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    // Not stage 2, which is where it would land with no parameter.
    expect(listCalls()[0].params.stageReached).toBe(7);
  });

  test("a stage number that is not on the board is ignored, not obeyed", async () => {
    signIn();
    at(`${o2dRoute("stages")}?stage=99`);

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls()[0].params.stageReached).toBe(2);
  });

  test("the selected stage names its owner and its late count", async () => {
    signIn();
    const user = userEvent.setup();
    at(o2dRoute("stages"));

    await user.click(await screen.findByRole("tab", { name: /Warehouse Picking Request/ }));

    expect(await screen.findByText("Warehouse User")).toBeTruthy();
    expect(screen.getByText(/2 overdue/)).toBeTruthy();
    expect(screen.getByText(/1 on hold/)).toBeTruthy();
  });
});

describe("the rail's keyboard behaviour", () => {
  /*
   * The arrows and the edge fades are not asserted here, and deliberately so:
   * both are driven by `clientWidth` / `scrollWidth`, which jsdom reports as 0
   * for every element. A test for them would be asserting that jsdom has no
   * layout engine, not that the rail works.
   *
   * What IS testable is the part a `role="tablist"` actually promises, and the
   * part that breaks silently when someone edits the markup later.
   */

  test("only the selected stage is in the tab order", async () => {
    signIn();
    at(o2dRoute("stages"));

    const rail = await screen.findByRole("tablist", { name: /workflow stages/i });
    const tabs = within(rail).getAllByRole("tab");

    // Twelve tabs in the tab order would cost twelve Tab presses to get past.
    const reachable = tabs.filter((t) => t.getAttribute("tabindex") === "0");
    expect(reachable).toHaveLength(1);
    expect(reachable[0].getAttribute("aria-selected")).toBe("true");
  });

  test("the right arrow key moves to the next stage", async () => {
    signIn();
    const user = userEvent.setup();
    at(o2dRoute("stages"));

    // Opens on stage 2, the first with work; the roving tabindex puts focus
    // there, and the keydown bubbles from the tab to the tablist.
    const rail = await screen.findByRole("tablist", { name: /workflow stages/i });
    within(rail).getAllByRole("tab").find((t) => t.tabIndex === 0).focus();
    await user.keyboard("{ArrowRight}");

    await waitFor(() =>
      expect(listCalls().some((c) => c.params.stageReached === 3)).toBe(true),
    );
  });

  test("End jumps to the last stage and Home back to the first", async () => {
    signIn();
    const user = userEvent.setup();
    at(o2dRoute("stages"));

    const rail = await screen.findByRole("tablist", { name: /workflow stages/i });
    const focusSelected = () =>
      within(rail).getAllByRole("tab").find((t) => t.tabIndex === 0).focus();

    focusSelected();
    await user.keyboard("{End}");
    await waitFor(() =>
      expect(listCalls().some((c) => c.params.stageReached === 12)).toBe(true),
    );

    // Selection moved, so the roving tabindex moved with it.
    focusSelected();
    await user.keyboard("{Home}");
    await waitFor(() =>
      expect(listCalls().some((c) => c.params.stageReached === 1)).toBe(true),
    );
  });

  test("arrowing past the end stays put rather than wrapping around", async () => {
    signIn();
    const user = userEvent.setup();
    at(`${o2dRoute("stages")}?stage=12`);

    const rail = await screen.findByRole("tablist", { name: /workflow stages/i });
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    within(rail).getAllByRole("tab").find((t) => t.tabIndex === 0).focus();
    await user.keyboard("{ArrowRight}");

    // The stages are a pipeline; hopping from 12 to 1 would misrepresent it.
    expect(listCalls().every((c) => c.params.stageReached === 12)).toBe(true);
    expect(
      (await screen.findByRole("tab", { name: /Upload AWB\/LR \+ Close Order/ }))
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("when the board cannot be loaded", () => {
  test("the failure is reported instead of an empty rail", async () => {
    installTransport({ "GET /o2d/stages/board": undefined });
    api.request.mockImplementation(async (config) => {
      sent.push(config);
      if (config.url === "/o2d/stages/board") {
        throw Object.assign(new Error("boom"), {
          response: { status: 500, data: { message: "Board unavailable" } },
        });
      }
      return page([]);
    });

    signIn();
    at(o2dRoute("stages"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Board unavailable/)).toBeTruthy();
  });
});
