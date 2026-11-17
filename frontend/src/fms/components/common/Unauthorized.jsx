import { Link } from "react-router-dom";
import { ShieldOff } from "lucide-react";

/**
 * What a guard renders when the signed-in user's role does not grant a screen.
 *
 * One component for every refusal (route guards and page-level checks), so a
 * user who follows a link or loses access mid-session is told why, instead of
 * being dropped on Home with no explanation. A panel, not a redirect: a
 * redirect "home" can loop for a role whose home is itself refused.
 *
 * Deliberately free of store imports so the Customer Portal's verbatim FMS copy
 * (src/fms/components/common/) resolves without adapters. `homePath` lets a
 * caller that knows a better landing page pass it in.
 *
 * Not the enforcement point: the API refuses the same request with a 403.
 */
export function Unauthorized({ homePath = "/" }) {
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
      <Link to={homePath} className="text-sm font-medium text-primary-700 hover:underline">
        Go to your home screen
      </Link>
    </div>
  );
}

export default Unauthorized;
