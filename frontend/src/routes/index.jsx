import { createBrowserRouter, Navigate } from "react-router-dom";
import MainLayout from "../components/layout/MainLayout";
import { ProtectedRoute } from "../components/layout/ProtectedRoute";
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

// ── HRMS (AD-14: same domain, /hrms prefix, same session) ─────────────────
// Lazy like every other route, so a customer never downloads an HRMS chunk.
import { HrmsProtectedRoute } from "../components/hrms/HrmsProtectedRoute";
import { REPORTS_ENTRY_GRANTS } from "../components/hrms/navItems";
const HrmsDashboard = lazy(() => import("../pages/Hrms/HrmsDashboard").then(m => ({ default: m.HrmsDashboard })));
const HrmsMyProfilePage = lazy(() => import("../pages/Hrms/MyProfilePage").then(m => ({ default: m.MyProfilePage })));
const HrmsOrgStructurePage = lazy(() => import("../pages/Hrms/org/OrgStructurePage").then(m => ({ default: m.OrgStructurePage })));
const HrmsLeavePage = lazy(() => import("../pages/Hrms/leave/LeavePage").then(m => ({ default: m.LeavePage })));
const HrmsAttendancePage = lazy(() => import("../pages/Hrms/attendance/AttendancePage").then(m => ({ default: m.AttendancePage })));
const HrmsExpensesPage = lazy(() => import("../pages/Hrms/expenses/ExpensesPage").then(m => ({ default: m.ExpensesPage })));
const HrmsExitsPage = lazy(() => import("../pages/Hrms/exits/ExitsPage").then(m => ({ default: m.ExitsPage })));
const HrmsAssetsPage = lazy(() => import("../pages/Hrms/assets/AssetsPage").then(m => ({ default: m.AssetsPage })));
const HrmsDocumentsPage = lazy(() => import("../pages/Hrms/documents/DocumentsPage").then(m => ({ default: m.DocumentsPage })));
const HrmsHelpdeskPage = lazy(() => import("../pages/Hrms/helpdesk/HelpdeskPage").then(m => ({ default: m.HelpdeskPage })));
const HrmsPayrollPage = lazy(() => import("../pages/Hrms/payroll/PayrollPage").then(m => ({ default: m.PayrollPage })));
const HrmsEmployeesPage = lazy(() => import("../pages/Hrms/employees/EmployeesPage").then(m => ({ default: m.EmployeesPage })));
const HrmsEmployeeProfilePage = lazy(() => import("../pages/Hrms/employees/EmployeeProfilePage").then(m => ({ default: m.EmployeeProfilePage })));
const HrmsEmployeeEditPage = lazy(() => import("../pages/Hrms/employees/EmployeeEditPage").then(m => ({ default: m.EmployeeEditPage })));
const HrmsHiringPage = lazy(() => import("../pages/Hrms/hiring/HiringPage").then(m => ({ default: m.HiringPage })));
const HrmsOnboardingPage = lazy(() => import("../pages/Hrms/onboarding/OnboardingPage").then(m => ({ default: m.OnboardingPage })));
const HrmsPerformancePage = lazy(() => import("../pages/Hrms/performance/PerformancePage").then(m => ({ default: m.PerformancePage })));
const HrmsEngagePage = lazy(() => import("../pages/Hrms/engage/EngagePage").then(m => ({ default: m.EngagePage })));
const HrmsPlanningPage = lazy(() => import("../pages/Hrms/planning/PlanningPage").then(m => ({ default: m.PlanningPage })));
const HrmsReportsPage = lazy(() => import("../pages/Hrms/reports/ReportsPage").then(m => ({ default: m.ReportsPage })));
const HrmsSettingsPage = lazy(() => import("../pages/Hrms/settings/SettingsPage").then(m => ({ default: m.SettingsPage })));
const HrmsAuditLogsPage = lazy(() => import("../pages/Hrms/audit/AuditLogsPage").then(m => ({ default: m.AuditLogsPage })));
const HrmsInboxPage = lazy(() => import("../pages/Hrms/inbox/InboxPage").then(m => ({ default: m.InboxPage })));

// ── Public careers (no session: an applicant has no account) ──────────
const CareersLayout = lazy(() => import("../pages/Careers/CareersLayout").then(m => ({ default: m.CareersLayout })));
const CareersHome = lazy(() => import("../pages/Careers/CareersHome").then(m => ({ default: m.CareersHome })));
const CareersRolePage = lazy(() => import("../pages/Careers/CareersRolePage").then(m => ({ default: m.CareersRolePage })));
const CareersOfferPage = lazy(() => import("../pages/Careers/OfferPage").then(m => ({ default: m.OfferPage })));

export const router = createBrowserRouter([
  {
    element: <AuthLayout />,
    children: [
      { path: "/login", element: <Login /> },
    ]
  },
  {
    /*
     * The public careers surface.
     *
     * Sits OUTSIDE ProtectedRoute deliberately, and is the only part of this
     * app that does. A job applicant has no account, and a candidate deciding
     * on an offer is not an employee yet; putting these behind the session
     * guard would make the careers page unreachable by the only people it is
     * for.
     *
     * The offer route is addressed by a single-use access token, never by an
     * offer id — the token is the credential, and the server holds only its
     * hash.
     */
    path: "/careers",
    element: <CareersLayout />,
    children: [
      { index: true, element: <CareersHome /> },
      { path: "offer/:token", element: <CareersOfferPage /> },
      { path: ":slug", element: <CareersRolePage /> },
    ],
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
            path: "",
            element: <Dashboard />,
          },
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
          },
          {
            // HRMS lives INSIDE the portal's MainLayout — same sidebar, same
            // top bar, same session. Not a second application (AD-14).
            //
            // HrmsProtectedRoute adds the AD-4 check on top of the portal's
            // authentication: being signed in is not being an HRMS user, so a
            // customer typing /hrms/... is redirected here, not just hidden
            // from the menu.
            path: "hrms",
            element: <HrmsProtectedRoute />,
            children: [
              { index: true, element: <Navigate to="/hrms/dashboard" replace /> },
              { path: "dashboard", element: <HrmsDashboard /> },
              {
                // "My Profile". A redirect to the actor's own employee record,
                // as in the reference. Behind the employees module because
                // that is where it lands, and because the nav item declares
                // the same requirement - a link the router would then refuse
                // is exactly the dead end the nav gate exists to prevent.
                path: "me",
                element: <HrmsProtectedRoute module="employees" />,
                children: [{ index: true, element: <HrmsMyProfilePage /> }],
              },
              {
                // Employee Master. The route shape matches the reference,
                // which has NO /employees/new — creation happens in a drawer
                // over the directory, and only editing gets its own page.
                //
                // The nested guard re-checks the module, so a customer or an
                // HRMS user without employee access is redirected rather than
                // shown an empty screen.
                path: "employees",
                element: <HrmsProtectedRoute module="employees" />,
                children: [
                  { index: true, element: <HrmsEmployeesPage /> },
                  { path: ":id", element: <HrmsEmployeeProfilePage /> },
                  { path: ":id/edit", element: <HrmsEmployeeEditPage /> },
                ],
              },
              {
                // Org Structure. The tab lives in the URL, as it does in the
                // reference (`/org/:tab`), so a tab is linkable and the
                // Departments employee-count link can point at one.
                path: "org",
                element: <HrmsProtectedRoute module="org-structure" />,
                children: [
                  { index: true, element: <HrmsOrgStructurePage /> },
                  { path: ":tab", element: <HrmsOrgStructurePage /> },
                ],
              },
              {
                // Leave, with Holidays as one of its tabs — the reference's
                // shape, and the reason there is no separate holidays module.
                // The tab lives in the URL so it is linkable.
                path: "leave",
                element: <HrmsProtectedRoute module="leave" />,
                children: [
                  { index: true, element: <HrmsLeavePage /> },
                  { path: ":tab", element: <HrmsLeavePage /> },
                ],
              },
              {
                // Helpdesk: my tickets, the resolver queue for the categories my
                // team answers for, the knowledge base, and the catalogue. The
                // tab lives in the URL, as it does for every other module here.
                path: "helpdesk",
                element: <HrmsProtectedRoute module="helpdesk" />,
                children: [
                  { index: true, element: <HrmsHelpdeskPage /> },
                  { path: ":tab", element: <HrmsHelpdeskPage /> },
                ],
              },
              {
                // Documents: the company library, policies with acknowledgment,
                // my own records, and the folder tree. The tab lives in the URL,
                // as it does for every other module here.
                path: "documents",
                element: <HrmsProtectedRoute module="documents" />,
                children: [
                  { index: true, element: <HrmsDocumentsPage /> },
                  { path: ":tab", element: <HrmsDocumentsPage /> },
                ],
              },
              {
                // Assets: my kit, the request queue, the inventory and the
                // category catalogue. The tab lives in the URL, as it does for
                // Leave, Expenses and Exits.
                path: "assets",
                element: <HrmsProtectedRoute module="assets" />,
                children: [
                  { index: true, element: <HrmsAssetsPage /> },
                  { path: ":tab", element: <HrmsAssetsPage /> },
                ],
              },
              {
                // Exits: the offboarding workflow — my exit, the HR/manager
                // queue, and the clearances assigned to me. The tab lives in
                // the URL, as it does for Leave and Expenses.
                path: "exits",
                element: <HrmsProtectedRoute module="exits" />,
                children: [
                  { index: true, element: <HrmsExitsPage /> },
                  { path: ":tab", element: <HrmsExitsPage /> },
                ],
              },
              {
                // Expenses: claims, the approver queue, and the category
                // catalogue. The tab lives in the URL, as it does for Leave.
                path: "expenses",
                element: <HrmsProtectedRoute module="expenses" />,
                children: [
                  { index: true, element: <HrmsExpensesPage /> },
                  { path: ":tab", element: <HrmsExpensesPage /> },
                ],
              },
              {
                // Attendance: punches, history, team view and corrections.
                // The tab lives in the URL, as it does for Org Structure and
                // Leave — the reference keeps it in component state, so a
                // refresh drops the manager back onto My Attendance.
                path: "attendance",
                element: <HrmsProtectedRoute module="attendance" />,
                children: [
                  { index: true, element: <HrmsAttendancePage /> },
                  { path: ":tab", element: <HrmsAttendancePage /> },
                ],
              },
              {
                // Payroll. The tab lives in the URL, as it does for every other
                // multi-tab HRMS module here, so a tab is linkable and survives
                // a refresh.
                path: "payroll",
                element: <HrmsProtectedRoute module="payroll" />,
                children: [
                  { index: true, element: <HrmsPayrollPage /> },
                  { path: ":tab", element: <HrmsPayrollPage /> },
                ],
              },
              {
                // Hiring. The tab lives in the URL, as it does for every other
                // multi-tab HRMS module here, so a tab is linkable and
                // survives a refresh.
                //
                // The candidate-facing half of this module is NOT here: it is
                // the /careers tree above, outside the session guard.
                path: "hiring",
                element: <HrmsProtectedRoute module="hiring" />,
                children: [
                  { index: true, element: <HrmsHiringPage /> },
                  { path: ":tab", element: <HrmsHiringPage /> },
                ],
              },
              {
                // Onboarding. The tab lives in the URL, as it does for every
                // other multi-tab HRMS module here, so a tab is linkable and
                // survives a refresh. It defaults to the new hire's own portal
                // rather than to an HR screen, as the reference does.
                path: "onboarding",
                element: <HrmsProtectedRoute module="onboarding" />,
                children: [
                  { index: true, element: <HrmsOnboardingPage /> },
                  { path: ":tab", element: <HrmsOnboardingPage /> },
                ],
              },
              {
                // Performance. The tab lives in the URL, as it does for every
                // other multi-tab HRMS module here, so a tab is linkable and
                // survives a refresh. It defaults to the employee's own goals
                // rather than to an HR screen, as the reference does.
                path: "performance",
                element: <HrmsProtectedRoute module="performance" />,
                children: [
                  { index: true, element: <HrmsPerformancePage /> },
                  { path: ":tab", element: <HrmsPerformancePage /> },
                ],
              },
              {
                // Engage. The tab lives in the URL, as it does for every other
                // multi-tab HRMS module here, so a tab is linkable and survives
                // a refresh. Every tab is visible to everyone — Engage has no
                // team scope; what HR alone gets is the write controls inside.
                path: "engage",
                element: <HrmsProtectedRoute module="engage" />,
                children: [
                  { index: true, element: <HrmsEngagePage /> },
                  { path: ":tab", element: <HrmsEngagePage /> },
                ],
              },
              {
                // Planning. The tab lives in the URL, as it does for every
                // other multi-tab HRMS module here — the reference holds it in
                // component state on a single route, so neither of its tabs is
                // linkable and a refresh always returns to Headcount.
                //
                // Org scope only: planning the company's headcount and budget
                // has no self or team view in either codebase. `view:org`
                // reads; `edit:org` adds the write controls, which the server
                // enforces regardless of what renders.
                path: "planning",
                element: <HrmsProtectedRoute module="planning" />,
                children: [
                  { index: true, element: <HrmsPlanningPage /> },
                  { path: ":tab", element: <HrmsPlanningPage /> },
                ],
              },
              {
                // Reports: the catalogue, and one report open at a time. The
                // report key lives in the URL so a report is linkable and
                // survives a refresh — the reference holds it in component
                // state, where it is neither.
                //
                // The `module` gate is `reports`, matching the sidebar. Which
                // reports exist for this viewer is decided by the server, on
                // every request, from each report's own data module.
                path: "reports",
                element: <HrmsProtectedRoute module="reports" anyOf={REPORTS_ENTRY_GRANTS} />,
                children: [
                  { index: true, element: <HrmsReportsPage /> },
                  { path: ":key", element: <HrmsReportsPage /> },
                ],
              },
              {
                // Audit logs: its own page and its own module key, as in the
                // reference. Read by super_admin, hr_admin and auditor — two
                // roles that cannot open Settings, which is exactly why the
                // server redacts credentials out of the trail.
                path: "audit-logs",
                element: <HrmsProtectedRoute module="audit-logs" />,
                children: [{ index: true, element: <HrmsAuditLogsPage /> }],
              },
              {
                // Settings: company profile and branding, the read-only role
                // matrix, SSO providers and integrations. The tab lives in the
                // URL, as it does for every other module here.
                path: "settings",
                element: <HrmsProtectedRoute module="settings" />,
                children: [
                  { index: true, element: <HrmsSettingsPage /> },
                  { path: ":tab", element: <HrmsSettingsPage /> },
                ],
              },
              {
                // Inbox. A single page, as the reference has — its filters live
                // in the QUERY STRING rather than in component state, so an
                // "unread" view is linkable and survives a refresh.
                //
                // `self` scope only. The grant is in the baseline, so every
                // HRMS role reaches it; what they see is their own items, which
                // the server enforces by putting the actor's own employee id in
                // every filter.
                path: "inbox",
                element: <HrmsProtectedRoute module="inbox" />,
                children: [{ index: true, element: <HrmsInboxPage /> }],
              },
              // Further module routes are added here as each one ships.
              // Deliberately absent until then: a route to an unbuilt page is
              // worse than a 404, because it looks like a broken feature
              // rather than a feature that does not exist yet.
            ],
          },
        ],
      }
    ]
  },
]);
export default router;
