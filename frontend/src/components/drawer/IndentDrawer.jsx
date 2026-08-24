import {
  X,
  Printer,
  Download,
  User,
  Hash,
  Calendar as CalendarIcon,
  PackageX,
  FileText,
} from "lucide-react";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import toast from "react-hot-toast";
import { reservationsApi } from "../../services/reservations";
import { useIndentHistoryStore } from "../../store/indentHistoryStore";
import { useUserStore } from "../../store/userStore";
import { ERPButton } from "../ui/ERPButton";
import { IndentStatusBadge } from "../ui/IndentStatusBadge";
import { useShowMsilCode } from "../../hooks/useShowMsilCode";
import { usePagination } from "../../hooks/usePagination";
import { Pagination } from "../ui/Pagination";
import { IndentScheduleSection } from "./IndentScheduleSection";

const PAGE_SIZE = 10;

export const IndentDrawer = () => {
  const { selectedIndent, setSelectedIndent, fetchIndents } = useIndentHistoryStore();
  const { user } = useUserStore();
  const showMsilCode = useShowMsilCode();
  const isAdmin = user?.role === "Admin";
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  // Derived before the early return so the paging hook always runs.
  const lines = Array.isArray(selectedIndent?.lines) ? selectedIndent.lines : [];
  const linePaging = usePagination(lines, PAGE_SIZE);

  // Lines still waiting on stock. Cancelling the indent cancels exactly these —
  // a line already confirmed or cancelled has nothing left to cancel.
  const openLines = lines.filter(
    (l) => l.status === "Pending" || l.status === "Partially Confirmed",
  );

  if (!selectedIndent) return null;

  const handleCancelIndent = async () => {
    setBusy(true);
    try {
      // Per-line, because the server addresses reservations by id. allSettled
      // so one refusal (e.g. a line confirmed meanwhile) does not hide the rest.
      const results = await Promise.allSettled(
        openLines.map((l) => reservationsApi.cancel(l._id)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed) {
        toast.error(`${failed} of ${openLines.length} line(s) could not be cancelled.`);
      } else {
        toast.success(`Indent ${selectedIndent.indentNumber || ""} cancelled.`.trim());
      }
      setSelectedIndent(null);
      fetchIndents();
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  };

  const buildExport = () => {
    const rows = lines.map((l, i) => ({
      sr: i + 1,
      code: l.product?.code || "-",
      msil: l.product?.msilCode || "-",
      qty: l.pendingQuantity || 0,
      available: l.product?.availableStock ?? 0,
      status: l.status || "-",
    }));
    const columns = [
      { key: "sr", label: "S.No" },
      { key: "code", label: "SKU Code" },
      ...(showMsilCode ? [{ key: "msil", label: "MSIL Code" }] : []),
      { key: "qty", label: "Indent Qty" },
      { key: "available", label: "Available Qty" },
      { key: "status", label: "Status" },
    ];
    const title = `Indent ${selectedIndent.indentNumber || ""}${selectedIndent.customer ? ` - ${selectedIndent.customer}` : ""}`;
    return { rows, columns, title };
  };

  const handlePrint = () => {
    const { rows, columns, title } = buildExport();
    import("../../utils/exportUtils").then(({ printData }) => {
      if (!printData(rows, columns, title)) {
        toast.error("Unable to open print window (check pop-up blocker).");
      }
    });
  };

  const handlePDF = () => {
    const { rows, columns, title } = buildExport();
    import("../../utils/exportUtils").then(({ exportToPDF }) => {
      if (!exportToPDF(rows, columns, title, selectedIndent.indentNumber || "Indent")) {
        toast.error("PDF download failed");
      }
    });
  };

  const readyCount = selectedIndent.readyLines;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex justify-end">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => setSelectedIndent(null)}
          className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm cursor-pointer"
        />

        <motion.div
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className="relative w-full max-w-4xl bg-slate-50 h-full shadow-2xl flex flex-col z-10 overflow-hidden"
        >
          {/* Header */}
          <div className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-4">
              <h2 className="text-xl font-black text-slate-800">
                Indent {selectedIndent.indentNumber || "—"}
              </h2>
              <IndentStatusBadge status={selectedIndent.status} />
            </div>

            <div className="flex items-center gap-2">
              {openLines.length > 0 && (
                <ERPButton
                  variant="outline"
                  size="sm"
                  className="text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => setConfirmingCancel(true)}
                >
                  <PackageX size={16} className="mr-2" /> Cancel Indent
                </ERPButton>
              )}
              <ERPButton variant="outline" size="sm" className="hidden sm:flex" onClick={handlePrint}>
                <Printer size={16} className="mr-2" /> Print
              </ERPButton>
              <ERPButton variant="outline" size="sm" className="hidden sm:flex" onClick={handlePDF}>
                <Download size={16} className="mr-2" /> PDF
              </ERPButton>
              <button
                onClick={() => setSelectedIndent(null)}
                className="p-2 ml-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors focus:outline-none"
              >
                <X size={24} />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-8">
            {/* Top Info Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {isAdmin && (
                <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                  <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                    <User size={16} className="text-blue-600" />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Customer</p>
                    <p className="text-sm font-bold text-slate-800 line-clamp-2">
                      {selectedIndent.customer}
                    </p>
                  </div>
                </div>
              )}

              <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center shrink-0">
                  <Hash size={16} className="text-indigo-600" />
                </div>
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase">Booking ID</p>
                  {/* Null means this indent was raised on its own. Deriving an
                      id from the indent number would name a booking that was
                      never created. */}
                  <p className={`text-sm font-bold line-clamp-2 ${
                    selectedIndent.bookingId ? "text-slate-800" : "text-amber-600"
                  }`}>
                    {selectedIndent.bookingId || "Standalone indent"}
                  </p>
                </div>
              </div>

              <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                <div className="w-8 h-8 rounded-full bg-violet-50 flex items-center justify-center shrink-0">
                  <CalendarIcon size={16} className="text-violet-600" />
                </div>
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase">Indent Date</p>
                  <p className="text-sm font-bold text-slate-800 line-clamp-2">
                    {selectedIndent.date
                      ? new Date(selectedIndent.date).toLocaleDateString()
                      : "—"}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              {/* Main Content */}
              <div className="lg:col-span-2 flex flex-col gap-6">
                <div className="bg-white border border-amber-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                  <div className="px-5 py-4 border-b border-amber-100 flex items-center gap-2 bg-amber-50/50">
                    <PackageX size={18} className="text-amber-500" />
                    <h3 className="text-sm font-bold text-slate-800">
                      Indent Lines ({lines.length})
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left whitespace-nowrap">
                      <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                        <tr>
                          <th className="px-5 py-3">
                            {showMsilCode ? "Code / MSIL" : "SKU Code"}
                          </th>
                          <th className="px-5 py-3 text-center">Indent Qty</th>
                          <th className="px-5 py-3 text-center">Available</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm">
                        {linePaging.pageItems.map((line) => {
                          // Still used to colour the available-stock figure —
                          // a line whose stock has arrived reads green.
                          const inStock =
                            (line.product?.availableStock || 0) >= (line.pendingQuantity || 0);
                          return (
                            <tr key={line._id} className="hover:bg-slate-50">
                              <td className="px-5 py-4">
                                <div className="flex flex-col">
                                  <span className="font-bold text-slate-800">
                                    {line.product.code}
                                  </span>
                                  {showMsilCode && (
                                    <span className="text-xs text-slate-500">
                                      {line.product.msilCode || "-"}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-5 py-4 text-center font-black text-amber-600">
                                {line.pendingQuantity}
                              </td>
                              <td
                                className={`px-5 py-4 text-center font-bold ${inStock ? "text-emerald-600" : "text-slate-500"}`}
                              >
                                {line.product.availableStock}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {linePaging.total > 0 && (
                    <div className="px-5 py-3 border-t border-amber-100 bg-amber-50/30">
                      <Pagination
                        page={linePaging.page}
                        pageSize={PAGE_SIZE}
                        totalItems={linePaging.total}
                        onPageChange={linePaging.setPage}
                      />
                    </div>
                  )}
                </div>

                {/* Scheduling — admin only, and it sits under the lines because
                    it is about those lines. */}
                {isAdmin && <IndentScheduleSection lines={lines} />}
              </div>

              {/* Sidebar */}
              <div className="flex flex-col gap-6">
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col">
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
                    <FileText size={18} className="text-primary-600" />
                    <h3 className="text-sm font-bold text-slate-800">Indent Summary</h3>
                  </div>
                  <div className="p-5 flex flex-col gap-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-medium">Lines</span>
                      <span className="font-bold text-slate-800">{selectedIndent.itemCount}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-medium">Total Qty</span>
                      <span className="font-black text-amber-600">
                        {selectedIndent.totalQuantity}
                      </span>
                    </div>
                    <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                      <span className="text-slate-500 font-medium">In Stock Now</span>
                      <span
                        className={`font-bold ${readyCount > 0 ? "text-emerald-600" : "text-slate-400"}`}
                      >
                        {readyCount} / {selectedIndent.itemCount}
                      </span>
                    </div>
                    {selectedIndent.poNumber && selectedIndent.poNumber !== "-" && (
                      <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                        <span className="text-slate-500 font-medium">PO Number</span>
                        <span className="font-bold text-slate-800">{selectedIndent.poNumber}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-5 text-xs text-amber-900 leading-relaxed">
                  <p className="font-bold mb-1">What is an indent?</p>
                  Quantities that could not be fulfilled from stock when the booking was
                  confirmed. Once stock arrives they move back to the customer's selection
                  list for confirmation.
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-white border-t border-slate-200 flex items-center justify-between shrink-0">
            <span className="text-xs text-slate-400 font-medium">
              Status:{" "}
              <span className="font-bold text-slate-600">{selectedIndent.status}</span>
            </span>
            {/* Reports stock position only. It used to say lines "can be
                restored now", which described the manual action that has been
                removed — the move to the selection list is automatic. */}
            {isAdmin && (
              <span className="text-xs font-bold text-slate-500">
                {readyCount === 0
                  ? "Awaiting stock for every line"
                  : readyCount === selectedIndent.itemCount
                    ? "Stock is available for every line"
                    : `${readyCount} of ${selectedIndent.itemCount} lines have stock available`}
              </span>
            )}
          </div>

          {confirmingCancel && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-6">
              <div className="w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                    <PackageX size={18} className="text-red-600" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-800">
                      Cancel indent {selectedIndent.indentNumber || ""}?
                    </h3>
                    <p className="text-[11px] text-slate-500">This cannot be undone.</p>
                  </div>
                </div>

                <div className="px-5 py-4">
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {openLines.length} open line{openLines.length === 1 ? "" : "s"} (
                    {openLines.reduce((n, l) => n + (l.pendingQuantity || 0), 0)} unit
                    {openLines.reduce((n, l) => n + (l.pendingQuantity || 0), 0) === 1 ? "" : "s"}
                    ) will stop waiting for stock. No inventory is affected — an indent
                    holds no reserved stock. To order these items again, place a fresh
                    booking.
                  </p>
                </div>

                <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
                  <ERPButton
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingCancel(false)}
                  >
                    Keep indent
                  </ERPButton>
                  <ERPButton variant="danger" size="sm" loading={busy} onClick={handleCancelIndent}>
                    {busy ? "Cancelling..." : "Cancel indent"}
                  </ERPButton>
                </div>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
