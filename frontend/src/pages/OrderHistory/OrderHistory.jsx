import { useEffect } from "react";
import { PageHeader } from "../../components/common/PageHeader";
import { MetricsCard } from "../../components/cards/MetricsCard";
import { OrderToolbar } from "../../components/layout/OrderToolbar";
import { OrderHistoryTable } from "../../components/tables/OrderHistoryTable";
import { OrderDrawer } from "../../components/drawer/OrderDrawer";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useCartStore } from "../../store/cartStore";

export const OrderHistory = () => {
  const { ensureOrders, fetchCancelledCount } = useOrderHistoryStore();
  const { ensurePendingReservations } = useCartStore();

  // Reopening the page reuses a list read in the last few seconds instead of
  // downloading every booking again; anything that changes a booking — here or
  // on another screen — makes the next visit re-read (store/invalidation.js).
  useEffect(() => {
    ensureOrders();
    // indents drive the per-row "includes indent" badge.
    ensurePendingReservations();
    // Live Available Quantity for the export is read when an export is made,
    // for its own SKUs only — see utils/exportAvailability.js.
    // Cancelled bookings (expired/removed reservations) for the metric tile.
    fetchCancelledCount();
  }, [ensureOrders, ensurePendingReservations, fetchCancelledCount]);

  return (
    <div className="flex flex-col gap-6 relative">
      <PageHeader title="Booking History" />
      <p className="text-slate-600 -mt-2 text-sm">
        Track, search and manage bookings in one place.
      </p>

      <MetricsCard />

      <OrderToolbar />

      <OrderHistoryTable />

      <OrderDrawer />
    </div>
  );
};
