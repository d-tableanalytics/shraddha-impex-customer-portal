import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, User, Hash, Calendar as CalendarIcon, Package, Lock, Timer,
  Plus, Trash2, Save, FileCheck2, Loader2, RotateCcw, AlertTriangle, Download, FileText,
  MapPin,
} from "lucide-react";
import toast from "react-hot-toast";
import { useSalesStore } from "../../store/salesStore";
import { useUserStore } from "../../store/userStore";
import { ERPButton } from "../ui/ERPButton";
import { PoStatusBadge } from "../ui/PoStatusBadge";
import { PoCountdown } from "../ui/PoCountdown";
import { ProductSearchDropdown } from "../ui/ProductSearchDropdown";
import { canEditBooking, canRaisePo, canViewLineItemBoxNo, hasPermission, PERMISSIONS } from "../../utils/permissions";
import { PoConfirmModal } from "../modal/PoConfirmModal";

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
    quantity: l.confirmedQty,
  }));

export const SalesBookingDrawer = () => {
  const { selected, close, saveItems, raisePo, saving } = useSalesStore();
  const { user } = useUserStore();

  const [draft, setDraft] = useState([]);
  const [poInput, setPoInput] = useState("");
  const [showPoBox, setShowPoBox] = useState(false);
  const [showModal, setShowModal] = useState(false);

  // `selected` is only replaced on an explicit select / save / raise-PO, so this
  // resyncs the draft with server truth after a write without clobbering
  // in-progress edits on unrelated store updates.
  useEffect(() => {
    setDraft(toDraft(selected));
    setShowPoBox(false);
    setPoInput("");
    setShowModal(false);
  }, [selected]);

  if (!selected) return null;

  const locked = selected.locked;
  const editable = canEditBooking(user, selected);
  const showBoxNo = canViewLineItemBoxNo(user);
  const mayRaise = canRaisePo(user, selected);
  const isOverride = locked && hasPermission(user, PERMISSIONS.OVERRIDE_PO_LOCK);

  const dirty =
    JSON.stringify(draft.map(({ id, skuCode, quantity }) => ({ id: id || null, skuCode, quantity }))) !==
    JSON.stringify(toDraft(selected).map(({ id, skuCode, quantity }) => ({ id: id || null, skuCode, quantity })));

  const setLine = (idx, patch) =>
    setDraft((d) => d.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const removeLine = (idx) => setDraft((d) => d.filter((_, i) => i !== idx));
  const addLine = () =>
    setDraft((d) => [...d, { id: null, skuCode: "", msilCode: null, boxNo: null, quantity: 1 }]);

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
            .map((s) => `${s.skuCode}: ${s.toQty} confirmed, ${s.indentQty} moved to indent (stock short).`)
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

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                  <User size={16} className="text-blue-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-slate-400 uppercase">Customer</p>
                  <p className="text-sm font-bold text-slate-800 truncate">{selected.customer || "—"}</p>
                </div>
              </div>
              <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center shrink-0">
                  <Hash size={16} className="text-indigo-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-slate-400 uppercase">PO Number</p>
                  <p className="text-sm font-bold text-slate-800 truncate">{selected.poNumber || "Not raised"}</p>
                </div>
              </div>
              <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                <div className="w-8 h-8 rounded-full bg-violet-50 flex items-center justify-center shrink-0">
                  <CalendarIcon size={16} className="text-violet-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-slate-400 uppercase">Booking Date</p>
                  <p className="text-sm font-bold text-slate-800">
                    {selected.date ? new Date(selected.date).toLocaleDateString() : "—"}
                  </p>
                </div>
              </div>
              {/* The pair the pick list prints — shown on screen so the desk
                  can check it before printing, and spot a booking without one. */}
              <div className="bg-white border border-slate-200 p-4 rounded-xl flex items-start gap-3 shadow-sm">
                <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
                  <MapPin size={16} className="text-emerald-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-slate-400 uppercase">Location &amp; Phone</p>
                  <p className="text-sm font-bold text-slate-800 truncate">{selected.location || "—"}</p>
                  <p className="text-xs font-semibold text-slate-500 truncate">{selected.phoneNumber || "—"}</p>
                </div>
              </div>
            </div>

            {/* Lines */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
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

              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    <tr>
                      <th className="px-5 py-3 w-[45%]">SKU / Product</th>
                      <th className="px-5 py-3">MSIL Code</th>
                      {showBoxNo && <th className="px-5 py-3">Box No</th>}
                      <th className="px-5 py-3 text-center w-[18%]">Quantity</th>
                      {editable && <th className="px-5 py-3 text-center">Remove</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {draft.map((line, idx) => (
                      <tr key={line.id || `new-${idx}`} className="align-top">
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
                            <span className="font-bold text-slate-800">{line.skuCode}</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-slate-500">{line.msilCode || "—"}</td>
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
                <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/60 text-xs text-slate-500">
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
              {selected.lineCount} line(s) · {selected.totalQuantity} unit(s)
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
