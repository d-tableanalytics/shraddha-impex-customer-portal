import { ChevronUp, ChevronDown, Eye, FileDown, PackageX, FileSpreadsheet } from "lucide-react";
import toast from "react-hot-toast";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useCartStore } from "../../store/cartStore";
import { useUserStore } from "../../store/userStore";
import { Pagination } from "../ui/Pagination";
import { TableSkeleton } from "../ui/TableSkeleton";

export const OrderHistoryTable = () => {
  const {
    orders,
    loading,
    sortBy,
    sortOrder,
    setSort,
    page,
    setPage,
    limit,
    setSelectedOrder,
    selectedIds,
    toggleSelectId,
    toggleSelectAll,
  } = useOrderHistoryStore();

  // PO numbers that have unfulfilled pending indents — used to flag rows.
  const pendingItems = useCartStore((s) => s.pendingItems);
  const indentPOs = new Set(
    pendingItems.map((p) => p.poNumber).filter(Boolean),
  );

  const isAdmin = useUserStore((s) => s.user?.role === "Admin");

  const totalPages = Math.max(1, Math.ceil(orders.length / limit));
  const currentPage = Math.min(page, totalPages);
  const currentOrders = orders.slice((currentPage - 1) * limit, currentPage * limit);
  const allSelected =
    orders.length > 0 && orders.every((o) => selectedIds.includes(o.orderNumber));

  const handleSort = (field) => {
    if (sortBy === field) {
      setSort(field, sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSort(field, "desc");
    }
  };

  const handleRowPDF = (order) => {
    import("../../utils/exportUtils").then(({ exportToPDF }) => {
      const cols = [
        { key: "sku", label: "SKU Code" },
        { key: "quantity", label: "Quantity" },
      ];
      const items = (order.items || []).map((it) => ({
        sku: it.product?.code || it.product?.name || "-",
        quantity: it.orderQuantity ?? it.quantity ?? 0,
      }));
      const ok = exportToPDF(
        items,
        cols,
        `Booking ${order.orderNumber} — ${order.customer || ""}`,
        `Booking_${order.orderNumber}`,
      );
      if (!ok) toast.error("PDF download failed");
    });
  };

  const handleRowExcel = (order) => {
    import("../../utils/exportUtils").then(({ exportToExcel }) => {
      const cols = [
        { key: "bookingId", label: "Booking ID" },
        { key: "sku", label: "SKU Code" },
        { key: "productName", label: "Product Name" },
        { key: "quantity", label: "Quantity" },
      ];
      const items = (order.items || []).map((it) => ({
        bookingId: order.orderNumber,
        sku: it.product?.code || "-",
        productName: it.product?.name || "-",
        quantity: it.orderQuantity ?? it.quantity ?? 0,
      }));
      const ok = exportToExcel(
        items,
        cols,
        `Booking_${order.orderNumber}`,
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

  return (
    <div className="flex flex-col gap-4">
      {/* max-h, not a fixed height: a short list shouldn't leave 600px of empty
          box between the last row and the pagination bar. */}
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
                  title="Select all bookings"
                />
              </th>
              <th className="px-5 py-3 border-b border-slate-200">Booking ID</th>
              {isAdmin && <th className="px-5 py-3 border-b border-slate-200">Customer</th>}
              <th className="px-5 py-3 border-b border-slate-200">PO Number</th>
              <th
                className="px-5 py-3 border-b border-slate-200 cursor-pointer hover:bg-slate-100"
                onClick={() => handleSort("date")}
              >
                Date {renderSortIcon("date")}
              </th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">
                Items
              </th>
              <th className="px-5 py-3 border-b border-slate-200 text-center">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            {loading ? (
              <TableSkeleton rows={8} columns={isAdmin ? 7 : 6} cellClass="px-5 py-4" />
            ) : currentOrders.length > 0 ? (
              currentOrders.map((order) => (
                <tr
                  key={order.id}
                  className="hover:bg-slate-50 transition-colors cursor-pointer"
                  onClick={() => setSelectedOrder(order)}
                >
                  <td className="px-5 py-4 text-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(order.orderNumber)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        toggleSelectId(order.orderNumber);
                      }}
                      className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
                    />
                  </td>
                  <td className="px-5 py-4 font-bold text-slate-800">
                    <div className="flex items-center gap-2">
                      <span>{order.orderNumber}</span>
                      {indentPOs.has(order.poNumber) && (
                        <span
                          className="inline-flex items-center gap-1 text-[9px] font-bold text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                          title="This booking has items to raise an indent for"
                        >
                          <PackageX size={10} /> Raise Indent
                        </span>
                      )}
                    </div>
                  </td>
                  {isAdmin && (
                    <td className="px-5 py-4 font-bold text-slate-700 truncate max-w-[200px]" title={order.customer}>
                      {order.customer}
                    </td>
                  )}
                  <td className="px-5 py-4 font-medium text-slate-600">
                    {order.poNumber || "-"}
                  </td>
                  <td className="px-5 py-4 text-slate-600">
                    {new Date(order.date).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-4 text-center font-bold text-slate-700">
                    {order.totalQuantity}
                  </td>
                  <td className="px-5 py-4 text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedOrder(order);
                      }}
                      className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors focus:outline-none"
                      title="View Details"
                    >
                      <Eye size={18} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRowPDF(order);
                      }}
                      className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors focus:outline-none"
                      title="Download PDF"
                    >
                      <FileDown size={18} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRowExcel(order);
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
                <td
                  colSpan={isAdmin ? 7 : 6}
                  className="px-5 py-10 text-center text-slate-400"
                >
                  No bookings found matching your criteria.
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
          totalItems={orders.length}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
};
