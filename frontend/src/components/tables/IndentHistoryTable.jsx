import { ChevronUp, ChevronDown, Eye, FileDown, FileSpreadsheet, PackageCheck } from "lucide-react";
import toast from "react-hot-toast";
import { useIndentHistoryStore } from "../../store/indentHistoryStore";
import { useUserStore } from "../../store/userStore";
import { Pagination } from "../ui/Pagination";
import { TableSkeleton } from "../ui/TableSkeleton";
import { IndentStatusBadge } from "../ui/IndentStatusBadge";

export const IndentHistoryTable = () => {
  const {
    indents,
    loading,
    sortBy,
    sortOrder,
    setSort,
    page,
    setPage,
    limit,
    setSelectedIndent,
    selectedIds,
    toggleSelectId,
    toggleSelectAll,
  } = useIndentHistoryStore();

  const isAdmin = useUserStore((s) => s.user?.role === "Admin");

  const totalPages = Math.max(1, Math.ceil(indents.length / limit));
  const currentPage = Math.min(page, totalPages);
  const currentIndents = indents.slice((currentPage - 1) * limit, currentPage * limit);
  const allSelected = indents.length > 0 && indents.every((r) => selectedIds.includes(r.id));

  const handleSort = (field) => {
    if (sortBy === field) setSort(field, sortOrder === "asc" ? "desc" : "asc");
    else setSort(field, "desc");
  };

  // One row per SKU line, so a single-indent export matches the bulk export shape.
  const rowsFor = (indent) =>
    indent.lines.map((l) => ({
      indentNumber: indent.indentNumber || "—",
      bookingId: indent.bookingId || "—",
      sku: l.product?.code || "—",
      msilCode: l.product?.msilCode || "—",
      quantity: l.pendingQuantity || 0,
      available: l.product?.availableStock ?? 0,
    }));

  const rowCols = [
    { key: "indentNumber", label: "Indent No" },
    { key: "bookingId", label: "Booking ID" },
    { key: "sku", label: "SKU Code" },
    { key: "msilCode", label: "MSIL Code" },
    { key: "quantity", label: "Indent Qty" },
    { key: "available", label: "Available Qty" },
  ];

  const handleRowPDF = (indent) => {
    import("../../utils/exportUtils").then(({ exportToPDF }) => {
      const ok = exportToPDF(
        rowsFor(indent),
        rowCols,
        `Indent ${indent.indentNumber || ""} — ${indent.customer || ""}`,
        `Indent_${indent.indentNumber || indent.id}`,
      );
      if (!ok) toast.error("PDF download failed");
    });
  };

  const handleRowExcel = (indent) => {
    import("../../utils/exportUtils").then(({ exportToExcel }) => {
      const ok = exportToExcel(
        rowsFor(indent),
        rowCols,
        `Indent_${indent.indentNumber || indent.id}`,
      );
      if (!ok) toast.error("Excel download failed");
    });
  };

  const renderSortIcon = (field) => {
    if (sortBy !== field) return null;
    return sortOrder === "asc" ? (
      <ChevronUp size={14} className="inline ml-1" />
    ) : (
      <ChevronDown size={14} className="inline ml-1" />
    );
  };

  const colCount = isAdmin ? 9 : 8;

  return (
    <div className="flex flex-col gap-4">
      {/* max-h, not a fixed height: a short list shouldn't leave empty space
          between the last row and the pagination bar. */}
      <div className="overflow-auto w-full border border-slate-200 rounded-xl bg-white shadow-sm max-h-[600px]">
        <table className="w-full text-left border-collapse whitespace-nowrap">
          <thead className="sticky top-0 bg-slate-50 z-10 shadow-sm">
            <tr className="text-xs text-slate-500 font-bold uppercase select-none">
              <th className="px-5 py-3 border-b border-slate-200 text-center w-[4%]">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
                  title="Select all indents"
                />
              </th>
              <th className="px-5 py-3 border-b border-slate-200">Indent No</th>
              <th className="px-5 py-3 border-b border-slate-200">Booking ID</th>
              {isAdmin && <th className="px-5 py-3 border-b border-slate-200">Customer</th>}
              <th
                className="px-5 py-3 border-b border-slate-200 cursor-pointer hover:bg-slate-100"
                onClick={() => handleSort("date")}
              >
                Date {renderSortIcon("date")}
              </th>
              <th
                className="px-5 py-3 border-b border-slate-200 cursor-pointer hover:bg-slate-100"
                onClick={() => handleSort("status")}
              >
                Status {renderSortIcon("status")}
              </th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">Items</th>
              <th
                className="px-5 py-3 border-b border-slate-200 text-center cursor-pointer hover:bg-slate-100"
                onClick={() => handleSort("qty")}
              >
                Qty {renderSortIcon("qty")}
              </th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            {loading ? (
              <TableSkeleton rows={8} columns={colCount} cellClass="px-5 py-4" />
            ) : currentIndents.length > 0 ? (
              currentIndents.map((indent) => (
                <tr
                  key={indent.id}
                  className="hover:bg-slate-50 transition-colors cursor-pointer"
                  onClick={() => setSelectedIndent(indent)}
                >
                  <td className="px-5 py-4 text-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(indent.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        toggleSelectId(indent.id);
                      }}
                      className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
                    />
                  </td>
                  <td className="px-5 py-4 font-bold text-amber-700">
                    <div className="flex items-center gap-2">
                      <span>{indent.indentNumber || "—"}</span>
                      {indent.allReady && (
                        <span
                          className="inline-flex items-center gap-1 text-[9px] font-bold text-emerald-700 bg-emerald-100 border border-emerald-200 px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                          title="Stock is available for every line in this indent"
                        >
                          <PackageCheck size={10} /> In Stock
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-4 font-bold text-slate-800">
                    {indent.bookingId || "—"}
                  </td>
                  {isAdmin && (
                    <td
                      className="px-5 py-4 font-bold text-slate-700 truncate max-w-[200px]"
                      title={indent.customer}
                    >
                      {indent.customer}
                    </td>
                  )}
                  <td className="px-5 py-4 text-slate-600">
                    {indent.date ? new Date(indent.date).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-5 py-4">
                    <IndentStatusBadge status={indent.status} />
                  </td>
                  <td className="px-5 py-4 text-center font-bold text-slate-700">
                    {indent.itemCount}
                  </td>
                  <td className="px-5 py-4 text-center font-black text-amber-600">
                    {indent.totalQuantity}
                  </td>
                  <td className="px-5 py-4 text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedIndent(indent);
                      }}
                      className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors focus:outline-none"
                      title="View Details"
                    >
                      <Eye size={18} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRowPDF(indent);
                      }}
                      className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors focus:outline-none"
                      title="Download PDF"
                    >
                      <FileDown size={18} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRowExcel(indent);
                      }}
                      className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors focus:outline-none"
                      title="Download Excel"
                    >
                      <FileSpreadsheet size={18} />
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={colCount} className="px-5 py-10 text-center text-slate-400">
                  No indents found matching your criteria.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-3 border border-slate-200 rounded-xl bg-white shadow-sm">
        <Pagination
          page={currentPage}
          pageSize={limit}
          totalItems={indents.length}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
};
