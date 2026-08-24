import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { History, PackageX } from "lucide-react";
import { PageHeader } from "../../components/common/PageHeader";
import { MetricsCard } from "../../components/cards/MetricsCard";
import { OrderToolbar } from "../../components/layout/OrderToolbar";
import { OrderHistoryTable } from "../../components/tables/OrderHistoryTable";
import { OrderDrawer } from "../../components/drawer/OrderDrawer";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useCartStore } from "../../store/cartStore";
import { useProductStore } from "../../store/productStore";
import { IndentMetricsCard } from "../../components/cards/IndentMetricsCard";
import { IndentToolbar } from "../../components/layout/IndentToolbar";
import { IndentHistoryTable } from "../../components/tables/IndentHistoryTable";
import { IndentDrawer } from "../../components/drawer/IndentDrawer";
import { useIndentHistoryStore } from "../../store/indentHistoryStore";
import { useUserStore } from "../../store/userStore";

/**
 * Booking History and Indent History as one section.
 *
 * The two lists describe one process — what a customer asked for, split into
 * the part stock covered (the booking) and the part still waiting (the
 * indent) — so they live behind one nav entry with a tab switch, instead of
 * two pages the user has to correlate by id.
 *
 * The active tab rides in the URL (?tab=indents) so a link lands on the right
 * list, the old /orders/indent-history route can redirect here, and refresh
 * keeps the user's place.
 */

const BookingsTab = () => {
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
    <>
      <MetricsCard />
      <OrderToolbar />
      <OrderHistoryTable />
      <OrderDrawer />
    </>
  );
};

const IndentsTab = () => {
  const { fetchIndents } = useIndentHistoryStore();

  useEffect(() => {
    fetchIndents();
  }, [fetchIndents]);

  return (
    <>
      <IndentMetricsCard />
      <IndentToolbar />
      <IndentHistoryTable />
      <IndentDrawer />
    </>
  );
};

const TABS = [
  { key: "bookings", label: "Booking History", icon: History },
  { key: "indents", label: "Indent History", icon: PackageX },
];

export const BookingIndentHistory = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = useUserStore((s) => s.user?.role === "Admin");

  const tab = searchParams.get("tab") === "indents" ? "indents" : "bookings";
  const setTab = (key) => {
    // replace, not push — flipping tabs is not navigation worth a Back stop.
    setSearchParams(key === "bookings" ? {} : { tab: key }, { replace: true });
  };

  return (
    <div className="flex flex-col gap-6 relative">
      <PageHeader title="Booking & Indent History" />
      <p className="text-slate-600 -mt-2 text-sm">
        {tab === "bookings"
          ? "Track, search and manage bookings in one place."
          : isAdmin
            ? "Track, search and manage unfulfilled quantities across all customers."
            : "Track and search your unfulfilled quantities, awaiting fresh stock."}
      </p>

      <div className="flex items-center gap-1 bg-slate-100 border border-slate-200 rounded-xl p-1 w-fit">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
              tab === key
                ? "bg-white text-primary-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {/* Keyed remount per tab keeps each tab's mount-time fetches honest. */}
      {tab === "bookings" ? <BookingsTab key="bookings" /> : <IndentsTab key="indents" />}
    </div>
  );
};

export default BookingIndentHistory;
