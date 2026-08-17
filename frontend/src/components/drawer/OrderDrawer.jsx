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
  Sparkles,
} from "lucide-react";
import { useState, useEffect } from "react";

const PAGE_SIZE = 10;

import { motion, AnimatePresence } from "framer-motion";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useUserStore } from "../../store/userStore";
import { useCartStore } from "../../store/cartStore";
import { StatusBadge } from "../ui/StatusBadge";
import { PoStatusBadge } from "../ui/PoStatusBadge";
import { ERPButton } from "../ui/ERPButton";
import { OrderTimeline } from "../cards/OrderTimeline";
import { useShowMsilCode } from "../../hooks/useShowMsilCode";
import { canViewLineItemBoxNo } from "../../utils/permissions";
import { usePagination } from "../../hooks/usePagination";
import { Pagination } from "../ui/Pagination";
import { PackageX } from "lucide-react";
import toast from "react-hot-toast";
import {
  BOOKING_LIFECYCLE,
  TERMINAL_STATUSES,
  normalizeStatus,
  stageLabel,
  nextStageOf,
} from "../../constants/bookingLifecycle";

export const OrderDrawer = () => {
  const {
    selectedOrder,
    setSelectedOrder,
    updateOrderStatus,
    updateOrderPO,
    cancelBooking,
    timelines,
    timelineLoading,
    fetchTimeline,
    resendStatusEmail,
    resendingEventId,
  } = useOrderHistoryStore();
  const { user } = useUserStore();
  const { pendingItems, fetchPendingReservations } = useCartStore();
  const showMsilCode = useShowMsilCode();
  // This drawer is also the customer's own order-history view, so the box
  // number is limited to the desk that acts on the booking.
  const showBoxNo = canViewLineItemBoxNo(user);
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

  // The lifecycle history — when each stage was reached, and (for staff)
  // whether the customer's email for it actually went.
  useEffect(() => {
    if (selectedOrder?.orderNumber) fetchTimeline(selectedOrder.orderNumber);
  }, [selectedOrder?.orderNumber, fetchTimeline]);

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

  // Recorded status events for this booking. Empty until the fetch lands — the
  // timeline still draws all four stages, just without their timestamps.
  const timeline = timelines[selectedOrder?.orderNumber] || [];

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
    if (busy || normalizeStatus(newStatus) === normalizeStatus(selectedOrder.status)) return;
    setBusy(true);
    const res = await updateOrderStatus(selectedOrder, newStatus);
    setBusy(false);

    if (!res.success) {
      toast.error(res.error || "Failed to update status");
      return;
    }
    if (!res.changed) {
      // The server refused to re-announce a status the booking already held.
      toast(res.message || "The booking was already at this status.");
      return;
    }

    // The status moved either way — but an admin who is not told the email
    // failed will assume the customer knows, which is the whole point of
    // reporting delivery here rather than only in a log.
    if (res.notified === "sent") {
      toast.success(`Moved to ${stageLabel(newStatus)} — the customer has been emailed.`);
    } else if (res.notified === "failed" || res.notified === "skipped") {
      toast.error(
        `Moved to ${stageLabel(newStatus)}, but the customer was NOT emailed — ` +
          `${res.notifyError || "see the timeline"}. You can resend it from the timeline.`,
        { duration: 8000 },
      );
    } else {
      toast.success(`Moved to ${stageLabel(newStatus)}`);
    }
  };

  const handleResend = async (eventId) => {
    const res = await resendStatusEmail(selectedOrder.orderNumber, eventId);
    if (res.success) toast.success(res.message || "The notification was sent.");
    else toast.error(res.message || "The notification could not be sent.");
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
        boxNo: p.boxNo || selectedOrder.boxNo || "-",
        qty,
      };
    });
    const columns = [
      { key: "sr", label: "S.No" },
      { key: "code", label: "SKU / Product" },
      ...(showMsilCode ? [{ key: "msil", label: "MSIL Code" }] : []),
      // Gated identically to the on-screen column — a printed pick list must
      // not carry a column the same user cannot see in the drawer.
      ...(showBoxNo ? [{ key: "boxNo", label: "Box No" }] : []),
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
          {/* Header. Two tiers: the booking's identity and its actions on the
              first row, its state on the second. Everything used to share one
              row — title, up to four badges and four buttons — which squeezed
              the title until it wrapped mid-reference. */}
          <div className="px-6 py-3.5 bg-white border-b border-slate-200 shrink-0 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-xl font-black text-slate-800 whitespace-nowrap truncate">
                Booking {selectedOrder.orderNumber}
              </h2>

              <div className="flex items-center gap-2 shrink-0">
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

            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={selectedOrder.status} />
              <PoStatusBadge locked={poRaised} poNumber={selectedOrder.poNumber} />
              {selectedOrder.orderType === "bulk_upload" && (
                <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 text-[10px] font-bold uppercase rounded-md border border-indigo-200">
                  Bulk Import
                </span>
              )}
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-8">
            {/* Top Info Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Moved out of the header, where it was one badge among four and
                  said less than it could. Here it has room to name the indent
                  the booking came from. */}
              {selectedOrder.autoBooked && (
                <div className="bg-white border border-emerald-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                  <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
                    <Sparkles size={16} className="text-emerald-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">
                      Raised automatically
                    </p>
                    <p className="text-sm font-bold text-slate-800 truncate">
                      From indent {selectedOrder.autoBookedFrom || "—"}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      when the stock came back in
                    </p>
                  </div>
                </div>
              )}

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
                          <th className="px-5 py-3">SKU Code</th>
                          {/* MSIL Code replaces the old Product Name column, which
                              only ever rendered a placeholder like "Koken Product".
                              Shown only to users MSIL codes apply to — the same rule
                              used everywhere else (utils/msilVisibility on the server). */}
                          {showMsilCode && <th className="px-5 py-3">MSIL Code</th>}
                          {/* Beside the codes and before the quantity, so the row
                              reads the way it is picked: which part, which box,
                              how many. */}
                          {showBoxNo && <th className="px-5 py-3">Box No</th>}
                          <th className="px-5 py-3 text-center">Qty</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm">
                        {linePaging.pageItems.map((item, idx) => (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="px-5 py-4 font-bold text-slate-800">
                              {item.product.code}
                            </td>
                            {showMsilCode && (
                              <td className="px-5 py-4 font-medium text-slate-700">
                                {item.product.msilCode || "—"}
                              </td>
                            )}
                            {showBoxNo && (
                              <td className="px-5 py-4 font-mono font-bold text-slate-700">
                                {item.product.boxNo || (
                                  <span className="font-sans font-normal text-slate-400">—</span>
                                )}
                              </td>
                            )}
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
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-slate-800">
                      Lifecycle Timeline
                    </h3>
                    {timelineLoading && (
                      <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                        Loading…
                      </span>
                    )}
                  </div>
                  <div className="p-5">
                    <OrderTimeline
                      currentStatus={selectedOrder.status}
                      history={timeline}
                      // The delivery log is operational detail. A customer can
                      // neither act on a bounce reason nor resend the mail, so
                      // they are shown the stages and their dates only.
                      showNotifications={isAdmin}
                      onResend={handleResend}
                      resendingId={resendingEventId}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer Actions — advance through the booking lifecycle.
              Every change from here emails the customer, so both controls go
              through the same applyStatus() and the same one-request-per-
              booking path. The dropdown exists because the next-stage button
              alone gives an admin no way to correct a stage set by mistake. */}
          <div className="px-6 py-4 bg-white border-t border-slate-200 flex items-center justify-between gap-4 shrink-0">
            <span className="text-xs text-slate-400 font-medium">
              Status:{" "}
              <span className="font-bold text-slate-600">{stageLabel(selectedOrder.status)}</span>
            </span>

            {isAdmin && !TERMINAL_STATUSES.includes(selectedOrder.status) && (() => {
              const next = nextStageOf(selectedOrder.status);
              const current = normalizeStatus(selectedOrder.status);
              return (
                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor="booking-stage">Set booking status</label>
                  <select
                    id="booking-stage"
                    value={current}
                    disabled={busy}
                    onChange={(e) => applyStatus(e.target.value)}
                    className="text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg
                               px-2.5 py-2 outline-none focus:ring-1 focus:ring-primary-500
                               disabled:opacity-50 disabled:cursor-not-allowed bg-white"
                  >
                    {BOOKING_LIFECYCLE.map((stage) => (
                      <option key={stage.key} value={stage.key}>
                        {stage.label}
                      </option>
                    ))}
                  </select>

                  {next ? (
                    <ERPButton variant="primary" disabled={busy} onClick={() => applyStatus(next)}>
                      {busy ? "Updating..." : `Move to ${stageLabel(next)}`}
                      <ArrowRight size={16} className="ml-2" />
                    </ERPButton>
                  ) : (
                    <span className="text-xs font-bold text-emerald-600">
                      Delivered — lifecycle complete
                    </span>
                  )}
                </div>
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
