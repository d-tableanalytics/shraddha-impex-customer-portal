import { describe, test, expect } from "vitest";
import { buildNavigation, navPathFor } from "./navigation";

/**
 * Inventory Health and Brands are reached from buttons on Inventory Master, not
 * the sidebar. Upcoming Stock used to be anchored on the Inventory Health menu
 * row, so hiding that row must not take Upcoming Stock out with it.
 */

const paths = (groups) => groups.flatMap((g) => g.items.map((i) => i.path));

// What the server sends now: Health and Brands are `hidden` in the registry.
const serverMenu = [{
  key: "inventory", label: "Inventory Management", icon: "Warehouse",
  items: [
    { key: "dashboard", label: "Inventory Dashboard", path: "/inventory/dashboard", icon: "GaugeCircle" },
    { key: "master", label: "Inventory Master", path: "/inventory/master", icon: "Warehouse" },
    { key: "ledger", label: "Stock Ledger", path: "/inventory/ledger", icon: "ScrollText" },
  ],
}];

describe("inventory sidebar entries", () => {
  test("no Inventory Health or Brands entry; Upcoming Stock follows Inventory Master", () => {
    const user = {
      role: "Inventory Manager", permissions: ["view_inventory"], menu: serverMenu,
      grants: [{ module: "inventory", submodule: "health", actions: ["view"] }],
    };
    const p = paths(buildNavigation(user));
    expect(p).not.toContain("/inventory/health");
    expect(p).not.toContain("/inventory/brands");
    expect(p.indexOf("/inventory/upcoming")).toBe(p.indexOf("/inventory/master") + 1);
  });

  test("Upcoming Stock is withheld from a user without the health cell", () => {
    const user = { role: "X", permissions: ["view_inventory"], menu: serverMenu, grants: [] };
    expect(paths(buildNavigation(user))).not.toContain("/inventory/upcoming");
  });

  test("the client fallback menu (older server, no menu) agrees", () => {
    const admin = { role: "Admin", permissions: ["*"] };
    const p = paths(buildNavigation(admin));
    expect(p).toContain("/inventory/master");
    expect(p).not.toContain("/inventory/health");
    expect(p).not.toContain("/inventory/brands");
    expect(p).toContain("/inventory/upcoming");
  });
});

describe("navPathFor", () => {
  const items = [{ path: "/inventory" }, { path: "/inventory/master" }];

  test("reads Inventory Health and Brands as Inventory Master", () => {
    expect(navPathFor("/inventory/health", items)).toBe("/inventory/master");
    expect(navPathFor("/inventory/brands", items)).toBe("/inventory/master");
  });

  test("leaves every other path alone, including look-alikes", () => {
    expect(navPathFor("/inventory", items)).toBe("/inventory");
    expect(navPathFor("/inventory/upcoming", items)).toBe("/inventory/upcoming");
    expect(navPathFor("/inventory/healthy", items)).toBe("/inventory/healthy");
  });

  test("a child with its own menu entry keeps it", () => {
    expect(navPathFor("/inventory/brands", [...items, { path: "/inventory/brands" }])).toBe("/inventory/brands");
  });

  test("without Inventory Master in the menu, nothing is highlighted rather than the catalogue", () => {
    expect(navPathFor("/inventory/health", [{ path: "/inventory" }])).toBeNull();
  });
});
