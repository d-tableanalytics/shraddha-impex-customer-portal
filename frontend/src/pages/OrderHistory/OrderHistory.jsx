import { useEffect } from "react";
import { PageHeader } from "../../components/common/PageHeader";
import { MetricsCard } from "../../components/cards/MetricsCard";
import { OrderToolbar } from "../../components/layout/OrderToolbar";
import { OrderHistoryTable } from "../../components/tables/OrderHistoryTable";
import { OrderDrawer } from "../../components/drawer/OrderDrawer";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useCartStore } from "../../store/cartStore";
import { useProductStore } from "../../store/productStore";

export const OrderHistory = () => {
  const { fetchOrders, fetchCancelledCount } = useOrderHistoryStore();
  const { fetchPendingReservations } = useCartStore();
  const { fetchAllProducts } = useProductStore();

  useEffect(() => {
    fetchOrders();
    // indents drive the per-row "includes indent" badge.
    fetchPendingReservations();
    // Products give live Available Quantity for the detailed export.
    fetchAllProducts();
    // Cancelled bookings (expired/removed reservations) for the metric tile.
    fetchCancelledCount();
  }, [fetchOrders, fetchPendingReservations, fetchAllProducts, fetchCancelledCount]);

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
