import { describe, test, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { MODULE_INFO } from "./content";
import ROUTES from "./content/routes";
import { moduleInfoForPath } from "./registry";
import { PageHeader } from "../components/common/PageHeader";

/**
 * The ⓘ "About this module" panel: every routed screen has documentation, the
 * documentation is well formed, and the header shows it.
 */

/** One URL per screen in routes/index.jsx. Add a line when a screen is added. */
const SCREENS = [
  "/", "/orders/new", "/orders/history", "/orders/bulk-upload", "/orders/indent-history",
  "/inventory", "/settings", "/help",
  "/sales", "/reports",
  "/inventory/dashboard", "/inventory/master", "/inventory/health", "/inventory/upcoming",
  "/inventory/ledger", "/inventory/brands", "/inventory/indent-assignment", "/inventory/import",
  "/admin/product-details",
  "/admin", "/admin/customers", "/admin/users", "/admin/permissions",
  "/fms/o2d/tasks", "/fms/o2d/orders", "/fms/o2d/orders/new", "/fms/o2d/stages",
  "/fms/o2d/analytics",
];

const KINDS = ["automatic", "manual", "historical", "multi"];

describe("module documentation", () => {
  test.each(SCREENS)("%s has its own panel", (path) => {
    expect(moduleInfoForPath(path), `no documentation for ${path}`).not.toBeNull();
  });

  test("the route index matches the documentation exactly", () => {
    expect(ROUTES).toEqual(MODULE_INFO.map(({ key, title, paths }) => ({ key, title, paths })));
  });

  test("keys are unique", () => {
    const keys = MODULE_INFO.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("no two screens share an overview (no copied boilerplate)", () => {
    const whats = MODULE_INFO.map((e) => e.overview.what.trim());
    expect(new Set(whats).size).toBe(whats.length);
  });

  test.each(MODULE_INFO.map((e) => [e.key, e]))("%s is well formed", (_key, e) => {
    expect(e.title).toBeTruthy();
    expect(e.paths.length).toBeGreaterThan(0);
    expect(e.overview.what.length).toBeGreaterThan(20);
    expect(e.functions.length).toBeGreaterThan(0);
    expect(e.steps.length).toBeGreaterThan(0);
    for (const i of e.impacts) expect(KINDS).toContain(i.kind);
    for (const c of e.connections) expect(["one-way", "two-way"]).toContain(c.direction);
    // Source paths stay in the documentation map, never in the browser bundle.
    expect(JSON.stringify(e)).not.toMatch(/backend\/|frontend\/|\.jsx?\b/);
  });

  test("an unknown route has no panel, so no empty icon appears", () => {
    expect(moduleInfoForPath("/no-such-screen")).toBeNull();
  });
});

describe("the ⓘ icon in the page header", () => {
  const at = (path, ui) => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);

  test("sits beside the heading and opens this screen's panel", async () => {
    at("/sales", <PageHeader title="Sales Desk" />);
    const button = screen.getByRole("button", { name: /About this module/ });
    expect(button.getAttribute("title")).toBe("About this module");
    fireEvent.click(button);
    const panel = await screen.findByTestId("module-info-panel");
    expect(panel.textContent).toContain(MODULE_INFO.find((e) => e.key === "sales.bookings").overview.what);
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    // Jump links to each section, so a long panel is quick to scan.
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeTruthy();
  });

  test("is absent where nothing is documented", () => {
    at("/no-such-screen", <PageHeader title="Nothing" />);
    expect(screen.queryByTestId("module-info-button")).toBeNull();
  });

  test("can be turned off by a page", () => {
    at("/sales", <PageHeader title="Sales Desk" info={false} />);
    expect(screen.queryByTestId("module-info-button")).toBeNull();
  });
});
