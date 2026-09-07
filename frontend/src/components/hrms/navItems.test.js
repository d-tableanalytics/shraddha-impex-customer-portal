/**
 * HRMS navigation: permission-aware and honest about what exists.
 *
 * Covers the Phase 1 frontend test requirements:
 *   2. HRMS navigation respects permissions.
 *   8. The shell composes only from modules that are actually built.
 *
 * The filtering is pure, so it is tested directly against the real permission
 * matrix rather than through a rendered tree - the risk here is a wrong
 * permission check, not a wrong div.
 */

import { describe, it, expect } from "vitest";

import {
  HRMS_NAV_ITEMS,
  visibleHrmsNavItems,
  groupHrmsNavItems,
  plannedHrmsNavItems,
  HRMS_NAV_GROUP_ORDER,
} from "./navItems";
import {
  buildHrmsActor,
  hasHrmsPermission,
} from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

/** The same `can` the hook builds, without React. */
const canFor = (roles) => {
  const actor = buildHrmsActor({ userId: "u1", roles });
  return (module, action, scope, resource) =>
    hasHrmsPermission(actor, module, action, scope, resource);
};

const ALL_MODULES = [...new Set(HRMS_NAV_ITEMS.map((i) => i.module))];

describe("HRMS navigation", () => {
  it("shows a customer nothing at all", () => {
    // Not a filtered-down menu — no HRMS trace whatsoever (AD-4).
    const can = canFor(["Customer"]);
    expect(visibleHrmsNavItems(can, ALL_MODULES)).toEqual([]);
    expect(groupHrmsNavItems(visibleHrmsNavItems(can, ALL_MODULES))).toEqual([]);
    expect(plannedHrmsNavItems(can, [])).toEqual([]);
  });

  it("shows a portal-only account nothing, whatever its portal role", () => {
    for (const role of ["Admin", "Sales", "Inventory Manager", "Warehouse User", "Management"]) {
      expect(visibleHrmsNavItems(canFor([role]), ALL_MODULES)).toEqual([]);
    }
  });

  it("hides modules that are not built, even from someone entitled to them", () => {
    const can = canFor([R.SUPER_ADMIN]);

    // Entitled to nearly everything...
    const ifEverythingExisted = visibleHrmsNavItems(can, ALL_MODULES);
    expect(ifEverythingExisted.length).toBeGreaterThan(10);

    // ...but only the dashboard is built, so that is all the menu offers.
    const actual = visibleHrmsNavItems(can, [M.DASHBOARD]);
    expect(actual.map((i) => i.key)).toEqual(["hrms-dashboard"]);
  });

  it("hides built modules from someone without permission", () => {
    // An employee is entitled to the dashboard but not to Planning.
    const employee = canFor([R.EMPLOYEE]);
    const built = [M.DASHBOARD, M.PLANNING];

    const keys = visibleHrmsNavItems(employee, built).map((i) => i.key);
    expect(keys).toContain("hrms-dashboard");
    expect(keys).not.toContain("hrms-planning");

    // ...whereas HR admin, who holds planning:view:org, does see it.
    const hr = canFor([R.HR_ADMIN]);
    expect(visibleHrmsNavItems(hr, built).map((i) => i.key)).toContain("hrms-planning");
  });

  it("gives each role only the modules its permissions reach", () => {
    const allBuilt = ALL_MODULES;

    const employee = visibleHrmsNavItems(canFor([R.EMPLOYEE]), allBuilt).map((i) => i.key);
    // Self-service, yes.
    expect(employee).toContain("hrms-leave");
    expect(employee).toContain("hrms-payroll"); // own payslip
    // Other people's records, no.
    expect(employee).not.toContain("hrms-employees"); // needs team scope
    expect(employee).not.toContain("hrms-settings");
    expect(employee).not.toContain("hrms-audit");

    const manager = visibleHrmsNavItems(canFor([R.MANAGER]), allBuilt).map((i) => i.key);
    expect(manager).toContain("hrms-employees"); // team scope
    expect(manager).not.toContain("hrms-settings");

    const itAdmin = visibleHrmsNavItems(canFor([R.IT_ADMIN]), allBuilt).map((i) => i.key);
    expect(itAdmin).toContain("hrms-assets");
    expect(itAdmin).toContain("hrms-exits"); // holds exits:view:org for asset clearance
    expect(itAdmin).not.toContain("hrms-payroll-runs");

    const auditorCan = canFor([R.AUDITOR]);
    const auditor = visibleHrmsNavItems(auditorCan, allBuilt).map((i) => i.key);
    expect(auditor).toContain("hrms-audit");
    // The auditor DOES see Leave, and that is correct: it holds leave:view:org,
    // and a wider granted scope satisfies the item's `self` requirement. What
    // separates a read-only role is the actions it cannot take, not the modules
    // it cannot see.
    expect(auditor).toContain("hrms-leave");
    expect(auditorCan(M.LEAVE, "view", "org")).toBe(true);
    expect(auditorCan(M.LEAVE, "submit", "self")).toBe(false);
    expect(auditorCan(M.LEAVE, "approve", "team")).toBe(false);
  });

  it("unions the grants of several HRMS roles (AD-3)", () => {
    const both = visibleHrmsNavItems(canFor([R.EMPLOYEE, R.IT_ADMIN]), ALL_MODULES).map((i) => i.key);
    expect(both).toContain("hrms-leave"); // from employee
    expect(both).toContain("hrms-assets"); // from it_admin
  });

  it("lets a portal role and an HRMS role coexist without interfering", () => {
    const salesEmployee = visibleHrmsNavItems(canFor(["Sales", R.EMPLOYEE]), ALL_MODULES);
    const employeeOnly = visibleHrmsNavItems(canFor([R.EMPLOYEE]), ALL_MODULES);
    // Being Sales adds nothing to HRMS, and takes nothing away.
    expect(salesEmployee.map((i) => i.key)).toEqual(employeeOnly.map((i) => i.key));
  });

  it("drops groups that end up empty rather than rendering a bare heading", () => {
    const groups = groupHrmsNavItems(visibleHrmsNavItems(canFor([R.EMPLOYEE]), [M.DASHBOARD]));
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(1);
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });

  it("keeps groups in the reference's order", () => {
    const groups = groupHrmsNavItems(visibleHrmsNavItems(canFor([R.SUPER_ADMIN]), ALL_MODULES));
    const order = groups.map((g) => g.group);
    expect(order).toEqual(HRMS_NAV_GROUP_ORDER.filter((g) => order.includes(g)));
  });

  it("reports entitled-but-unbuilt modules as planned, not as nav items", () => {
    const can = canFor([R.HR_ADMIN]);
    const visible = visibleHrmsNavItems(can, [M.DASHBOARD]).map((i) => i.key);
    const planned = plannedHrmsNavItems(can, [M.DASHBOARD]).map((i) => i.key);

    expect(visible).toEqual(["hrms-dashboard"]);
    expect(planned).toContain("hrms-employees");
    expect(planned).not.toContain("hrms-dashboard");
    // Nothing can be in both lists.
    expect(planned.filter((k) => visible.includes(k))).toEqual([]);
  });

  it("does not list Operations or Projects — out of scope under AD-5", () => {
    const modules = HRMS_NAV_ITEMS.map((i) => i.module);
    expect(modules).not.toContain("operations");
    expect(modules).not.toContain("projects");
    const keys = HRMS_NAV_ITEMS.map((i) => i.key);
    expect(keys).not.toContain("hrms-operations");
    expect(keys).not.toContain("hrms-projects");
  });

  it("routes every item under the /hrms namespace with a unique key", () => {
    for (const item of HRMS_NAV_ITEMS) {
      expect(item.path.startsWith("/hrms/")).toBe(true);
      expect(item.requires.length).toBeGreaterThan(0); // no ungated item
      expect(item.module).toBeTruthy();
    }
    const keys = HRMS_NAV_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    const paths = HRMS_NAV_ITEMS.map((i) => i.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
