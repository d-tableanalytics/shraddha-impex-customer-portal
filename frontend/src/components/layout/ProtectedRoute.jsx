import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useUserStore } from '../../store/userStore';
import { Loader2 } from 'lucide-react';
import { prefetchRoute } from '../../routes/routeChunks';

export const ProtectedRoute = () => {
  const { user, loading } = useUserStore();
  const { pathname } = useLocation();

  // While the session is being checked, download the CODE for the page being
  // opened, so it is ready when the check passes instead of being requested
  // after it. Nothing renders and no page data is requested until then — the
  // spinner below still holds, and the guards further down still decide.
  useEffect(() => {
    if (loading) prefetchRoute(pathname);
  }, [loading, pathname]);

  if (loading) {
    return (
      <div className="w-screen h-screen flex flex-col items-center justify-center bg-slate-50 gap-4">
        <Loader2 className="animate-spin text-primary-600" size={32} />
        <span className="text-sm font-semibold text-slate-600 select-none">
          Loading portal credentials...
        </span>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};
