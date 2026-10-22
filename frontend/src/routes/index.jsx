import { createBrowserRouter, Navigate } from "react-router-dom";
import MainLayout from "../components/layout/MainLayout";
import { ProtectedRoute } from "../components/layout/ProtectedRoute";
import { OrderingRoute } from "../components/layout/OrderingRoute";
import { HomeRoute } from "../components/layout/HomeRoute";
import { ModuleRoute } from "../components/layout/ModuleRoute";
import { lazy } from 'react';
// One loader per page, shared with route prefetching — see routeChunks.js.
import { lazyPage } from './routeChunks';

const Dashboard = lazy(lazyPage("Dashboard"));
const CustomerOrders = lazy(lazyPage("CustomerOrders"));
const OrderHistory = lazy(lazyPage("OrderHistory"));
const BulkUpload = lazy(lazyPage("BulkUpload"));
const IndentHistory = lazy(lazyPage("IndentHistory"));
const SalesDesk = lazy(lazyPage("SalesDesk"));
const Admin = lazy(lazyPage("Admin"));
const UserManagement = lazy(lazyPage("UserManagement"));
// Admin - Product Details. Descriptions, photographs and videos,
// the content the inventory slide-over shows. The page re-checks the
// permission itself, and every underlying API is guarded server-side.
const ProductDetailsAdmin = lazy(lazyPage("ProductDetailsAdmin"));
const AuthLayout = lazy(lazyPage("AuthLayout"));
const Login = lazy(lazyPage("Login"));
const Inventory = lazy(lazyPage("Inventory"));
// IMS Module M1 — the internal stock master, distinct from the customer-facing
// Inventory view above. Both pages re-check their permission themselves.
const InventoryMaster = lazy(lazyPage("InventoryMaster"));
const StockLedger = lazy(lazyPage("StockLedger"));
const InventoryHealth = lazy(lazyPage("InventoryHealth"));
// Upcoming Stock (GET /inventory/upcoming). Opens for anyone who can open
// Inventory Health (view_inventory), the screen it sits beside in the menu.
const UpcomingStock = lazy(lazyPage("UpcomingStock"));
const InventoryDashboard = lazy(lazyPage("InventoryDashboard"));
const InventoryImport = lazy(lazyPage("InventoryImport"));
const InventoryBrands = lazy(lazyPage("InventoryBrands"));
const IndentAssignment = lazy(lazyPage("IndentAssignment"));
const Reports = lazy(lazyPage("Reports"));
const Settings = lazy(lazyPage("Settings"));
const Help = lazy(lazyPage("Help"));
// Roles & Permissions — this portal's modules only. The page re-checks
// manage_roles itself, and the API behind it is guarded server-side.
const RolesPermissions = lazy(lazyPage("RolesPermissions"));
// FMS (O2D). The Employee Portal's screens, verbatim, calling the Employee API
// — see src/fms/ and scripts/fms-port.mjs. The guard re-checks view_o2d against
// that server's answer, and every API behind it is guarded there too.
const O2dProtectedRoute = lazy(lazyPage("O2dProtectedRoute"));
const O2dPage = lazy(lazyPage("O2dPage"));
const O2dNewOrderPage = lazy(lazyPage("O2dNewOrderPage", "NewOrderPage"));

export const router = createBrowserRouter([
  {
    element: <AuthLayout />,
    children: [
      { path: "/login", element: <Login /> },
    ]
  },
  {
    path: "/",
    element: <ProtectedRoute />,
    children: [
      {
        path: "/",
        element: <MainLayout />,
        children: [
          {
            // The front door. Most roles get the main dashboard; the ones whose
            // home is elsewhere are redirected here rather than in the login
            // handler, so a bookmark and a restored tab land in the same place
            // as a fresh sign-in.
            path: "",
            element: <HomeRoute><Dashboard /></HomeRoute>,
          },
          {
            // The ordering screens, behind one gate.
            //
            // Grouped under a layout route rather than repeating a check in
            // each page: the rule is "does this user work orders at all", it is
            // the same rule the sidebar uses to decide whether to offer them,
            // and stating it once is what stops the menu and the router
            // disagreeing. An internal stock role landing here by URL is sent
            // to the dashboard.
            element: <OrderingRoute />,
            children: [
              {
                path: "orders/new",
                element: <ModuleRoute module="customer_portal" submodule="create_booking"><CustomerOrders /></ModuleRoute>,
              },
              {
                path: "orders/history",
                element: <ModuleRoute module="customer_portal" submodule="booking_history"><OrderHistory /></ModuleRoute>,
              },
              {
                path: "orders/bulk-upload",
                element: <ModuleRoute module="customer_portal" submodule="bulk_upload"><BulkUpload /></ModuleRoute>,
              },
              {
                path: "orders/indent-history",
                element: <ModuleRoute module="customer_portal" submodule="indent_history"><IndentHistory /></ModuleRoute>,
              },
            ],
          },
          {
            // Sales desk. The page re-checks the permission itself, and every
            // underlying API is guarded server-side.
            path: "sales",
            element: <ModuleRoute module="sales" submodule="bookings"><SalesDesk /></ModuleRoute>,
          },
          {
            path: "admin",
            element: <ModuleRoute module="administration" submodule="overview"><Admin /></ModuleRoute>,
          },
          /*
           * TWO USER-MANAGEMENT ROUTES, not one screen doing both jobs.
           *
           * Same component, two audiences — see the note on UserManagement.
           * They are separate ROUTES rather than a tab because they are
           * separate workflows with separate permissions: Customer Management
           * admits Sales, Internal User Management does not, and a tab would
           * put the second one inside a page the first can already open.
           *
           * Which of these a DOMAIN offers is decided server-side by the module
           * registry, and the sidebar is built from it — so the Employee Portal
           * simply never shows /admin/customers.
           */
          {
            path: "admin/customers",
            element: <ModuleRoute module="administration" submodule="customers"><UserManagement audience="customers" /></ModuleRoute>,
          },
          {
            path: "admin/users",
            element: <ModuleRoute module="administration" submodule="users"><UserManagement audience="internal" /></ModuleRoute>,
          },
          {
            path: "admin/permissions",
            element: <RolesPermissions />,
          },
          {
            path: "admin/product-details",
            element: <ModuleRoute module="inventory" submodule="product_content"><ProductDetailsAdmin /></ModuleRoute>,
          },
          {
            path: "inventory",
            element: <ModuleRoute module="customer_portal" submodule="catalogue"><Inventory /></ModuleRoute>,
          },
          {
            // IMS master. The page re-checks the permission itself, and every
            // underlying API is guarded server-side.
            path: "inventory/master",
            element: <ModuleRoute module="inventory" submodule="master"><InventoryMaster /></ModuleRoute>,
          },
          {
            // Stock ledger (M2). Read-only movement history.
            path: "inventory/ledger",
            element: <ModuleRoute module="inventory" submodule="ledger"><StockLedger /></ModuleRoute>,
          },
          {
            // Stock health (M4). Classification projected from balances.
            path: "inventory/health",
            element: <ModuleRoute module="inventory" submodule="health"><InventoryHealth /></ModuleRoute>,
          },
          {
            // Upcoming stock. Gated on the Health screen's cell (view_inventory)
            // because it has no registry entry; its API re-checks every action.
            path: "inventory/upcoming",
            element: <ModuleRoute module="inventory" submodule="health"><UpcomingStock /></ModuleRoute>,
          },
          {
            // Inventory dashboard (M5). A read model over the projections.
            path: "inventory/dashboard",
            element: <ModuleRoute module="inventory" submodule="dashboard"><InventoryDashboard /></ModuleRoute>,
          },
          {
            // Indent Stock Assignment: which customer indent arriving stock
            // goes to (auto FIFO, manual, reassign).
            path: "inventory/indent-assignment",
            element: <ModuleRoute module="inventory" submodule="indent_assignment"><IndentAssignment /></ModuleRoute>,
          },
          {
            // Import (M9). Files flow through the approved services; nothing
            // here writes to a projection.
            path: "inventory/import",
            element: <ModuleRoute module="inventory" submodule="imports"><InventoryImport /></ModuleRoute>,
          },
          {
            // The brand master — every brand list in both portals reads it.
            path: "inventory/brands",
            element: <ModuleRoute module="inventory" submodule="brands"><InventoryBrands /></ModuleRoute>,
          },
          {
            path: "reports",
            element: <ModuleRoute module="reports" submodule="operational"><Reports /></ModuleRoute>,
          },
          {
            path: "settings",
            element: <ModuleRoute module="customer_portal" submodule="profile"><Settings /></ModuleRoute>,
          },
          {
            path: "help",
            element: <ModuleRoute module="customer_portal" submodule="support"><Help /></ModuleRoute>,
          },
          {
            // FMS, at the same paths as the Employee Portal, so a notification's
            // link (`/fms/o2d/orders?open=<id>`) opens the same screen here.
            // `orders/new` before `:tab`, or "orders" would be read as a tab.
            path: "fms/o2d",
            element: <O2dProtectedRoute />,
            children: [
              { index: true, element: <Navigate to="/fms/o2d/tasks" replace /> },
              { path: "orders/new", element: <O2dNewOrderPage /> },
              { path: ":tab", element: <O2dPage /> },
            ],
          },
        ],
      }
    ]
  },
]);
export default router;
