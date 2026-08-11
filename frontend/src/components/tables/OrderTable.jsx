import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trash2, PackagePlus } from "lucide-react";
import toast from "react-hot-toast";
import { Pagination } from "../ui/Pagination";
import { usePagination } from "../../hooks/usePagination";

const PAGE_SIZE = 10;

// Qty cell with local edit state — commits on blur/Enter so a below-MOQ value
// typed mid-keystroke isn't reverted by the controlled input.
const QtyCell = ({ item, enforceMoq, onUpdateQty }) => {
  const rowMoq = Number(item.product.moq) || 0;
  const applyMoq = enforceMoq && rowMoq > 1;
  const avl = item.product.availableStock ?? 0;
  const shortfall = Math.max(0, item.orderQuantity - avl);

  const [draft, setDraft] = useState(String(item.orderQuantity));

  // Reflect external changes (e.g. store refresh) when not actively editing.
  React.useEffect(() => {
    setDraft(String(item.orderQuantity));
  }, [item.orderQuantity]);

  const commit = () => {
    const val = parseInt(draft, 10);
    if (isNaN(val) || val <= 0) {
      setDraft(String(item.orderQuantity)); // revert invalid entry
      return;
    }
    // MOQ is a minimum, not a pack size — see utils/moq.js. The multiple-of
    // check that used to follow this one had no counterpart on the server, so
    // it reverted quantities the API would have accepted.
    if (applyMoq && val < rowMoq) {
      toast.error(`Quantity must be at least the MOQ (${rowMoq})`);
      setDraft(String(item.orderQuantity));
      return;
    }
    if (val !== item.orderQuantity) onUpdateQty(item.product.code, val);
  };

  return (
    <div className="flex flex-col gap-1 items-center">
      <input
        type="number"
        value={draft}
        min={applyMoq ? rowMoq : 1}
        step={1}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        className="w-16 px-1 py-1 text-center font-bold border border-slate-300 text-slate-800 rounded-md outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 bg-white text-xs shadow-sm"
      />
      {applyMoq && <span className="text-[9px] text-slate-400 font-semibold">MOQ {rowMoq}</span>}
      {shortfall > 0 && <span className="text-[9px] text-amber-600 font-bold">+{shortfall} indent</span>}
    </div>
  );
};

export const OrderTable = ({ items, onUpdateQty, onRemoveItem, onBulkRemove, onRaiseIndent, enforceMoq = false }) => {
  const [selectedIds, setSelectedIds] = useState([]);
  const { page, setPage, pageItems, total } = usePagination(items, PAGE_SIZE);

  // Selection is keyed by reservation _id (unique even when the same product
  // appears twice) and pruned against the current items so removed rows never
  // linger as ghost selections.
  const itemIds = items.map((i) => i._id);
  const selected = selectedIds.filter((id) => itemIds.includes(id));

  const allSelected = items.length > 0 && selected.length === items.length;

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : itemIds);
  };

  const toggleOne = (id) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  };

  const handleBulkDelete = () => {
    if (selected.length === 0) return;
    onBulkRemove?.(selected);
    setSelectedIds([]);
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <div className="w-full border border-slate-200 rounded-xl bg-white overflow-hidden shadow-sm">
      {selected.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-red-50/70 border-b border-red-100">
          <span className="text-xs font-bold text-red-700">
            {selected.length} item{selected.length > 1 ? "s" : ""} selected
          </span>
          <button
            onClick={handleBulkDelete}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 text-white hover:bg-red-700 transition-all focus:outline-none"
          >
            <Trash2 size={13} /> Delete Selected
          </button>
        </div>
      )}
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 font-bold uppercase select-none">
            <th className="px-4 py-4 w-[5%] text-center">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
                title="Select all"
              />
            </th>
            <th className="px-4 py-4 w-[24%]">SKU & Product</th>
            <th className="px-4 py-4 w-[23%]">Reservation Dates</th>
            <th className="px-4 py-4 w-[13%] text-center">AVL Qty</th>
            <th className="px-4 py-4 w-[12%] text-center">Qty</th>
            <th className="px-4 py-4 w-[13%] text-center">Status</th>
            <th className="px-4 py-4 w-[10%] text-center">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 text-[13px]">
          <AnimatePresence initial={false}>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-slate-400 font-medium italic">
                  No active reservations in your selection list.
                </td>
              </tr>
            )}
            {pageItems.map((item) => {
              return (
                <motion.tr
                  key={item._id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="bg-white hover:bg-slate-50 transition-colors"
                >
                  {/* Select */}
                  <td className="px-4 py-4 text-center">
                    <input
                      type="checkbox"
                      checked={selected.includes(item._id)}
                      onChange={() => toggleOne(item._id)}
                      className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
                    />
                  </td>

                  {/* SKU & Name */}
                  <td className="px-4 py-4">
                    <div className="flex flex-col">
                      <span className="font-bold text-slate-900 select-all">{item.product.code}</span>
                      <span className="text-slate-500 text-[11px] font-medium line-clamp-1">{item.product.name}</span>
                    </div>
                  </td>

                  {/* Dates */}
                  <td className="px-4 py-4">
                    <div className="flex flex-col gap-0.5 text-slate-600 text-[11px] font-medium">
                      <div className="flex items-center gap-1">
                        <span className="text-slate-400 font-semibold">Res:</span>
                        <span>{formatDate(item.reservationDate)}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-slate-400 font-semibold">Exp:</span>
                        <span className="text-slate-800 font-bold">{formatDate(item.expiryDate)}</span>
                      </div>
                    </div>
                  </td>

                  {/* Available Quantity (AVL) */}
                  <td className="px-4 py-4 text-center">
                    <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-bold bg-slate-50 text-slate-700 border border-slate-200">
                      AVL: {item.product.availableStock ?? 0}
                    </span>
                  </td>

                  {/* Qty Input — editable directly from the Selection List */}
                  <td className="px-4 py-4">
                    <QtyCell item={item} enforceMoq={enforceMoq} onUpdateQty={onUpdateQty} />
                  </td>

                  {/* Status */}
                  <td className="px-4 py-4 text-center">
                    <span className="inline-flex px-2 py-0.5 rounded text-xs font-bold bg-blue-50 text-blue-600 border border-blue-200">
                      {item.status}
                    </span>
                  </td>

                  {/* Action */}
                  <td className="px-4 py-4">
                    <div className="flex items-center justify-center gap-1">
                      {onRaiseIndent && (item.orderQuantity - (item.product.availableStock ?? 0)) > 0 && (
                        <button
                          onClick={() => onRaiseIndent(item)}
                          className="p-1.5 rounded-lg text-amber-500 hover:text-amber-700 hover:bg-amber-50 transition-all focus:outline-none"
                          title="Raise indent for the out-of-stock quantity"
                        >
                          <PackagePlus size={15} />
                        </button>
                      )}
                      <button
                        onClick={() => onRemoveItem(item.product.code)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all focus:outline-none"
                        title="Remove Item"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </motion.tr>
              );
            })}
          </AnimatePresence>
        </tbody>
      </table>

      {total > 0 && (
        <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/50">
          <Pagination page={page} pageSize={PAGE_SIZE} totalItems={total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
};

export default OrderTable;
