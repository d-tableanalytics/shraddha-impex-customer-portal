import { Search, Filter, Download, X, Users } from "lucide-react";
import { ERPButton } from "../ui/ERPButton";
import { DateField } from "../ui/DateField";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useProductStore } from "../../store/productStore";
import { useState, useEffect } from "react";
import { api } from "../../services/api";
import { useUserStore } from "../../store/userStore";
import toast from "react-hot-toast";

export const OrderToolbar = () => {
  const { searchQuery, setSearchQuery, filters, setFilters, selectedIds } =
    useOrderHistoryStore();
  const [showFilters, setShowFilters] = useState(false);
  const [companies, setCompanies] = useState([]);
  const isAdmin = useUserStore((s) => s.user?.role === "Admin");

  // Bookings to export: the selected ones, or the full filtered list.
  const selectedBookings = () => {
    const state = useOrderHistoryStore.getState();
    if (state.selectedIds.length === 0) return state.orders;
    return state.orders.filter((o) => state.selectedIds.includes(o.orderNumber));
  };

  // Flatten bookings into one row per SKU line item with the required columns.
  // Available Quantity comes from live product stock (SKU → availableStock).
  const exportData = () => {
    const bookings = selectedBookings();
    const products = useProductStore.getState().products || [];
    const availBySku = new Map(products.map((p) => [p.code, p.availableStock]));

    const rows = [];
    for (const b of bookings) {
      const lines = b.lineItems?.length ? b.lineItems : [{ skuCode: '—', bookedQty: b.totalQuantity, confirmedQty: b.totalQuantity, pendingQty: 0 }];
      for (const li of lines) {
        rows.push({
          orderNumber: b.orderNumber,
          poNumber: b.poNumber,
          status: b.status,
          date: b.date,
          skuCode: li.skuCode,
          available: availBySku.has(li.skuCode) ? availBySku.get(li.skuCode) : '—',
          bookedQty: li.bookedQty,
          indentQty: li.pendingQty,
        });
      }
    }
    return rows;
  };

  const exportCols = [
    { key: 'orderNumber', label: 'Booking ID' },
    { key: 'poNumber', label: 'PO Number' },
    { key: 'status', label: 'Status' },
    { key: 'date', label: 'Booking Date', format: (v) => (v ? new Date(v).toLocaleDateString() : 'N/A') },
    { key: 'skuCode', label: 'SKU Details' },
    { key: 'available', label: 'Available Quantity' },
    { key: 'bookedQty', label: 'Booked Quantity' },
    { key: 'indentQty', label: 'Indent Quantity' },
  ];

  // Load distinct company names from real orders
  useEffect(() => {
    api.get('/orders')
      .then(r => {
        const all = r.data.data || [];
        const unique = [...new Set(all.map(o => o.company).filter(Boolean))].sort();
        setCompanies(unique);
      })
      .catch(() => setCompanies([]));
  }, []);

  return (
    <div className="flex flex-col gap-4 bg-white p-4 border border-slate-200 rounded-xl shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="text"
            placeholder={isAdmin ? "Search Booking No, PO No, Customer..." : "Search Booking No, PO No..."}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />

          {searchQuery && (
            <X
              size={14}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 cursor-pointer hover:text-slate-600"
              onClick={() => setSearchQuery("")}
            />
          )}
        </div>

        <div className="flex items-center gap-2">
          {isAdmin && (
            <div className="relative hidden sm:block">
              <Users
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
              />
              <select
                value={filters.customer}
                onChange={(e) => setFilters({ customer: e.target.value })}
                title="Filter by customer"
                className="appearance-none pl-9 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 text-slate-700 font-semibold max-w-55 truncate"
              >
                <option value="all">All Customers</option>
                {companies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}
          <ERPButton
            variant="outline"
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter size={16} className="mr-2" /> Filters
          </ERPButton>
          <div className="relative group">
            <ERPButton variant="primary" size="sm">
              <Download size={16} className="mr-2" />
              Export{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
            </ERPButton>
            <div className="absolute right-0 mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 overflow-hidden">
              <button
                onClick={() => {
                  import('../../utils/exportUtils').then(({ exportToExcel }) => {
                    if (!exportToExcel(exportData(), exportCols, 'Booking_History')) {
                      toast.error('Excel export failed');
                    }
                  });
                }}
                className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-primary-600 transition-colors"
              >
                {selectedIds.length > 0 ? `Export ${selectedIds.length} selected to Excel` : "Export to Excel"}
              </button>
              <button
                onClick={() => {
                  import('../../utils/exportUtils').then(({ exportToPDF }) => {
                    if (!exportToPDF(exportData(), exportCols, 'Booking History Report', 'Booking_History')) {
                      toast.error('PDF export failed');
                    }
                  });
                }}
                className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-primary-600 transition-colors border-t border-slate-100"
              >
                Export to PDF
              </button>
              <button
                onClick={() => {
                  import('../../utils/exportUtils').then(({ printData }) => {
                    printData(exportData(), exportCols, 'Booking History Report');
                  });
                }}
                className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-primary-600 transition-colors border-t border-slate-100"
              >
                Print Report
              </button>
            </div>
          </div>
        </div>
      </div>

      {showFilters && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 pt-4 border-t border-slate-100">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-600">Status</label>
            <select
              value={filters.status}
              onChange={(e) => setFilters({ status: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg outline-none focus:border-primary-500 text-slate-700 font-semibold"
            >
              <option value="all">All Statuses</option>
              <option value="PO Received">PO Received</option>
              <option value="Ready for Dispatch">Ready for Dispatch</option>
              <option value="Dispatched">Dispatched</option>
              <option value="Delivered">Delivered</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-600">Date</label>
            <DateField
              value={filters.dateOn}
              onChange={(v) => setFilters({ dateOn: v, dateFrom: "", dateTo: "" })}
              placeholder="Any date"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-600">From Date</label>
            <DateField
              value={filters.dateFrom}
              onChange={(v) => setFilters({ dateFrom: v, dateOn: "" })}
              max={filters.dateTo || undefined}
              placeholder="Start date"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-600">To Date</label>
            <DateField
              value={filters.dateTo}
              onChange={(v) => setFilters({ dateTo: v, dateOn: "" })}
              min={filters.dateFrom || undefined}
              placeholder="End date"
              align="right"
            />
          </div>
        </div>
      )}
    </div>
  );
};
