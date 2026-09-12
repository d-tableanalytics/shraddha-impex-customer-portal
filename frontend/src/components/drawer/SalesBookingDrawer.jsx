import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, User, Hash, Calendar as CalendarIcon, Package, Lock, Timer,
  Plus, Trash2, Save, FileCheck2, Loader2, RotateCcw, AlertTriangle, Download, FileText,
  MapPin, Receipt, IndianRupee, Pencil, GripVertical, SlidersHorizontal,
} from "lucide-react";
import toast from "react-hot-toast";
import { useSalesStore } from "../../store/salesStore";
import { useUserStore } from "../../store/userStore";
import { ERPButton } from "../ui/ERPButton";
import { PoStatusBadge } from "../ui/PoStatusBadge";
import { PoCountdown } from "../ui/PoCountdown";
import { ProductSearchDropdown } from "../ui/ProductSearchDropdown";
import { CodeValue } from "../ui/CodeValue";
import { BookingDetailsModal } from "../modal/BookingDetailsModal";
import { canEditBooking, canRaisePo, canViewLineItemBoxNo, canViewPricing, hasPermission, PERMISSIONS } from "../../utils/permissions";
import { PoConfirmModal } from "../modal/PoConfirmModal";
import { PicklistPreview } from "../pricing/PicklistPreview";
import { PriceTypeSelector } from "../pricing/PriceTypeSelector";
import { picklistFromSalesBooking } from "../../utils/picklistDocument";
import { formatRupees, withGst, GST_LABEL } from "../../constants/pricing";

// Local editable copy of the booking's lines. `id` present = existing row.
//
// `boxNo` rides along read-only: the desk never sets it, it is derived from the
// SKU. The server sends the CURRENT mapping while the PO is pending and the
// stamped one once it is raised, so what is shown here is always the box the
// PO will quote.
const toDraft = (booking) =>
  (booking?.lines || []).map((l) => ({
    id: l.id,
    skuCode: l.skuCode,
    msilCode: l.msilCode,
    boxNo: l.boxNo,
    // The line's TOTAL — confirmed plus indent — because that is what the
    // edit endpoint takes: "make this line 15" means fifteen units for the
    // customer, however stock splits them.
    quantity: (l.confirmedQty || 0) + (l.pendingQty || 0),
  }));

export const SalesBookingDrawer = () => {
  const { selected, close, saveItems, raisePo, setPricing, reorderLines, saving } = useSalesStore();
  const { user } = useUserStore();

  const [draft, setDraft] = useState([]);
  const [poInput, setPoInput] = useState("");
  const [showPoBox, setShowPoBox] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showPicklist, setShowPicklist] = useState(false);
  // Whether the tier picker is open. Closed by default on both sides of the PO:
  // before it, because the ordinary path is still to choose the rate in the PO
  // dialog and this is the desk checking what each tier totals; after it,
  // because a raised PO is priced already and this is the correction.
  const [repricing, setRepricing] = useState(false);
  // Admin-only correction of the submitted customer/order details.
  const [editingDetails, setEditingDetails] = useState(false);
  // Which line is being dragged, and which row the pointer is over.
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  // `selected` is only replaced on an explicit select / save / raise-PO, so this
  // resyncs the draft with server truth after a write without clobbering
  // in-progress edits on unrelated store updates.
  useEffect(() => {
    setDraft(toDraft(selected));
    setShowPoBox(false);
    setPoInput("");
    setShowModal(false);
    setShowPicklist(false);
    setRepricing(false);
    setEditingDetails(false);
    setDragIdx(null);
    setDragOverIdx(null);
  }, [selected]);

  if (!selected) return null;

  const locked = selected.locked;
  const editable = canEditBooking(user, selected);
  const showBoxNo = canViewLineItemBoxNo(user);
  const mayRaise = canRaisePo(user, selected);
  const mayPrice = canViewPricing(user);
  const pricing = selected.pricing || null;
  // Subtotal, GST and payable total, from the one shared helper.
  const money = withGst(pricing?.totalAmount ?? null);
  const isOverride = locked && hasPermission(user, PERMISSIONS.OVERRIDE_PO_LOCK);
  /**
   * Correcting submitted details is Admin-only, and the server enforces it with
   * the same key. Hiding the button from Sales is a courtesy so nobody clicks
   * into a 403 - it is not the guard.
   */
  const mayEditDetails = hasPermission(user, PERMISSIONS.OVERRIDE_PO_LOCK);

  const dirty =
    JSON.stringify(draft.map(({ id, skuCode, quantity }) => ({ id: id || null, skuCode, quantity }))) !==
    JSON.stringify(toDraft(selected).map(({ id, skuCode, quantity }) => ({ id: id || null, skuCode, quantity })));

  const setLine = (idx, patch) =>
    setDraft((d) => d.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const removeLine = (idx) => setDraft((d) => d.filter((_, i) => i !== idx));
  const addLine = () =>
    setDraft((d) => [...d, { id: null, skuCode: "", msilCode: null, boxNo: null, quantity: 1 }]);

  /**
   * Reordering the lines to match the customer's paper PO.
   *
   * ── DRAG AND DROP, WITH THE KEYBOARD STILL WORKING ─────────────────────
   * The handle is draggable, and it is also a focusable button that responds
   * to the arrow keys. Native HTML5 drag is mouse-only and exposes nothing to
   * a screen reader, so a drag-only implementation would take the feature away
   * from anyone not using a mouse. The arrow keys are not a second UI - there
   * are no visible buttons - they are the same handle, reachable another way.
   *
   * ── NATIVE, NOT A LIBRARY ──────────────────────────────────────────────
   * The list is one booking's lines, it does not nest, and it does not scroll
   * independently. That is the case native drag handles well, and a dependency
   * for it would be weight the brief explicitly asked us not to add.
   *
   * ── THE DROP IS WHAT PERSISTS ──────────────────────────────────────────
   * `dragOverIdx` moves a preview while the pointer travels; nothing is sent
   * until the drop. One request per rearrangement, not one per row crossed.
   *
   * Blocked while there are unsaved line edits, the same rule pricing follows:
   * the reorder response replaces `selected`, which re-derives the draft and
   * would silently discard them.
   */
  const reorderable = editable && !dirty && !saving;

  /** Persist a specific order of the CURRENT lines. */
  const persistOrder = async (lines) => {
    const ids = lines.map((l) => l.id);
    // A line that has never been saved has no id for the server to order.
    // Unreachable while `reorderable` is false, but a null would come back as
    // "does not match this booking", which is a confusing way to learn that.
    if (ids.some((id) => !id)) {
      return toast.error("Save the new lines before rearranging them.");
    }
    const res = await reorderLines(selected.orderId, ids);
    if (!res.success) toast.error(res.error);
  };

  /** Move the line at `from` so it sits at `to`, and save. */
  const moveLineTo = async (from, to) => {
    if (from === to || to < 0 || to >= draft.length) return;
    const next = [...draft];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // Optimistic, so the row lands where it was dropped instead of snapping
    // back for the length of the round trip. `selected` replaces it on success
    // and re-derives it from server truth on failure.
    setDraft(next);
    await persistOrder(next);
  };

  const onDragStart = (idx) => (e) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    // Firefox refuses to start a drag unless some data is set.
    e.dataTransfer.setData("text/plain", String(idx));
  };

  const onDragOver = (idx) => (e) => {
    // Without preventDefault the browser treats the row as an invalid target
    // and no drop event ever fires.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (idx !== dragOverIdx) setDragOverIdx(idx);
  };

  const onDrop = (idx) => async (e) => {
    e.preventDefault();
    const from = dragIdx;
    setDragIdx(null);
    setDragOverIdx(null);
    if (from === null) return;
    await moveLineTo(from, idx);
  };

  /** Dropped outside a row, or cancelled with Escape. */
  const onDragEnd = () => {
    setDragIdx(null);
    setDragOverIdx(null);
  };

  /** The handle is a button too, so the list is operable without a mouse. */
  const onHandleKeyDown = (idx) => (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    // The row scrolls the drawer otherwise, which moves the list out from
    // under the person rearranging it.
    e.preventDefault();
    moveLineTo(idx, idx + (e.key === "ArrowUp" ? -1 : 1));
  };

  // Rearranging is an amendment, so it follows the same lock as one.
  const mayReorder = editable && draft.length > 1;

  const handleSave = async () => {
    if (draft.length === 0) return toast.error("A booking must keep at least one line.");
    for (const l of draft) {
      if (!l.skuCode) return toast.error("Every line needs a SKU.");
      if (!Number.isInteger(Number(l.quantity)) || Number(l.quantity) <= 0) {
        return toast.error(`Quantity for ${l.skuCode} must be a whole number above zero.`);
      }
    }
    const res = await saveItems(selected.orderId, draft.map((l) => ({
      id: l.id || undefined, skuCode: l.skuCode, quantity: Number(l.quantity),
    })));
    if (res.success) {
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
        toast.success(res.changes.length ? `Booking updated — inventory adjusted.` : "No changes to save.");
      }
    } else {
      toast.error(res.error);
    }
  };

  /**
   * Rows and columns for BOTH exports, built once.
   *
   * Exports the DRAFT — what is on screen — rather than the last saved state,
   * so a file always matches the table it came from. With unsaved edits pending
   * those two differ, which is why the buttons say so.
   *
   * Columns mirror the visible ones, Box No included only when the viewer is
   * allowed to see it: a downloaded pick list must not carry a column the same
   * user cannot see on screen. Excel and PDF share this, because two formats
   * differing in content is a bug nobody notices until someone compares files.
   */
  const buildExport = () => {
    const rows = draft.map((l, i) => ({
      sr: i + 1,
      skuCode: l.skuCode || "-",
      msilCode: l.msilCode || "-",
      boxNo: l.boxNo || "-",
      quantity: Number(l.quantity) || 0,
    }));
    const columns = [
      { key: "sr", label: "S.No" },
      { key: "skuCode", label: "SKU Code" },
      { key: "msilCode", label: "MSIL Code" },
      ...(showBoxNo ? [{ key: "boxNo", label: "Box No" }] : []),
      { key: "quantity", label: "Quantity" },
    ];
    const title = `Booking ${selected.orderId}${selected.customer ? ` — ${selected.customer}` : ""}`;
    // Reference lines under the title. The pick list travels to the warehouse
    // floor, so the delivery location and its phone number ride on it — always
    // both lines, with an em dash when unknown, so a missing value is VISIBLY
    // missing rather than the field silently absent from the form.
    const meta = [
      `Location: ${selected.location || "—"}`,
      `Phone: ${selected.phoneNumber || "—"}`,
    ];
    return { rows, columns, title, meta };
  };

  // Loaded on demand: the xlsx/jspdf bundles are large and most visits to this
  // drawer never download anything.
  const handleDownload = () => {
    if (draft.length === 0) return toast.error("Nothing to download — this booking has no lines.");
    const { rows, columns, meta } = buildExport();
    import("../../utils/exportUtils").then(({ exportToExcel }) => {
      const ok = exportToExcel(rows, columns, `Booking_${selected.orderId}`, meta);
      if (ok) toast.success(`Downloaded ${rows.length} line(s).`);
      else toast.error("Download failed.");
    });
  };

  const handleDownloadPdf = async () => {
    if ((selected.lines || []).length === 0) {
      return toast.error("Nothing to download — this booking has no lines.");
    }
    // The PDF is a formal document of the SAVED booking, never the draft —
    // an unsaved edit is not booking data until Save commits it.
    if (dirty) {
      toast("Unsaved edits are not in the PDF — save them first to include them.", { icon: "ℹ️" });
    }
    const { downloadBookingPdf } = await import("../../utils/bookingPdf");
    const ok = await downloadBookingPdf(selected, {
      generatedBy: user?.user || user?.name || user?.email || "Sales Desk",
    });
    if (ok) toast.success(`Booking ${selected.orderId} downloaded as PDF.`);
    else toast.error("PDF download failed.");
  };

  const handleOpenModal = () => {
    setShowModal(true);
  };

  // The document both audiences see. Built from the SAVED booking, never the
  // draft: a picklist showing quantities that are not in the system yet is the
  // kind of paper that gets goods picked wrong.
  const picklist = picklistFromSalesBooking(selected, { showBoxNo });

  const handlePicklistPdf = async (docModel) => {
    const { downloadPicklistPdf } = await import("../../utils/picklistPdf");
    return downloadPicklistPdf(docModel);
  };

  const handleSetPrice = async (priceType) => {
    const res = await setPricing(selected.orderId, priceType);
    if (res.success) {
      setRepricing(false);
      toast.success(
        res.pricing?.priceType
          ? `Priced at the ${res.pricing.priceTypeLabel} rate.`
          : "Pricing removed from this booking.",
      );
    } else {
      toast.error(res.error);
    }
  };

  const handleModalConfirm = async (formData) => {
    const res = await raisePo(selected.orderId, formData);
    if (res.success) {
      toast.success(`PO ${res.poNumber} raised. Booking is now locked.`);
      setShowModal(false);
      setShowPoBox(false);
    } else {
      toast.error(res.error);
    }
  };

  const cellInput =
    "w-full px-2 py-1.5 text-sm border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed";

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex justify-end">
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={close}
          className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm cursor-pointer"
        />
        <motion.div
          initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className="relative w-full max-w-4xl bg-slate-50 h-full shadow-2xl flex flex-col z-10 overflow-hidden"
        >
          {/* Header */}
          <div className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-black text-slate-800">{selected.orderId}</h2>
              <PoStatusBadge locked={locked} poNumber={selected.poNumber} />
              {!locked && <PoCountdown dueAt={selected.poDueAt} />}
            </div>
            <button
              onClick={close}
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors focus:outline-none"
            >
              <X size={24} />
            </button>
          </div>

          {/* Body — the one scroller in the drawer.

              BLOCK FLOW, NOT A FLEX COLUMN, and that is load-bearing. As a
              flex column every card here was a flex item free to SHRINK, and a
              flex item whose own overflow is hidden has an automatic minimum
              size of zero — so the Customer Pricing card (the only card in here
              carrying `overflow-hidden`) absorbed the whole overflow and was
              squeezed to a sliver, its tier picker clipped out of existence
              rather than missing. `space-y-6` gives the same rhythm with every
              child at its natural height, and the scroller does the rest. */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {!locked && selected.poDueAt && (
              <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-200 bg-amber-50/60">
                <Timer size={18} className="text-amber-600 mt-0.5 shrink-0" />
                <div className="text-sm text-amber-900">
                  <p className="font-bold">
                    PO must be raised by {new Date(selected.poDueAt).toLocaleString()}
                  </p>
                  <p className="text-amber-800 mt-0.5">
                    If no PO is raised within {selected.poDeadlineDays ?? 7} days of the booking date,
                    this booking is cancelled automatically and the reserved stock returns to inventory.
                  </p>
                </div>
              </div>
            )}

            {locked && (
              <div className="flex items-start gap-3 p-4 rounded-xl border border-slate-300 bg-slate-100">
                <Lock size={18} className="text-slate-500 mt-0.5 shrink-0" />
                <div className="text-sm text-slate-700">
                  <p className="font-bold">Booking is locked because the PO has already been generated.</p>
                  <p className="text-slate-600 mt-0.5">
                    PO <span className="font-mono font-bold">{selected.poNumber}</span>
                    {selected.poGeneratedAt && ` · raised ${new Date(selected.poGeneratedAt).toLocaleString()}`}
                  </p>
                  {isOverride && (
                    <p className="mt-2 flex items-center gap-1.5 text-amber-700 font-semibold">
                      <AlertTriangle size={14} />
                      You have administrator override — any change here is recorded in the audit trail.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Info cards */}
            {mayEditDetails && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-700">Customer &amp; order details</p>
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    {locked
                      ? "This booking is locked, but these details can still be corrected. Every change is recorded."
                      : "Correct anything Sales captured wrongly. Every change is recorded."}
                  </p>
                </div>
                <button
                  onClick={() => setEditingDetails(true)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary-200 bg-primary-50 px-3 py-1.5 text-xs font-bold text-primary-700 transition-all hover:bg-primary-100"
                >
                  <SlidersHorizontal size={13} /> Edit details
                </button>
              </div>
            )}

            {/*
              ── THE SUMMARY TILES ──────────────────────────────────────────
              Redesigned for the width they actually get. This is a drawer, not
              a page: the content column is ~830px, so five equal tiles left
              each one ~150px, and the old layout spent 44px of that on a
              left-aligned 32px icon plus its gap. "TOTAL QUANTITY" wrapped onto
              two lines, "160 booked · 4 indent" broke mid-phrase, and the tiles
              ended up at three different heights.

              Three changes fix it:

                1. THE ICON MOVED INLINE with the label instead of sitting in a
                   column of its own, so the value gets the tile's full width.
                2. TOTAL QUANTITY SPANS TWO. It is the figure the desk checks
                   against the customer's PO first, and it is the only tile
                   carrying a breakdown line, so it earns the room. The grid is
                   six units at xl: 2 for the total, 1 each for the other four.
                3. LABELS NEVER WRAP. `whitespace-nowrap` on every one, and
                   "Location & Phone" became "Location" with the phone beneath -
                   a label that wraps is what made the row look broken.

              Heights are equalised by `items-stretch` plus `h-full`, so a tile
              with a sub-line no longer makes its neighbours look unfinished.
            */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 items-stretch">
              {/*
                TOTAL BOOKING AMOUNT, GST included.

                ── ONE DOCUMENT-LEVEL RATE, NOT A PER-LINE ONE ──────────────
                `withGst` is the same helper the picklist and the PDF use, and
                its rate is deliberately applied to the subtotal rather than per
                line: this portal holds no HSN code and no per-SKU tax rate -
                only the customer's GSTIN, which is an identifier - so a
                line-level rate would be an invention. Sharing the helper is
                also what stops the screen, the printed page and the PDF quoting
                three different totals.

                ── WHAT THE SUBTOTAL COVERS ─────────────────────────────────
                `pricingSummary` rates CONFIRMED quantity only, because that is
                what the PO charges for - an indent remainder has not shipped
                and is not on it. So this figure can be legitimately lower than
                the line count suggests, and the quantity breakdown moved to the
                footer rather than being dropped.

                ── UNPRICED LINES ARE SAID OUT LOUD ─────────────────────────
                A booking can be part-rated. Showing its total without saying so
                would present a number that looks like the whole booking and is
                not - the same failure mode as a total that silently omitted the
                indent. Nothing priced at all shows a dash, never a confident
                zero.
              */}
              {mayPrice ? (
                <div className="col-span-2 h-full rounded-xl border border-emerald-200 bg-emerald-50/60 p-3.5 shadow-sm">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <IndianRupee size={13} className="text-emerald-700 shrink-0" />
                    <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-800/80 whitespace-nowrap">
                      Total Amount
                    </p>
                  </div>
                  {money.grandTotal == null ? (
                    <>
                      <p className="text-2xl font-black leading-none text-slate-400">—</p>
                      <p className="mt-1.5 text-[11px] text-slate-500">No rate set on this booking</p>
                    </>
                  ) : (
                    <>
                      <p className="text-2xl font-black leading-none text-slate-900 tabular-nums">
                        {formatRupees(money.grandTotal)}
                      </p>
                      <p className="mt-1.5 text-[11px] font-semibold text-slate-500 tabular-nums whitespace-nowrap">
                        {formatRupees(money.subtotal)} + {formatRupees(money.gstAmount)} {GST_LABEL}
                      </p>
                      {pricing?.unpricedLines > 0 && (
                        <p className="mt-0.5 text-[11px] font-bold text-amber-700">
                          Covers {pricing.pricedLines} of{" "}
                          {pricing.pricedLines + pricing.unpricedLines} line(s)
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : (
                /*
                  No pricing rights, so the amount would be a permanent dash.
                  The quantity is the useful figure for this reader instead —
                  confirmed from stock plus what is still open on the indent.

                  NOT confirmed + pendingQty: `pendingQty` is the shortfall
                  frozen onto the order row at confirmation, while the indent is
                  the live balance that shrinks as stock auto-books against it.
                  They are also the same units recorded twice, so adding both
                  double-counts. See bookingTotals() in booking.shape.js.
                */
                <div className="col-span-2 h-full rounded-xl border border-primary-200 bg-primary-50/60 p-3.5 shadow-sm">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Package size={13} className="text-primary-700 shrink-0" />
                    <p className="text-[10px] font-bold uppercase tracking-wide text-primary-700/80 whitespace-nowrap">
                      Total Quantity
                    </p>
                  </div>
                  {selected.totals?.total == null ? (
                    <>
                      <p className="text-2xl font-black leading-none text-slate-400">—</p>
                      <p className="mt-1.5 text-[11px] text-slate-500">Indent balance unavailable</p>
                    </>
                  ) : (
                    <>
                      <p className="text-2xl font-black leading-none text-slate-900 tabular-nums">
                        {selected.totals.total}
                        <span className="ml-1 text-[11px] font-bold text-slate-500">
                          {selected.totals.total === 1 ? "unit" : "units"}
                        </span>
                      </p>
                      <p className="mt-1.5 text-[11px] font-semibold text-slate-500 tabular-nums whitespace-nowrap">
                        {selected.totals.booked} booked
                        {selected.totals.indent > 0 && (
                          <span className="text-amber-700"> · {selected.totals.indent} indent</span>
                        )}
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* CUSTOMER */}
              <div className="h-full rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <User size={13} className="text-blue-600 shrink-0" />
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">
                    Customer
                  </p>
                </div>
                <p
                  className="text-sm font-bold text-slate-800 truncate"
                  title={selected.customer || ""}
                >
                  {selected.customer || "—"}
                </p>
              </div>

              {/* PO NUMBER */}
              <div className="h-full rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Hash size={13} className="text-indigo-600 shrink-0" />
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">
                    PO Number
                  </p>
                </div>
                {/* Wraps rather than truncating: a PO number is an identifier the
                    desk reads back to the customer, and half of one is unusable. */}
                <p className="text-sm font-bold leading-snug text-slate-800 break-all">
                  {selected.poNumber || <span className="font-semibold text-slate-400">Not raised</span>}
                </p>
              </div>

              {/* BOOKING DATE */}
              <div className="h-full rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <CalendarIcon size={13} className="text-violet-600 shrink-0" />
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">
                    Booked
                  </p>
                </div>
                <p className="text-sm font-bold text-slate-800 tabular-nums whitespace-nowrap">
                  {selected.date ? new Date(selected.date).toLocaleDateString() : "—"}
                </p>
              </div>

              {/* LOCATION — the pair the pick list prints, shown so the desk can
                  check it before printing and spot a booking without one. The
                  phone sits under the town rather than beside it, because two
                  values on one line in a 130px tile is what forced the old
                  layout to truncate both. */}
              <div className="h-full rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <MapPin size={13} className="text-emerald-600 shrink-0" />
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">
                    Location
                  </p>
                </div>
                <p
                  className="text-sm font-bold text-slate-800 truncate"
                  title={selected.location || ""}
                >
                  {selected.location || "—"}
                </p>
                {/* Only when there is one. A second dash under the first said
                    nothing and made the tile look like it had failed to load. */}
                {selected.phoneNumber && (
                  <p className="text-[11px] font-semibold text-slate-500 truncate tabular-nums">
                    {selected.phoneNumber}
                  </p>
                )}
              </div>
            </div>

            {/* Customer pricing. Shown to every view_pricing holder, on every
                booking — PO raised or not.

                It used to carry `&& locked` as well, on the reasoning that the
                rate is chosen in the PO dialog and a second control would be two
                ways to set one thing. In practice that hid the section on the
                bookings people most wanted it on: the ones still waiting for a
                PO, where the desk is quoting the customer and wants to see what
                each tier totals BEFORE committing to the PO.

                Nothing behind it needed the lock either. PUT .../pricing is
                deliberately not blocked by the PO lock (see the note on
                setBookingPricing), and shapeBooking sends `pricing` on any
                booking whose reader holds view_pricing. The PO dialog still
                offers the same choice and opens on whatever is set here. */}
            {mayPrice && (
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <IndianRupee size={18} className="text-emerald-600" />
                    <div>
                      <h3 className="text-sm font-bold text-slate-800">Customer Pricing</h3>
                      <p className="text-[11px] text-slate-500">
                        {pricing?.priceType
                          ? `${pricing.priceTypeLabel} rate · ${pricing.pricedLines} of ${pricing.pricedLines + pricing.unpricedLines} line(s) rated`
                          : locked
                            ? "This purchase order has no pricing on it."
                            : "No rate on this booking yet — set it here, or when the PO is raised."}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {pricing?.totalAmount != null && (
                      <span className="text-base font-black text-slate-900">
                        {formatRupees(pricing.totalAmount)}
                      </span>
                    )}
                    {/* Locked out while there are unsaved line edits, the same
                        rule Raise PO follows. Pricing is applied to the SAVED
                        lines, and the response replaces `selected`, which resyncs
                        the draft — so pricing mid-edit would have quietly thrown
                        the edits away AND rated the old quantities. */}
                    <button
                      onClick={() => setRepricing((v) => !v)}
                      disabled={dirty}
                      title={dirty ? "Save your line changes before pricing this booking" : undefined}
                      className="inline-flex items-center gap-1.5 text-xs font-bold text-primary-700 bg-primary-50 border border-primary-200 px-3 py-1.5 rounded-lg hover:bg-primary-100 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Pencil size={13} /> {repricing ? "Close" : pricing?.priceType ? "Change" : "Set price"}
                    </button>
                  </div>
                </div>
                {repricing && (
                  <div className="p-5">
                    <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
                      The customer sees only the rate chosen here.{" "}
                      {locked
                        ? "Changing it rewrites what this purchase order shows them, and is recorded in the audit trail."
                        : "It is carried onto the purchase order when it is raised, and every change is recorded in the audit trail."}
                    </p>
                    <PriceTypeSelector
                      orderId={selected.orderId}
                      value={pricing?.priceType ?? null}
                      onChange={handleSetPrice}
                      customerCategory={selected.customerProfile?.customerCategory}
                      disabled={saving || dirty}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Lines */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package size={18} className="text-primary-600" />
                  <h3 className="text-sm font-bold text-slate-800">Booking Items</h3>
                </div>
                <div className="flex items-center gap-2">
                  {/* Available whether or not the booking is editable — a locked
                      booking is exactly the one the warehouse picks against. */}
                  <button
                    onClick={handleDownload}
                    disabled={draft.length === 0}
                    title={
                      dirty
                        ? "Downloads the lines as shown, including your unsaved edits"
                        : "Download these lines as Excel"
                    }
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 hover:text-slate-800 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Download size={14} /> Excel
                  </button>
                  <button
                    onClick={handleDownloadPdf}
                    disabled={draft.length === 0}
                    title={
                      dirty
                        ? "Downloads the lines as shown, including your unsaved edits"
                        : "Download these lines as PDF"
                    }
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 hover:text-slate-800 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <FileText size={14} /> PDF
                  </button>
                  {/* The document the customer will see, on the desk's screen
                      first. The desk's copy names the price schedule and shows
                      box numbers; the customer's carries neither. */}
                  <button
                    onClick={() => setShowPicklist(true)}
                    disabled={(selected.lines || []).length === 0}
                    title="Preview the picklist / purchase order document"
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 hover:text-slate-800 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Receipt size={14} /> Picklist
                  </button>
                  {editable && (
                    <button
                      onClick={addLine}
                      className="inline-flex items-center gap-1.5 text-xs font-bold text-primary-700 bg-primary-50 border border-primary-200 px-3 py-1.5 rounded-lg hover:bg-primary-100 transition-all"
                    >
                      <Plus size={14} /> Add product
                    </button>
                  )}
                </div>
              </div>

              {/* The lines flow at full height on purpose: the drawer body is
                  the ONE scroller in here. This used to be a capped
                  `overscroll-contain` box of its own, and because it covered
                  most of the panel the wheel landed on it almost every time —
                  the table moved, the detail page behind it did not, and the
                  drawer read as unscrollable. Nothing above or below it is
                  clipped either (no `overflow-hidden` on the card, no
                  `overflow-x-auto` here), which is what lets the header row
                  below stay sticky against that body scroller instead of
                  against a container that never moves.

                  A booking of a hundred SKUs therefore makes a long page, which
                  is fine: the column headers pin to the top of the panel while
                  it scrolls, and the footer actions are outside the scroller
                  and stay put. */}
              <div>
                <table className="w-full text-left">
                  <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    <tr>
                      {/* The inset shadow stands in for the header's border: a
                          collapsed table does not carry a border along with a
                          sticky cell, so the underline would be left behind the
                          moment the list scrolls. */}
                      {/* The reorder handle column. Narrow and first, so the
                          arrows sit where the eye starts a row. */}
                      {mayReorder && (
                        <th className="px-2 py-3 w-[52px] sticky top-0 z-20 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">
                          <span className="sr-only">Reorder</span>
                        </th>
                      )}
                      {/* ── Column widths (requirement 1) ─────────────────
                          SKU and MSIL are IDENTIFIERS and are what the desk
                          compares against a paper PO, so they get the room.
                          Quantity needs only a few digits and Box No a short
                          code, so the width comes from there rather than from
                          squeezing the codes. `min-w` on the SKU header stops
                          a table-layout:auto column collapsing when every
                          visible code happens to be short - which is how the
                          long ones ended up truncated in the first place. */}
                      <th className="px-5 py-3 w-[38%] min-w-[180px] sticky top-0 z-20 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">SKU / Product</th>
                      <th className="px-5 py-3 w-[26%] min-w-[140px] sticky top-0 z-20 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">MSIL Code</th>
                      {showBoxNo && <th className="px-5 py-3 sticky top-0 z-20 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">Box No</th>}
                      <th className="px-5 py-3 text-center w-[110px] sticky top-0 z-20 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">Quantity</th>
                      {editable && <th className="px-5 py-3 text-center sticky top-0 z-20 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">Remove</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {draft.map((line, idx) => (
                      <tr
                        key={line.id || `new-${idx}`}
                        /* The whole ROW is the drop target, not just the handle:
                           a target the size of a grip icon is a target people
                           miss, and a missed drop silently does nothing. The
                           row is only draggable FROM the handle (see
                           draggable={false} on the cells' parent below), so a
                           text selection in the SKU box does not start a drag. */
                        onDragOver={reorderable ? onDragOver(idx) : undefined}
                        onDrop={reorderable ? onDrop(idx) : undefined}
                        onDragEnd={onDragEnd}
                        className={`align-top transition-colors ${
                          dragIdx === idx
                            ? "opacity-40"
                            : dragOverIdx === idx && dragIdx !== null
                              ? "bg-primary-50"
                              : ""
                        } ${
                          /* Where it will land. A line across the top edge is
                             read as "between these two rows"; highlighting the
                             whole row instead says "onto this row", which is not
                             what a reorder does. */
                          dragOverIdx === idx && dragIdx !== null && dragIdx !== idx
                            ? "shadow-[inset_0_2px_0_0_theme(colors.primary.500)]"
                            : ""
                        }`}
                      >
                        {mayReorder && (
                          <td className="px-2 py-3">
                            <div className="flex flex-col items-center gap-1">
                              {/*
                                A button that is also a drag handle.

                                `draggable` gives the mouse the drag; the arrow
                                keys give everyone else the same move. Native
                                HTML5 drag is mouse-only and announces nothing,
                                so a drag-only control would quietly remove this
                                feature for keyboard and screen-reader users.

                                Disabled while there are unsaved line edits: the
                                reorder response replaces the booking and would
                                re-derive the draft over the top of them.
                              */}
                              <button
                                type="button"
                                draggable={reorderable}
                                onDragStart={reorderable ? onDragStart(idx) : undefined}
                                onKeyDown={reorderable ? onHandleKeyDown(idx) : undefined}
                                disabled={!reorderable}
                                title={
                                  dirty
                                    ? "Save your line changes first"
                                    : "Drag to reorder, or use the arrow keys"
                                }
                                aria-label={`Reorder ${line.skuCode || "line"}, position ${idx + 1} of ${draft.length}. Drag, or press the up and down arrow keys.`}
                                className={`rounded p-1 text-slate-300 transition-colors hover:bg-primary-50 hover:text-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-25 disabled:hover:bg-transparent ${
                                  reorderable ? "cursor-grab active:cursor-grabbing" : ""
                                }`}
                              >
                                <GripVertical size={15} />
                              </button>
                              {/* The position, so a reorder can be checked
                                  against the numbered lines on the paper PO. */}
                              <span className="text-[10px] font-bold text-slate-400 tabular-nums">
                                {idx + 1}
                              </span>
                            </div>
                          </td>
                        )}
                        <td className="px-5 py-3">
                          {editable ? (
                            <ProductSearchDropdown
                              value={line.skuCode}
                              placeholder="Search SKU…"
                              onChange={(p) =>
                                // Box number follows the SKU, so picking a
                                // different product shows its box immediately —
                                // no save round-trip needed to see it.
                                setLine(idx, {
                                  skuCode: p?.code || "",
                                  msilCode: p?.msilCode || null,
                                  boxNo: p?.boxNo || null,
                                })
                              }
                            />
                          ) : (
                            <CodeValue value={line.skuCode} />
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <CodeValue value={line.msilCode} tone="muted" />
                        </td>
                        {showBoxNo && (
                          <td className="px-5 py-3">
                            {line.boxNo ? (
                              <span className="font-mono font-bold text-slate-700">{line.boxNo}</span>
                            ) : (
                              <span className="text-slate-400" title="No box number mapped for this SKU">
                                —
                              </span>
                            )}
                          </td>
                        )}
                        <td className="px-5 py-3">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            className={`${cellInput} text-center`}
                            value={line.quantity}
                            disabled={!editable}
                            onChange={(e) => setLine(idx, { quantity: e.target.value })}
                          />
                        </td>
                        {editable && (
                          <td className="px-5 py-3 text-center">
                            <button
                              onClick={() => removeLine(idx)}
                              className="p-1.5 text-slate-400 hover:text-error-600 hover:bg-error-50 rounded-lg transition-colors focus:outline-none"
                              title="Remove this line"
                            >
                              <Trash2 size={16} />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {editable && (
                <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/60 rounded-b-xl text-xs text-slate-500">
                  Saving adjusts inventory immediately: raising a quantity reserves more stock,
                  lowering it or removing a line returns the difference.
                  {showBoxNo && (
                    <>
                      {" "}Box numbers come from the product master and are maintained by an
                      administrator — the PO will quote whatever is mapped at the moment it is raised.
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-white border-t border-slate-200 flex items-center justify-between shrink-0 gap-3">
            <div className="text-xs text-slate-400 font-medium">
              {/* The quantity readout moved here when the hero tile became the
                  booking amount. It reports the TRUE total — confirmed plus
                  what is still open on the indent — rather than `totalQuantity`,
                  which counts confirmed units only and so quietly under-reported
                  every booking carrying an indent. Falls back to the old figure
                  when the server did not send the indent balance. */}
              {selected.lineCount} line(s) ·{" "}
              {selected.totals?.total ?? selected.totalQuantity} unit(s)
              {selected.totals?.indent > 0 && (
                <span className="text-amber-700"> ({selected.totals.indent} on indent)</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {editable && dirty && (
                <ERPButton variant="outline" size="sm" onClick={() => setDraft(toDraft(selected))} disabled={saving}>
                  <RotateCcw size={16} className="mr-2" /> Reset
                </ERPButton>
              )}
              {editable && (
                <ERPButton variant="outline" size="sm" onClick={handleSave} disabled={saving || !dirty}>
                  {saving ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Save size={16} className="mr-2" />}
                  Save changes
                </ERPButton>
              )}

              {mayRaise && !showPoBox && (
                <ERPButton variant="primary" size="sm" onClick={() => setShowPoBox(true)} disabled={saving || dirty}
                  title={dirty ? "Save your changes before raising the PO" : "Raise the PO and lock this booking"}>
                  <FileCheck2 size={16} className="mr-2" /> Raise PO
                </ERPButton>
              )}
              {mayRaise && showPoBox && (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={poInput}
                    onChange={(e) => setPoInput(e.target.value)}
                    placeholder="PO number (blank = auto)"
                    className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg outline-none focus:border-primary-500 w-56"
                  />
                  <ERPButton variant="primary" size="sm" onClick={handleOpenModal} disabled={saving}>
                    {saving ? <Loader2 size={16} className="mr-2 animate-spin" /> : null}
                    Confirm &amp; lock
                  </ERPButton>
                  <ERPButton variant="outline" size="sm" onClick={() => setShowPoBox(false)} disabled={saving}>
                    Cancel
                  </ERPButton>
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {showPicklist && (
          <PicklistPreview
            doc={picklist}
            onClose={() => setShowPicklist(false)}
            onDownload={handlePicklistPdf}
          />
        )}

        {mayEditDetails && editingDetails && (
        <BookingDetailsModal
          isOpen={editingDetails}
          booking={selected}
          onClose={() => setEditingDetails(false)}
          /* The response is the whole booking, so the drawer resyncs from
             server truth rather than from what the form believed it sent. */
          onSaved={(updated) => useSalesStore.setState({ selected: updated })}
        />
      )}

      <PoConfirmModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          onConfirm={handleModalConfirm}
          booking={selected}
          initialPoNumber={poInput.trim()}
          saving={saving}
        />
      </div>
    </AnimatePresence>
  );
};

export default SalesBookingDrawer;
