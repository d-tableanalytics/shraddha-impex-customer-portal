/**
 * /hrms/me — "My Profile".
 *
 * The nav has shipped this link since Phase 1, but the route was never
 * registered, so clicking it 404'd. Two things are tested here: the page's own
 * behaviour, and the invariant that let the dead link through in the first
 * place — every nav item the sidebar is willing to show must resolve to a real
 * route.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { MyProfilePage } from "./MyProfilePage";
import { HrmsProtectedRoute } from "../../components/hrms/HrmsProtectedRoute";
import { useHrmsStore } from "../../store/hrmsStore";
import { visibleHrmsNavItems } from "../../components/hrms/navItems";
import { router } from "../../routes";
import { buildHrmsActor, hasHrmsPermission } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const EMPLOYEE_ID = "652f000000000000000000a1";

const setActor = (patch = {}) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles: [R.HR_ADMIN] }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES],
    loaded: true,
    loading: false,
    error: null,
    ...patch,
  });

const withEmployee = (id) =>
  setActor({
    actor: buildHrmsActor({
      userId: "u1",
      roles: [R.EMPLOYEE],
      employee: { id, managerChain: [] },
    }),
  });

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/hrms/me"]}>
      <Routes>
        <Route path="/hrms/me" element={<MyProfilePage />} />
        <Route path="/hrms/employees/:id" element={<div>Employee profile</div>} />
        <Route path="/hrms/dashboard" element={<div>HRMS dashboard</div>} />
        <Route path="/" element={<div>Portal home</div>} />
      </Routes>
    </MemoryRouter>,
  );

const realLoad = useHrmsStore.getState().load;

beforeEach(() => {
  useHrmsStore.setState({ load: realLoad });
  useHrmsStore.getState().clear();
});

// ---------------------------------------------------------------------------
// With a linked employee
// ---------------------------------------------------------------------------

describe("with a linked employee record", () => {
  it("redirects to that employee's profile", () => {
    withEmployee(EMPLOYEE_ID);
    renderPage();

    expect(screen.getByText("Employee profile")).toBeTruthy();
  });

  it("does not render a second profile screen of its own", () => {
    // The reference's /me is a redirect, not a parallel page. A duplicate would
    // have to be kept in step with the employee profile, and would need its own
    // answer to what a person may see about themselves.
    withEmployee(EMPLOYEE_ID);
    renderPage();

    expect(screen.queryByText(/No employee record/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: "My Profile" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Without one
// ---------------------------------------------------------------------------

describe("without a linked employee record", () => {
  it("explains what is missing instead of 404ing or rendering blank", () => {
    // An HRMS role and an employee record are separate things. The first HRMS
    // account necessarily has no employee record — it is the account that
    // creates the first employee.
    setActor(); // hr_admin, employeeId null
    renderPage();

    expect(screen.getByText(/No employee record linked to this account/i)).toBeTruthy();
    expect(screen.getByText(/Ask HR to add you to the employee directory/i)).toBeTruthy();
  });

  it("stays on the page rather than redirecting somewhere misleading", () => {
    setActor();
    renderPage();

    expect(screen.queryByText("Employee profile")).toBeNull();
    expect(screen.queryByText("HRMS dashboard")).toBeNull();
  });

  it("does not redirect to an employee profile with an undefined id", () => {
    // The bug this guards against: `/hrms/employees/undefined`, which would
    // reach the API and 404 there instead.
    setActor();
    renderPage();

    expect(document.body.textContent).not.toMatch(/undefined/);
  });
});

// ---------------------------------------------------------------------------
// Loading and error
// ---------------------------------------------------------------------------

describe("loading and error", () => {
  it("shows a loading state rather than deciding before the actor is known", () => {
    setActor({ actor: null, loading: true, loaded: false });
    renderPage();

    expect(screen.queryByText("Employee profile")).toBeNull();
    expect(screen.queryByText(/No employee record/i)).toBeNull();
  });

  it("surfaces a failed actor load with a retry", () => {
    setActor({ actor: null, error: "Could not load HRMS access." });
    renderPage();

    expect(screen.getByText("Could not load HRMS access.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again|retry/i })).toBeTruthy();
  });

  it("does not redirect while an error is showing", () => {
    // A stale actor plus a failed refresh must not silently navigate away from
    // the error the user needs to see.
    withEmployee(EMPLOYEE_ID);
    useHrmsStore.setState({ error: "Network unreachable." });
    renderPage();

    expect(screen.queryByText("Employee profile")).toBeNull();
    expect(screen.getByText("Network unreachable.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe("access", () => {
  const renderGuarded = () =>
    render(
      <MemoryRouter initialEntries={["/hrms/me"]}>
        <Routes>
          <Route path="/" element={<div>Portal home</div>} />
          <Route path="/hrms/dashboard" element={<div>HRMS dashboard</div>} />
          <Route path="/hrms/me" element={<HrmsProtectedRoute module={M.EMPLOYEES} />}>
            <Route index element={<MyProfilePage />} />
          </Route>
          <Route path="/hrms/employees/:id" element={<div>Employee profile</div>} />
        </Routes>
      </MemoryRouter>,
    );

  it("AD-4: a signed-in customer cannot reach it", () => {
    useHrmsStore.setState({
      actor: buildHrmsActor({ userId: "c1", roles: ["Customer"], legacyRole: "Customer" }),
      implementedModules: [M.DASHBOARD, M.EMPLOYEES],
      loaded: true,
      loading: false,
      error: null,
    });
    renderGuarded();

    expect(screen.getByText("Portal home")).toBeTruthy();
    expect(screen.queryByText(/No employee record/i)).toBeNull();
  });

  it("an ordinary employee can, on the self baseline alone", () => {
    withEmployee(EMPLOYEE_ID);
    renderGuarded();

    expect(screen.getByText("Employee profile")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The invariant that would have caught this
// ---------------------------------------------------------------------------

describe("the nav and the router agree", () => {
  /** Every path the real router can match, flattened from the route config. */
  const routablePaths = () => {
    const out = [];
    const walk = (routes, prefix) => {
      for (const route of routes) {
        const raw = route.path ?? "";
        const joined = raw.startsWith("/")
          ? raw
          : [prefix, raw].filter(Boolean).join("/").replace(/\/+/g, "/");
        if (raw || route.index) out.push(joined || prefix);
        if (route.children) walk(route.children, joined || prefix);
      }
    };
    walk(router.routes, "");
    return out;
  };

  it("every nav item an HRMS admin can see resolves to a real route", () => {
    // This is the whole bug: "My Profile" shipped in the nav in Phase 1, became
    // visible the moment Employee Master made its module implemented, and had
    // no route behind it. Nothing asserted the two lists agreed.
    const actor = buildHrmsActor({ userId: "u1", roles: [R.SUPER_ADMIN] });
    const can = (module, action, scope) => hasHrmsPermission(actor, module, action, scope);
    const visible = visibleHrmsNavItems(can, [M.DASHBOARD, M.EMPLOYEES]);
    const paths = routablePaths();

    expect(visible.length).toBeGreaterThan(0);
    for (const item of visible) {
      expect(paths, `nav item "${item.label}" points at ${item.path}`).toContain(item.path);
    }
  });

  it("includes /hrms/me specifically", () => {
    expect(routablePaths()).toContain("/hrms/me");
  });
});
