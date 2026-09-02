import { createBrowserRouter } from "react-router-dom";
import MainLayout from "../components/layout/MainLayout";
import { ProtectedRoute } from "../components/layout/ProtectedRoute";
import { OrderingRoute } from "../components/layout/OrderingRoute";
import { HomeRoute } from "../components/layout/HomeRoute";
import { lazy } from 'react';

const Dashboard = lazy(() => import("../pages/Dashboard/Dashboard").then(m => ({ default: m.Dashboard })));
const CustomerOrders = lazy(() => import("../pages/CustomerOrders/CustomerOrders").then(m => ({ default: m.CustomerOrders })));
const OrderHistory = lazy(() => import("../pages/OrderHistory/OrderHistory").then(m => ({ default: m.OrderHistory })));
const BulkUpload = lazy(() => import("../pages/BulkUpload/BulkUpload").then(m => ({ default: m.BulkUpload })));
const IndentHistory = lazy(() => import("../pages/IndentHistory/IndentHistory").then(m => ({ default: m.IndentHistory })));
const SalesDesk = lazy(() => import("../pages/SalesDesk/SalesDesk").then(m => ({ default: m.SalesDesk })));
const Admin = lazy(() => import("../pages/Admin/Admin").then(m => ({ default: m.Admin })));
const UserManagement = lazy(() => import("../pages/Admin/Settings/UserManagement").then(m => ({ default: m.UserManagement })));
const PermissionMatrix = lazy(() => import("../pages/Admin/Settings/PermissionMatrix").then(m => ({ default: m.PermissionMatrix })));
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
                element: <CustomerOrders />,
              },
              {
                path: "orders/history",
                element: <OrderHistory />,
              },
              {
                path: "orders/bulk-upload",
                element: <BulkUpload />,
              },
              {
                path: "orders/indent-history",
                element: <IndentHistory />,
              },
            ],
          },
          {
            // Sales desk. The page re-checks the permission itself, and every
            // underlying API is guarded server-side.
            path: "sales",
            element: <SalesDesk />,
          },
          {
            path: "admin",
            element: <Admin />,
          },
          {
            path: "admin/users",
            element: <UserManagement />,
          },
          {
            path: "admin/permissions",
            element: <PermissionMatrix />,
          },
          {
            path: "admin/product-details",
            element: <ProductDetailsAdmin />,
          },
          {
            path: "inventory",
            element: <Inventory />,
          },
          {
            // IMS master. The page re-checks the permission itself, and every
            // underlying API is guarded server-side.
            path: "inventory/master",
            element: <InventoryMaster />,
          },
          {
            // Stock ledger (M2). Read-only movement history.
            path: "inventory/ledger",
            element: <StockLedger />,
          },
          {
            // Stock health (M4). Classification projected from balances.
            path: "inventory/health",
            element: <InventoryHealth />,
          },
          {
            // Inventory dashboard (M5). A read model over the projections.
            path: "inventory/dashboard",
            element: <InventoryDashboard />,
          },
          {
            // Import (M9). Files flow through the approved services; nothing
            // here writes to a projection.
            path: "inventory/import",
            element: <InventoryImport />,
          },
          {
            path: "reports",
            element: <Reports />,
          },
          {
            path: "settings",
            element: <Settings />,
          },
          {
            path: "help",
            element: <Help />,
          }
        ],
      }
    ]
  },
]);
export default router;
