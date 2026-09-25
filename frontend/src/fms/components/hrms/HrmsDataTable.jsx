import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { twMerge } from "tailwind-merge";

import { Pagination } from "../ui/Pagination";
import { TableSkeleton } from "../ui/TableSkeleton";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "./ErrorState";

/**
 * A SERVER-paginated table.
 *
 * ---------------------------------------------------------------------------
 * Why not the existing DataTable
 * ---------------------------------------------------------------------------
 * `components/ui/DataTable` sorts and slices in memory: it takes the whole
 * array and pages it client-side. That is right for the lists it serves, and
 * wrong for HRMS. Every list endpoint in the reference is server-paginated and
 * returns `{ data, total, page, pageSize }`, and AD-13 requires server-side
 * pagination regardless of how small the dataset looks today - a table that
 * works at 200 employees by loading all of them stops working at 2,000.
 *
 * So this is a second table, deliberately, and the two are not
 * interchangeable. It reuses Pagination, TableSkeleton and EmptyState rather
 * than reimplementing them.
 *
 * Column shape matches the existing DataTable so the two read alike:
 *   { header, accessorKey?, cell?, sortable?, className?, headerClassName? }
 *
 * Row interaction follows the reference: clicking a row opens its detail, and
 * clicks landing on an interactive control inside the row are ignored so a
 * checkbox or a menu does not also navigate.
 */

const INTERACTIVE = "a,button,input,select,textarea,label,[role='button'],[data-no-row-click]";

export function HrmsDataTable({
  columns,
  rows,
  loading = false,
  error = null,
  onRetry,

  // Server-side pagination. `total` is the count across ALL pages.
  page = 1,
  pageSize = 25,
  total = 0,
  onPageChange,

  // Server-side sorting.
  sortBy = null,
  sortDir = "asc",
  onSortChange,

  onRowClick,
  rowKey = (row) => row.id ?? row._id,

  emptyTitle = "Nothing here yet",
  emptyDescription = "No records match your current filters.",
  className,
}) {
  /**
   * A page that is still loading, or one whose request failed, has no rows to
   * give. Treating that as an empty set renders the skeleton or the error
   * state, which is what the caller wants; reading `.length` off it instead
   * takes down the whole route with a render error, which is never what the
   * caller wants. A missing dataset is a normal moment in a table's life, not
   * a programming mistake worth crashing over.
   */
  const safeRows = Array.isArray(rows) ? rows : [];

  const showPagination = !loading && !error && total > pageSize;

  const handleSort = (key) => {
    if (!onSortChange || !key) return;
    onSortChange(key, sortBy === key && sortDir === "asc" ? "desc" : "asc");
  };

  const SortIcon = ({ column }) => {
    if (!column.sortable || !column.accessorKey) return null;
    if (sortBy !== column.accessorKey) {
      return <ChevronsUpDown size={13} className="text-slate-300" />;
    }
    return sortDir === "asc" ? <ChevronUp size={13} /> : <ChevronDown size={13} />;
  };

  return (
    <div
      className={twMerge(
        "flex flex-col w-full bg-white border border-slate-200 rounded-xl overflow-hidden shadow-enterprise",
        className,
      )}
    >
      {error ? (
        <ErrorState
          variant={error.isForbidden ? "forbidden" : error.isNotImplemented ? "unavailable" : "error"}
          description={error.message}
          onRetry={onRetry}
          className="border-0 rounded-none"
        />
      ) : (
        <div className="overflow-x-auto w-full">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {columns.map((col, idx) => {
                  const sortable = col.sortable && col.accessorKey && onSortChange;
                  return (
                    <th
                      key={col.accessorKey ?? idx}
                      scope="col"
                      onClick={sortable ? () => handleSort(col.accessorKey) : undefined}
                      aria-sort={
                        sortBy === col.accessorKey
                          ? sortDir === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                      className={twMerge(
                        "px-6 py-4 text-left text-xs font-bold text-slate-500 uppercase tracking-wider",
                        sortable &&
                          "cursor-pointer select-none hover:bg-slate-100 hover:text-slate-900 transition-colors",
                        col.headerClassName,
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        {col.header}
                        <SortIcon column={col} />
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100 bg-white">
              {loading ? (
                <TableSkeleton rows={Math.min(pageSize, 8)} columns={columns.length} />
              ) : safeRows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="p-0">
                    <EmptyState
                      title={emptyTitle}
                      description={emptyDescription}
                      className="border-0 rounded-none py-12"
                    />
                  </td>
                </tr>
              ) : (
                safeRows.map((row, rIdx) => (
                  <tr
                    key={rowKey(row) ?? rIdx}
                    onClick={
                      onRowClick
                        ? (e) => {
                            // A click on a control inside the row belongs to
                            // that control, not to the row.
                            if (e.target.closest(INTERACTIVE)) return;
                            onRowClick(row);
                          }
                        : undefined
                    }
                    className={twMerge(
                      "transition-colors",
                      onRowClick ? "cursor-pointer hover:bg-slate-50" : "hover:bg-slate-50/50",
                    )}
                  >
                    {columns.map((col, cIdx) => (
                      <td
                        key={col.accessorKey ?? cIdx}
                        className={twMerge(
                          "px-6 py-4 text-sm text-slate-700 font-medium",
                          col.className,
                        )}
                      >
                        {col.cell
                          ? col.cell(row)
                          : col.accessorKey
                            ? String(row[col.accessorKey] ?? "—")
                            : ""}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {showPagination && (
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/50">
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={total}
            onPageChange={onPageChange}
          />
        </div>
      )}
    </div>
  );
}

export default HrmsDataTable;
