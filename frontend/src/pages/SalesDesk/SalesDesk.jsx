import { useEffect } from "react";
import { History, Eye, Clock, Lock, FileCheck2, Download, FileText, Loader2 } from "lucide-react";
import { SearchInput } from "../../components/ui/SearchInput";
import { useBusyAction } from "../../hooks/useBusyAction";
import { PageHeader } from "../../components/common/PageHeader";
import { Card, CardContent } from "../../components/ui/Card";
import { SkeletonLoader } from "../../components/ui/SkeletonLoader";
import { TableSkeleton } from "../../components/ui/TableSkeleton";
import { PoStatusBadge } from "../../components/ui/PoStatusBadge";
import { PoCountdown } from "../../components/ui/PoCountdown";
import { SalesBookingDrawer } from "../../components/drawer/SalesBookingDrawer";
import { BookingHistoryDrawer } from "../../components/drawer/BookingHistoryDrawer";
import { useSalesStore } from "../../store/salesStore";
import { useUserStore } from "../../store/userStore";
import { canUseSalesDesk } from "../../utils/permissions";
import { customerNameOf, companyNameOf, siTeamOf, siTeamLabelOf } from "../../utils/bookingParty";
import toast from "react-hot-toast";

// `count` reads the matching figure out of meta, so each tab shows its own
// live total. meta always covers the whole (search-filtered) set, so these
// numbers stay put as you switch tabs.
const SCOPES = [
  { key: "all", label: "All Bookings", countKey: "total" },
  { key: "pending", label: "Pending PO", countKey: "pendingPo" },
  { key: "generated", label: "PO Generated", countKey: "generated" },
];

/**
 * Customer Name, Company Name and SI Team are resolved by ONE rule shared with
 * the booking drawer and the exports — see utils/bookingParty.js, which also
 * records why the customer name never falls back to the company. Re-exported
 * here because `salesDeskCustomer.test.js` pins that rule through this module.
 */
export { customerNameOf, companyNameOf, siTeamOf };

export const SalesDesk = () => {
  const {
    bookings, meta, scope, search, appliedScope, appliedSearch, loading, refreshing, error,
    ensureBookings, setScope, setSearch, select, openHistory,
  } = useSalesStore();
  // Exports of the whole list build their file in the browser; busy until done.
  const { run: runExport, isBusy: isExporting } = useBusyAction();
  const { user } = useUserStore();

  // A desk reopened within a few seconds keeps the list it has; every write and
  // any booking change elsewhere forces a re-read (store/invalidation.js).
  useEffect(() => {
    ensureBookings();
  }, [ensureBookings]);

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

  /**
   * The bookings currently on screen, as export rows.
   *
   * `bookings` is ALREADY the filtered set — the store applies the search term
   * and the scope tab before it reaches this component — so an export follows
   * whatever the user is looking at without re-implementing either filter. Both
   * formats share this, so Excel and PDF can never disagree about content.
   *
   * The title and file name use the scope and search the rows were FETCHED for,
   * not the live box: while typing, the box runs a moment ahead of the list.
   */
  const buildExport = () => {
    const rows = bookings.map((b, i) => ({
      sr: i + 1,
      orderId: b.orderId,
      customerName: customerNameOf(b) || "-",
      customer: companyNameOf(b) || "-",
      siTeam: siTeamOf(b) || "-",
      date: b.date ? new Date(b.date).toLocaleDateString() : "-",
      poStatus: b.locked ? "PO Generated" : "PO Pending",
      poNumber: b.poNumber || "-",
      lineCount: b.lineCount ?? 0,
      totalQuantity: b.totalQuantity ?? 0,
    }));
    const columns = [
      { key: "sr", label: "S.No" },
      { key: "orderId", label: "Booking ID" },
      { key: "customerName", label: "Customer Name" },
      { key: "customer", label: "Company Name" },
      { key: "siTeam", label: "SI Team" },
      { key: "date", label: "Date" },
      { key: "poStatus", label: "PO Status" },
      { key: "poNumber", label: "PO Number" },
      { key: "lineCount", label: "Items" },
      { key: "totalQuantity", label: "Qty" },
    ];
    // The title records WHICH slice this is, so a file opened next week still
    // says what it was filtered to.
    const scopeLabel = SCOPES.find((x) => x.key === appliedScope)?.label ?? "All Bookings";
    const title = `Sales Desk — ${scopeLabel}${appliedSearch.trim() ? ` — search "${appliedSearch.trim()}"` : ""}`;
    return { rows, columns, title };
  };

  const fileStem = () => `SalesDesk_${appliedScope}`;

  const handleExcel = () => {
    if (bookings.length === 0) return toast.error("Nothing to export for the current filter.");
    return runExport("excel", async () => {
      const { rows, columns } = buildExport();
      const { exportToExcel } = await import("../../utils/exportUtils");
      const ok = exportToExcel(rows, columns, fileStem());
      if (ok) toast.success(`Exported ${rows.length} booking(s).`);
      return ok;
    }, { error: "Export failed." });
  };

  const handlePdf = () => {
    if (bookings.length === 0) return toast.error("Nothing to export for the current filter.");
    // exportToPDF uses jspdf-autotable, which paginates a long table across
    // pages and repeats the header row on each — nothing extra to do for a
    // large result set.
    return runExport("pdf", async () => {
      const { rows, columns, title } = buildExport();
      const { exportToPDF } = await import("../../utils/exportUtils");
      const ok = exportToPDF(rows, columns, title, fileStem());
      if (ok) toast.success(`Exported ${rows.length} booking(s) as PDF.`);
      return ok;
    }, { error: "PDF export failed." });
  };

  const exportBtn =
    "inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 hover:text-slate-800 transition-all disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex flex-col gap-6 relative">
      <PageHeader
        title="Sales Desk"
        actions={(
          <div className="flex items-center gap-2">
            <button onClick={handleExcel} disabled={loading || bookings.length === 0 || isExporting("excel")}
              title="Download the bookings shown, as Excel" className={exportBtn}>
              {isExporting("excel") ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Excel
            </button>
            <button onClick={handlePdf} disabled={loading || bookings.length === 0 || isExporting("pdf")}
              title="Download the bookings shown, as PDF" className={exportBtn}>
              {isExporting("pdf") ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} PDF
            </button>
          </div>
        )}
      />
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
          {/* Matched on the server: customer name (partial, any case), booking
              ID, SKU, company and PO number. A refresh keeps the current rows
              on screen; the spinner says one is running. */}
          <SearchInput
            className="flex-1 min-w-64 max-w-md"
            value={search}
            onChange={setSearch}
            placeholder="Search customer name, booking, SKU, PO, SI Team…"
            label="Search bookings"
            busy={refreshing}
            busyLabel="Refreshing bookings"
          />

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
        {/* What the rows were fetched for, not the box: while typing, the box
            runs a moment ahead of the list. */}
        {!loading && appliedSearch.trim() && (
          <p className="-mt-1 text-xs text-slate-500" role="status">
            <span className="font-bold text-slate-700">{(meta.total ?? 0).toLocaleString()}</span>
            {" "}booking{meta.total === 1 ? "" : "s"} match “{appliedSearch.trim()}”
          </p>
        )}
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
              <th className="px-5 py-3 border-b border-slate-200">Customer Name</th>
              <th className="px-5 py-3 border-b border-slate-200">Company Name</th>
              <th className="px-5 py-3 border-b border-slate-200">SI Team</th>
              <th className="px-5 py-3 border-b border-slate-200">Date</th>
              <th className="px-5 py-3 border-b border-slate-200">PO Status</th>
              <th className="px-5 py-3 border-b border-slate-200">PO Deadline</th>
              <th className="px-5 py-3 border-b border-slate-200">PO Number</th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">Items</th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">Qty</th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            {/* The skeleton's eleven columns: Booking ID, Customer Name, Company
                Name, SI Team, Date, PO Status, PO Deadline, PO Number, Items,
                Qty, Action. */}
            {loading ? (
              <TableSkeleton rows={8} columns={11} cellClass="px-5 py-4" />
            ) : bookings.length > 0 ? (
              bookings.map((b) => (
                <tr
                  key={b.orderId}
                  onClick={() => select(b)}
                  className="hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  <td className="px-5 py-4 font-bold text-slate-800">{b.orderId}</td>
                  <td
                    className="px-5 py-4 font-semibold text-slate-700 truncate max-w-[200px]"
                    title={customerNameOf(b) || undefined}
                  >
                    {customerNameOf(b) || <span className="text-slate-400">—</span>}
                  </td>
                  {/*
                    Its own column, and shown even when it matches the customer
                    name — the same call Booking History makes. A blank here
                    would read as "no company recorded" rather than "same as the
                    name", and the desk cannot tell those apart.
                  */}
                  <td
                    className="px-5 py-4 text-slate-600 truncate max-w-[200px]"
                    title={companyNameOf(b) || undefined}
                  >
                    {companyNameOf(b) || <span className="text-slate-400">—</span>}
                  </td>
                  {/* SI Team: who placed the booking for the customer, as
                      stored on it. A dash is the customer's own booking. */}
                  <td
                    className="px-5 py-4 text-slate-600 truncate max-w-[180px]"
                    title={siTeamLabelOf(b) || "Placed by the customer"}
                  >
                    {siTeamOf(b) || <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-5 py-4 text-slate-600">
                    {b.date ? new Date(b.date).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-5 py-4">
                    <PoStatusBadge locked={b.locked} poNumber={b.poNumber} />
                    {/* MSIL indent lines the supply check held for Convert / Cancel. */}
                    {b.awaitingDecision > 0 && (
                      <span
                        className="mt-1 block w-fit px-1.5 py-0.5 rounded border text-[10px] font-bold bg-amber-50 text-amber-800 border-amber-200 whitespace-nowrap"
                        title="Stock arrived after the MSIL Supply Date or the 7-day window. Open the booking to Convert or Cancel."
                      >
                        {b.awaitingDecision} indent line{b.awaitingDecision === 1 ? "" : "s"} need a decision
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {b.locked ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <PoCountdown dueAt={b.poDueAt} />
                    )}
                  </td>
                  <td className="px-5 py-4 font-medium text-slate-600">{b.poNumber || "—"}</td>
                  <td className="px-5 py-4 text-center font-bold text-slate-700">{b.lineCount}</td>
                  <td className="px-5 py-4 text-center font-bold text-slate-700">{b.totalQuantity}</td>
                  <td className="px-5 py-4 text-center">
                    {/* Two actions, one icon each. View Details opens the
                        booking for review and editing (the same drawer a row
                        click opens); View History opens the booking's whole
                        history — created, indent, allocations, PO, status and
                        every update. */}
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          select(b);
                        }}
                        className="p-1.5 rounded-lg text-slate-400 transition-colors hover:text-primary-600 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        title={`View Details for ${b.orderId}`}
                        aria-label={`View details for ${b.orderId}`}
                      >
                        <Eye size={18} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openHistory(b);
                        }}
                        className="p-1.5 rounded-lg text-slate-400 transition-colors hover:text-violet-600 hover:bg-violet-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        title={`View History for ${b.orderId}`}
                        aria-label={`View history for ${b.orderId}`}
                      >
                        <History size={18} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={11} className="px-5 py-10 text-center text-slate-400">
                  {appliedScope === "pending"
                    ? "No bookings are waiting for a PO."
                    : "No bookings found matching your criteria."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <SalesBookingDrawer />
      <BookingHistoryDrawer />
    </div>
  );
};

export default SalesDesk;
