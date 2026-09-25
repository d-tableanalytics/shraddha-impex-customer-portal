import { Outlet, Link } from "react-router-dom";
import { ShieldOff } from "lucide-react";

import { useUserStore } from "../../store/userStore";
import { canAction, homePathFor } from "../../utils/permissions";

/**
 * A screen opens only for someone whose role grants its matrix cell.
 *
 * The sidebar is built from the server's menu, which already filters on each
 * screen's VIEW cell. Without this, the URL bar did not: every screen outside
 * the ordering group could be opened by typing its path, and was protected only
 * by whatever its API happened to check. This asks the same question the menu
 * does — `canAction` over `user.grants` from /auth/me — so the two agree.
 *
 * Refusal is a panel, not a redirect: redirecting "home" can loop for a role
 * whose home is itself refused. If the server sent no grants at all (an older
 * backend), this steps aside and leaves the decision to the API, rather than
 * locking every account out of every screen.
 */
export const ModuleRoute = ({ module, submodule, action = "view", children }) => {
  const user = useUserStore((s) => s.user);
  const decides = Array.isArray(user?.grants);

  if (!decides || canAction(user, module, submodule, action)) {
    return children ?? <Outlet />;
  }

  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white p-8 text-center">
      <ShieldOff className="text-slate-400" size={28} />
      <h1 className="text-base font-semibold text-slate-900">You don&apos;t have access to this screen</h1>
      <p className="text-sm text-slate-500">
        Your role does not include it. If you need it, ask an administrator to grant it in Roles &amp; Permissions.
      </p>
      <Link to={homePathFor(user)} className="text-sm font-medium text-primary-700 hover:underline">
        Go to your home screen
      </Link>
    </div>
  );
};

export default ModuleRoute;
