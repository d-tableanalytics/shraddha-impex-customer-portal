import { createBrowserRouter, Navigate } from "react-router-dom";
import MainLayout from "../components/layout/MainLayout";
import { ProtectedRoute } from "../components/layout/ProtectedRoute";
import { OrderingRoute } from "../components/layout/OrderingRoute";
import { HomeRoute } from "../components/layout/HomeRoute";
import { ModuleRoute } from "../components/layout/ModuleRoute";
import { lazy } from 'react';

const Dashboard = lazy(() => import("../pages/Dashboard/Dashboard").then(m => ({ default: m.Dashboard })));
const CustomerOrders = lazy(() => import("../pages/CustomerOrders/CustomerOrders").then(m => ({ default: m.CustomerOrders })));
const OrderHistory = lazy(() => import("../pages/OrderHistory/OrderHistory").then(m => ({ default: m.OrderHistory })));
const BulkUpload = lazy(() => import("../pages/BulkUpload/BulkUpload").then(m => ({ default: m.BulkUpload })));
const IndentHistory = lazy(() => import("../pages/IndentHistory/IndentHistory").then(m => ({ default: m.IndentHistory })));
const SalesDesk = lazy(() => import("../pages/SalesDesk/SalesDesk").then(m => ({ default: m.SalesDesk })));
const Admin = lazy(() => import("../pages/Admin/Admin").then(m => ({ default: m.Admin })));
const UserManagement = lazy(() => import("../pages/Admin/Settings/UserManagement").then(m => ({ default: m.UserManagement })));
// Admin - Product Details. Descriptions, photographs and videos,
// the content the inventory slide-over shows. The page re-checks the
// permission itself, and every underlying API is guarded server-side.
const ProductDetailsAdmin = lazy(() => import("../pages/Admin/Settings/ProductDetails").then(m => ({ default: m.ProductDetailsAdmin })));
const AuthLayout = lazy(() => import("../pages/Auth/AuthLayout").then(m => ({ default: m.AuthLayout })));
const Login = lazy(() => import("../pages/Auth/Login").then(m => ({ default: m.Login })));
const Inventory = lazy(() => import("../pages/Inventory/Inventory").then(m => ({ default: m.Inventory })));
// IMS Module M1 — the internal stock master, distinct from the customer-facing
// Inventory view above. Both pages re-check their permission themselves.
const InventoryMaster = lazy(() => import("../pages/Inventory/InventoryMaster").then(m => ({ default: m.InventoryMaster })));
const StockLedger = lazy(() => import("../pages/Inventory/StockLedger").then(m => ({ default: m.StockLedger })));
const InventoryHealth = lazy(() => import("../pages/Inventory/InventoryHealth").then(m => ({ default: m.InventoryHealth })));
const InventoryDashboard = lazy(() => import("../pages/Inventory/InventoryDashboard").then(m => ({ default: m.InventoryDashboard })));
const InventoryImport = lazy(() => import("../pages/Inventory/InventoryImport").then(m => ({ default: m.InventoryImport })));
const Reports = lazy(() => import("../pages/Reports/Reports").then(m => ({ default: m.Reports })));
const Settings = lazy(() => import("../pages/Settings/Settings").then(m => ({ default: m.Settings })));
const Help = lazy(() => import("../pages/Help/Help").then(m => ({ default: m.Help })));
// Roles & Permissions — this portal's modules only. The page re-checks
// manage_roles itself, and the API behind it is guarded server-side.
const RolesPermissions = lazy(() => import("../pages/Admin/Settings/RolesPermissions").then(m => ({ default: m.RolesPermissions })));
// FMS (O2D). The Employee Portal's screens, verbatim, calling the Employee API
// — see src/fms/ and scripts/fms-port.mjs. The guard re-checks view_o2d against
// that server's answer, and every API behind it is guarded there too.
const O2dProtectedRoute = lazy(() => import("../fms/components/o2d/O2dProtectedRoute").then(m => ({ default: m.O2dProtectedRoute })));
const O2dPage = lazy(() => import("../fms/pages/O2d/O2dPage").then(m => ({ default: m.O2dPage })));
const O2dNewOrderPage = lazy(() => import("../fms/pages/O2d/NewOrderPage").then(m => ({ default: m.NewOrderPage })));

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
            // Inventory dashboard (M5). A read model over the projections.
            path: "inventory/dashboard",
            element: <ModuleRoute module="inventory" submodule="dashboard"><InventoryDashboard /></ModuleRoute>,
          },
          {
            // Import (M9). Files flow through the approved services; nothing
            // here writes to a projection.
            path: "inventory/import",
            element: <ModuleRoute module="inventory" submodule="imports"><InventoryImport /></ModuleRoute>,
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
