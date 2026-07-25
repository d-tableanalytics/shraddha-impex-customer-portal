import { SkeletonLoader } from "./SkeletonLoader";

/**
 * Placeholder rows shown while a table's data is still loading, so the user sees
 * the shape of the table filling in rather than a "No records found" empty state
 * that only means "not loaded yet".
 *
 * @param {number} rows     How many placeholder rows to render.
 * @param {number} columns  Columns per row — match the real table's column count.
 * @param {string} cellClass Padding utility to line the cells up with the real rows.
 */
export const TableSkeleton = ({ rows = 6, columns = 4, cellClass = "px-6 py-4" }) => (
  <>
    {Array.from({ length: rows }).map((_, r) => (
      <tr key={r} className="border-b border-slate-100 last:border-0">
        {Array.from({ length: columns }).map((_, c) => (
          <td key={c} className={cellClass}>
            {/* Vary the width a little so it reads as content, not a grid. */}
            <SkeletonLoader
              variant="text"
              className={c === 0 ? "w-1/2" : c === columns - 1 ? "w-1/4" : "w-3/4"}
            />
          </td>
        ))}
      </tr>
    ))}
  </>
);

export default TableSkeleton;
