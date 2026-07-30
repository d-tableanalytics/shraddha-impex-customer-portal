import { useEffect } from "react";
import { Search, X, Eye, Clock, Lock, FileCheck2 } from "lucide-react";
import { PageHeader } from "../../components/common/PageHeader";
import { Card, CardContent } from "../../components/ui/Card";
import { SkeletonLoader } from "../../components/ui/SkeletonLoader";
import { TableSkeleton } from "../../components/ui/TableSkeleton";
import { PoStatusBadge } from "../../components/ui/PoStatusBadge";
import { SalesBookingDrawer } from "../../components/drawer/SalesBookingDrawer";
import { useSalesStore } from "../../store/salesStore";
import { useUserStore } from "../../store/userStore";
import { canUseSalesDesk } from "../../utils/permissions";

// `count` reads the matching figure out of meta, so each tab shows its own
// live total. meta always covers the whole (search-filtered) set, so these
// numbers stay put as you switch tabs.
const SCOPES = [
  { key: "all", label: "All Bookings", countKey: "total" },
  { key: "pending", label: "Pending PO", countKey: "pendingPo" },
  { key: "generated", label: "PO Generated", countKey: "generated" },
];

export const SalesDesk = () => {
  const { bookings, meta, scope, search, loading, error, fetchBookings, setScope, setSearch, select } =
    useSalesStore();
  const { user } = useUserStore();

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  // The route is already guarded, but a direct URL hit by the wrong role should
  // explain itself rather than render an empty table.
  if (!canUseSalesDesk(user)) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Sales Desk" />
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500">
          You do not have permission to view the sales desk.
        </div>
      </div>
    );
  }

  // Same figures the tabs carry — meta covers the whole (search-filtered) set,
  // so these hold steady whichever tab is open. Clicking a tile selects the
  // matching tab, so the summary row doubles as a shortcut.
  const tiles = [
    { scope: "pending", label: "Pending PO", value: meta.pendingPo ?? 0, icon: <Clock size={20} className="text-warning-600" />, bg: "bg-warning-50" },
    { scope: "generated", label: "PO Generated", value: meta.generated ?? 0, icon: <Lock size={20} className="text-slate-500" />, bg: "bg-slate-100" },
    { scope: "all", label: "Total Bookings", value: meta.total ?? 0, icon: <FileCheck2 size={20} className="text-primary-600" />, bg: "bg-primary-50" },
  ];

  return (
    <div className="flex flex-col gap-6 relative">
      <PageHeader title="Sales Desk" />
      <p className="text-slate-600 -mt-2 text-sm">
        Review confirmed bookings, amend them while the PO is pending, then raise the PO to lock them.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
        {tiles.map((t) => (
          <button
            key={t.scope}
            onClick={() => setScope(t.scope)}
            title={`Show ${t.label.toLowerCase()}`}
            className="text-left focus:outline-none"
          >
            <Card className="border-slate-200 shadow-sm overflow-hidden transition-all hover:shadow-md">
              <CardContent className="p-3 flex items-center gap-3">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${t.bg}`}>
                  {t.icon}
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider truncate">
                    {t.label}
                  </p>
                  {loading ? (
                    <SkeletonLoader variant="text" className="h-7 w-12 mt-1" />
                  ) : (
                    <h3 className="text-xl font-bold text-slate-800">{t.value.toLocaleString()}</h3>
                  )}
                </div>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-4 bg-white p-4 border border-slate-200 rounded-xl shadow-sm">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="relative flex-1 min-w-64 max-w-md">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search booking, SKU, customer, PO…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
            {search && (
              <X
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 cursor-pointer hover:text-slate-600"
                onClick={() => setSearch("")}
              />
            )}
          </div>

          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
            {SCOPES.map((s) => {
              const active = scope === s.key;
              const count = meta[s.countKey] ?? 0;
              return (
                <button
                  key={s.key}
                  onClick={() => setScope(s.key)}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${
                    active ? "bg-white text-primary-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {s.label}
                  <span
                    className={`px-1.5 py-0.5 rounded-full text-[10px] font-black tabular-nums ${
                      active ? "bg-primary-50 text-primary-700" : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {loading ? "–" : count.toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-error-50 border border-error-200 text-error-600 rounded-xl px-4 py-3 text-sm font-semibold">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-auto w-full border border-slate-200 rounded-xl bg-white shadow-sm max-h-[600px]">
        <table className="w-full text-left border-collapse whitespace-nowrap">
          <thead className="sticky top-0 bg-slate-50 z-10 shadow-sm">
            <tr className="text-xs text-slate-500 font-bold uppercase select-none">
              <th className="px-5 py-3 border-b border-slate-200">Booking ID</th>
              <th className="px-5 py-3 border-b border-slate-200">Customer</th>
              <th className="px-5 py-3 border-b border-slate-200">Date</th>
              <th className="px-5 py-3 border-b border-slate-200">PO Status</th>
              <th className="px-5 py-3 border-b border-slate-200">PO Number</th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">Items</th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">Qty</th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            {loading ? (
              <TableSkeleton rows={8} columns={8} cellClass="px-5 py-4" />
            ) : bookings.length > 0 ? (
              bookings.map((b) => (
                <tr
                  key={b.orderId}
                  onClick={() => select(b)}
                  className="hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  <td className="px-5 py-4 font-bold text-slate-800">{b.orderId}</td>
                  <td className="px-5 py-4 font-semibold text-slate-700 truncate max-w-[200px]" title={b.customer}>
                    {b.customer || "—"}
                  </td>
                  <td className="px-5 py-4 text-slate-600">
                    {b.date ? new Date(b.date).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-5 py-4">
                    <PoStatusBadge locked={b.locked} poNumber={b.poNumber} />
                  </td>
                  <td className="px-5 py-4 font-medium text-slate-600">{b.poNumber || "—"}</td>
                  <td className="px-5 py-4 text-center font-bold text-slate-700">{b.lineCount}</td>
                  <td className="px-5 py-4 text-center font-bold text-slate-700">{b.totalQuantity}</td>
                  <td className="px-5 py-4 text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        select(b);
                      }}
                      className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors focus:outline-none"
                      title={b.locked ? "View booking (locked)" : "Review & edit booking"}
                    >
                      <Eye size={18} />
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-slate-400">
                  {scope === "pending"
                    ? "No bookings are waiting for a PO."
                    : "No bookings found matching your criteria."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <SalesBookingDrawer />
    </div>
  );
};

export default SalesDesk;
