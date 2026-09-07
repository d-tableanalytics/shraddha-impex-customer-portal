/**
 * HRMS route protection and permission-driven visibility.
 *
 * Covers two of the Employee Master frontend requirements:
 *   - HRMS routes are protected (AD-4: authenticated is not the same as HRMS).
 *   - Controls appear only for the roles entitled to them.
 *
 * These render the REAL guard against the REAL permission matrix. Stubbing the
 * `can` function would only prove the component calls something.
 *
 * Hiding a control is a convenience, never a control: the corresponding server
 * checks live in backend/tests/employee-master.test.js, and both halves read
 * the same matrix out of @shared.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { HrmsProtectedRoute } from "./HrmsProtectedRoute";
import { PermissionGate } from "./PermissionGate";
import { useHrmsStore } from "../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import {
  HRMS_ROLES as R,
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/** Put a signed-in actor into the store without touching the network. */
const signIn = (roles, employee = null) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES],
    loaded: true,
    loading: false,
    error: null,
  });

/** A portal customer: authenticated, but holding no HRMS role at all. */
const signInAsCustomer = () =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "c1", roles: ["Customer"], legacyRole: "Customer" }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES],
    loaded: true,
    loading: false,
    error: null,
  });

const renderAt = (path, element) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>Portal home</div>} />
        <Route path="/hrms/dashboard" element={<div>HRMS dashboard</div>} />
        <Route path="/hrms/employees" element={element}>
          <Route index element={<div>Employee directory</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

const realLoad = useHrmsStore.getState().load;

beforeEach(() => {
  useHrmsStore.setState({ load: realLoad });
  useHrmsStore.getState().clear();
});

// ---------------------------------------------------------------------------
// Route protection
// ---------------------------------------------------------------------------

describe("route protection", () => {
  it("holds the route while the actor is still unknown", () => {
    // `load` is stubbed: the real one runs on mount, finds no token and
    // resolves the unknown state within the same tick, so the branch under
    // test would never be reachable.
    useHrmsStore.setState({ actor: null, loaded: false, loading: true, load: async () => null });
    renderAt("/hrms/employees", <HrmsProtectedRoute module={M.EMPLOYEES} />);

    // Deciding before the answer is in would bounce a real HRMS user on a cold
    // reload - the bug this branch exists to prevent.
    expect(screen.getByText(/Checking HRMS access/i)).toBeTruthy();
    expect(screen.queryByText("Employee directory")).toBeNull();
    expect(screen.queryByText("Portal home")).toBeNull();
  });

  it("AD-4: an authenticated customer is redirected away from /hrms/employees", () => {
    signInAsCustomer();
    renderAt("/hrms/employees", <HrmsProtectedRoute module={M.EMPLOYEES} />);

    expect(screen.getByText("Portal home")).toBeTruthy();
    expect(screen.queryByText("Employee directory")).toBeNull();
  });

  it("an HR admin reaches the directory", () => {
    signIn([R.HR_ADMIN]);
    renderAt("/hrms/employees", <HrmsProtectedRoute module={M.EMPLOYEES} />);

    expect(screen.getByText("Employee directory")).toBeTruthy();
  });

  it("an employee reaches it too - the list is scoped server-side, not hidden", () => {
    // `employees:view:self` is in every HRMS role baseline, so the route opens;
    // what the employee can SEE is decided by the scope filter on the server,
    // which is tested in backend/tests/employee-master.test.js.
    signIn([R.EMPLOYEE]);
    renderAt("/hrms/employees", <HrmsProtectedRoute module={M.EMPLOYEES} />);

    expect(screen.getByText("Employee directory")).toBeTruthy();
  });

  it("a module that is not built yet redirects to the dashboard, not a blank page", () => {
    signIn([R.HR_ADMIN]);
    useHrmsStore.setState({ implementedModules: [M.DASHBOARD] }); // employees not built

    renderAt("/hrms/employees", <HrmsProtectedRoute module={M.EMPLOYEES} />);
    expect(screen.getByText("HRMS dashboard")).toBeTruthy();
  });

  it("redirects rather than announcing that the route exists", () => {
    signInAsCustomer();
    renderAt("/hrms/employees", <HrmsProtectedRoute module={M.EMPLOYEES} />);

    // No "403", no "forbidden", no "access denied" - on a shell customers and
    // employees share, an error page confirms both that the route is real and
    // that this person is merely not permitted.
    expect(document.body.textContent).not.toMatch(/denied|forbidden|not authori[sz]ed|403/i);
  });
});

// ---------------------------------------------------------------------------
// Permission-based UI visibility
// ---------------------------------------------------------------------------

describe("permission-gated controls", () => {
  const gate = (props) =>
    render(
      <PermissionGate {...props}>
        <button>Add employee</button>
      </PermissionGate>,
    );

  it("shows Add employee to an HR admin", () => {
    signIn([R.HR_ADMIN]);
    gate({ module: M.EMPLOYEES, action: A.CREATE, scope: S.ORG });
    expect(screen.getByRole("button", { name: "Add employee" })).toBeTruthy();
  });

  it("hides Add employee from an ordinary employee", () => {
    signIn([R.EMPLOYEE]);
    gate({ module: M.EMPLOYEES, action: A.CREATE, scope: S.ORG });
    expect(screen.queryByRole("button", { name: "Add employee" })).toBeNull();
  });

  it("hides it from an auditor, who may read the whole organisation but write nothing", () => {
    signIn([R.AUDITOR]);
    gate({ module: M.EMPLOYEES, action: A.CREATE, scope: S.ORG });
    expect(screen.queryByRole("button", { name: "Add employee" })).toBeNull();
  });

  it("a manager sees only their team, so no org-wide directory action", () => {
    signIn([R.MANAGER]);
    gate({ module: M.EMPLOYEES, action: A.CREATE, scope: S.ORG });
    expect(screen.queryByRole("button", { name: "Add employee" })).toBeNull();
  });

  it("Reveal is gated on compensation access, which creating employees does not imply", () => {
    const revealVisibleFor = (roles) => {
      signIn(roles);
      const { unmount } = render(
        <PermissionGate module={M.EMPLOYEES_COMPENSATION} action={A.VIEW} scope={S.ORG}>
          <button>Reveal</button>
        </PermissionGate>,
      );
      const found = Boolean(screen.queryByRole("button", { name: "Reveal" }));
      unmount();
      return found;
    };

    // The HR admin creates and edits every employee but holds no compensation
    // grant, so a PAN stays masked for them. The payroll admin is the reverse:
    // it may read the sensitive values and may not create anyone.
    expect(revealVisibleFor([R.HR_ADMIN])).toBe(false);
    expect(revealVisibleFor([R.PAYROLL_ADMIN])).toBe(true);
  });

  it("renders the fallback rather than nothing when one is given", () => {
    signIn([R.EMPLOYEE]);
    render(
      <PermissionGate
        module={M.EMPLOYEES}
        action={A.CREATE}
        scope={S.ORG}
        fallback={<span>Ask HR to add someone.</span>}
      >
        <button>Add employee</button>
      </PermissionGate>,
    );
    expect(screen.getByText("Ask HR to add someone.")).toBeTruthy();
  });

  it("anyOf reveals a control when EITHER grant is held", () => {
    // The Edit button on a profile: org-wide editors see it, and so does an
    // employee on their own record.
    signIn([R.EMPLOYEE]);
    render(
      <PermissionGate
        anyOf={[
          { module: M.EMPLOYEES, action: A.EDIT, scope: S.ORG },
          { module: M.EMPLOYEES, action: A.EDIT, scope: S.SELF },
        ]}
      >
        <button>Edit</button>
      </PermissionGate>,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("an actor with no HRMS role sees nothing, even for the self baseline", () => {
    // The baseline is granted by HOLDING AN HRMS ROLE, never by being signed in.
    signInAsCustomer();
    render(
      <PermissionGate module={M.EMPLOYEES} action={A.VIEW} scope={S.SELF}>
        <span>My profile</span>
      </PermissionGate>,
    );
    expect(screen.queryByText("My profile")).toBeNull();
  });
});
