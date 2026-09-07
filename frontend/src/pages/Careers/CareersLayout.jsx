import { Outlet, Link } from "react-router-dom";

/**
 * The chrome for every public careers page.
 *
 * ---------------------------------------------------------------------------
 * Deliberately NOT the portal's MainLayout
 * ---------------------------------------------------------------------------
 * These pages are reachable without signing in — a job applicant has no
 * account, and a candidate deciding on an offer is not an employee yet. The
 * portal's shell assumes a session: a sidebar of modules, a notifications bell,
 * a user menu. Rendering that to an anonymous visitor would show them a
 * navigation they cannot use and, worse, invite the assumption that some of it
 * might work.
 *
 * So this is a plain, self-contained page frame. It sits OUTSIDE
 * `ProtectedRoute` in the router, which is the only thing that makes these
 * routes reachable at all.
 */
export function CareersLayout() {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/careers" className="text-sm font-bold text-slate-900 hover:text-primary-700">
            Careers
          </Link>
          <Link
            to="/login"
            className="text-xs font-semibold text-slate-500 hover:text-slate-800"
          >
            Employee sign in
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <p className="text-[11px] text-slate-400">
            Information you submit here is used to consider your application and is handled
            confidentially.
          </p>
        </div>
      </footer>
    </div>
  );
}

export default CareersLayout;
