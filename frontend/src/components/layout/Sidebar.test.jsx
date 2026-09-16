import { describe, test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { useUIStore } from "../../store/uiStore";
import { useUserStore } from "../../store/userStore";
import { useCartStore } from "../../store/cartStore";
import { Sidebar } from "./Sidebar";

/**
 * The Customer Portal rail.
 *
 * The Employee Portal's equivalent file exists because a live
 * `ReferenceError` reached the browser with a green build and a green suite —
 * nothing imported the Sidebar in a test, so nothing ever executed it. This
 * rail had no such file at all, which is the same exposure.
 *
 * So the first test is the one that matters: it renders. The rest pin the tree
 * structure — that children are DOM-nested under their parent rather than
 * merely indented, which is the difference between a tree view and a flat list
 * with padding.
 */

/**
 * The menu arrives from the SERVER on `user.menu` — see the header on
 * utils/navigation.js. Supplying it explicitly is the primary path and keeps
 * these tests independent of the permission fallback.
 */
const MENU = [
  {
    key: "customer_portal",
    label: "Customer Portal",
    icon: "Store",
    items: [
      { key: "dashboard", label: "Dashboard", path: "/dashboard", icon: "LayoutDashboard" },
      { key: "create_booking", label: "New Booking", path: "/orders/new", icon: "PlusCircle" },
      { key: "history", label: "Booking History", path: "/orders/history", icon: "History" },
    ],
  },
  {
    key: "inventory",
    label: "Inventory",
    icon: "Boxes",
    items: [
      { key: "stock", label: "Stock", path: "/inventory", icon: "Warehouse" },
      { key: "master", label: "Item Master", path: "/inventory/master", icon: "Boxes" },
    ],
  },
  {
    // A single destination — deliberately NOT a group. A disclosure that opens
    // to reveal one row costs a click and tells the user nothing.
    key: "help",
    label: "Help",
    icon: "HelpCircle",
    items: [{ key: "help", label: "Help", path: "/help", icon: "HelpCircle" }],
  },
];

const signIn = (over = {}) =>
  useUserStore.setState({
    user: {
      _id: "u1",
      user: "A Person",
      role: "Admin",
      permissions: ["*"],
      status: "Active",
      menu: MENU,
      ...over,
    },
  });

const draw = (path = "/dashboard") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
    </MemoryRouter>,
  );

beforeEach(() => {
  useUIStore.setState({ sidebarOpen: true, collapsedNavGroups: [], mobileNavOpen: false });
  useUserStore.setState({ user: null });
  useCartStore.setState({ items: [] });
});

/** Class names as a list, so assertions compare tokens not substrings. */
const classList = (el) => String(el.className).split(/\s+/).filter(Boolean);

/** Every element carrying the tree rail — the indented well children sit in. */
const branchesIn = (container) =>
  Array.from(container.querySelectorAll("div")).filter((el) =>
    classList(el).includes("border-l"),
  );

describe("the rail renders", () => {
  test("without throwing, for an account with a menu", () => {
    signIn();
    expect(() => draw()).not.toThrow();
  });

  test("and for an account with nothing at all", () => {
    useUserStore.setState({ user: { _id: "u1", role: "Customer", permissions: [], menu: [] } });
    expect(() => draw()).not.toThrow();
  });
});

describe("the menu is a tree, not a flat list", () => {
  test("a group's links are nested INSIDE a branch, not siblings of the header", () => {
    signIn();
    const { container } = draw();

    const stock = screen.getByRole("link", { name: "Stock" });
    const branches = branchesIn(container);

    expect(branches.length).toBeGreaterThan(0);
    // The structural claim. A flat list with padding on each row would pass a
    // visual check and fail this one.
    expect(branches.some((b) => b.contains(stock))).toBe(true);
  });

  test("each parent owns its own branch", () => {
    signIn();
    const { container } = draw();

    const branches = branchesIn(container);
    const portal = screen.getByRole("link", { name: "New Booking" });
    const inventory = screen.getByRole("link", { name: "Item Master" });

    const holdingPortal = branches.find((b) => b.contains(portal));
    const holdingInventory = branches.find((b) => b.contains(inventory));

    expect(holdingPortal).toBeTruthy();
    expect(holdingInventory).toBeTruthy();
    // Two parents, two separate wells — not one rail running past both.
    expect(holdingPortal).not.toBe(holdingInventory);
  });

  test("the rail brightens for the branch holding the current page", () => {
    signIn();
    const { container } = draw("/inventory/master");

    const active = screen.getByRole("link", { name: "Item Master" });
    const holding = branchesIn(container).filter((b) => b.contains(active));
    const idle = branchesIn(container).filter((b) => !b.contains(active));

    for (const rail of holding) expect(classList(rail)).toContain("border-primary-400/40");
    for (const rail of idle) expect(classList(rail)).toContain("border-white/10");
  });

  test("a single-destination module stays a plain link with no branch of its own", () => {
    signIn();
    const { container } = draw();

    const help = screen.getByRole("link", { name: "Help" });
    // Inventing a parent for one child is hierarchy theatre: a chevron that
    // opens to reveal the row you can already see.
    expect(branchesIn(container).some((b) => b.contains(help))).toBe(false);
  });

  test("collapsing a parent takes its whole branch with it", async () => {
    signIn();
    const { container } = draw();

    const before = branchesIn(container).length;
    expect(screen.getByRole("link", { name: "Item Master" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Inventory/i }));

    expect(screen.queryByRole("link", { name: "Item Master" })).toBeNull();
    // The rail goes too — a rail with nothing under it is a line pointing at
    // empty space.
    expect(branchesIn(container).length).toBe(before - 1);
  });
});

describe("the active row is unmistakable", () => {
  test("it is a solid white pill, not a translucent tint", () => {
    signIn();
    draw("/inventory/master");

    const classes = classList(screen.getByRole("link", { name: "Item Master" }));
    // `bg-white/10` on a dark gradient sat about as far from the hover state
    // (`white/[0.07]`) as a rounding error. The Employee Portal's rail fixed
    // this first and carries the same assertion.
    expect(classes).toContain("bg-white");
    expect(classes).not.toContain("bg-white/10");
    expect(classes).toContain("text-primary-900");
  });

  test("only ONE row is active, and it is the most specific match", () => {
    signIn();
    draw("/inventory/master");

    // Keyed on `nav-active` rather than on the white background: the LOGO is
    // also a link with a white background.
    const active = screen
      .getAllByRole("link")
      .filter((el) => classList(el).includes("nav-active"));

    // "/inventory" is a prefix of "/inventory/master"; the longer path wins.
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("Item Master");
  });

  test("a parent holding the active page is tinted, never given the pill", () => {
    signIn();
    draw("/inventory/master");

    const header = screen.getByRole("button", { name: /Inventory/i });
    // The two states have to stay distinguishable: a solid pill means "this row
    // is the page", a tint means "the page is somewhere under here".
    expect(classList(header)).toContain("bg-white/[0.06]");
    expect(classList(header)).not.toContain("bg-white");
  });
});
