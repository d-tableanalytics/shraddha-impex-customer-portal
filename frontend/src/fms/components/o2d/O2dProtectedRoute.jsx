import { Navigate, Outlet } from "react-router-dom";

import { useUserStore } from "../../store/userStore";
import { hasPermission, PERMISSIONS } from "../../utils/permissions";
import { LoadingSpinner } from "../ui/LoadingSpinner";

/**
 * The O2D route guard.
 *
 * Modelled on `HrmsProtectedRoute`, but asking a different question. HRMS access
 * is a module/action/scope grant resolved into an HRMS actor; O2D is a PORTAL
 * module, so the question is a portal permission on the user the session already
 * carries. Using the HRMS guard here would refuse Billing and Accounts — roles
 * that hold no HRMS grant at all and are exactly who this module is for.
 *
 * ---------------------------------------------------------------------------
 * NOT THE ENFORCEMENT POINT
 * ---------------------------------------------------------------------------
 *
 * Every O2D endpoint re-checks the same permission, and the router itself is
 * fenced to the Employee Portal — a customer-domain request for `/api/v1/o2d`
 * gets a 404 from `requirePortalModule`, whatever the browser believes. This
 * guard exists so a user who cannot use the module does not see a broken screen,
 * not to keep anybody out.
 */
export function O2dProtectedRoute({ permission = PERMISSIONS.VIEW_O2D }) {
  const user = useUserStore((s) => s.user);
  const loading = useUserStore((s) => s.loading);

  /**
   * Wait before judging.
   *
   * `permissionsFor` falls back to a compiled-in map until `/auth/me` lands. For
   * a custom role — one a Super Admin invented, which this file has never heard
   * of — that fallback is empty, so deciding during the loading window would
   * bounce a legitimate user to the dashboard before their permissions arrived.
   */
  // `userStore.loading` starts true whenever a token exists, and flips false
  // once /auth/me resolves — so this single check covers the whole window.
  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    );
  }

  if (!hasPermission(user, permission)) return <Navigate to="/" replace />;

  return <Outlet />;
}

export default O2dProtectedRoute;
