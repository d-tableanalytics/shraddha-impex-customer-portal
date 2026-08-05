import { Search, Filter, Download, X, Users } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { ERPButton } from "../ui/ERPButton";
import { DateField } from "../ui/DateField";
import { useIndentHistoryStore, INDENT_STATUSES } from "../../store/indentHistoryStore";
import { useUserStore } from "../../store/userStore";

export const IndentToolbar = () => {
  const { searchQuery, setSearchQuery, filters, setFilters, selectedIds, allIndents } =
    useIndentHistoryStore();
  const [showFilters, setShowFilters] = useState(false);
  const isAdmin = useUserStore((s) => s.user?.role === "Admin");

  // Customer list is derived from the loaded indents — no extra request needed,
  // and it can only ever offer customers that actually have an indent.
  const customers = [...new Set(allIndents.map((r) => r.customer).filter((c) => c && c !== "—"))].sort();

  // Indents to export: the selected ones, or the full filtered list.
  const selectedIndents = () => {
    const state = useIndentHistoryStore.getState();
    if (state.selectedIds.length === 0) return state.indents;
    return state.indents.filter((r) => state.selectedIds.includes(r.id));
  };

  // Flatten indents into one row per SKU line, matching how Booking History
  // exports one row per line item rather than one per booking.
  const exportData = () =>
    selectedIndents().flatMap((r) =>
      r.lines.map((l) => ({
        indentNumber: r.indentNumber || "—",
        bookingId: r.bookingId || "—",
        poNumber: r.poNumber || "—",
        customer: r.customer,
        status: l.status,
        date: r.date,
        skuCode: l.product?.code || "—",
        msilCode: l.product?.msilCode || "—",
        pendingQty: l.pendingQuantity || 0,
        available: l.product?.availableStock ?? 0,
      })),
    );

  const exportCols = [
    { key: "indentNumber", label: "Indent No" },
    { key: "bookingId", label: "Booking ID" },
    { key: "poNumber", label: "PO Number" },
    ...(isAdmin ? [{ key: "customer", label: "Customer" }] : []),
    { key: "status", label: "Status" },
    { key: "date", label: "Indent Date", format: (v) => (v ? new Date(v).toLocaleDateString() : "N/A") },
    { key: "skuCode", label: "SKU Details" },
    { key: "msilCode", label: "MSIL Code" },
    { key: "pendingQty", label: "Indent Quantity" },
    { key: "available", label: "Available Quantity" },
  ];

  const runExport = (fn, ...args) => {
    const rows = exportData();
    if (rows.length === 0) {
      toast.error("No indents to export");
      return;
    }
    import("../../utils/exportUtils").then((mod) => {
      if (!mod[fn](rows, exportCols, ...args)) toast.error(`${fn} failed`);
    });
  };

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
            placeholder={
              isAdmin
                ? "Search Indent No, Booking ID, SKU, Customer..."
                : "Search Indent No, Booking ID, SKU..."
            }
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
          <ERPButton variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter size={16} className="mr-2" /> Filters
          </ERPButton>
          <div className="relative group">
            <ERPButton variant="primary" size="sm">
              <Download size={16} className="mr-2" />
              Export{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
            </ERPButton>
            <div className="absolute right-0 mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 overflow-hidden">
              <button
                onClick={() => runExport("exportToExcel", "Indent_History")}
                className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-primary-600 transition-colors"
              >
                {selectedIds.length > 0
                  ? `Export ${selectedIds.length} selected to Excel`
                  : "Export to Excel"}
              </button>
              <button
                onClick={() => runExport("exportToPDF", "Indent History Report", "Indent_History")}
                className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-primary-600 transition-colors border-t border-slate-100"
              >
                Export to PDF
              </button>
              <button
                onClick={() => {
                  const rows = exportData();
                  if (rows.length === 0) {
                    toast.error("No indents to export");
                    return;
                  }
                  import("../../utils/exportUtils").then(({ printData }) => {
                    printData(rows, exportCols, "Indent History Report");
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
              {INDENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
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
