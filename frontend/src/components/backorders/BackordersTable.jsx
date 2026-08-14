import { useState } from "react";
import { PackageX, Eye, FileSpreadsheet } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Pagination } from "../ui/Pagination";
import { TableSkeleton } from "../ui/TableSkeleton";
import { usePagination } from "../../hooks/usePagination";

const DETAIL_PAGE_SIZE = 10;

// Groups flat pending-indent rows (one per SKU) that came from the same
// booking confirmation (shared indentNumber) into a single entry, so multiple
// items confirmed together show as one row instead of one row per SKU.
export const groupByIndent = (items) => {
  const byIndent = new Map();
  const ungrouped = [];

  for (const item of items) {
    if (!item.indentNumber) {
      ungrouped.push({ indentNumber: null, lines: [item], primary: item });
      continue;
    }
    if (!byIndent.has(item.indentNumber)) {
      byIndent.set(item.indentNumber, []);
    }
    byIndent.get(item.indentNumber).push(item);
  }

  const grouped = [...byIndent.entries()].map(([indentNumber, lines]) => ({
    indentNumber,
    lines,
    primary: lines[0],
  }));

  return [...grouped, ...ungrouped];
};

/**
 * Renders the list of indents (unfulfilled reservation quantities),
 * one row per booking confirmation. Click a row to see every SKU it covers.
 *
 * There is deliberately NO per-line action here. Moving an indent to the
 * customer's selection list is not something an admin does by hand — it happens
 * automatically once stock covers the line (see the indent availability
 * service on the server), so an "action" column offered a second, manual route
 * to the same outcome and has been removed.
 *
 * @param {Array}    items        Pending items from the cart store.
 * @param {boolean}  showCustomer Show the customer column (admin view).
 * @param {boolean}  compact      Tighter padding for embedding in a dashboard.
 */
export const BackordersTable = ({
  items = [],
  loading = false,
  showCustomer = false,
  compact = false,
  selectedIds = [],
  toggleSelectId,
  toggleSelectAll,
  onExportRow,
}) => {
  const [selectedGroup, setSelectedGroup] = useState(null);
  const detailPaging = usePagination(selectedGroup?.lines || [], DETAIL_PAGE_SIZE);

  const pad = compact ? "py-2" : "py-3";

  // Opening a different indent should always start at its first page.
  const openGroup = (group) => {
    detailPaging.setPage(1);
    setSelectedGroup(group);
  };

  // Skeleton while the first fetch is in flight, so the table doesn't flash
  // "No indents" before the data has had a chance to arrive.
  if (loading) {
    const cols = 8 + (showCustomer ? 1 : 0);
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            <TableSkeleton rows={6} columns={cols} cellClass={`${pad} px-4`} />
          </tbody>
        </table>
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <PackageX size={32} className="text-slate-300" />
        <p className="text-sm font-semibold text-slate-400">No indents</p>
        <p className="text-xs text-slate-400">
          Unfulfilled quantities from confirmations will appear here.
        </p>
      </div>
    );
  }

  const groups = groupByIndent(items);

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-200/80">
              <th className={`${pad} px-4 w-[4%]`}>
                <input
                  type="checkbox"
                  checked={groups.length > 0 && selectedIds.length === groups.length}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
                />
              </th>
              <th className={`${pad} pr-4`}>Indent No</th>
              <th className={`${pad} pr-4`}>SKU Code</th>
              {showCustomer && <th className={`${pad} pr-4`}>Customer</th>}
              <th className={`${pad} pr-4`}>Date</th>
              <th className={`${pad} pr-4 text-center`}>Items</th>
              <th className={`${pad} pr-4 text-center`}>Qty</th>
              <th className={`${pad} pr-4 text-center`}>Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {groups.map((group) => {
              const { primary, lines, indentNumber } = group;
              const totalQty = lines.reduce((sum, l) => sum + (l.pendingQuantity || 0), 0);
              const isMulti = lines.length > 1;
              const key = indentNumber || primary._id;

              return (
                <tr key={key} className="text-slate-700">
                  <td className={`${pad} px-4`}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(key)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        toggleSelectId(key);
                      }}
                      className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
                    />
                  </td>
                  <td className={`${pad} pr-4 font-bold text-amber-700`}>
                    {indentNumber || "—"}
                  </td>
                  <td className={`${pad} pr-4 font-bold text-slate-800`}>
                    {isMulti ? `${primary.product.code} +${lines.length - 1} more` : primary.product.code}
                  </td>
                  {showCustomer && (
                    <td className={`${pad} pr-4 text-slate-600 font-semibold`}>
                      {primary.customer?.name || "—"}
                    </td>
                  )}
                  <td className={`${pad} pr-4 text-slate-500`}>
                    {primary.updatedAt ? new Date(primary.updatedAt).toLocaleDateString() : "—"}
                  </td>
                  <td className={`${pad} pr-4 text-center font-semibold text-slate-600`}>
                    {lines.length}
                  </td>
                  <td className={`${pad} pr-4 text-center font-black text-amber-600`}>
                    {totalQty}
                  </td>
                  <td className={`${pad} pr-4 text-center`}>
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => openGroup(group)}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-primary-700 bg-primary-50 border border-primary-200 px-3 py-1.5 rounded-lg hover:bg-primary-100 transition-all"
                        title="View indent details"
                      >
                        <Eye size={14} /> View
                      </button>
                      {onExportRow && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onExportRow(group);
                          }}
                          className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors focus:outline-none border border-transparent hover:border-emerald-200"
                          title="Download Excel"
                        >
                          <FileSpreadsheet size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={!!selectedGroup}
        onClose={() => setSelectedGroup(null)}
        title={`Indent ${selectedGroup?.indentNumber || ""}`}
        size="lg"
      >
        {selectedGroup && (
          <div className="flex flex-col gap-4">
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-2.5">SKU Code</th>
                    {showCustomer && <th className="px-4 py-2.5">Customer</th>}
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5 text-center">Pending Qty</th>
                    <th className="px-4 py-2.5 text-center">Current Stock</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detailPaging.pageItems.map((line) => {
                    return (
                      <tr key={line._id}>
                        <td className="px-4 py-2.5 font-bold text-slate-800">{line.product.code}</td>
                        {showCustomer && (
                          <td className="px-4 py-2.5 text-slate-600 font-semibold">
                            {line.customer?.name || "—"}
                          </td>
                        )}
                        <td className="px-4 py-2.5 text-slate-500">
                          {line.updatedAt ? new Date(line.updatedAt).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-center font-black text-amber-600">
                          {line.pendingQuantity}
                        </td>
                        <td className="px-4 py-2.5 text-center font-semibold text-slate-600">
                          {line.product.availableStock}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              page={detailPaging.page}
              pageSize={DETAIL_PAGE_SIZE}
              totalItems={detailPaging.total}
              onPageChange={detailPaging.setPage}
            />
          </div>
        )}
      </Modal>
    </>
  );
};

export default BackordersTable;
