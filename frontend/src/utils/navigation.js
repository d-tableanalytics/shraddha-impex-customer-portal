import { PERMISSIONS, hasPermission, homePathFor, canManageRoles, canAction } from "./permissions";

/**
 * Turns the user's access into the sidebar's groups.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THE MENU COMES FROM
 * ─────────────────────────────────────────────────────────────────────────
 *
 * From the SERVER. /auth/me returns `menu`: the modules and sub-modules this
 * account may see, already filtered, already ordered, built by the same
 * resolver that will authorise the request when the user clicks the link.
 *
 * That is the whole reason it is not computed here. A frontend that decides for
 * itself which links to show is a frontend that can disagree with the server,
 * and every disagreement is either a dead link (shown, then refused) or an
 * invisible feature (allowed, never offered). Neither is discoverable by
 * testing the frontend alone, because the frontend is self-consistent in both
 * cases.
 *
 * Requirement 8 falls out of the same choice: a module added to
 * backend/config/moduleRegistry.js appears in this sidebar with no frontend
 * change at all.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE STILL DECIDES
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Presentation, and only presentation: which group is always a group, where the
 * cart badge goes, and the one redirect-avoidance rule below. Anything that
 * answers "may they?" belongs on the server.
 */

/**
 * Modules that stay a labelled group even when they hold a single item.
 *
 * The Customer Portal is here because it is a NAMED PLACE, not an accident of
 * how many screens a role can reach. A customer with one section still has a
 * Customer Portal; flattening it to a bare link would make the portal's
 * identity a function of how many boxes somebody ticked - requirement 6 asks
 * for the grouping itself, not for a grouping that appears once it is big
 * enough to look like one.
 */
const ALWAYS_GROUPED = new Set(["customer_portal"]);

/** Items that carry a live badge, and what feeds it. */
const BADGES = {
  "customer_portal.create_booking": "cart",
};

/**
 * The menu to fall back on when the server did not send one.
 *
 * Only reachable against a backend older than this feature - during a rolling
 * deploy, say, where a fresh bundle is talking to a server that has not
 * restarted yet. It mirrors the registry's screen-bearing sub-modules and their
 * view permissions, so the sidebar degrades to the right menu rather than to an
 * empty rail.
 *
 * NOT a second source of truth. If this disagrees with the registry, the
 * registry is right, and the disagreement can only show during that deploy
 * window.
 */
const FALLBACK_MODULES = [
  {
    key: "customer_portal",
    label: "Customer Portal",
    icon: "Store",
    items: [
      { key: "dashboard", label: "Dashboard", path: "/", icon: "LayoutDashboard", any: [PERMISSIONS.VIEW_DASHBOARD] },
      { key: "create_booking", label: "Create Booking", path: "/orders/new", icon: "PlusCircle", any: [PERMISSIONS.CREATE_ORDER, PERMISSIONS.VIEW_ALL_BOOKINGS] },
      { key: "bulk_upload", label: "Bulk Upload", path: "/orders/bulk-upload", icon: "UploadCloud", any: [PERMISSIONS.CREATE_ORDER, PERMISSIONS.VIEW_ALL_BOOKINGS] },
      { key: "booking_history", label: "Booking History", path: "/orders/history", icon: "History", any: [PERMISSIONS.VIEW_ORDERS] },
      { key: "indent_history", label: "Indent History", path: "/orders/indent-history", icon: "PackageX", any: [PERMISSIONS.VIEW_ORDERS] },
      { key: "catalogue", label: "Product Catalogue", path: "/inventory", icon: "Boxes", any: [PERMISSIONS.VIEW_CATALOGUE] },
      { key: "profile", label: "Profile & Settings", path: "/settings", icon: "Settings", any: [PERMISSIONS.VIEW_PROFILE] },
      { key: "support", label: "Help & Support", path: "/help", icon: "HelpCircle", any: [PERMISSIONS.VIEW_HELP] },
    ],
  },
  {
    key: "sales",
    label: "Sales Desk",
    icon: "FileCheck2",
    items: [
      { key: "bookings", label: "Booking Desk", path: "/sales", icon: "FileCheck2", any: [PERMISSIONS.VIEW_ALL_BOOKINGS] },
    ],
  },
  {
    key: "inventory",
    label: "Inventory Management",
    icon: "Warehouse",
    items: [
      { key: "dashboard", label: "Inventory Dashboard", path: "/inventory/dashboard", icon: "GaugeCircle", any: [PERMISSIONS.VIEW_INVENTORY] },
      { key: "master", label: "Inventory Master", path: "/inventory/master", icon: "Warehouse", any: [PERMISSIONS.VIEW_INVENTORY] },
      // Inventory Health and Brands are not menu entries: both are reached from
      // buttons on Inventory Master (Inventory Health Check, Add Brands). They
      // are `hidden` in backend/config/moduleRegistry.js for the same reason.
      { key: "ledger", label: "Stock Ledger", path: "/inventory/ledger", icon: "ScrollText", any: [PERMISSIONS.VIEW_STOCK_LEDGER] },
      { key: "imports", label: "Inventory Import", path: "/inventory/import", icon: "Upload", any: [PERMISSIONS.VIEW_INVENTORY] },
      { key: "product_content", label: "Product Details", path: "/admin/product-details", icon: "Images", any: [PERMISSIONS.MANAGE_INVENTORY_MASTER] },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    icon: "BarChart3",
    items: [
      { key: "operational", label: "Reports", path: "/reports", icon: "BarChart3", any: [PERMISSIONS.VIEW_REPORTS] },
    ],
  },
  {
    key: "administration",
    label: "Administration",
    icon: "ShieldCheck",
    items: [
      // Mirrors backend/config/moduleRegistry.js: the Admin Panel is for
      // administering the SYSTEM. Customer Management is its own entry below.
      { key: "overview", label: "Admin Panel", path: "/admin", icon: "LayoutGrid", any: [PERMISSIONS.MANAGE_USERS, PERMISSIONS.MANAGE_ROLES] },
      { key: "customers", label: "Customer Management", path: "/admin/customers", icon: "Store", any: [PERMISSIONS.MANAGE_CUSTOMER_USERS, PERMISSIONS.MANAGE_USERS] },
      { key: "users", label: "Internal User Management", path: "/admin/users", icon: "Users", any: [PERMISSIONS.MANAGE_USERS] },
      // Roles & Permissions is deliberately absent: the matrix has one editor,
      // in the Employee Portal. See backend/config/moduleRegistry.js.
    ],
  },
];

const fallbackMenu = (user) =>
  FALLBACK_MODULES.map((mod) => ({
    key: mod.key,
    label: mod.label,
    icon: mod.icon,
    items: mod.items.filter((item) => item.any.some((p) => hasPermission(user, p))),
  })).filter((mod) => mod.items.length > 0);

/**
 * The sidebar's groups, in order.
 *
 * Every item gets a stable `id` of "module.submodule" so the active-item
 * calculation has something to compare that is unique across groups - two
 * modules can both have a sub-module called "dashboard", and labels are not
 * identifiers.
 */
/**
 * Roles & Permissions, added on the client.
 *
 * The shared registry tags `administration.roles` as the Employee Portal's, so
 * this server's menu never carries it — and retagging it is a shared-contract
 * change. The screen and its API now exist here (scoped to this portal's
 * modules), gated on `manage_roles`, so the entry is drawn from that same key.
 */
const ROLES_ITEM = {
  id: "administration.roles",
  key: "roles",
  label: "Roles & Permissions",
  path: "/admin/permissions",
  icon: "Key",
};

const withRolesItem = (groups, user) => {
  if (!canManageRoles(user)) return groups;
  const at = groups.findIndex((g) => g.key === "administration");
  if (at >= 0) {
    if (groups[at].items.some((i) => i.path === ROLES_ITEM.path)) return groups;
    const next = [...groups];
    next[at] = { ...groups[at], items: [...groups[at].items, ROLES_ITEM] };
    return next;
  }
  return [...groups, { key: "administration", label: "Administration", icon: "ShieldCheck", alwaysGrouped: false, items: [ROLES_ITEM] }];
};

/**
 * Upcoming Stock, added on the client.
 *
 * It has no registry entry — its API is guarded by existing permission keys
 * (view_inventory / manage_inventory_master / assign_indent_stock) rather than
 * a cell of its own — so the server's menu never carries it.
 *
 * It is offered to whoever may VIEW INVENTORY HEALTH, the cell its route
 * checks (routes/index.jsx), and placed directly after Inventory Master.
 *
 * It used to be anchored on the Inventory Health menu row and offered only
 * where that row was present. Inventory Health left the sidebar (2026-11-16),
 * and anchoring on the row would have taken Upcoming Stock out with it, so it
 * now asks the permission itself.
 */
const UPCOMING_ITEM = {
  id: "inventory.upcoming",
  key: "upcoming",
  label: "Upcoming Stock",
  path: "/inventory/upcoming",
  icon: "CalendarClock",
};

/** May open Upcoming Stock: the route's own cell, or view_inventory on an older server. */
const mayOpenUpcoming = (user) => (Array.isArray(user?.grants)
  ? canAction(user, "inventory", "health", "view")
  : hasPermission(user, PERMISSIONS.VIEW_INVENTORY));

const withUpcomingItem = (groups, user) => {
  if (!mayOpenUpcoming(user)) return groups;
  return groups.map((g) => {
    const at = g.items.findIndex((i) => i.path === "/inventory/master");
    if (at < 0 || g.items.some((i) => i.path === UPCOMING_ITEM.path)) return g;
    const items = [...g.items];
    items.splice(at + 1, 0, UPCOMING_ITEM);
    return { ...g, items };
  });
};

/**
 * Activity Log, added on the client for the same reason as Upcoming Stock.
 *
 * It has no registry entry: it is a PROJECTION of the stock ledger — the same
 * history, said in plain language — so its API is guarded by `view_stock_ledger`
 * rather than a permission cell of its own. Giving it a cell would mean every
 * existing role losing the screen until a role baseline was re-applied, for a
 * question those roles can already answer the hard way.
 *
 * Offered to whoever may open the Stock Ledger, and placed directly after it,
 * because that is the row a person would look under for it.
 */
const ACTIVITY_ITEM = {
  id: "inventory.activity",
  key: "activity",
  label: "Activity Log",
  path: "/inventory/activity",
  // `Activity`, not `History` — Booking History already carries that icon, and
  // two rows with one glyph is how a rail stops being scannable.
  icon: "Activity",
};

/** May open the Activity Log: the ledger's own cell, or its permission key. */
const mayOpenActivity = (user) => (Array.isArray(user?.grants)
  ? canAction(user, "inventory", "ledger", "view")
  : hasPermission(user, PERMISSIONS.VIEW_STOCK_LEDGER));

const withActivityItem = (groups, user) => {
  if (!mayOpenActivity(user)) return groups;
  return groups.map((g) => {
    const at = g.items.findIndex((i) => i.path === "/inventory/ledger");
    if (at < 0 || g.items.some((i) => i.path === ACTIVITY_ITEM.path)) return g;
    const items = [...g.items];
    items.splice(at + 1, 0, ACTIVITY_ITEM);
    return { ...g, items };
  });
};

/**
 * Pages with no sidebar entry of their own that belong to one that has.
 *
 * Inventory Health and Brands are opened from buttons on Inventory Master and
 * are not in the menu. The sidebar highlights the item whose path is the
 * longest prefix of the URL, so without this "/inventory/health" fell through
 * to "/inventory" — Product Catalogue — which has nothing to do with it.
 *
 * Exact parents, not a pattern: only these pages are re-pointed, so no other
 * URL can start highlighting Inventory Master by accident.
 */
export const NAV_PARENTS = Object.freeze({
  "/inventory/health": "/inventory/master",
  "/inventory/brands": "/inventory/master",
});

/**
 * The path the sidebar should treat as current.
 *
 * A child page reads as its parent. Two guards keep that honest: if the child
 * ever gets a menu entry of its own again, that entry wins; and if the parent
 * is not in this user's menu, the result is null — highlight nothing — rather
 * than letting the parent's path fall through to some broader prefix and light
 * up an unrelated item, which is the bug this exists to stop.
 *
 * @param {string} pathname  location.pathname
 * @param {Array<{path: string}>} items  every item in the sidebar
 * @returns {string|null}
 */
export const navPathFor = (pathname, items = []) => {
  for (const [child, parent] of Object.entries(NAV_PARENTS)) {
    if (pathname !== child && !pathname.startsWith(`${child}/`)) continue;
    if (items.some((i) => i.path === child)) return pathname;
    return items.some((i) => i.path === parent) ? parent : null;
  }
  return pathname;
};

export const buildNavigation = (user) => {
  const menu = Array.isArray(user?.menu) && user.menu.length ? user.menu : fallbackMenu(user);

  /**
   * Where "/" actually lands for this user.
   *
   * Import Team's home is the inventory dashboard, so their Customer Portal
   * "Dashboard" row would be a link that only ever redirects - and it would sit
   * in the menu alongside "Inventory Dashboard", which goes to the same screen
   * directly. Two rows leading to one screen, one of them highlighted and one
   * not, reads as a bug. The redirecting one is dropped.
   */
  const homePath = homePathFor(user);

  const groups = menu
    .map((mod) => ({
      key: mod.key,
      label: mod.label,
      icon: mod.icon,
      alwaysGrouped: ALWAYS_GROUPED.has(mod.key),
      items: mod.items
        .filter((item) => !(item.path === "/" && homePath !== "/"))
        .map((item) => ({
          id: `${mod.key}.${item.key}`,
          key: item.key,
          label: item.label,
          path: item.path,
          icon: item.icon,
          badge: BADGES[`${mod.key}.${item.key}`],
        })),
    }))
    .filter((mod) => mod.items.length > 0);

  return withRolesItem(withActivityItem(withUpcomingItem(groups, user), user), user);
};

export default buildNavigation;
