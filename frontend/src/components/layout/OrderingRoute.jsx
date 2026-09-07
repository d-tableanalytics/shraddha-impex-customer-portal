import { Navigate, Outlet } from 'react-router-dom';

import { useUserStore } from '../../store/userStore';
import { canUseOrdering, homePathFor } from '../../utils/permissions';

/**
 * Gate for the ordering screens — bookings, the selection list, bulk upload,
 * booking history, indent history.
 *
 * WHY A ROUTE GUARD AND NOT JUST A HIDDEN MENU. The sidebar already declines to
 * build these items for a role that holds no ordering permission, and for a
 * long time that was enough: everyone who could sign in was either a customer
 * or trusted staff, and the missing button was the whole story. It stops being
 * enough the moment a role is DEFINED by what it must not reach — an Import
 * Team account with a bookmarked URL, or a browser restoring yesterday's tabs,
 * would land on a booking screen the menu never offered.
 *
 * It sends people home rather than showing "denied", because a role that has no
 * ordering permission was never refused anything: these screens are simply not
 * part of their portal, and an error page implies they took a wrong turn.
 *
 * NOT THE ENFORCEMENT POINT. Every booking write path re-checks server-side —
 * see MAY_BOOK in backend/modules/reservations/reservation.routes.js and the
 * `create_order` guard on POST /orders. This spares the user a screen that
 * would only fill with 403s.
 */
export const OrderingRoute = () => {
  const { user, loading } = useUserStore();

  // Still resolving the session. ProtectedRoute above already renders the
  // spinner, so this only has to avoid redirecting on a user that is not
  // loaded yet — which would bounce a legitimate customer to the dashboard on
  // every hard refresh.
  if (loading || !user) return null;

  // Sent HOME, wherever home is for them — for a role whose home is not "/"
  // this saves a second redirect through a screen they never see.
  if (!canUseOrdering(user)) return <Navigate to={homePathFor(user)} replace />;

  return <Outlet />;
};

export default OrderingRoute;
