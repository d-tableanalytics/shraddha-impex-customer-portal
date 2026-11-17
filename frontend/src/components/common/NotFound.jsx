import { Link } from "react-router-dom";
import { Compass } from "lucide-react";

import { useUserStore } from "../../store/userStore";
import { homePathFor } from "../../utils/permissions";

/**
 * The catch-all route's screen: the path matches nothing in the router.
 *
 * Kept separate from <Unauthorized/> on purpose: "this page does not exist" and
 * "you may not open this page" are different answers.
 */
export function NotFound() {
  const user = useUserStore((s) => s.user);

  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white p-8 text-center">
      <Compass className="text-slate-400" size={28} />
      <h1 className="text-base font-semibold text-slate-900">Page not found</h1>
      <p className="text-sm text-slate-500">The address you followed does not match any screen in this portal.</p>
      <Link to={homePathFor(user)} className="text-sm font-medium text-primary-700 hover:underline">
        Go to your home screen
      </Link>
    </div>
  );
}

export default NotFound;
