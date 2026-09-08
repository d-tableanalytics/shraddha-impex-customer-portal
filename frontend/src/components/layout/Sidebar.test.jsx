/**
 * The HRMS half of the navigation rail: structure and active state.
 *
 * The sidebar was restyled to a flat, sectioned layout. These pin the two
 * things that restyle could silently break — the SECTION HEADINGS and the
 * ACTIVE ROUTE — because both are invisible to a build and to lint, and the
 * active state is the only part of a sidebar that is behaviour rather than
 * decoration.
 *
 * The real permission matrix and the real nav definitions are used; only the
 * portal stores are stubbed, since a Zustand store is not what is under test.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The ERP half of the rail is data from the server. An empty list keeps these
// focused on HRMS without asserting anything about the portal's own menu.
vi.mock("../../utils/navigation", () => ({ buildNavigation: () => [] }));
vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { Sidebar } from "./Sidebar";
import { useHrmsStore } from "../../store/hrmsStore";
import { useUserStore } from "../../store/userStore";
import { useUIStore } from "../../store/uiStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const ALL_MODULES = Object.values(M);

const signIn = (roles = [R.SUPER_ADMIN]) => {
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: ALL_MODULES,
    loaded: true,
    loading: false,
    error: null,
  });
  useUserStore.setState({ user: { user: "Test User", role: "Admin" } });
  useUIStore.setState({ sidebarOpen: true, collapsedNavGroups: [] });
};

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
    </MemoryRouter>,
  );

/**
 * Every link label in the rail, read once.
 *
 * Deliberately not `getByRole("link", { name })` per label: accessible-name
 * computation is the most expensive query testing-library offers, and running
 * it twenty-one times made this file slow enough to flake under load. One pass
 * over the DOM answers the same question deterministically.
 */
const railLabels = () =>
  [...document.querySelectorAll("nav a")].map((a) => a.textContent.trim());

beforeEach(() => {
  signIn();
});

// ===========================================================================

describe("HRMS section headings", () => {
  it("renders the three named sections, in order", () => {
    at("/hrms/dashboard");

    const headings = ["My Work", "People & Org", "HRMS Admin"];
    for (const h of headings) expect(screen.getByText(h)).toBeTruthy();

    // Order matters: My Work, then People & Org, then Admin.
    const html = document.body.innerHTML;
    expect(html.indexOf("My Work")).toBeLessThan(html.indexOf("People &amp; Org"));
    expect(html.indexOf("People &amp; Org")).toBeLessThan(html.indexOf("HRMS Admin"));
  });

  it("renders section headings as plain text, never as controls", () => {
    at("/hrms/dashboard");

    for (const label of ["My Work", "People & Org", "HRMS Admin"]) {
      const node = screen.getByText(label);
      expect(node.tagName).toBe("P");
      expect(node.closest("button")).toBeNull();
      expect(node.closest("a")).toBeNull();
    }
  });

  it("gives the core links no heading of their own", () => {
    at("/hrms/dashboard");
    // "HRMS" is the group button; there is no second "Core"/"HRMS" label above
    // Dashboard, Inbox and My Profile.
    expect(screen.queryByText("Core")).toBeNull();
  });

  it("keeps every navigation item reachable", () => {
    at("/hrms/dashboard");

    const labels = railLabels();
    for (const label of [
      "HR Dashboard", "Inbox", "My Profile",
      "Attendance", "Leave", "Payroll", "Expenses", "Performance", "Documents", "Engage", "Helpdesk",
      "Employees", "Org Structure", "Onboarding", "Exits", "Assets", "Hiring", "Planning",
      "HR Reports", "HR Audit Logs", "HR Settings",
    ]) {
      expect(labels, `${label} is missing from the rail`).toContain(label);
    }
    // Twenty-one items, and no duplicates — a restyle must not fan an item out
    // into two rows, which is exactly what the old flattening risked.
    expect(labels).toHaveLength(21);
    expect(new Set(labels).size).toBe(21);
  });
});

// ===========================================================================

describe("active route", () => {
  /** Every route the brief lists, and the item that must light up for it. */
  const CASES = [
    ["/hrms/dashboard", "HR Dashboard"],
    ["/hrms/attendance", "Attendance"],
    ["/hrms/leave", "Leave"],
    ["/hrms/payroll", "Payroll"],
    ["/hrms/employees", "Employees"],
    ["/hrms/org", "Org Structure"],
    ["/hrms/onboarding", "Onboarding"],
    ["/hrms/exits", "Exits"],
    ["/hrms/assets", "Assets"],
    ["/hrms/hiring", "Hiring"],
    ["/hrms/planning", "Planning"],
    ["/hrms/reports", "Reports"],
    ["/hrms/audit-logs", "Audit Logs"],
    ["/hrms/settings", "Settings"],
    ["/hrms/inbox", "Inbox"],
  ];

  for (const [path, label] of CASES) {
    it(`lights exactly one item for ${path}`, () => {
      at(path);

      const active = document.querySelectorAll("a.nav-active");
      expect(active.length, `${path} lit ${active.length} rows`).toBe(1);
      expect(active[0].textContent).toContain(label);
    });
  }

  it("stays on the parent item for a nested tab", () => {
    // Leave owns /leave/holidays; the tab must not un-light Leave, and must
    // not light a second row.
    at("/hrms/leave/holidays");

    const active = document.querySelectorAll("a.nav-active");
    expect(active.length).toBe(1);
    expect(active[0].textContent).toContain("Leave");
  });

  it("marks the active row with an accent, not a full-width pill", () => {
    at("/hrms/attendance");

    const active = document.querySelector("a.nav-active");
    // The subtle wash, not the old opaque white pill.
    expect(active.className).toContain("bg-white/10");
    expect(active.className).not.toContain("shadow-md");
    // And a left accent bar inside the row.
    expect(active.querySelector("span[aria-hidden='true']")).toBeTruthy();
  });
});

// ===========================================================================

describe("collapsing the HRMS group", () => {
  /** The HRMS disclosure button. */
  const groupButton = () => screen.getByRole("button", { name: /HRMS/ });

  it("collapses when clicked, even while you are on an HRMS page", async () => {
    const user = userEvent.setup();
    at("/hrms/dashboard");

    // Open to begin with, and showing its children.
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(railLabels()).toContain("Attendance");

    await user.click(groupButton());

    // The regression: this used to stay open because the group held the
    // active route, so the chevron accepted the click and did nothing.
    expect(groupButton().getAttribute("aria-expanded")).toBe("false");
    expect(railLabels()).not.toContain("Attendance");
    expect(screen.queryByText("My Work")).toBeNull();
  });

  it("reopens on a second click", async () => {
    const user = userEvent.setup();
    at("/hrms/dashboard");

    await user.click(groupButton());
    await user.click(groupButton());

    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(railLabels()).toContain("Attendance");
  });

  it("still shows where you are while collapsed", () => {
    // Collapsed by the user, and the current page is inside the group.
    useUIStore.setState({ sidebarOpen: true, collapsedNavGroups: ["hrms"] });
    at("/hrms/attendance");

    const button = groupButton();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // The accent marks the group as holding the current screen, so collapsing
    // never costs the user their place.
    expect(button.querySelector("span[aria-hidden='true']")).toBeTruthy();
  });

  it("stays collapsed across a re-render — the choice is remembered", () => {
    useUIStore.setState({ sidebarOpen: true, collapsedNavGroups: ["hrms"] });

    at("/hrms/dashboard");
    expect(railLabels()).not.toContain("Attendance");
  });
});

// ===========================================================================

describe("layout", () => {
  it("indents no item — every row shares one left edge", () => {
    at("/hrms/attendance");

    for (const link of document.querySelectorAll("nav a")) {
      expect(link.className, `${link.textContent} is indented`).not.toContain("pl-9");
    }
  });

  it("shows the items flat when the rail is collapsed", () => {
    useUIStore.setState({ sidebarOpen: false, collapsedNavGroups: [] });
    at("/hrms/attendance");

    // No headings in the narrow rail — there is no room for a label.
    expect(screen.queryByText("My Work")).toBeNull();
    // The links are still there, and the active one is still lit.
    expect(document.querySelectorAll("a.nav-active").length).toBe(1);
  });

  it("renders nothing HRMS-related for an account with no HRMS access", () => {
    useHrmsStore.setState({
      actor: null,
      implementedModules: [],
      loaded: true,
      loading: false,
      error: null,
    });
    at("/");

    expect(screen.queryByText("My Work")).toBeNull();
    expect(screen.queryByText("Attendance")).toBeNull();
  });
});
