import { Search, Filter, Download, X, Users } from "lucide-react";
import { ERPButton } from "../ui/ERPButton";
import { DateField } from "../ui/DateField";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { productsApi } from "../../services/products";
import { useState, useMemo } from "react";
import { useUserStore } from "../../store/userStore";
import { BOOKING_LIFECYCLE } from "../../constants/bookingLifecycle";
import {
  CUSTOMER_EXPORT_COLS, customerExportRow, exportDate, poNumberValue,
} from "../../utils/historyExportColumns";
import toast from "react-hot-toast";
import { Loader2 } from "lucide-react";
import { useBusyAction } from "../../hooks/useBusyAction";
import { availabilityFor, fetchExportAvailability } from "../../utils/exportAvailability";

import { isSuperAdmin } from "../../utils/permissions";
export const OrderToolbar = () => {
  const { searchQuery, setSearchQuery, filters, setFilters, selectedIds, allOrders } =
    useOrderHistoryStore();
  const [showFilters, setShowFilters] = useState(false);
  // An export of the whole history builds its file in the browser after
  // loading a large library; busy until it is done — see useBusyAction.
  const { run: runExport, anyBusy: exporting } = useBusyAction();
  const isAdmin = useUserStore((s) => isSuperAdmin(s.user));

  // Bookings to export: the selected ones, or the full filtered list.
  const selectedBookings = () => {
    const state = useOrderHistoryStore.getState();
    if (state.selectedIds.length === 0) return state.orders;
    return state.orders.filter((o) => state.selectedIds.includes(o.orderNumber));
  };

  // Flatten bookings into one row per SKU line item with the required columns.
  // Available Quantity is live product stock, read for exactly the SKUs being
  // exported at the moment of export — see utils/exportAvailability.js for why
  // the page no longer downloads the catalogue up front.
  //
  // The customer block repeats on every line of a booking. That is what a flat
  // sheet is for: each row has to stand on its own once it is sorted, filtered
  // or pivoted in Excel, and a name printed once at the top of a group does not
  // survive any of that.
  const exportData = async () => {
    const bookings = selectedBookings();
    const lineOf = (b) => (b.lineItems?.length ? b.lineItems : [{ skuCode: '—', bookedQty: b.totalQuantity, confirmedQty: b.totalQuantity, pendingQty: 0 }]);
    // Rejects if stock cannot be read; the busy wrapper reports it rather than
    // writing a file full of blanks.
    const availability = await fetchExportAvailability(
      bookings.flatMap(lineOf),
      productsApi.lookupSkus,
    );

    const rows = [];
    for (const b of bookings) {
      for (const li of lineOf(b)) {
        rows.push({
          // Shared with Indent History — see utils/historyExportColumns.js.
          ...customerExportRow({
            name: b.customer,
            profile: b.customerProfile,
            // The booking's own stamp first, the customer's registered details
            // as the fallback: a PO may quote a different address on purpose.
            shopNumber: b.shopNumber,
            location: b.customerLocation || b.shippingAddress || b.location,
          }),
          orderNumber: b.orderNumber,
          poNumber: b.poNumber,
          status: b.status,
          date: b.date,
          skuCode: li.skuCode,
          available: availabilityFor(availability, li),
          bookedQty: li.bookedQty,
          indentQty: li.pendingQty,
        });
      }
    }
    return rows;
  };

  const exportCols = [
    { key: 'orderNumber', label: 'Booking ID' },
    ...CUSTOMER_EXPORT_COLS,
    { key: 'date', label: 'Booking Date', format: exportDate },
    // N/A rather than blank when no PO has been raised, and '-' — which is how
    // an unraised PO is stored — reads as no PO rather than as a number.
    { key: 'poNumber', label: 'PO Number', format: poNumberValue },
    { key: 'status', label: 'Status' },
    { key: 'skuCode', label: 'SKU Details' },
    { key: 'available', label: 'Available Quantity' },
    { key: 'bookedQty', label: 'Booked Quantity' },
    { key: 'indentQty', label: 'Indent Quantity' },
  ];

  // The customer filter's options, from the bookings the page has already
  // loaded (this used to download the whole order list a second time).
  //
  // Built from `customer` — the SAME value the filter compares against
  // (orderHistoryStore.applyFilters) — so every option selects something. It
  // used to list the stamped `company` instead, while `customer` prefers the
  // Customer Master name: for any customer with a master name, picking their
  // company matched no bookings at all.
  const customers = useMemo(
    () => [...new Set(allOrders.map((o) => o.customer).filter(Boolean))].sort(),
    [allOrders],
  );

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
            // SKU is named because it is now searchable and nothing else on the
            // screen would tell you so — a booking's SKUs are a click inside
            // the row, and a search box that does not mention them reads as one
            // that does not look at them.
            placeholder={isAdmin ? "Search Booking No, PO No, SKU, Customer..." : "Search Booking No, PO No, SKU..."}
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
                {customers.map((c) => (
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
            <ERPButton variant="primary" size="sm" disabled={exporting}>
              {exporting ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Download size={16} className="mr-2" />}
              {exporting ? "Exporting…" : `Export${selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}`}
            </ERPButton>
            <div className="absolute right-0 mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 overflow-hidden">
              <button
                disabled={exporting}
                onClick={() => runExport('excel', async () => {
                  const { exportToExcel } = await import('../../utils/exportUtils');
                  return exportToExcel(await exportData(), exportCols, 'Booking_History');
                }, { error: 'Excel export failed' })}
                className="disabled:opacity-50 disabled:cursor-wait w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-primary-600 transition-colors"
              >
                {selectedIds.length > 0 ? `Export ${selectedIds.length} selected to Excel` : "Export to Excel"}
              </button>
              <button
                disabled={exporting}
                onClick={() => runExport('pdf', async () => {
                  const { exportToPDF } = await import('../../utils/exportUtils');
                  return exportToPDF(await exportData(), exportCols, 'Booking History Report', 'Booking_History');
                }, { error: 'PDF export failed' })}
                className="disabled:opacity-50 disabled:cursor-wait w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-primary-600 transition-colors border-t border-slate-100"
              >
                Export to PDF
              </button>
              <button
                disabled={exporting}
                onClick={() => runExport('print', async () => {
                  const { printData } = await import('../../utils/exportUtils');
                  return printData(await exportData(), exportCols, 'Booking History Report');
                }, { error: 'Unable to open print window (check pop-up blocker).' })}
                className="disabled:opacity-50 disabled:cursor-wait w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-primary-600 transition-colors border-t border-slate-100"
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
              {/* Filter by the STORED status, labelled the way the customer
                  sees it on the timeline and in their email. */}
              {BOOKING_LIFECYCLE.map((stage) => (
                <option key={stage.key} value={stage.key}>
                  {stage.label}
                </option>
              ))}
              <option value="Cancelled">Cancelled</option>
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
