import { Outlet } from "react-router-dom";

import { useUserStore } from "../../store/userStore";
import { Unauthorized } from "../common/Unauthorized";

/**
 * Route guard for a screen whose rule is a helper over the user, for the few
 * screens that have no Customer Portal matrix cell to hand to ModuleRoute.
 *
 *   <PredicateRoute allow={canManageRoles}><RolesPermissions /></PredicateRoute>
 *
 * /admin/permissions is the case: the registry's administration.roles cell
 * serves only the Employee Portal, so the server never sends it here, but the
 * screen exists and is opened by manage_roles (audit F14). Mirrors the Employee
 * Portal's PredicateProtectedRoute. Not the enforcement point.
 */
export const PredicateRoute = ({ allow, children }) => {
  const user = useUserStore((s) => s.user);
  const loading = useUserStore((s) => s.loading);

  // Same loading rule as ModuleRoute: decide only once the session is known.
  if (loading) return children ?? <Outlet />;
  if (user && allow(user)) return children ?? <Outlet />;
  return <Unauthorized />;
};

export default PredicateRoute;
