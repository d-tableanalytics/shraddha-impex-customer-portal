import {
  X,
  Printer,
  Download,
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

/**
 * One booking fact, as a cell of the facts panel.
 *
 * Replaces six near-identical card bodies that differed only in icon, colour
 * and wording. One cell means one answer to the questions that were being
 * answered six slightly different ways: how tall is the icon, how much padding
 * is there, what happens to a value too long for its column.
 *
 * LONG VALUES TRUNCATE AND KEEP THE FULL TEXT ON HOVER. These fields hold
 * customer names, addresses and GST numbers, none of which has a bound. The
 * old cards used `line-clamp-2`, which silently cut the tail off a long value
 * with no way to see the rest and made the whole row two lines tall whenever
 * one field wrapped. `min-w-0` on the text column is what lets `truncate`
 * work inside a flex row at all.
 *
 * `children` takes over from `value` for the one cell that is interactive —
 * the PO number, which carries an inline editor.
 */
const FACT_TONES = {
  blue: "bg-blue-50 text-blue-600",
  violet: "bg-violet-50 text-violet-600",
  emerald: "bg-emerald-50 text-emerald-600",
  indigo: "bg-indigo-50 text-indigo-600",
  sky: "bg-sky-50 text-sky-600",
};

const Fact = ({ icon: Icon, tone = "blue", label, value, hint, children }) => (
  <div className="border-b border-r border-slate-200 px-3 py-2.5 flex items-start gap-2.5 min-w-0">
    <span className={`w-6 h-6 mt-0.5 rounded-full flex items-center justify-center shrink-0 ${FACT_TONES[tone]}`}>
      <Icon size={13} />
    </span>
    <div className="min-w-0 flex-1">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
      {children ?? (
        <p className="text-sm font-bold text-slate-800 truncate" title={value || undefined}>
          {value}
        </p>
      )}
      {hint && (
        <p className="text-[10px] text-slate-500 truncate" title={hint}>{hint}</p>
      )}
    </div>
  </div>
);


import { motion, AnimatePresence } from "framer-motion";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useUserStore } from "../../store/userStore";
import { useBusyAction } from "../../hooks/useBusyAction";
import { useCartStore } from "../../store/cartStore";
import { StatusBadge } from "../ui/StatusBadge";
import { CodeValue } from "../ui/CodeValue";
import { PoStatusBadge } from "../ui/PoStatusBadge";
import { ERPButton } from "../ui/ERPButton";
import { OrderTimeline } from "../cards/OrderTimeline";
import { BookingBifurcation } from "../common/BookingBifurcation";
import { useShowMsilCode } from "../../hooks/useShowMsilCode";
import { canViewLineItemBoxNo, canEditBookingQuantity, canCancelBookings, hasPermission, PERMISSIONS, canUseSalesDesk } from "../../utils/permissions";
import { BookingScheduleSection } from "./BookingScheduleSection";
import { usePagination } from "../../hooks/usePagination";
import { Pagination } from "../ui/Pagination";
import { PackageX, Receipt } from "lucide-react";
import toast from "react-hot-toast";
import { PicklistPreview } from "../pricing/PicklistPreview";
import { picklistFromCustomerOrder, allocationPicklistFromCustomerOrder } from "../../utils/picklistDocument";
import { AllocationsSection } from "./AllocationsSection";
import { stageLabel, AMENDABLE_STATUSES } from "../../constants/bookingLifecycle";
import { formatDisplayDate } from "../../utils/dateValue";

export const OrderDrawer = () => {
  const {
    selectedOrder,
    setSelectedOrder,
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
    refreshSelected,
  } = useOrderHistoryStore();
  const { user } = useUserStore();
  const { pendingItems, fetchPendingReservations, ensurePendingReservations } = useCartStore();
  const showMsilCode = useShowMsilCode();
  // This drawer is also the customer's own order-history view, so the box
  // number is limited to the desk that acts on the booking.
  const showBoxNo = canViewLineItemBoxNo(user);
  // Customer columns/filters/cards follow the sales-desk cell (view_all_bookings),
  // not the Super Admin role name: staff granted every booking need to see whose it is.
  const seesCustomers = canUseSalesDesk(user);
  // The status, PO and resend controls below call routes guarded by
  // manage_orders, so they are offered on that key rather than on the role
  // name — a role granted it in Roles & Permissions gets the controls too.
  const mayManageOrders = hasPermission(user, PERMISSIONS.MANAGE_ORDERS);

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
  const { run: runExport, isBusy: isExporting } = useBusyAction();
  const [showPicklist, setShowPicklist] = useState(false);
  // An inward allocation's own pick list, when one is open.
  const [allocationDoc, setAllocationDoc] = useState(null);

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

  // Indents, so the drawer can show the ones tied to this booking's PO. The
  // history page has normally just loaded them, so opening a booking reuses a
  // list read in the last few seconds instead of downloading every indent again
  // per click. Anything done FROM this drawer that can change indents (quantity
  // save, PO, cancellation) re-reads it explicitly below.
  useEffect(() => {
    if (selectedOrder) ensurePendingReservations();
  }, [selectedOrder?.orderNumber, ensurePendingReservations]);

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

  // Cancellable at any stage, PO or not (decided 2026-10-19): the server puts
  // every unit back into stock and closes the booking's open indent. Staff
  // only — a customer is never offered it (2026-10-27).
  const canCancel = Boolean(
    selectedOrder && selectedOrder.status !== "Cancelled" && canCancelBookings(user),
  );

  // Who may amend quantities here, and when. Staff follow the desk rules;
  // the customer may revise their own booking until the PO is raised. The
  // server re-checks both on every write, answering 423 once the booking is
  // locked and 404 for a booking that is not the caller's.
  //
  // `amendable` is derived from the booking's STATUS rather than read off the
  // payload, because this screen's adapter predates the field. Once the goods
  // have gone the quantities are closed to everyone — the server answers 409
  // regardless, and offering the control would only produce one.
  const canEditQty = canEditBookingQuantity(user, {
    locked: poRaised,
    amendable: AMENDABLE_STATUSES.includes(selectedOrder?.status),
  });
  const isStaff = hasPermission(user, PERMISSIONS.VIEW_ALL_BOOKINGS);

  // Only this booking's history — the store holds one booking's at a time and
  // a stale one would put the wrong badge on the wrong order.
  const qtyHistory =
    quantityHistoryFor === selectedOrder?.orderNumber ? quantityHistory : null;
  const qtyEntries = qtyHistory?.entries || [];

  // The quantity a line is currently showing: the pending edit if it has one,
  // otherwise what the booking holds. This is the line's TOTAL — confirmed
  // plus indent — because that is what the edit endpoint takes: "make this
  // line 15" means fifteen units for the customer, however stock splits them.
  const savedQtyOf = (item) =>
    (item.confirmedQty ?? item.orderQuantity ?? 0) + (item.pendingQty ?? 0);
  const qtyOf = (item) =>
    draftQty[item.lineId] !== undefined ? draftQty[item.lineId] : savedQtyOf(item);

  const lineChange = (item) => qtyOf(item) - savedQtyOf(item);
  const dirty = lineItems.some((item) => lineChange(item) !== 0);
  const hasIndent = lineItems.some((item) => (item.pendingQty ?? 0) > 0);
  const hasDispatchDate = lineItems.some((item) => item.scheduledDate);
  // What the CUSTOMER asked for across the booking, indent included.
  const totalBooked = lineItems.reduce((n, i) => n + (i.bookedQty ?? 0), 0);
  const totalIndent = lineItems.reduce((n, i) => n + (i.pendingQty ?? 0), 0);

  /**
   * WHICH COLUMN ABSORBS THE LEFTOVER WIDTH.
   *
   * A `w-full` table shares its spare width out between every column, so five
   * short columns in a wide drawer became five islands with voids between
   * them. Every column here holds a code, a date or a number — none of them
   * WANTS to be wide — so the slack has to be parked somewhere deliberate
   * rather than spread evenly.
   *
   * It goes on the LAST IDENTIFIER column, which puts the gap between the
   * identifiers and the figures: codes tight on the left, quantities tight on
   * the right, one gutter down the middle. That is how the row is actually
   * read — which part, which box, how many — and it is the only place a gap
   * carries meaning rather than just existing.
   *
   * Computed rather than hardcoded because the identifier columns are
   * conditional: MSIL Code is shown only to users it applies to, Box No only
   * to staff. Whichever of them is last takes the width; with neither, the SKU
   * column takes it.
   */
  const growCol = showBoxNo ? "box" : showMsilCode ? "msil" : "sku";
  const grow = (col) => (growCol === col ? "w-full" : "w-px");

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
      // An increase that outran stock becomes an indent; the list must show it.
      fetchPendingReservations();
      // An increase that outran stock was split: the covered part stayed on
      // the booking, the rest became an indent. Say so — a plain "updated"
      // would read as the full quantity having been confirmed.
      const splits = (res.changes || []).filter((c) => c.type === "quantity-split");
      if (splits.length) {
        toast.success(
          splits
            .map((s) => `${s.skuCode}: set to ${s.toQty} — ${s.confirmed} confirmed, ${s.indentQty} on indent (stock short).`)
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
    // floor, so the delivery location and its phone number ride on it — always
    // both lines, with an em dash when unknown, so a missing value is VISIBLY
    // missing rather than the field silently absent from the form.
    const meta = [
      `Location: ${selectedOrder.location || "—"}`,
      `Phone: ${selectedOrder.phoneNumber || "—"}`,
    ];
    return { rows, columns, title, meta };
  };

  // Busy while the bundle loads and the document is built — see useBusyAction.
  const handlePrint = () => runExport("print", async () => {
    const { rows, columns, title, meta } = buildExport();
    const { printData } = await import("../../utils/exportUtils");
    return printData(rows, columns, title, meta);
  }, { error: "Unable to open print window (check pop-up blocker)." });

  const handlePDF = () => runExport("pdf", async () => {
    const { rows, columns, title, meta } = buildExport();
    const { exportToPDF } = await import("../../utils/exportUtils");
    return exportToPDF(rows, columns, title, selectedOrder.orderNumber || "Booking", meta);
  }, { error: "PDF download failed" });

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
                {/* The purchase order as a document, with the price that was
                    agreed on it. Offered only once the PO has been raised —
                    before that there is no purchase order to preview, and no
                    price has been given. */}
                {poRaised && (
                  <ERPButton
                    variant="outline"
                    size="sm"
                    className="hidden sm:flex"
                    onClick={() => setShowPicklist(true)}
                  >
                    <Receipt size={16} className="mr-2" /> PO Preview
                  </ERPButton>
                )}
                <ERPButton variant="outline" size="sm" className="hidden sm:flex" onClick={handlePrint} loading={isExporting("print")}>
                  {!isExporting("print") && <Printer size={16} className="mr-2" />} Print
                </ERPButton>
                <ERPButton variant="outline" size="sm" className="hidden sm:flex" onClick={handlePDF} loading={isExporting("pdf")}>
                  {!isExporting("pdf") && <Download size={16} className="mr-2" />} PDF
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
            {/* ── Booking facts ────────────────────────────────────────────
                ONE PANEL, NOT SIX CARDS.

                This was a three-column grid of six separate cards, each with
                its own border, its own 16px padding and its own 32px avatar
                circle. Two things made it waste most of its height:

                  • Grid cells stretch to the tallest in the row. "Customer"
                    holds one line and sat next to "Customer master details",
                    which holds five — so a one-line field was rendered 170px
                    tall, almost all of it empty.
                  • Every field got an equal third of the width whatever it
                    held, so a 10-character date claimed as much room as a GST
                    number, a shop name and a vendor code together.

                It is now one bordered panel whose cells are divided by
                hairlines. Six borders become one, six paddings become one
                grid, and the stretching that remains is between cells of
                genuinely similar height.

                THE DIVIDERS ARE CELL BORDERS, NOT A `gap-px` BACKGROUND. The
                gap trick — a slate background showing through 1px gaps — is
                shorter to write and wrong here: the fields are conditional, so
                the last row is usually part-filled, and an empty grid cell has
                nothing to paint over the background. It rendered as a grey
                block in the corner of the panel. Borders on the cells instead
                mean an empty cell is simply empty. The grid is pulled 1px
                right and down inside an `overflow-hidden` panel so the final
                column's and row's borders are clipped rather than doubling up
                against the panel's own.

                Field widths follow content: the five short facts share a
                responsive 1/2/3-column grid, and the master details — the only
                multi-value field — spans the full width underneath, laying its
                pairs out side by side instead of stacking five rows deep.

                UI only. Every value, condition and permission below is exactly
                what it was. */}
            <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm bg-white">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 -mr-px -mb-px">

                {/* Moved out of the header, where it was one badge among four
                    and said less than it could. Here it has room to name the
                    indent the booking came from. */}
                {selectedOrder.autoBooked && (
                  <Fact
                    icon={Sparkles}
                    tone="emerald"
                    label="Raised automatically"
                    value={`From indent ${selectedOrder.autoBookedFrom || "—"}`}
                    hint="when the stock came back in"
                  />
                )}

                {seesCustomers && (
                  <Fact
                    icon={User}
                    tone="blue"
                    label="Customer"
                    value={selectedOrder.customer}
                  />
                )}

                {/* Who placed the booking on the customer's behalf (the SI
                    Team), as stored on the booking. Shown to everyone, the
                    customer included: it is their booking, and they are told
                    who made it. Absent on a booking the customer placed
                    themselves. */}
                {selectedOrder.siTeam && (
                  <Fact
                    icon={User}
                    tone="violet"
                    label="Booked by (SI Team)"
                    value={selectedOrder.siTeam}
                    hint={selectedOrder.siTeamRole && `${selectedOrder.siTeamRole} · Shraddha Impex`}
                  />
                )}

                {/* Delivery location and its phone number — the pair the pick
                    list prints, shown here so it can be checked before
                    printing. */}
                {(selectedOrder.location || selectedOrder.phoneNumber) && (
                  <Fact
                    icon={MapPin}
                    tone="emerald"
                    label="Location & Phone"
                    value={selectedOrder.location || "—"}
                    hint={selectedOrder.phoneNumber}
                  />
                )}

                <Fact icon={Hash} tone="indigo" label="PO Number">
                  {isEditingPO ? (
                    <div className="flex items-center gap-1.5 mt-1">
                      <input
                        type="text"
                        value={newPO}
                        onChange={(e) => setNewPO(e.target.value)}
                        className="w-full min-w-0 text-sm border border-slate-300 rounded px-2 py-1 outline-none focus:border-indigo-500 font-semibold text-slate-800"
                        placeholder="Enter PO No..."
                        autoFocus
                      />
                      <button onClick={handleSavePO} disabled={busy} className="shrink-0 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-2 py-1.5 rounded">Save</button>
                      <button onClick={() => setIsEditingPO(false)} disabled={busy} className="shrink-0 text-xs font-bold text-slate-500 bg-slate-100 hover:bg-slate-200 px-2 py-1.5 rounded">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-bold text-slate-800 truncate" title={selectedOrder.poNumber || undefined}>
                        {selectedOrder.poNumber || "-"}
                      </p>
                      {/* Once the PO exists the booking is locked; only an
                          Admin may change it, and the server enforces this
                          regardless. */}
                      {mayManageOrders && (
                        <button
                          onClick={() => {
                            setNewPO(poRaised ? selectedOrder.poNumber : "");
                            setIsEditingPO(true);
                          }}
                          className="shrink-0 text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded hover:bg-indigo-100 whitespace-nowrap"
                        >
                          {poRaised ? "Edit" : "Raise PO"}
                        </button>
                      )}
                    </div>
                  )}
                </Fact>

                <Fact
                  icon={CalendarIcon}
                  tone="violet"
                  label="Booking Date"
                  value={new Date(selectedOrder.date).toLocaleDateString()}
                />

                {/* The customer's registered master details, from User
                    Management. Read live, so anything an admin fills in there
                    appears on past bookings too.

                    Kept SEPARATE from the delivery pair above, which is the
                    booking's own snapshot and may deliberately differ once a
                    PO quotes a different address. Showing one in place of the
                    other is how a desk ships to the wrong place.

                    Full width, because it is the one field holding several
                    values: given a third of a row it stacked five label/value
                    pairs vertically and set the height of everything beside
                    it. Across the whole width the same five pairs sit two or
                    three abreast in two short rows.

                    `border-t` as well as `border-b`: the row of short facts
                    above is usually part-filled — there are five of them in a
                    three-column grid — and an empty cell draws no border, so
                    the divider under that row stopped halfway across. This
                    cell's own top border carries the line the rest of the way.
                    A part-filled row at the BOTTOM of the panel needs no such
                    help: those are the borders the `-mb-px` clips. */}
                {selectedOrder.customerProfile && (
                  selectedOrder.customerProfile.location
                  || selectedOrder.customerProfile.phone
                  || selectedOrder.customerProfile.gstNumber
                  || selectedOrder.customerProfile.shopNumber
                  || selectedOrder.customerProfile.vendorNumber
                ) && (
                  <div className="sm:col-span-2 lg:col-span-3 border-t border-b border-r border-slate-200 px-3 py-2.5">
                    <div className="flex items-start gap-2.5">
                      <span className="w-6 h-6 mt-0.5 rounded-full bg-sky-50 flex items-center justify-center shrink-0">
                        <User size={13} className="text-sky-600" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                          Customer master details
                        </p>
                        {/* A wrapping grid rather than a stack: the pairs are
                            independent facts, so they read as well side by
                            side and take a fraction of the height. */}
                        <dl className="mt-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-0.5 text-xs">
                          {[
                            ['Location', selectedOrder.customerProfile.location],
                            ['Phone', selectedOrder.customerProfile.phone],
                            ['Shop No.', selectedOrder.customerProfile.shopNumber],
                            ['Vendor No.', selectedOrder.customerProfile.vendorNumber],
                            ['GST No.', selectedOrder.customerProfile.gstNumber],
                          ].filter(([, v]) => v).map(([label, value]) => (
                            <div key={label} className="flex gap-2 min-w-0">
                              <dt className="text-slate-400 font-semibold w-[4.5rem] shrink-0">{label}</dt>
                              {/* Truncated with the full value on hover: a GST
                                  number wrapping onto a second line was what
                                  made this block tall in the first place. */}
                              <dd className="text-slate-700 font-semibold truncate min-w-0" title={value}>
                                {value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    </div>
                  </div>
                )}

              </div>
            </div>

            {/* The booking quantity split, as the server derived it. Rendered
                above the line items because it is the answer to the first
                question a customer asks of a part-fulfilled booking — how much
                of this do you actually have — and the per-line table below is
                the detail behind it, not the other way round.

                Null on a response from a server that does not send it, in
                which case nothing is rendered rather than a guess. */}
            {selectedOrder.bifurcation && (
              <div className="mb-6">
                <BookingBifurcation bifurcation={selectedOrder.bifurcation} />
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              {/* Main Content */}
              <div className="lg:col-span-2 flex flex-col gap-6">
                {/* Product Table */}
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                  <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
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
                      {/* `w-px` on a nowrap cell is "as narrow as the content
                          allows" — the column shrinks to fit and the one marked
                          `w-full` by grow() takes everything left over. */}
                      <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                        <tr>
                          <th className={`px-4 py-2.5 ${grow("sku")}`}>SKU Code</th>
                          {/* MSIL Code replaces the old Product Name column, which
                              only ever rendered a placeholder like "Koken Product".
                              Shown only to users MSIL codes apply to — the same rule
                              used everywhere else (utils/msilVisibility on the server). */}
                          {showMsilCode && <th className={`px-4 py-2.5 ${grow("msil")}`}>MSIL Code</th>}
                          {/* Beside the codes and before the quantity, so the row
                              reads the way it is picked: which part, which box,
                              how many. */}
                          {showBoxNo && <th className={`px-4 py-2.5 ${grow("box")}`}>Box No</th>}
                          {/* The figures are right-aligned and content-width, so
                              they line up as one block against the right edge
                              instead of floating in the middle of columns three
                              times wider than the numbers in them. */}
                          <th className="px-4 py-2.5 w-px text-right">Booked</th>
                          <th className="px-4 py-2.5 w-px text-right">Qty</th>
                          {canEditQty && <th className="px-4 py-2.5 w-px text-right">Change</th>}
                          {hasIndent && <th className="px-4 py-2.5 w-px text-right">Indent</th>}
                          {/* The line's dispatch date: 3 days after booking by
                              default, or what the desk set. The same value the
                              confirmation and schedule emails show. */}
                          {hasDispatchDate && <th className="px-4 py-2.5 w-px text-right">Dispatch Date</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm">
                        {linePaging.pageItems.map((item, idx) => (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className={`px-4 py-2.5 font-bold text-slate-800 ${grow("sku")}`}>
                              <CodeValue value={item.product.code} />
                            </td>
                            {showMsilCode && (
                              <td className={`px-4 py-2.5 ${grow("msil")}`}>
                                <CodeValue value={item.product.msilCode} tone="muted" />
                              </td>
                            )}
                            {showBoxNo && (
                              <td className={`px-4 py-2.5 font-mono font-bold text-slate-700 ${grow("box")}`}>
                                {item.product.boxNo || (
                                  <span className="font-sans font-normal text-slate-400">—</span>
                                )}
                              </td>
                            )}
                            {/* What the customer originally asked for. Read-only
                                everywhere: a stock shortfall or a desk edit moves
                                the Qty beside it, never this. */}
                            <td className="px-4 py-2.5 w-px text-right font-medium text-slate-500 tabular-nums">
                              {item.bookedQty ?? item.orderQuantity}
                            </td>
                            <td className="px-4 py-2.5 w-px text-right font-bold text-slate-700 tabular-nums">
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
                                  className="w-16 text-right border border-slate-300 rounded-lg px-2 py-1 text-sm font-bold text-slate-800 tabular-nums outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                                />
                              ) : (
                                <>
                                  {item.orderQuantity} {item.product.unit}
                                </>
                              )}
                            </td>
                            {canEditQty && (
                              <td className="px-4 py-2.5 w-px text-right text-xs font-bold tabular-nums">
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
                              <td className="px-4 py-2.5 w-px text-right font-bold tabular-nums">
                                {(item.pendingQty ?? 0) > 0 ? (
                                  <span className="text-amber-600">{item.pendingQty}</span>
                                ) : (
                                  <span className="text-slate-300">&mdash;</span>
                                )}
                              </td>
                            )}
                            {hasDispatchDate && (
                              <td className="px-4 py-2.5 w-px text-right text-sm font-semibold text-slate-700">
                                {item.scheduledDate ? (
                                  formatDisplayDate(new Date(item.scheduledDate))
                                ) : (
                                  <span className="font-normal text-slate-300">&mdash;</span>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {canEditQty && (
                    <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50/60 flex items-center justify-between gap-3 flex-wrap">
                      <p className="text-[11px] text-slate-500 leading-snug max-w-md">
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
                    <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50/50">
                      <Pagination
                        page={linePaging.page}
                        pageSize={PAGE_SIZE}
                        totalItems={linePaging.total}
                        onPageChange={linePaging.setPage}
                      />
                    </div>
                  )}
                </div>

                {/* Stock that arrived later against this booking's indent, each
                    receipt with its own status and pick list. */}
                <AllocationsSection
                  lines={(selectedOrder.lineItems || []).map((l) => ({ ...l, lineId: l.id }))}
                  // Allocation stages are moved on the Sales Desk; here they are only shown.
                  onViewPicklist={picklistFromCustomerOrder(selectedOrder)
                    ? (batch) => setAllocationDoc(allocationPicklistFromCustomerOrder(selectedOrder, batch))
                    : undefined}
                />

                {/* Delivery schedule — sits under the lines because it is about
                    those lines, matching where Indent History puts its twin.

                    Gated on the SAME permission the endpoint enforces
                    (`manage_orders`), so the control is never offered to someone
                    whose save would be refused. The indent equivalent uses a
                    bare isSuperAdmin check; this follows the rest of
                    order.routes.js instead, which is permission-based — and any
                    admin satisfies it through the wildcard regardless. */}
                {hasPermission(user, PERMISSIONS.MANAGE_ORDERS) && (
                  <BookingScheduleSection
                    orderId={selectedOrder.orderNumber}
                    lines={selectedOrder.lineItems || []}
                    onSaved={() => refreshSelected(selectedOrder.orderNumber)}
                  />
                )}

                {/* Indents tied to this booking (matched by PO number) */}
                {bookingIndents.length > 0 && (
                  <div className="bg-white border border-amber-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                    <div className="px-4 py-3 border-b border-amber-100 flex items-center gap-2 bg-amber-50/50">
                      <PackageX size={18} className="text-amber-500" />
                      <h3 className="text-sm font-bold text-slate-800">
                        Indents ({bookingIndents.length})
                      </h3>
                    </div>
                    <div className="overflow-x-auto">
                      {/* Same column rule as Line Items above: codes tight on
                          the left, the quantity tight on the right, the spare
                          width in one gutter between them rather than shared
                          out between three short columns. The two tables sit
                          one above the other in this drawer, so a different
                          answer in each would read as a mistake. */}
                      <table className="w-full text-left whitespace-nowrap">
                        <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                          <tr>
                            <th className={`px-4 py-2.5 ${showMsilCode ? "w-px" : "w-full"}`}>SKU Code</th>
                            {showMsilCode && <th className="px-4 py-2.5 w-full">MSIL Code</th>}
                            <th className="px-4 py-2.5 w-px text-right">Qty</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-sm">
                          {indentPaging.pageItems.map((p) => (
                            <tr key={p._id} className="hover:bg-slate-50">
                              <td className={`px-4 py-2.5 ${showMsilCode ? "w-px" : "w-full"}`}>
                                <CodeValue value={p.product.code} />
                              </td>
                              {showMsilCode && (
                                <td className="px-4 py-2.5 w-full">
                                  <CodeValue value={p.product.msilCode} tone="muted" />
                                </td>
                              )}
                              <td className="px-4 py-2.5 w-px text-right font-black text-amber-600 tabular-nums">
                                {p.pendingQuantity}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="px-4 py-2.5 border-t border-amber-100 bg-amber-50/30">
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
                      showNotifications={mayManageOrders}
                      onResend={handleResend}
                      resendingId={resendingEventId}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer — the booking's stage, shown. It is moved on the Sales
              Desk (BookingStatusControl), not here. */}
          <div className="px-6 py-4 bg-white border-t border-slate-200 flex items-center justify-between gap-4 shrink-0">
            <span className="text-xs text-slate-400 font-medium">
              Status:{" "}
              <span className="font-bold text-slate-600">{stageLabel(selectedOrder.status)}</span>
            </span>

            {/* Booking status is managed on the Sales Desk (decided 2026-10-19);
                here it is only shown. */}
            {mayManageOrders && (
              <span className="text-[11px] text-slate-400">Status is updated from the Sales Desk.</span>
            )}
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
                    released back into available stock, where anyone can book them
                    {poRaised ? " — the PO has been raised, so they are taken back into inventory" : ""}
                    . Any items still waiting on this booking's indent are cancelled too. To order
                    these again you would need to place a fresh booking.
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

        {/* The purchase order document. Built from what the server sent, so an
            unpriced PO — or one this reader is not entitled to see the rate on
            — renders the same paper with no money columns rather than a broken
            one. */}
        {allocationDoc && (
          <PicklistPreview
            doc={allocationDoc}
            onClose={() => setAllocationDoc(null)}
            onDownload={async (docModel) => {
              const { downloadPicklistPdf } = await import("../../utils/picklistPdf");
              return downloadPicklistPdf(docModel);
            }}
          />
        )}

        {showPicklist && (
          <PicklistPreview
            doc={picklistFromCustomerOrder(selectedOrder)}
            onClose={() => setShowPicklist(false)}
            onDownload={async (docModel) => {
              const { downloadPicklistPdf } = await import("../../utils/picklistPdf");
              return downloadPicklistPdf(docModel);
            }}
          />
        )}
      </div>
    </AnimatePresence>
  );
};
