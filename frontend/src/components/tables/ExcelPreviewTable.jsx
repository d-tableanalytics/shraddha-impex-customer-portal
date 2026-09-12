import { motion, AnimatePresence } from "framer-motion";
import { Badge } from "../ui/Badge";
import { Pagination } from "../ui/Pagination";
import { usePagination } from "../../hooks/usePagination";

const PAGE_SIZE = 25;

// Row background by validation status. Warning rows are highlighted so the user
// can review them before selecting; errors are highlighted red.
const rowClass = (status) => {
  if (status === "error") return "bg-error-50/60";
  if (status === "warning") return "bg-amber-50/60";
  return "hover:bg-slate-50/50";
};

export const ExcelPreviewTable = ({
  rows,
  onUpdateRow,
  selectedIds = null,
  onToggleRow = null,
  onToggleAll = null,
  showMsilCode = true,
}) => {
  const selectable = !!selectedIds && !!onToggleRow;
  // Only rows that can actually be imported are eligible for selection. Select-all
  // still spans the whole file, not just the visible page, so an import isn't
  // silently limited to one page of rows.
  const selectableRows = rows.filter((r) => r.status === "valid" || r.status === "warning");
  const allSelected =
    selectable && selectableRows.length > 0 &&
    selectableRows.every((r) => selectedIds.includes(r.id));

  const { page, setPage, pageItems, total } = usePagination(rows, PAGE_SIZE);

  return (
    <div className="w-full border border-slate-200 rounded-xl bg-white shadow-sm flex flex-col">
      <div className="overflow-x-auto overflow-y-auto h-[400px]">
        <table className="w-full text-left border-collapse whitespace-nowrap">
          <thead className="sticky top-0 bg-slate-50 z-10">
            <tr className="border-b border-slate-200 text-xs text-slate-500 font-bold uppercase select-none">
              {selectable && (
                <th className="px-4 py-3 text-center w-[4%]">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => onToggleAll?.(selectableRows.map((r) => r.id))}
                    className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
                    title="Select all importable rows"
                  />
                </th>
              )}
              <th className="px-4 py-3">Row</th>
              {/* ── Identifier column widths ─────────────────────────────
                  SKU and MSIL are what the customer re-checks against their
                  own list before importing, and both inputs were 96px wide -
                  narrow enough to hide the end of a long code while still
                  looking like a filled-in field. The width is set once on the
                  column so the inputs below can simply fill it, and the table's
                  existing `overflow-x-auto` absorbs the extra width on a narrow
                  screen rather than squeezing the codes again. */}
              <th className="px-4 py-3 w-[200px]">SKU Code</th>
              {showMsilCode && <th className="px-4 py-3 w-[190px]">MSIL Code</th>}
              <th className="px-4 py-3">Product Info</th>
              <th className="px-4 py-3 text-center">Avail Stock</th>
              <th className="px-4 py-3 text-center">Req Qty</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            <AnimatePresence initial={false}>
              {pageItems.map((row) => {
                const isSelectable = row.status === "valid" || row.status === "warning";
                const checked = selectable && selectedIds.includes(row.id);
                return (
                  <motion.tr
                    key={row.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className={`transition-colors ${rowClass(row.status)}`}
                  >
                    {selectable && (
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!isSelectable}
                          onChange={() => onToggleRow(row.id)}
                          className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        />
                      </td>
                    )}
                    <td className="px-4 py-3 font-bold text-slate-500">
                      {row.originalRowNumber}
                    </td>
                    <td className="px-4 py-3">
                      {/* `title` carries the whole value for a hover, because an
                          input cannot wrap the way a read-only cell can - it can
                          only scroll, and only once focused. Monospace with
                          tabular figures so two codes differing in one character
                          line up when read down the column, which is what makes
                          a mismatch visible rather than merely present. */}
                      <input
                        type="text"
                        value={row.skuCode || ""}
                        title={row.skuCode || ""}
                        onChange={(e) =>
                          onUpdateRow(row.id, { skuCode: e.target.value })
                        }
                        className="w-full min-w-0 px-2 py-1 text-sm font-bold font-mono tabular-nums tracking-tight border border-slate-300 rounded outline-none focus:border-primary-500 bg-white"
                      />
                    </td>
                    {showMsilCode && (
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          value={row.msilCode && row.msilCode !== "-" ? row.msilCode : ""}
                          title={row.msilCode && row.msilCode !== "-" ? row.msilCode : ""}
                          placeholder="-"
                          onChange={(e) =>
                            onUpdateRow(row.id, { msilCode: e.target.value })
                          }
                          className="w-full min-w-0 px-2 py-1 text-sm font-bold font-mono tabular-nums tracking-tight border border-slate-300 rounded outline-none focus:border-primary-500 bg-white placeholder:text-slate-400 placeholder:font-normal placeholder:font-sans"
                        />
                      </td>
                    )}
                    <td
                      className="px-4 py-3 text-slate-600 truncate max-w-[150px]"
                      title={row.product ? String(row.product.category || row.product.name) : ""}
                    >
                      {row.product ? (
                        <span className="text-sm font-medium">{String(row.product.category || row.product.name)}</span>
                      ) : (
                        <span className="text-error-500 italic">Unknown</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center font-semibold text-slate-600">
                      {row.product
                        ? `${row.product.availableStock} ${row.product.unit || 'PCS'}`
                        : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-center">
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={row.quantity}
                          onChange={(e) =>
                            onUpdateRow(row.id, {
                              quantity: Number(e.target.value),
                            })
                          }
                          className="w-20 px-2 py-1 text-center font-bold border border-slate-300 rounded outline-none focus:border-primary-500 bg-white"
                        />
                      </div>
                    </td>
                    <td
                      className="px-4 py-3 flex gap-2 items-center"
                      title={[...(row.errors || []), ...(row.warnings || [])].join("; ")}
                    >
                      {row.status === "valid" && (
                        <Badge variant="success">Valid</Badge>
                      )}
                      {row.status === "warning" && (
                        <Badge variant="warning">Warning</Badge>
                      )}
                      {row.status === "error" && (
                        <Badge variant="danger">Error</Badge>
                      )}
                      {row.status === "pending" && (
                        <Badge variant="secondary">Pending</Badge>
                      )}
                      {row.isMerged && <Badge variant="primary">Merged</Badge>}
                    </td>
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/50">
          <Pagination page={page} pageSize={PAGE_SIZE} totalItems={total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
};
