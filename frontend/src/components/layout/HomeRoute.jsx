import { Navigate } from 'react-router-dom';

import { useUserStore } from '../../store/userStore';
import { homePathFor } from '../../utils/permissions';

/**
 * The portal's front door.
 *
 * Renders the main dashboard for everyone whose home it is, and redirects the
 * roles whose home is elsewhere — today that is Import Team, which opens on the
 * inventory dashboard instead. See homePathFor() for why.
 *
 * SITTING AT "/" RATHER THAN IN THE LOGIN HANDLER is what makes this hold. A
 * redirect written into the login flow only covers the moment of signing in;
 * this also covers a bookmark, a browser restoring yesterday's tabs, the logo
 * in the sidebar, and every guard that sends someone home. There is one answer
 * to "where does this user start", and every route into "/" gets it.
 *
 * The dashboard is passed in as a child so the router keeps its lazy import —
 * importing it here would pull the main dashboard's bundle into the app shell
 * for users who are never shown it.
 */
export const HomeRoute = ({ children }) => {
  const { user, loading } = useUserStore();

  // Still resolving the session. ProtectedRoute above renders the spinner; this
  // only has to avoid redirecting on a user that is not loaded yet.
  if (loading || !user) return null;

  const home = homePathFor(user);
  if (home !== '/') return <Navigate to={home} replace />;

  return children;
};

export default HomeRoute;
