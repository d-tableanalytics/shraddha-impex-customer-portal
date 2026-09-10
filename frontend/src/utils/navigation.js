import { PERMISSIONS, hasPermission, homePathFor } from "./permissions";

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
      { key: "health", label: "Inventory Health", path: "/inventory/health", icon: "Activity", any: [PERMISSIONS.VIEW_INVENTORY] },
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

  return menu
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
};

export default buildNavigation;
