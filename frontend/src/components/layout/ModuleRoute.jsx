import { Outlet } from "react-router-dom";

import { useUserStore } from "../../store/userStore";
import { canCell } from "../../utils/cellKeys";
import { Unauthorized } from "../common/Unauthorized";

/**
 * A screen opens only for someone whose role grants its matrix cell.
 *
 * The sidebar is built from the server's menu, which already filters on each
 * screen's VIEW cell. Without this, the URL bar did not: every screen outside
 * the ordering group could be opened by typing its path, and was protected only
 * by whatever its API happened to check. This asks the same question the menu
 * does — `canAction` over `user.grants` from /auth/me — so the two agree.
 *
 * Refusal is a panel (<Unauthorized/>), not a redirect: redirecting "home" can
 * loop for a role whose home is itself refused.
 *
 * FAILS CLOSED once the session is loaded. If the server sent no grants (an
 * older backend, or a login response without them), the cell's permission keys
 * (utils/cellKeys.js, a checked copy of the registry) are asked of the user's
 * permission list instead of letting everyone through. Only a cell this bundle
 * does not know at all is still left to the API, since refusing it would lock
 * every account out of that screen.
 */
export const ModuleRoute = ({ module, submodule, action = "view", children }) => {
  const user = useUserStore((s) => s.user);
  const loading = useUserStore((s) => s.loading);

  // Permissive only while /auth/me is in flight. ProtectedRoute above already
  // shows the spinner then, so this never renders a page for an unknown user.
  if (loading) return children ?? <Outlet />;

  const allowed = user ? canCell(user, module, submodule, action) : false;
  if (allowed || allowed === null) return children ?? <Outlet />;

  return <Unauthorized />;
};

export default ModuleRoute;
