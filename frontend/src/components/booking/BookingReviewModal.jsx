import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { AlertTriangle, Clock, Loader2, Plus, Trash2, X } from "lucide-react";

import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Pagination } from "../ui/Pagination";
import { CodeValue } from "../ui/CodeValue";
import { ProductSearchDropdown } from "../ui/ProductSearchDropdown";
import { usePagination } from "../../hooks/usePagination";
import { useShowMsilCode } from "../../hooks/useShowMsilCode";
import { useCartStore } from "../../store/cartStore";
import { useUserStore } from "../../store/userStore";
import { effectiveMoq, isMultipleOf, moqAppliesTo } from "../../utils/moq";

/**
 * Booking review — the last step before a Selection List becomes a booking.
 *
 * Nothing is booked until the Confirm Booking button in here is pressed. The
 * popup lists every line with its stock split and lets the customer change
 * quantities, remove lines and add products. Those edits are saved to the
 * Selection List as they are made (the same reservation calls the list itself
 * uses), so "Back to Edit" returns to a list that already shows them, and the
 * booking is made from the edited lines, never from an earlier copy.
 *
 * On Confirm, the lines as shown are sent with the request. The server refuses
 * with a 409 if the list changed elsewhere or stock fell below what was shown;
 * the popup then reloads the lines, marks the ones that changed and stays open
 * so the customer can correct them.
 */

const PAGE_SIZE = 10;

const bookableOf = (line) =>
  Math.min(line.orderQuantity, Math.max(0, line.product.availableStock ?? 0));

// Commits on blur/Enter, like the Selection List's own cell, and reverts to the
// saved quantity when the server refuses the change.
const QtyInput = ({ line, multiple, onCommit, disabled }) => {
  const [draft, setDraft] = useState(String(line.orderQuantity));

  useEffect(() => {
    setDraft(String(line.orderQuantity));
  }, [line.orderQuantity]);

  const commit = async () => {
    const val = Number(draft);
    if (!Number.isInteger(val) || val < 1) {
      toast.error("Enter a whole-number quantity of at least 1");
      setDraft(String(line.orderQuantity));
      return;
    }
    if (multiple && !isMultipleOf(val, multiple)) {
      toast.error(`Quantity must be a multiple of ${multiple}`);
      setDraft(String(line.orderQuantity));
      return;
    }
    if (val === line.orderQuantity) return;
    const res = await onCommit(line.product.code, val);
    if (!res?.success) setDraft(String(line.orderQuantity));
  };

  return (
    <div className="flex flex-col items-center gap-0.5">
      <input
        type="number"
        value={draft}
        min={multiple || 1}
        step={multiple || 1}
        disabled={disabled}
        aria-label={`Booking quantity for ${line.product.code}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        className="w-20 px-2 py-1.5 text-center text-sm font-bold border border-slate-300 text-slate-800 rounded-md outline-none focus:border-[#1a5b9e] focus:ring-2 focus:ring-[#1a5b9e]/20 bg-white disabled:bg-slate-50"
      />
      {multiple > 0 && <span className="text-[9px] text-slate-400 font-semibold">Multiple {multiple}</span>}
    </div>
  );
};

const AddProductRow = ({ user, disabled, onAdd }) => {
  const [product, setProduct] = useState(null);
  const [searchVal, setSearchVal] = useState("");
  const [qty, setQty] = useState("");
  const [adding, setAdding] = useState(false);

  const multiple = effectiveMoq(user, product);

  const reset = () => { setProduct(null); setSearchVal(""); setQty(""); };

  const handleAdd = async () => {
    const val = Number(qty);
    if (!product) { toast.error("Select a product to add"); return; }
    if (!Number.isInteger(val) || val < 1) { toast.error("Enter a whole-number quantity of at least 1"); return; }
    if (multiple && !isMultipleOf(val, multiple)) { toast.error(`Quantity must be a multiple of ${multiple}`); return; }
    setAdding(true);
    try {
      if (await onAdd(product, val)) reset();
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-end gap-3 p-3 bg-slate-50/80 border border-slate-200/60 rounded-xl">
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <label className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">Add product</label>
        <ProductSearchDropdown
          placeholder="Search by SKU Code..."
          value={searchVal}
          onChange={(p) => { setProduct(p); setSearchVal(p ? p.code : ""); setQty(""); }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">
          Qty{product && <span className="normal-case text-slate-400"> (AVL {product.availableStock ?? 0})</span>}
        </label>
        <input
          type="number"
          value={qty}
          min={multiple || 1}
          step={multiple || 1}
          placeholder={multiple ? `× ${multiple}` : "Qty"}
          disabled={!product || disabled}
          onChange={(e) => setQty(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          className="w-full sm:w-28 px-3 py-2 text-sm font-bold border border-slate-200 rounded-lg outline-none focus:border-[#1a5b9e] focus:ring-2 focus:ring-[#1a5b9e]/20 bg-white disabled:bg-slate-100"
        />
      </div>
      <Button variant="outline" onClick={handleAdd} disabled={!product || !qty || adding || disabled}>
        {adding ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Plus size={14} className="mr-1.5" />}
        Add
      </Button>
    </div>
  );
};

export const BookingReviewModal = ({ isOpen, onClose, onConfirmed }) => {
  const {
    items: lines, header, setPOHeader, loading,
    addItem, removeItem, updateQuantity, fetchReservations, confirmBooking,
  } = useCartStore();
  const user = useUserStore((s) => s.user);
  const showMsilCode = useShowMsilCode();
  const enforceMoq = moqAppliesTo(user);

  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState(null); // { message, skus: Set }
  // A synchronous guard: a double click lands before React has re-rendered
  // the disabled button, so state alone cannot stop the second request.
  const submittingRef = useRef(false);
  // Edits still being saved. Confirm waits for them so it books the quantity
  // the customer just typed, not the one before it.
  const pendingEdits = useRef(new Set());

  const { page, setPage, pageItems, total } = usePagination(lines, PAGE_SIZE);

  useEffect(() => {
    if (isOpen) setProblem(null);
  }, [isOpen]);

  const track = (promise) => {
    pendingEdits.current.add(promise);
    promise.finally(() => pendingEdits.current.delete(promise));
    return promise;
  };

  const rowMultiple = (line) => {
    if (!enforceMoq) return 0;
    const moq = Number(line.product.moq) || 0;
    return moq > 1 ? moq : 0;
  };

  const handleQtyChange = async (code, qty) => {
    const res = await track(updateQuantity(code, qty));
    if (!res.success) toast.error(res.error || "Quantity update failed");
    return res;
  };

  const handleRemove = (code) => track(removeItem(code));

  const handleAdd = async (product, qty) => {
    const res = await track(addItem(product, qty));
    if (!res.success) {
      toast.error(res.error || "Failed to add product");
      return false;
    }
    toast.success(res.merged ? "Quantity added to the existing line" : "Product added");
    return true;
  };

  const handleConfirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setProblem(null);
    try {
      await Promise.allSettled([...pendingEdits.current]);
      const current = useCartStore.getState().items;

      if (current.length === 0) {
        setProblem({ message: "Add at least one product before confirming.", skus: new Set() });
        return;
      }
      const invalid = current.filter((l) => {
        const m = rowMultiple(l);
        return !Number.isInteger(l.orderQuantity) || l.orderQuantity < 1 || (m && !isMultipleOf(l.orderQuantity, m));
      });
      if (invalid.length) {
        setProblem({
          message: `Fix the quantity for ${invalid.map((l) => l.product.code).join(", ")} before confirming.`,
          skus: new Set(invalid.map((l) => l.product.code)),
        });
        return;
      }

      const result = await confirmBooking(
        current.map((l) => ({ id: l._id, quantity: l.orderQuantity, bookable: bookableOf(l) })),
      );
      onConfirmed(result);
    } catch (err) {
      const data = err.response?.data;
      setProblem({
        message: data?.message || "Failed to confirm booking. Please try again.",
        skus: new Set((data?.details || []).map((d) => d.skuCode).filter(Boolean)),
      });
      // The list or stock moved under the review: show the lines as they are now.
      if (err.response?.status === 409) await fetchReservations();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const busy = submitting || loading;
  const totalUnits = lines.reduce((n, l) => n + l.orderQuantity, 0);
  const fromStock = lines.reduce((n, l) => n + bookableOf(l), 0);
  const toIndent = totalUnits - fromStock;
  const indentLines = lines.filter((l) => l.orderQuantity > bookableOf(l)).length;

  return (
    <Modal isOpen={isOpen} onClose={submitting ? () => {} : onClose} title="Confirm Booking" size="xl">
      <div className="flex flex-col gap-5">
        <p className="text-sm font-semibold text-slate-800">
          Are you sure you want to confirm this booking?
          <span className="block text-xs font-medium text-slate-500 mt-0.5">
            Check each line below. You can change quantities, remove lines or add products before confirming.
          </span>
        </p>

        {problem && (
          <div role="alert" className="flex items-start gap-2.5 p-3 bg-red-50 border border-red-200 rounded-xl">
            <AlertTriangle size={18} className="text-red-500 shrink-0 mt-0.5" />
            <p className="flex-1 text-sm text-red-700 leading-relaxed">{problem.message}</p>
            <button
              onClick={() => setProblem(null)}
              className="p-0.5 rounded text-red-400 hover:text-red-600"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Booking summary */}
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-180 text-left text-sm">
              <thead className="bg-slate-50 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2.5">SKU Code</th>
                  {showMsilCode && <th className="px-3 py-2.5">MSIL Code</th>}
                  <th className="px-3 py-2.5">Product Name</th>
                  <th className="px-3 py-2.5">Category</th>
                  <th className="px-3 py-2.5 text-center">Available</th>
                  <th className="px-3 py-2.5 text-center">Booking Qty</th>
                  <th className="px-3 py-2.5 text-center">From Stock / Indent</th>
                  <th className="px-3 py-2.5 w-10"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.length === 0 && (
                  <tr>
                    <td colSpan={showMsilCode ? 8 : 7} className="px-4 py-10 text-center text-slate-400 italic">
                      No products in this booking. Add one below.
                    </td>
                  </tr>
                )}
                {pageItems.map((line) => {
                  const bookable = bookableOf(line);
                  const indent = line.orderQuantity - bookable;
                  const flagged = problem?.skus.has(line.product.code);
                  return (
                    <tr key={line._id} className={flagged ? "bg-red-50/70" : "bg-white"}>
                      <td className="px-3 py-2.5 font-bold text-slate-800">
                        <CodeValue value={line.product.code} />
                      </td>
                      {showMsilCode && (
                        <td className="px-3 py-2.5 text-slate-700">
                          {line.product.msilCode ? <CodeValue value={line.product.msilCode} /> : "—"}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-slate-600 text-xs max-w-55">
                        <span className="line-clamp-2">{line.product.description || "—"}</span>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600 text-xs">{line.product.category || "—"}</td>
                      <td className="px-3 py-2.5 text-center font-semibold text-slate-700">
                        {line.product.availableStock ?? 0}
                      </td>
                      <td className="px-3 py-2.5">
                        <QtyInput
                          line={line}
                          multiple={rowMultiple(line)}
                          onCommit={handleQtyChange}
                          disabled={submitting}
                        />
                      </td>
                      <td className="px-3 py-2.5 text-center text-xs">
                        <span className="font-bold text-emerald-600">{bookable}</span>
                        {indent > 0 && <span className="font-bold text-amber-600"> / +{indent} indent</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          onClick={() => handleRemove(line.product.code)}
                          disabled={busy}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all disabled:opacity-40"
                          title="Remove from booking"
                          aria-label={`Remove ${line.product.code}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > PAGE_SIZE && (
            <div className="px-3 py-2.5 border-t border-slate-200 bg-slate-50/50">
              <Pagination page={page} pageSize={PAGE_SIZE} totalItems={total} onPageChange={setPage} />
            </div>
          )}
        </div>

        <AddProductRow user={user} disabled={submitting} onAdd={handleAdd} />

        {/* Totals */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            ["Products", lines.length, "text-slate-800"],
            ["Total Units", totalUnits, "text-slate-800"],
            ["From Stock", fromStock, "text-emerald-700"],
            ["To Indent", toIndent, toIndent > 0 ? "text-amber-700" : "text-slate-400"],
          ].map(([label, value, tone]) => (
            <div key={label} className="bg-slate-50 border border-slate-200/70 rounded-xl px-3 py-2.5 text-center">
              <p className={`text-xl font-black ${tone}`}>{value}</p>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {toIndent > 0 && (
          <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-xl">
            <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-xs text-slate-700 leading-relaxed">
              {toIndent} unit{toIndent === 1 ? "" : "s"} across {indentLines} product{indentLines === 1 ? "" : "s"} exceed
              available stock and will be raised as an <span className="font-bold">Indent</span>, fulfilled when fresh
              stock arrives.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">Remarks (Optional)</label>
          <input
            type="text"
            placeholder="Any specific instructions..."
            value={header.remarks}
            disabled={submitting}
            onChange={(e) => setPOHeader({ remarks: e.target.value })}
            className="w-full px-3.5 py-2 border border-slate-200/80 rounded-lg outline-none focus:border-[#1a5b9e] focus:ring-2 focus:ring-[#1a5b9e]/20 text-sm text-slate-800 font-semibold bg-white"
          />
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
          <Clock size={14} className="text-red-500 shrink-0" />
          <p className="text-[11px] text-red-700 leading-relaxed">
            Booking valid for <span className="font-semibold">7 days</span>. Items are released if no PO is received.
          </p>
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Back to Edit
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            // Not disabled while an edit saves: typing a quantity and clicking
            // here blurs the input first, and a button disabled by that save
            // would swallow the click. handleConfirm waits for the save instead.
            disabled={submitting || lines.length === 0}
            aria-busy={submitting}
          >
            {submitting && <Loader2 size={16} className="mr-2 animate-spin" />}
            {submitting ? "Confirming…" : "Confirm Booking"}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default BookingReviewModal;
