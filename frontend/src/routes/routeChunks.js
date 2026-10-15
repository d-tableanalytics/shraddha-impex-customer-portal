import { matchPath } from "react-router-dom";

/**
 * The code-split page chunks, with ONE loader per page.
 *
 * The router's `lazy()` calls and the prefetches below share these functions, so
 * a chunk fetched early is the very module the router renders later — the
 * browser's module cache answers the second import, and nothing downloads twice.
 *
 * WHY PREFETCH AT ALL. A hard load was strictly serial: the app shell, then
 * `/auth/me`, and only once that answered did the router render the page and
 * start downloading its code. The page's code does not depend on who the user
 * is, so it can travel alongside the session check instead of after it. Only
 * CODE is fetched early: the page still does not render — or ask for any data —
 * until the session and the route guards have passed, exactly as before.
 */

export const loaders = {
  Dashboard: () => import("../pages/Dashboard/Dashboard"),
  CustomerOrders: () => import("../pages/CustomerOrders/CustomerOrders"),
  OrderHistory: () => import("../pages/OrderHistory/OrderHistory"),
  BulkUpload: () => import("../pages/BulkUpload/BulkUpload"),
  IndentHistory: () => import("../pages/IndentHistory/IndentHistory"),
  SalesDesk: () => import("../pages/SalesDesk/SalesDesk"),
  Admin: () => import("../pages/Admin/Admin"),
  UserManagement: () => import("../pages/Admin/Settings/UserManagement"),
  ProductDetailsAdmin: () => import("../pages/Admin/Settings/ProductDetails"),
  AuthLayout: () => import("../pages/Auth/AuthLayout"),
  Login: () => import("../pages/Auth/Login"),
  Inventory: () => import("../pages/Inventory/Inventory"),
  InventoryMaster: () => import("../pages/Inventory/InventoryMaster"),
  StockLedger: () => import("../pages/Inventory/StockLedger"),
  InventoryHealth: () => import("../pages/Inventory/InventoryHealth"),
  UpcomingStock: () => import("../pages/Inventory/UpcomingStock"),
  InventoryDashboard: () => import("../pages/Inventory/InventoryDashboard"),
  InventoryImport: () => import("../pages/Inventory/InventoryImport"),
  IndentAssignment: () => import("../pages/Inventory/IndentAssignment"),
  Reports: () => import("../pages/Reports/Reports"),
  Settings: () => import("../pages/Settings/Settings"),
  Help: () => import("../pages/Help/Help"),
  RolesPermissions: () => import("../pages/Admin/Settings/RolesPermissions"),
  O2dProtectedRoute: () => import("../fms/components/o2d/O2dProtectedRoute"),
  O2dPage: () => import("../fms/pages/O2d/O2dPage"),
  O2dNewOrderPage: () => import("../fms/pages/O2d/NewOrderPage"),
};

/** `lazy()` factory for a named export of one of the loaders above. */
export const lazyPage = (name, exportName = name) => () =>
  loaders[name]().then((m) => ({ default: m[exportName] }));

// Path → page, for the protected screens worth fetching ahead. Exact paths, in
// the router's own spelling; FMS is left out on purpose (its guard re-checks
// against another server, and its chunk is large).
const ROUTE_PAGES = [
  ["/", "Dashboard"],
  ["/orders/new", "CustomerOrders"],
  ["/orders/history", "OrderHistory"],
  ["/orders/bulk-upload", "BulkUpload"],
  ["/orders/indent-history", "IndentHistory"],
  ["/sales", "SalesDesk"],
  ["/admin", "Admin"],
  ["/admin/customers", "UserManagement"],
  ["/admin/users", "UserManagement"],
  ["/admin/permissions", "RolesPermissions"],
  ["/admin/product-details", "ProductDetailsAdmin"],
  ["/inventory", "Inventory"],
  ["/inventory/master", "InventoryMaster"],
  ["/inventory/ledger", "StockLedger"],
  ["/inventory/health", "InventoryHealth"],
  ["/inventory/upcoming", "UpcomingStock"],
  ["/inventory/dashboard", "InventoryDashboard"],
  ["/inventory/indent-assignment", "IndentAssignment"],
  ["/inventory/import", "InventoryImport"],
  ["/reports", "Reports"],
  ["/settings", "Settings"],
  ["/help", "Help"],
];

/** The page chunk a path renders, or null. */
export const pageForPath = (pathname) => {
  const path = String(pathname || "").split(/[?#]/)[0] || "/";
  for (const [pattern, page] of ROUTE_PAGES) {
    if (matchPath({ path: pattern, end: true }, path)) return page;
  }
  return null;
};

// One attempt per page per session; a failed prefetch is simply retried by the
// router's own lazy() when the page is actually opened.
const requested = new Set();

/**
 * Start downloading the chunk for `pathname`, if it is a known page.
 * Safe to call repeatedly. Does nothing under the test runner, where importing
 * a page module would execute it inside a component test.
 */
export const prefetchRoute = (pathname) => {
  if (import.meta.env.MODE === "test") return;
  const page = pageForPath(pathname);
  if (!page || requested.has(page)) return;
  requested.add(page);
  loaders[page]().catch(() => requested.delete(page));
};
