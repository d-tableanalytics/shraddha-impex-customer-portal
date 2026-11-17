import { Link } from "react-router-dom";
import { ShieldOff } from "lucide-react";

import { useUserStore } from "../../store/userStore";
import { homePathFor } from "../../utils/permissions";

/**
 * What a guard renders when the signed-in user's role does not grant a screen.
 *
 * One component for every refusal: ModuleRoute, OrderingRoute, the admin-only
 * routes and the page-level checks. A user who follows a link, or loses access
 * mid-session, is told why instead of being dropped on Home with no
 * explanation. A panel, not a redirect: redirecting "home" can loop for a role
 * whose home is itself refused.
 *
 * The FMS screens (src/fms) use the Employee Portal's verbatim copy at
 * src/fms/components/common/Unauthorized.jsx, which looks the same.
 *
 * Not the enforcement point: the API refuses the same request with a 403.
 */
export function Unauthorized({ homePath }) {
  const user = useUserStore((s) => s.user);

  return (
    <div
      role="alert"
      className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white p-8 text-center"
    >
      <ShieldOff className="text-slate-400" size={28} />
      <h1 className="text-base font-semibold text-slate-900">You don&apos;t have access to this screen</h1>
      <p className="text-sm text-slate-500">
        Your role does not include it. If you need it, ask an administrator to grant it in Roles &amp; Permissions.
      </p>
      <Link to={homePath ?? homePathFor(user)} className="text-sm font-medium text-primary-700 hover:underline">
        Go to your home screen
      </Link>
    </div>
  );
}

export default Unauthorized;
