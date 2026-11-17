import { Outlet } from 'react-router-dom';

import { useUserStore } from '../../store/userStore';
import { canUseOrdering } from '../../utils/permissions';
import { Unauthorized } from '../common/Unauthorized';

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
 * A refusal renders <Unauthorized/> (2026-11-17). It used to send people home
 * silently, but a user who followed a link, or lost ordering mid-session, was
 * left on Home with no idea why; the panel says so and links to their home.
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

  // The panel's link goes HOME, wherever home is for them (homePathFor).
  if (!canUseOrdering(user)) return <Unauthorized />;

  return <Outlet />;
};

export default OrderingRoute;
