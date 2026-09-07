/**
 * Org Chart tab (step 5C).
 *
 * Two halves. The layout maths is pure and tested directly — geometry asserted
 * through a rendered DOM would be testing jsdom. The component is tested for
 * what it must never do: invent a relationship the payload does not state, drop
 * a node, render a sensitive field, or make one request per person.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { OrgStructurePage } from "./OrgStructurePage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildForest, layoutForest, CARD_W, CARD_H, GAP_X, GAP_Y, PAD } from "./orgLayout";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const node = (id, over = {}) => ({
  id,
  displayName: `Person ${id}`,
  designation: null,
  departmentName: null,
  status: "active",
  reportingManagerId: null,
  managerOutsideView: false,
  managerCycleBroken: false,
  ...over,
});

// ===========================================================================
// Layout — pure
// ===========================================================================

describe("buildForest", () => {
  it("attaches reports to their manager and collects the roots", () => {
    const { roots } = buildForest([
      node("a"),
      node("b", { reportingManagerId: "a" }),
      node("c", { reportingManagerId: "a" }),
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((n) => n.id)).toEqual(["b", "c"]);
  });

  it("keeps several roots", () => {
    const { roots } = buildForest([node("a"), node("b"), node("c", { reportingManagerId: "a" })]);
    expect(roots.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("treats a manager who is not in the payload as absent, not as a link", () => {
    // The server already nulls the edge and sets managerOutsideView; this is
    // belt and braces for a payload that still carries a dangling id.
    const { roots } = buildForest([node("b", { reportingManagerId: "missing" })]);
    expect(roots.map((r) => r.id)).toEqual(["b"]);
  });

  it("never drops a node, even if the data contains a cycle", () => {
    // The reference's buildTree gives every node in a ring a parent, so none is
    // pushed as a root and the whole ring disappears from the chart - hiding
    // exactly the people whose data is broken.
    const { roots, detached } = buildForest([
      node("a", { reportingManagerId: "b" }),
      node("b", { reportingManagerId: "a" }),
    ]);

    expect(detached).toBeGreaterThan(0);
    const rendered = new Set();
    const walk = (n) => { rendered.add(n.id); n.children.forEach(walk); };
    roots.forEach(walk);
    expect([...rendered].sort()).toEqual(["a", "b"]);
  });

  it("a self-referencing row does not become its own parent", () => {
    const { roots } = buildForest([node("a", { reportingManagerId: "a" })]);
    expect(roots.map((r) => r.id)).toEqual(["a"]);
    expect(roots[0].children).toEqual([]);
  });

  it("handles an empty payload", () => {
    expect(buildForest([]).roots).toEqual([]);
  });
});

describe("layoutForest", () => {
  it("puts a lone node at the padding offset", () => {
    const { cards, width, height } = layoutForest(buildForest([node("a")]).roots);

    expect(cards).toHaveLength(1);
    expect(cards[0].left).toBe(PAD);
    expect(cards[0].top).toBe(PAD);
    expect(width).toBe(CARD_W + PAD * 2);
    expect(height).toBe(CARD_H + PAD * 2);
  });

  it("centres a parent over its children", () => {
    const { cards } = layoutForest(
      buildForest([
        node("a"),
        node("b", { reportingManagerId: "a" }),
        node("c", { reportingManagerId: "a" }),
      ]).roots,
    );

    const by = Object.fromEntries(cards.map((c) => [c.node.id, c]));
    expect(by.a.left).toBe((by.b.left + by.c.left) / 2);
  });

  it("puts each generation on its own row", () => {
    const { cards } = layoutForest(
      buildForest([node("a"), node("b", { reportingManagerId: "a" })]).roots,
    );
    const by = Object.fromEntries(cards.map((c) => [c.node.id, c]));
    expect(by.b.top - by.a.top).toBe(CARD_H + GAP_Y);
  });

  it("does not overlap siblings", () => {
    const { cards } = layoutForest(
      buildForest([
        node("a"),
        node("b", { reportingManagerId: "a" }),
        node("c", { reportingManagerId: "a" }),
      ]).roots,
    );

    const row = cards.filter((c) => c.node.id !== "a").sort((x, y) => x.left - y.left);
    expect(row[1].left - row[0].left).toBeGreaterThanOrEqual(CARD_W + GAP_X);
  });

  it("packs separate roots side by side without overlap", () => {
    const { cards } = layoutForest(buildForest([node("a"), node("b")]).roots);
    const [first, second] = cards.sort((x, y) => x.left - y.left);
    expect(second.left - first.left).toBeGreaterThanOrEqual(CARD_W + GAP_X);
  });

  it("emits one edge per manager link and none for a root", () => {
    const { edges } = layoutForest(
      buildForest([
        node("a"),
        node("b", { reportingManagerId: "a" }),
        node("c", { reportingManagerId: "b" }),
        node("d"),
      ]).roots,
    );
    expect(edges).toHaveLength(2);
  });

  it("is deterministic — the same input lays out identically", () => {
    const input = [
      node("a"),
      node("b", { reportingManagerId: "a" }),
      node("c", { reportingManagerId: "a" }),
    ];
    const once = layoutForest(buildForest(input).roots);
    const twice = layoutForest(buildForest(input).roots);

    expect(once.cards.map((c) => [c.node.id, c.left, c.top]))
      .toEqual(twice.cards.map((c) => [c.node.id, c.left, c.top]));
  });

  it("survives a deep chain without collapsing", () => {
    const chain = Array.from({ length: 25 }, (_, i) =>
      node(`n${i}`, { reportingManagerId: i === 0 ? null : `n${i - 1}` }),
    );
    const { cards, height } = layoutForest(buildForest(chain).roots);

    expect(cards).toHaveLength(25);
    expect(height).toBe(24 * (CARD_H + GAP_Y) + CARD_H + PAD * 2);
  });
});

// ===========================================================================
// The tab
// ===========================================================================

const TREE = [
  node("e1", { displayName: "Ceo One", designation: "CEO", departmentName: "Admin" }),
  node("e2", { displayName: "Mgr Two", designation: "Manager", departmentName: "Engineering", reportingManagerId: "e1" }),
  node("e3", { displayName: "Dev Three", designation: "Developer", departmentName: "Engineering", reportingManagerId: "e2", status: "probation" }),
  node("e4", { displayName: "Solo Four" }),
  node("e5", { displayName: "Orphan Five", managerOutsideView: true }),
  node("e6", { displayName: "Looped Six", managerCycleBroken: true }),
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
    if (key === "GET /hrms/org/tree") return envelope(TREE);
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE],
    loaded: true,
    loading: false,
    error: null,
  });

const at = () =>
  render(
    <MemoryRouter initialEntries={["/hrms/org/org-chart"]}>
      <Routes>
        <Route path="/hrms/org/:tab" element={<OrgStructurePage />} />
      </Routes>
    </MemoryRouter>,
  );

const open = async (roles = [R.HR_ADMIN]) => {
  signIn(roles);
  at();
  return screen.findByText("Ceo One");
};

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

describe("the org chart tab", () => {
  it("draws every person the server returned", async () => {
    await open();
    for (const person of ["Ceo One", "Mgr Two", "Dev Three", "Solo Four", "Orphan Five", "Looped Six"]) {
      expect(screen.getByText(person)).toBeTruthy();
    }
  });

  it("uses ONE request and never asks per node", async () => {
    await open();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/hrms/org/tree");
    // No directory, department or employee lookup per card.
    expect(calls.some((c) => c.url.startsWith("/hrms/employees"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/org/departments"))).toBe(false);
  });

  it("shows designation, department and a non-active status", async () => {
    await open();

    const card = screen.getByText("Dev Three").closest("[role='group']");
    expect(within(card).getByText("Developer")).toBeTruthy();
    expect(within(card).getByText("Engineering")).toBeTruthy();
    expect(within(card).getByText("Probation")).toBeTruthy();
  });

  it("shows no status badge for an active employee", async () => {
    await open();
    const card = screen.getByText("Ceo One").closest("[role='group']");
    expect(within(card).queryByText("Active")).toBeNull();
  });

  it("renders one connector per manager link", async () => {
    await open();
    // e2->e1 and e3->e2. The four roots have none.
    expect(document.querySelectorAll("[data-org-edges] path")).toHaveLength(2);
  });

  it("says so when a manager is outside the view, rather than implying none", async () => {
    await open();

    const card = screen.getByText("Orphan Five").closest("[role='group']");
    expect(within(card).getByText("Manager not shown")).toBeTruthy();
    expect(card.getAttribute("aria-label")).toMatch(/reports to someone not shown/i);
  });

  it("keeps a cycle-broken employee visible and marks the cut", async () => {
    await open();

    const card = screen.getByText("Looped Six").closest("[role='group']");
    expect(within(card).getByText("Reporting loop")).toBeTruthy();
    expect(card.getAttribute("aria-label")).toMatch(/cycle/i);
  });

  it("gives every card an accessible label", async () => {
    await open();
    const cards = screen.getAllByRole("group");
    expect(cards).toHaveLength(6);
    for (const card of cards) {
      expect(card.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("renders no sensitive employee data", async () => {
    await open();
    const text = document.body.textContent;
    for (const leak of [/[A-Z]{5}\d{4}[A-Z]/, /IFSC/i, /aadhaar/i, /salary/i, /bank/i, /@/]) {
      expect(text).not.toMatch(leak);
    }
  });

  it("does not navigate on click — the reference's cards are inert", async () => {
    await open();
    const card = screen.getByText("Ceo One").closest("[role='group']");

    await userEvent.click(card);
    // Still on the chart; no second employee profile was invented for it.
    expect(screen.getByText("Ceo One")).toBeTruthy();
    expect(calls).toHaveLength(1);
  });
});

describe("its states", () => {
  it("shows a loading state before the data arrives", async () => {
    signIn([R.HR_ADMIN]);
    let release;
    installTransport({
      "GET /hrms/org/tree": () => new Promise((r) => { release = () => r(envelope(TREE)); }),
    });
    at();

    expect(screen.queryByText("Ceo One")).toBeNull();
    expect(screen.queryByText(/No hierarchy/i)).toBeNull();
    release();
    expect(await screen.findByText("Ceo One")).toBeTruthy();
  });

  it("explains an empty organisation", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({ "GET /hrms/org/tree": () => envelope([]) });
    at();

    expect(await screen.findByText("No hierarchy to show")).toBeTruthy();
    expect(document.querySelectorAll("[role='group']")).toHaveLength(0);
  });

  it("renders a 403 as a refusal, NOT as an empty company", async () => {
    // These are different facts and must never look the same: one says there is
    // nobody, the other says you may not look.
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/org/tree": () => fail(403, { message: "Forbidden.", code: "HRMS_FORBIDDEN" }),
    });
    at();

    expect(await screen.findByText(/needs org-wide access or a team of your own/i)).toBeTruthy();
    expect(screen.queryByText("No hierarchy to show")).toBeNull();
  });

  it("offers a retry for a server error, but not for a refusal", async () => {
    signIn([R.HR_ADMIN]);
    let attempts = 0;
    installTransport({
      "GET /hrms/org/tree": () => {
        attempts += 1;
        return attempts === 1 ? fail(500, { message: "Tree unavailable." }) : envelope(TREE);
      },
    });
    at();

    expect(await screen.findByText("Tree unavailable.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByText("Ceo One")).toBeTruthy();
  });

  it("shows no fake nodes in any failure state", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({ "GET /hrms/org/tree": () => fail(500, { message: "Down." }) });
    at();

    await screen.findByText("Down.");
    expect(document.querySelectorAll("[role='group']")).toHaveLength(0);
    expect(document.querySelectorAll("[data-org-edges] path")).toHaveLength(0);
  });

  it("is reachable by an employee, who is refused by the SERVER not the browser", async () => {
    // The tab is offered to everyone, as in the reference. The endpoint decides.
    signIn([R.EMPLOYEE]);
    installTransport({ "GET /hrms/org/tree": () => fail(403, { message: "Forbidden." }) });
    at();

    expect(screen.getByRole("tab", { name: "Org Chart" })).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url === "/hrms/org/tree")).toBe(true));
  });
});
