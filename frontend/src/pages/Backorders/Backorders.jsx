import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { PackageX, Download } from "lucide-react";
import { useCartStore } from "../../store/cartStore";
import { useUserStore } from "../../store/userStore";
import { PageHeader } from "../../components/common/PageHeader";
import { BackordersTable, groupByIndent } from "../../components/backorders/BackordersTable";
import { Pagination } from "../../components/ui/Pagination";
import { SkeletonLoader } from "../../components/ui/SkeletonLoader";

const PAGE_SIZE = 10;

export const Backorders = () => {
  const { pendingItems, pendingLoading, fetchPendingReservations, restorePending } = useCartStore();
  const { user } = useUserStore();
  const isAdmin = user?.role === "Admin";
  const [page, setPage] = useState(1);
  const [restoringId, setRestoringId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);

  const allGroups = pendingItems.length ? groupByIndent(pendingItems) : [];

  const toggleSelectId = (id) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // Rows are grouped indents, so paging counts groups — not the flat lines
  // behind them — otherwise "showing 1-10" disagrees with the rows on screen.
  const totalPages = Math.ceil(allGroups.length / PAGE_SIZE) || 1;
  const currentPage = Math.min(page, totalPages);
  const pageGroups = allGroups.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pageItems = pageGroups.flatMap((g) => g.lines);

  const toggleSelectAll = () => {
    // Only toggling selection for the current page
    const currentPageIds = pageGroups.map(g => g.indentNumber || g.primary._id);

    const allSelectedOnPage = currentPageIds.every(id => selectedIds.includes(id));

    if (allSelectedOnPage) {
      setSelectedIds(prev => prev.filter(id => !currentPageIds.includes(id)));
    } else {
      setSelectedIds(prev => [...new Set([...prev, ...currentPageIds])]);
    }
  };

  const exportToExcel = (groupsToExport) => {
    import("../../utils/exportUtils").then(({ exportToExcel }) => {
      const cols = [
        { key: "indentNo", label: "Indent No" },
        { key: "date", label: "Date" },
        { key: "sku", label: "SKU Code" },
        ...(isAdmin ? [{ key: "customer", label: "Customer" }] : []),
        { key: "pendingQty", label: "Qty" },
        { key: "stock", label: "Current Stock" },
        { key: "status", label: "Status" },
      ];

      const rows = [];
      groupsToExport.forEach(group => {
        group.lines.forEach(line => {
          rows.push({
            indentNo: group.indentNumber || "—",
            date: line.updatedAt ? new Date(line.updatedAt).toLocaleDateString() : "—",
            sku: line.product?.code || "—",
            customer: line.customer?.name || "—",
            pendingQty: line.pendingQuantity || 0,
            stock: line.product?.availableStock || 0,
            status: line.status || "—",
          });
        });
      });

      exportToExcel(rows, cols, "Pending_Indents");
    });
  };

  const handleBulkExport = () => {
    if (allGroups.length === 0) {
      toast.error("No pending indents to export");
      return;
    }
    let toExport = allGroups;
    if (selectedIds.length > 0) {
      toExport = allGroups.filter(g => selectedIds.includes(g.indentNumber || g.primary._id));
    }
    exportToExcel(toExport);
  };

  const handleExportRow = (group) => {
    exportToExcel([group]);
  };

  useEffect(() => {
    fetchPendingReservations();
  }, [fetchPendingReservations]);

  const handleRestore = async (item) => {
    setRestoringId(item._id);
    const res = await restorePending(item._id);
    setRestoringId(null);
    if (res.success) {
      toast.success(
        `${item.product.code} moved to ${item.customer?.name || "the customer"}'s selection list. They've been emailed to confirm.`,
      );
    } else {
      toast.error(res.error || "Could not move indent to selection list.");
    }
  };

  const totalPendingQty = pendingItems.reduce(
    (sum, i) => sum + (i.pendingQuantity || 0),
    0,
  );

  // Distinct booking confirmations represented in the indent list
  // (grouped by indentNumber; ungrouped/legacy rows each count as their own).
  const distinctIndents = new Set(
    pendingItems.map((i) => i.indentNumber || i._id),
  ).size;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Indent History"
        actions={
          <div className="flex gap-2">
            <button
              onClick={handleBulkExport}
              className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 border border-primary-600 rounded-lg px-3 py-1.5 transition-all"
            >
              <Download size={14} />
              Export{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
            </button>
          </div>
        }
      />
      <p className="text-slate-500 text-sm font-medium -mt-2">
        {isAdmin
          ? "Unfulfilled quantities across all customers, awaiting fresh stock."
          : "Your unfulfilled quantities, awaiting fresh stock."}
      </p>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-amber-200/70 shadow-sm">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
            Indents
          </p>
          {pendingLoading ? (
            <SkeletonLoader variant="text" className="h-8 w-16 mt-1" />
          ) : (
            <h3 className="text-2xl font-bold text-slate-900 mt-1">{distinctIndents}</h3>
          )}
        </div>
        <div className="bg-white p-5 rounded-2xl border border-amber-200/70 shadow-sm">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
            Indent Lines
          </p>
          {pendingLoading ? (
            <SkeletonLoader variant="text" className="h-8 w-16 mt-1" />
          ) : (
            <h3 className="text-2xl font-bold text-slate-900 mt-1">{pendingItems.length}</h3>
          )}
        </div>
        <div className="bg-white p-5 rounded-2xl border border-amber-200/70 shadow-sm">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
            Total Indent Qty
          </p>
          {pendingLoading ? (
            <SkeletonLoader variant="text" className="h-8 w-16 mt-1" />
          ) : (
            <h3 className="text-2xl font-bold text-amber-600 mt-1">{totalPendingQty}</h3>
          )}
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl border border-slate-200/60 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-400 to-orange-500" />
        <div className="flex items-center gap-2 mb-4">
          <PackageX size={18} className="text-amber-500" />
          <h2 className="text-lg font-black text-slate-900 tracking-tight">Indent Details</h2>
        </div>
        <BackordersTable
          items={pageItems}
          loading={pendingLoading}
          showCustomer={isAdmin}
          selectedIds={selectedIds}
          toggleSelectId={toggleSelectId}
          toggleSelectAll={toggleSelectAll}
          onExportRow={handleExportRow}
        />

        {!pendingLoading && allGroups.length > 0 && (
          <div className="mt-4 -mx-6 -mb-6 px-6 py-4 border-t border-slate-100 bg-slate-50/60">
            <Pagination
              page={currentPage}
              pageSize={PAGE_SIZE}
              totalItems={allGroups.length}
              onPageChange={setPage}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default Backorders;
