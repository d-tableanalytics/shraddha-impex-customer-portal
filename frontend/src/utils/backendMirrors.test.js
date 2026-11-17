import { describe, test, expect } from "vitest";

/**
 * Two hand-kept copies of backend config, held to the backend by test so they
 * cannot drift silently again (audit F11): the role fallback, and the cell keys
 * ModuleRoute falls back to when the server sends no grants.
 */

import { BASELINE_ROLE_PERMISSIONS } from "../../../backend/config/permissions.js";
import { MODULES, servesPortal } from "../../../backend/config/moduleRegistry.js";
import { FALLBACK_ROLE_PERMISSIONS, SYSTEM_ROLE_NAMES, PERMISSIONS } from "./permissions";
import { CELL_KEYS } from "./cellKeys";

const sorted = (list) => [...new Set(list)].sort();

describe("FALLBACK_ROLE_PERMISSIONS mirrors backend BASELINE_ROLE_PERMISSIONS", () => {
  test("same roles, including HR, Billing, Accounts and Billing Head", () => {
    expect(sorted(SYSTEM_ROLE_NAMES)).toEqual(sorted(Object.keys(BASELINE_ROLE_PERMISSIONS)));
    for (const role of ["HR", "Billing", "Accounts", "Billing Head"]) expect(SYSTEM_ROLE_NAMES).toContain(role);
  });

  test.each(Object.keys(BASELINE_ROLE_PERMISSIONS))("%s holds the same keys", (role) => {
    expect(sorted(FALLBACK_ROLE_PERMISSIONS[role])).toEqual(sorted(BASELINE_ROLE_PERMISSIONS[role]));
  });

  test("every key the fallback names exists in PERMISSIONS", () => {
    const known = new Set([...Object.values(PERMISSIONS), "*"]);
    const unknown = Object.values(FALLBACK_ROLE_PERMISSIONS).flat().filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });
});

describe("CELL_KEYS mirrors the customer-portal cells of moduleRegistry.js", () => {
  test("same cells, same actions, same keys", () => {
    const expected = {};
    for (const m of MODULES) {
      if (!servesPortal(m, "customer")) continue;
      for (const s of m.submodules) {
        if (!servesPortal(s, "customer")) continue;
        expected[`${m.key}.${s.key}`] = s.actions;
      }
    }
    expect(CELL_KEYS).toEqual(expected);
  });
});
