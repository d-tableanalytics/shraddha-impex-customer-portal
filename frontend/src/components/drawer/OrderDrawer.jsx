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
  Save,
  RotateCcw,
  Loader2,
  Info,
  MapPin,
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
import { canViewLineItemBoxNo, canEditBookingQuantity, hasPermission, PERMISSIONS } from "../../utils/permissions";
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
    saveLineQuantities,
    savingLines,
    quantityHistory,
    quantityHistoryFor,
    quantityHistoryLoading,
    fetchQuantityHistory,
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
  // Pending quantity edits, keyed by Order row id. An OVERRIDE map rather than
  // a full copy of the lines: an untouched line has no entry, so a refetch that
  // brings new server values cannot be silently clobbered by a stale draft.
  const [draftQty, setDraftQty] = useState({});
  const [showQtyHistory, setShowQtyHistory] = useState(false);

  // Close the confirmation when the drawer switches booking, so a prompt opened
  // against one booking cannot be confirmed against another.
  useEffect(() => {
    setConfirmingCancel(false);
    setCancelReason("");
    setDraftQty({});
    setShowQtyHistory(false);
  }, [selectedOrder?.orderNumber]);

  // The history drives a badge that has to be right the moment the drawer
  // opens, so it is fetched with the booking rather than on opening the panel.
  useEffect(() => {
    if (selectedOrder?.orderNumber) fetchQuantityHistory(selectedOrder.orderNumber);
    // fetchQuantityHistory is a stable zustand action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Who may amend quantities here, and when. Staff follow the desk rules;
  // the customer may revise their own booking until the PO is raised. The
  // server re-checks both on every write, answering 423 once the booking is
  // locked and 404 for a booking that is not the caller's.
  const canEditQty = canEditBookingQuantity(user, { locked: poRaised });
  const isStaff = hasPermission(user, PERMISSIONS.VIEW_ALL_BOOKINGS);

  // Only this booking's history — the store holds one booking's at a time and
  // a stale one would put the wrong badge on the wrong order.
  const qtyHistory =
    quantityHistoryFor === selectedOrder?.orderNumber ? quantityHistory : null;
  const qtyEntries = qtyHistory?.entries || [];

  // The quantity a line is currently showing: the pending edit if it has one,
  // otherwise what the booking holds.
  const savedQtyOf = (item) => item.confirmedQty ?? item.orderQuantity ?? 0;
  const qtyOf = (item) =>
    draftQty[item.lineId] !== undefined ? draftQty[item.lineId] : savedQtyOf(item);

  const lineChange = (item) => qtyOf(item) - savedQtyOf(item);
  const dirty = lineItems.some((item) => lineChange(item) !== 0);
  const hasIndent = lineItems.some((item) => (item.pendingQty ?? 0) > 0);
  // What the CUSTOMER asked for across the booking, indent included.
  const totalBooked = lineItems.reduce((n, i) => n + (i.bookedQty ?? 0), 0);
  const totalIndent = lineItems.reduce((n, i) => n + (i.pendingQty ?? 0), 0);

  const linePaging = usePagination(lineItems, PAGE_SIZE);
  const indentPaging = usePagination(bookingIndents, PAGE_SIZE);

  // Recorded status events for this booking. Empty until the fetch lands — the
  // timeline still draws all four stages, just without their timestamps.
  const timeline = timelines[selectedOrder?.orderNumber] || [];

  if (!selectedOrder) return null;

  const handleSaveQuantities = async () => {
    const invalid = lineItems.find((item) => !Number.isInteger(qtyOf(item)) || qtyOf(item) < 1);
    if (invalid) {
      toast.error("Every line needs a whole-number quantity of at least 1.");
      return;
    }
    // EVERY line is sent, not just the visible page: the endpoint treats an
    // unlisted row as removed, so posting one page of a paginated booking
    // would delete the rest.
    const res = await saveLineQuantities(
      selectedOrder.orderNumber,
      lineItems.map((item) => ({
        id: item.lineId,
        skuCode: item.product.code,
        quantity: qtyOf(item),
      })),
    );
    if (res.success) {
      setDraftQty({});
      // An increase that outran stock was split: the covered part stayed on
      // the booking, the rest became an indent. Say so — a plain "updated"
      // would read as the full quantity having been confirmed.
      const splits = (res.changes || []).filter((c) => c.type === "quantity-split");
      if (splits.length) {
        toast.success(
          splits
            .map((s) => `${s.skuCode}: ${s.toQty} confirmed, ${s.indentQty} moved to indent (stock short).`)
            .join(" "),
          { duration: 8000, icon: "⚠️" },
        );
      } else {
        toast.success("Quantities updated. Stock has been adjusted to match.");
      }
    } else {
      toast.error(res.error);
    }
  };

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
    // Reference lines under the title. The pick list travels to the warehouse
    // floor, so the delivery location and its phone number ride on it.
    const meta = [
      selectedOrder.location ? `Location: ${selectedOrder.location}` : null,
      selectedOrder.phoneNumber ? `Phone: ${selectedOrder.phoneNumber}` : null,
    ].filter(Boolean);
    return { rows, columns, title, meta };
  };

  const handlePrint = () => {
    const { rows, columns, title, meta } = buildExport();
    import("../../utils/exportUtils").then(({ printData }) => {
      const ok = printData(rows, columns, title, meta);
      if (!ok) toast.error("Unable to open print window (check pop-up blocker).");
    });
  };

  const handlePDF = () => {
    const { rows, columns, title, meta } = buildExport();
    import("../../utils/exportUtils").then(({ exportToPDF }) => {
      const ok = exportToPDF(rows, columns, title, selectedOrder.orderNumber || "Booking", meta);
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

              {/* Delivery location and its phone number — the pair the pick
                  list prints, shown here so it can be checked before printing. */}
              {(selectedOrder.location || selectedOrder.phoneNumber) && (
                <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                  <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
                    <MapPin size={16} className="text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase">
                      Location &amp; Phone
                    </p>
                    <p className="text-sm font-bold text-slate-800 line-clamp-2">
                      {selectedOrder.location || "—"}
                    </p>
                    {selectedOrder.phoneNumber && (
                      <p className="text-xs font-semibold text-slate-500">
                        {selectedOrder.phoneNumber}
                      </p>
                    )}
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
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                      <Package size={18} className="text-primary-600" />
                      <h3 className="text-sm font-bold text-slate-800">
                        Line Items
                      </h3>
                    </div>
                    {/* Booked-vs-holding, spelled out. These two differ whenever
                        stock was short at booking or the desk has amended a
                        line, and without both numbers the Qty column alone
                        looks like the customer asked for less than they did. */}
                    <div className="flex items-center gap-4 text-[11px]">
                      <span className="text-slate-500">
                        Booked by customer{" "}
                        <strong className="text-slate-800 text-xs">{totalBooked}</strong>
                      </span>
                      <span className="text-slate-500 inline-flex items-center gap-1">
                        On this booking{" "}
                        <strong className="text-slate-800 text-xs">
                          {lineItems.reduce((n, i) => n + qtyOf(i), 0)}
                        </strong>
                        {/* The quantity on a booking can have been moved by the
                            customer or by us, and the number alone says
                            neither. This opens the trail that does. */}
                        <button
                          type="button"
                          onClick={() => setShowQtyHistory(true)}
                          title="Who changed this quantity, and when"
                          className="ml-0.5 p-0.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-full transition-colors focus:outline-none"
                        >
                          <Info size={13} />
                        </button>
                      </span>
                      {/* Staff need to notice a customer revision without
                          opening anything — it changes what they are about to
                          put on the PO. */}
                      {isStaff && qtyHistory?.changedByCustomer && (
                        <button
                          type="button"
                          onClick={() => setShowQtyHistory(true)}
                          className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded-full uppercase tracking-wide hover:bg-blue-100"
                        >
                          Customer changed qty
                        </button>
                      )}
                      {totalIndent > 0 && (
                        <span className="text-amber-600">
                          On indent <strong className="text-xs">{totalIndent}</strong>
                        </span>
                      )}
                    </div>
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
                          <th className="px-5 py-3 text-center">Booked</th>
                          <th className="px-5 py-3 text-center">Qty</th>
                          {canEditQty && <th className="px-5 py-3 text-center">Change</th>}
                          {hasIndent && <th className="px-5 py-3 text-center">Indent</th>}
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
                            {/* What the customer originally asked for. Read-only
                                everywhere: a stock shortfall or a desk edit moves
                                the Qty beside it, never this. */}
                            <td className="px-5 py-4 text-center font-medium text-slate-500">
                              {item.bookedQty ?? item.orderQuantity}
                            </td>
                            <td className="px-5 py-4 text-center font-bold text-slate-700">
                              {canEditQty ? (
                                <input
                                  type="number"
                                  min={1}
                                  step={1}
                                  value={qtyOf(item)}
                                  onChange={(e) =>
                                    setDraftQty((d) => ({
                                      ...d,
                                      [item.lineId]:
                                        e.target.value === "" ? "" : Number(e.target.value),
                                    }))
                                  }
                                  className="w-20 text-center border border-slate-300 rounded-lg px-2 py-1 text-sm font-bold text-slate-800 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                                />
                              ) : (
                                <>
                                  {item.orderQuantity} {item.product.unit}
                                </>
                              )}
                            </td>
                            {canEditQty && (
                              <td className="px-5 py-4 text-center text-xs font-bold">
                                {lineChange(item) === 0 ? (
                                  <span className="text-slate-300">&mdash;</span>
                                ) : (
                                  <span
                                    className={
                                      lineChange(item) > 0 ? "text-emerald-600" : "text-amber-600"
                                    }
                                  >
                                    {lineChange(item) > 0 ? "+" : ""}
                                    {lineChange(item)}
                                  </span>
                                )}
                              </td>
                            )}
                            {hasIndent && (
                              <td className="px-5 py-4 text-center font-bold">
                                {(item.pendingQty ?? 0) > 0 ? (
                                  <span className="text-amber-600">{item.pendingQty}</span>
                                ) : (
                                  <span className="text-slate-300">&mdash;</span>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {canEditQty && (
                    <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/60 flex items-center justify-between gap-3 flex-wrap">
                      <p className="text-[11px] text-slate-500 leading-relaxed max-w-md">
                        Saving adjusts inventory immediately: raising a quantity reserves more
                        stock, lowering it returns the difference. The change is recorded and
                        shown to the customer when the PO is raised.
                      </p>
                      <div className="flex items-center gap-2">
                        {dirty && (
                          <button
                            onClick={() => setDraftQty({})}
                            disabled={savingLines}
                            className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 px-3 py-1.5 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                          >
                            <RotateCcw size={14} /> Reset
                          </button>
                        )}
                        <button
                          onClick={handleSaveQuantities}
                          disabled={savingLines || !dirty}
                          className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-primary-600 px-3 py-1.5 rounded-lg hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {savingLines ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Save size={14} />
                          )}
                          Save quantities
                        </button>
                      </div>
                    </div>
                  )}
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
          {/* Quantity-change history — the detail behind the "i" button.
              Newest first: what someone wants to know is what the quantity is
              now and who moved it there, not how it started. */}
          {showQtyHistory && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/40 px-6">
              <div className="w-full max-w-lg bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[80%]">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3 shrink-0">
                  <div className="w-9 h-9 rounded-full bg-primary-50 flex items-center justify-center shrink-0">
                    <Info size={18} className="text-primary-600" />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-bold text-slate-800">Quantity change history</h4>
                    <p className="text-[11px] text-slate-500">Booking {selectedOrder.orderNumber}</p>
                  </div>
                  <button
                    onClick={() => setShowQtyHistory(false)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg focus:outline-none"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="overflow-y-auto flex-1">
                  {quantityHistoryLoading && qtyEntries.length === 0 ? (
                    <div className="px-5 py-8 text-sm text-slate-500 flex items-center justify-center gap-2">
                      <Loader2 size={14} className="animate-spin text-primary-500" /> Loading…
                    </div>
                  ) : qtyEntries.length === 0 ? (
                    <div className="px-5 py-8 text-center">
                      <p className="text-sm text-slate-500">No quantity changes yet.</p>
                      <p className="text-[11px] text-slate-400 mt-1">
                        This booking still holds the quantities it was placed with.
                      </p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {[...qtyEntries].reverse().map((entry) => (
                        <li key={entry.id} className="px-5 py-3.5">
                          <div className="flex items-center justify-between gap-3 mb-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-bold text-slate-800 truncate">
                                {entry.by}
                              </span>
                              <span
                                className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide shrink-0 ${
                                  entry.source === "customer"
                                    ? "text-blue-700 bg-blue-50 border border-blue-200"
                                    : "text-violet-700 bg-violet-50 border border-violet-200"
                                }`}
                              >
                                {entry.source === "customer" ? "Customer" : entry.role}
                              </span>
                            </div>
                            <span className="text-[11px] text-slate-400 whitespace-nowrap shrink-0">
                              {new Date(entry.at).toLocaleString()}
                            </span>
                          </div>
                          <ul className="flex flex-col gap-1">
                            {entry.changes.map((c, i) => (
                              <li
                                key={`${entry.id}-${i}`}
                                className="flex items-center justify-between gap-3 text-xs"
                              >
                                <span className="font-mono font-bold text-slate-600 truncate">
                                  {c.fromSku && c.fromSku !== c.skuCode
                                    ? `${c.fromSku} → ${c.skuCode}`
                                    : c.skuCode}
                                </span>
                                <span className="whitespace-nowrap shrink-0">
                                  <span className="text-slate-400">{c.fromQty}</span>
                                  <span className="text-slate-300 mx-1">→</span>
                                  <span className="font-bold text-slate-800">{c.toQty}</span>
                                  <span
                                    className={`ml-2 font-bold ${
                                      c.delta > 0 ? "text-emerald-600" : "text-amber-600"
                                    }`}
                                  >
                                    {c.delta > 0 ? "+" : ""}
                                    {c.delta}
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 shrink-0 flex justify-end">
                  <ERPButton variant="outline" size="sm" onClick={() => setShowQtyHistory(false)}>
                    Close
                  </ERPButton>
                </div>
              </div>
            </div>
          )}

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
