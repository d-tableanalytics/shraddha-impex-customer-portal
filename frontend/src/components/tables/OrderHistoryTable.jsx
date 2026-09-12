import { ChevronUp, ChevronDown, Eye, FileDown, PackageX, FileSpreadsheet, MapPin, Phone } from "lucide-react";
import toast from "react-hot-toast";
import { useOrderHistoryStore } from "../../store/orderHistoryStore";
import { useCartStore } from "../../store/cartStore";
import { useUserStore } from "../../store/userStore";
import { Pagination } from "../ui/Pagination";
import { TableSkeleton } from "../ui/TableSkeleton";
import {
  CUSTOMER_EXPORT_COLS, customerExportRow, exportDate, poNumberValue,
} from "../../utils/historyExportColumns";

import { isSuperAdmin } from "../../utils/permissions";
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

  /* Bookings with unfulfilled indents against them — the "Indent" badge.
     Matched on the BOOKING ID the server reports for each indent, with the PO
     number as a secondary key for rows that predate it.

     It used to match on PO number alone, and an indent with no PO carries the
     placeholder '-' rather than a number: '-' passed the truthiness filter, so
     every booking that had no PO raised — also stored as '-' — matched every
     other one and wore the badge whether or not it had an indent. The server
     now normalises that placeholder away, which is what makes the ids here the
     only thing being compared. */
  const pendingItems = useCartStore((s) => s.pendingItems);
  const indentBookingIds = new Set(
    pendingItems.map((p) => p.bookingId).filter(Boolean),
  );
  const indentPOs = new Set(
    pendingItems.map((p) => p.poNumber).filter(Boolean),
  );
  const hasIndent = (order) =>
    indentBookingIds.has(order.orderNumber)
    || (Boolean(order.poNumber) && indentPOs.has(order.poNumber));

  const isAdmin = useUserStore((s) => isSuperAdmin(s.user));

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

  /* One booking's lines, carrying the same customer and transaction block the
     whole-history export does. The fields repeat down the sheet because a row
     of a flat export has to stand on its own — and because a single-booking
     export and a filtered one should not be two different documents. */
  const rowExportBlock = (order) => ({
    ...customerExportRow({
      name: order.customer,
      profile: order.customerProfile,
      shopNumber: order.shopNumber,
      location: order.customerLocation || order.shippingAddress || order.location,
    }),
    bookingId: order.orderNumber,
    date: order.date,
    poNumber: order.poNumber,
  });

  const ROW_EXPORT_COLS = [
    { key: "bookingId", label: "Booking ID" },
    ...CUSTOMER_EXPORT_COLS,
    { key: "date", label: "Booking Date", format: exportDate },
    { key: "poNumber", label: "PO Number", format: poNumberValue },
  ];

  const handleRowPDF = (order) => {
    import("../../utils/exportUtils").then(({ exportToPDF }) => {
      const cols = [
        ...ROW_EXPORT_COLS,
        { key: "sku", label: "SKU Code" },
        { key: "quantity", label: "Quantity" },
      ];
      const items = (order.items || []).map((it) => ({
        ...rowExportBlock(order),
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
        ...ROW_EXPORT_COLS,
        { key: "sku", label: "SKU Code" },
        { key: "productName", label: "Product Name" },
        { key: "quantity", label: "Quantity" },
      ];
      const items = (order.items || []).map((it) => ({
        ...rowExportBlock(order),
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
              {isAdmin && <th className="px-5 py-3 border-b border-slate-200">Customer Name</th>}
              {isAdmin && <th className="px-5 py-3 border-b border-slate-200">Company Name</th>}
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
              <TableSkeleton rows={8} columns={isAdmin ? 8 : 6} cellClass="px-5 py-4" />
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
                      {hasIndent(order) && (
                        <span
                          className="inline-flex items-center gap-1 text-[9px] font-bold text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                          title="This booking has items to raise an indent for"
                        >
                          <PackageX size={10} /> Indent
                        </span>
                      )}
                    </div>
                  </td>
                  {isAdmin && (
                    /* WHO the customer is. Previously this cell stacked the name
                       over the company to save a column, on the reasoning that a
                       booking list which scrolls sideways is worse than a
                       two-line cell. That is still true in general, but it made
                       the two facts impossible to scan down and impossible to
                       tell apart when one was missing - which is exactly the
                       complaint. They are now separate columns, and the
                       location/phone line stays here under the name it belongs
                       to. The table's own `overflow-x-auto` covers narrow
                       screens. */
                    <td className="px-5 py-4 max-w-[220px]">
                      <div
                        className="font-bold text-slate-700 truncate"
                        title={order.customerName || 'No customer name on the master record'}
                      >
                        {order.customerName || <span className="font-normal text-slate-400">—</span>}
                      </div>
                      {(order.customerLocation || order.customerPhone) && (
                        <div
                          className="text-[11px] text-slate-400 truncate flex items-center gap-1.5"
                          title={[order.customerLocation, order.customerPhone].filter(Boolean).join(' · ')}
                        >
                          {order.customerLocation && (
                            <span className="inline-flex items-center gap-1 min-w-0">
                              <MapPin size={10} className="shrink-0" />
                              <span className="truncate">{order.customerLocation}</span>
                            </span>
                          )}
                          {order.customerLocation && order.customerPhone && <span>·</span>}
                          {order.customerPhone && (
                            <span className="inline-flex items-center gap-1 shrink-0">
                              <Phone size={10} />
                              {order.customerPhone}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  )}
                  {isAdmin && (
                    /* Kept as its own column, per the requirement. Shown even
                       when it matches the customer name: a blank here would
                       read as "no company recorded" rather than "same as the
                       name", and the admin cannot tell those apart. */
                    <td className="px-5 py-4 max-w-[200px]">
                      <div className="text-slate-600 truncate" title={order.customerCompany || ''}>
                        {order.customerCompany || <span className="text-slate-400">—</span>}
                      </div>
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
                  colSpan={isAdmin ? 8 : 6}
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
