import {
  X,
  Printer,
  Download,
  ArrowRight,
  User,
  Hash,
  Calendar as CalendarIcon,
  Package,
  FileText,
} from "lucide-react";
import { useState, useEffect } from "react";

const PAGE_SIZE = 10;

// Admin-managed booking lifecycle. Each stage advances to the next.
const STAGES = ["PO Received", "Ready for Dispatch", "Dispatched", "Delivered"];
// Map a legacy 'Booked' status onto the first stage for display/progression.
const normalizeStage = (status) => (status === "Booked" ? "PO Received" : status);
const nextStageOf = (status) => {
  const idx = STAGES.indexOf(normalizeStage(status));
  return idx >= 0 && idx < STAGES.length - 1 ? STAGES[idx + 1] : null;
};
import { motion, AnimatePresence } from "framer-motion";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useUserStore } from "../../store/userStore";
import { useCartStore } from "../../store/cartStore";
import { StatusBadge } from "../ui/StatusBadge";
import { PoStatusBadge } from "../ui/PoStatusBadge";
import { ERPButton } from "../ui/ERPButton";
import { OrderTimeline } from "../cards/OrderTimeline";
import { useShowMsilCode } from "../../hooks/useShowMsilCode";
import { usePagination } from "../../hooks/usePagination";
import { Pagination } from "../ui/Pagination";
import { PackageX } from "lucide-react";
import toast from "react-hot-toast";

export const OrderDrawer = () => {
  const { selectedOrder, setSelectedOrder, updateOrderStatus, updateOrderPO, cancelBooking } =
    useOrderHistoryStore();
  const { user } = useUserStore();
  const { pendingItems, fetchPendingReservations } = useCartStore();
  const showMsilCode = useShowMsilCode();
  const isAdmin = user?.role === "Admin";

  const [busy, setBusy] = useState(false);
  const [isEditingPO, setIsEditingPO] = useState(false);
  const [newPO, setNewPO] = useState("");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  // Close the confirmation when the drawer switches booking, so a prompt opened
  // against one booking cannot be confirmed against another.
  useEffect(() => {
    setConfirmingCancel(false);
    setCancelReason("");
  }, [selectedOrder?.orderNumber]);

  const handleSavePO = async () => {
    if (!newPO.trim()) return;
    setBusy(true);
    const res = await updateOrderPO(selectedOrder, newPO.trim());
    setBusy(false);
    if (res.success) {
      toast.success("PO Number updated successfully");
      setIsEditingPO(false);
      fetchPendingReservations();
    } else {
      toast.error(res.error || "Failed to update PO Number");
    }
  };

  // Load indents so the drawer can show the ones tied to this booking's PO.
  useEffect(() => {
    if (selectedOrder) fetchPendingReservations();
  }, [selectedOrder?.orderNumber, fetchPendingReservations]);

  // Derived before the early return so the paging hooks below always run.
  const targetIndent = selectedOrder
    ? selectedOrder.orderNumber.replace(/^SO-|^BO-/, 'PI-')
    : null;
  const bookingIndents = targetIndent
    ? pendingItems.filter((p) => p.indentNumber === targetIndent)
    : [];
  const lineItems = Array.isArray(selectedOrder?.items) ? selectedOrder.items : [];

  // A booking is locked once its PO is raised. '-' and blank are the
  // "not raised yet" placeholders the backend also treats as unlocked.
  const poRaised = Boolean(
    selectedOrder?.poNumber &&
    !['-', ''].includes(String(selectedOrder.poNumber).trim()),
  );

  // Cancellable while the stock is still only reserved and no PO commits it.
  // Once the PO is raised those units have left inventory against a commitment,
  // so returning them is a conversation, not a button. The server enforces all
  // of this too — this only decides whether to offer the action.
  const canCancel = Boolean(
    selectedOrder &&
    selectedOrder.status !== "Cancelled" &&
    !poRaised &&
    (selectedOrder.hasReservedStock ?? true),
  );

  const linePaging = usePagination(lineItems, PAGE_SIZE);
  const indentPaging = usePagination(bookingIndents, PAGE_SIZE);

  if (!selectedOrder) return null;

  const handleCancelBooking = async () => {
    setBusy(true);
    const res = await cancelBooking(selectedOrder, cancelReason.trim());
    setBusy(false);
    if (res.success) {
      toast.success(res.message || "Booking cancelled and stock released.");
      setConfirmingCancel(false);
      setCancelReason("");
      // The released units change what is bookable, so the selection list and
      // indent views must not keep showing the pre-cancellation position.
      fetchPendingReservations();
    } else {
      toast.error(res.error || "The booking could not be cancelled.");
    }
  };

  const applyStatus = async (newStatus) => {
    if (busy || newStatus === selectedOrder.status) return;
    setBusy(true);
    const res = await updateOrderStatus(selectedOrder, newStatus);
    setBusy(false);
    if (res.success) toast.success(`Status updated to ${newStatus}`);
    else toast.error(res.error || "Failed to update status");
  };

  // Build printable / exportable rows for this order.
  const buildExport = () => {
    const items = Array.isArray(selectedOrder.items) ? selectedOrder.items : [];
    const rows = items.map((item, i) => {
      const p = item.product || {};
      const qty = item.orderQuantity ?? item.quantity ?? 0;
      return {
        sr: i + 1,
        code: p.code || p.name || "-",
        msil: p.msilCode || selectedOrder.msilCode || "-",
        qty,
      };
    });
    const columns = [
      { key: "sr", label: "S.No" },
      { key: "code", label: "SKU / Product" },
      ...(showMsilCode ? [{ key: "msil", label: "MSIL Code" }] : []),
      { key: "qty", label: "Qty" },
    ];
    const title = `Booking ${selectedOrder.orderNumber}${selectedOrder.customer ? ` - ${selectedOrder.customer}` : ""}`;
    return { rows, columns, title };
  };

  const handlePrint = () => {
    const { rows, columns, title } = buildExport();
    import("../../utils/exportUtils").then(({ printData }) => {
      const ok = printData(rows, columns, title);
      if (!ok) toast.error("Unable to open print window (check pop-up blocker).");
    });
  };

  const handlePDF = () => {
    const { rows, columns, title } = buildExport();
    import("../../utils/exportUtils").then(({ exportToPDF }) => {
      const ok = exportToPDF(rows, columns, title, selectedOrder.orderNumber || "Booking");
      if (!ok) toast.error("PDF download failed");
    });
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex justify-end">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => setSelectedOrder(null)}
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
                Booking {selectedOrder.orderNumber}
              </h2>
              <StatusBadge status={selectedOrder.status} />
              <PoStatusBadge locked={poRaised} poNumber={selectedOrder.poNumber} />
              {selectedOrder.orderType === "bulk_upload" && (
                <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 text-[10px] font-bold uppercase rounded-md border border-indigo-200">
                  Bulk Import
                </span>
              )}
              {selectedOrder.autoBooked && (
                <span
                  title="Raised automatically when the stock you indented became available"
                  className="px-2 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-bold uppercase rounded-md border border-emerald-200"
                >
                  Auto-booked from indent
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {canCancel && (
                <ERPButton
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingCancel(true)}
                  className="text-red-600 border-red-200 hover:bg-red-50"
                >
                  <PackageX size={16} className="mr-2" /> Cancel booking
                </ERPButton>
              )}
              <ERPButton variant="outline" size="sm" className="hidden sm:flex" onClick={handlePrint}>
                <Printer size={16} className="mr-2" /> Print
              </ERPButton>
              <ERPButton variant="outline" size="sm" className="hidden sm:flex" onClick={handlePDF}>
                <Download size={16} className="mr-2" /> PDF
              </ERPButton>
              <button
                onClick={() => setSelectedOrder(null)}
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
                    <p className="text-[10px] font-bold text-slate-400 uppercase">
                      Customer
                    </p>
                    <p className="text-sm font-bold text-slate-800 line-clamp-2">
                      {selectedOrder.customer}
                    </p>
                  </div>
                </div>
              )}

              <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center shrink-0">
                  <Hash size={16} className="text-indigo-600" />
                </div>
                <div className="flex-1">
                  <p className="text-[10px] font-bold text-slate-400 uppercase">
                    PO Number
                  </p>
                  {isEditingPO ? (
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="text"
                        value={newPO}
                        onChange={(e) => setNewPO(e.target.value)}
                        className="w-full text-sm border border-slate-300 rounded px-2 py-1 outline-none focus:border-indigo-500 font-semibold text-slate-800"
                        placeholder="Enter PO No..."
                        autoFocus
                      />
                      <button onClick={handleSavePO} disabled={busy} className="text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-2 py-1.5 rounded">Save</button>
                      <button onClick={() => setIsEditingPO(false)} disabled={busy} className="text-xs font-bold text-slate-500 bg-slate-100 hover:bg-slate-200 px-2 py-1.5 rounded">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <p className="text-sm font-bold text-slate-800 line-clamp-2">
                        {selectedOrder.poNumber || "-"}
                      </p>
                      {/* Once the PO exists the booking is locked; only an Admin
                          may change it, and the server enforces this regardless. */}
                      {isAdmin && (
                        <button
                          onClick={() => {
                            setNewPO(poRaised ? selectedOrder.poNumber : "");
                            setIsEditingPO(true);
                          }}
                          className="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-1 rounded hover:bg-indigo-100 whitespace-nowrap"
                        >
                          {poRaised ? "Edit" : "Raise PO"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                <div className="w-8 h-8 rounded-full bg-violet-50 flex items-center justify-center shrink-0">
                  <CalendarIcon size={16} className="text-violet-600" />
                </div>
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase">
                    Booking Date
                  </p>
                  <p className="text-sm font-bold text-slate-800 line-clamp-2">
                    {new Date(selectedOrder.date).toLocaleDateString()}
                  </p>
                </div>
              </div>

            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              {/* Main Content */}
              <div className="lg:col-span-2 flex flex-col gap-6">
                {/* Product Table */}
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
                    <Package size={18} className="text-primary-600" />
                    <h3 className="text-sm font-bold text-slate-800">
                      Line Items
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left whitespace-nowrap">
                      <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                        <tr>
                          <th className="px-5 py-3">{showMsilCode ? "Code / MSIL" : "SKU Code"}</th>
                          <th className="px-5 py-3">Product Name</th>
                          <th className="px-5 py-3 text-center">Qty</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm">
                        {linePaging.pageItems.map((item, idx) => (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="px-5 py-4">
                              <div className="flex flex-col">
                                <span className="font-bold text-slate-800">
                                  {item.product.code}
                                </span>
                                {showMsilCode && (
                                  <span className="text-xs text-slate-500">
                                    {item.product.msilCode}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td
                              className="px-5 py-4 font-medium text-slate-700 truncate max-w-[200px]"
                              title={item.product.name}
                            >
                              {item.product.name}
                            </td>
                            <td className="px-5 py-4 text-center font-bold text-slate-700">
                              {item.orderQuantity} {item.product.unit}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {linePaging.total > 0 && (
                    <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50">
                      <Pagination
                        page={linePaging.page}
                        pageSize={PAGE_SIZE}
                        totalItems={linePaging.total}
                        onPageChange={linePaging.setPage}
                      />
                    </div>
                  )}
                </div>

                {/* Indents tied to this booking (matched by PO number) */}
                {bookingIndents.length > 0 && (
                  <div className="bg-white border border-amber-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                    <div className="px-5 py-4 border-b border-amber-100 flex items-center gap-2 bg-amber-50/50">
                      <PackageX size={18} className="text-amber-500" />
                      <h3 className="text-sm font-bold text-slate-800">
                        Indents ({bookingIndents.length})
                      </h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left whitespace-nowrap">
                        <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                          <tr>
                            <th className="px-5 py-3">SKU Code</th>
                            {showMsilCode && <th className="px-5 py-3">MSIL Code</th>}
                            <th className="px-5 py-3 text-center">Qty</th>
                            <th className="px-5 py-3 text-center">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-sm">
                          {indentPaging.pageItems.map((p) => (
                            <tr key={p._id} className="hover:bg-slate-50">
                              <td className="px-5 py-3 font-bold text-slate-800">{p.product.code}</td>
                              {showMsilCode && (
                                <td className="px-5 py-3 text-slate-500">{p.product.msilCode || "-"}</td>
                              )}
                              <td className="px-5 py-3 text-center font-black text-amber-600">{p.pendingQuantity}</td>
                              <td className="px-5 py-3 text-center">
                                <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-2.5 py-1 rounded-full uppercase tracking-wider">
                                  {p.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="px-5 py-3 border-t border-amber-100 bg-amber-50/30">
                      <Pagination
                        page={indentPaging.page}
                        pageSize={PAGE_SIZE}
                        totalItems={indentPaging.total}
                        onPageChange={indentPaging.setPage}
                      />
                    </div>
                  </div>
                )}

                {/* Remarks */}
                {selectedOrder.remarks && (
                  <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                    <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
                      <FileText size={18} className="text-primary-600" />
                      <h3 className="text-sm font-bold text-slate-800">
                        Remarks & Instructions
                      </h3>
                    </div>
                    <div className="p-5 text-sm text-slate-600 bg-slate-50/50">
                      {selectedOrder.remarks}
                    </div>
                  </div>
                )}
              </div>

              {/* Sidebar */}
              <div className="flex flex-col gap-6">
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col">
                  <div className="px-5 py-4 border-b border-slate-100">
                    <h3 className="text-sm font-bold text-slate-800">
                      Lifecycle Timeline
                    </h3>
                  </div>
                  <div className="p-5">
                    <OrderTimeline currentStatus={selectedOrder.status} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer Actions — advance through the booking lifecycle */}
          <div className="px-6 py-4 bg-white border-t border-slate-200 flex items-center justify-between shrink-0">
            <span className="text-xs text-slate-400 font-medium">
              Status: <span className="font-bold text-slate-600">{normalizeStage(selectedOrder.status)}</span>
            </span>

            {isAdmin && (() => {
              const next = nextStageOf(selectedOrder.status);
              return next ? (
                <ERPButton
                  variant="primary"
                  disabled={busy}
                  onClick={() => applyStatus(next)}
                >
                  {busy ? "Updating..." : `Move to ${next}`}
                  <ArrowRight size={16} className="ml-2" />
                </ERPButton>
              ) : (
                <span className="text-xs font-bold text-emerald-600">Delivered — lifecycle complete</span>
              );
            })()}
          </div>

          {/* Cancellation confirmation. Releasing stock is not undoable from
              here — the booking would have to be placed again, and by then the
              units may be gone — so the quantity being released is spelled out
              before the customer commits. */}
          {confirmingCancel && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-6">
              <div className="w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                    <PackageX size={18} className="text-red-600" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-800">
                      Cancel booking {selectedOrder.orderNumber}?
                    </h3>
                    <p className="text-[11px] text-slate-500">This cannot be undone.</p>
                  </div>
                </div>

                <div className="px-5 py-4 flex flex-col gap-3">
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {selectedOrder.totalQuantity} unit
                    {selectedOrder.totalQuantity === 1 ? "" : "s"} across{" "}
                    {lineItems.length} item{lineItems.length === 1 ? "" : "s"} will be
                    released back into available stock, where anyone can book them.
                    To order these again you would need to place a fresh booking.
                  </p>

                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                      Reason (optional)
                    </span>
                    <input
                      type="text"
                      value={cancelReason}
                      maxLength={300}
                      autoFocus
                      placeholder="e.g. no longer required"
                      onChange={(e) => setCancelReason(e.target.value)}
                      className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-700
                                 outline-none focus:ring-1 focus:ring-primary-500"
                    />
                  </label>
                </div>

                <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
                  <ERPButton
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingCancel(false)}
                  >
                    Keep booking
                  </ERPButton>
                  <ERPButton variant="danger" size="sm" loading={busy} onClick={handleCancelBooking}>
                    {busy ? "Cancelling..." : "Cancel booking"}
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
