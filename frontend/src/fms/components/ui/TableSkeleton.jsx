import { SkeletonLoader } from "./SkeletonLoader";

/**
 * Placeholder rows shown while a table's data is still loading, so the user sees
 * the shape of the table filling in rather than a "No records found" empty state
 * that only means "not loaded yet".
 *
 * RENDERS <tr> ELEMENTS. It must go inside a <tbody>, never straight into a
 * <div> — the browser hoists stray rows out of the div and React reports
 * invalid nesting.
 *
 * @param {number} rows     How many placeholder rows to render.
 * @param {number} columns  Columns per row — match the real table's column count.
 * @param {string} cellClass Padding utility to line the cells up with the real rows.
 */
export const TableSkeleton = ({ rows = 6, columns = 4, cellClass = "px-6 py-4", ...rest }) => {
  // `cols` reads as the obvious name and silently fell back to the 4-column
  // default in three places, so the placeholder never matched the table it
  // stood in for. Caught loudly in development rather than eyeballed.
  if (import.meta.env.DEV && Object.keys(rest).length > 0) {
    console.error(
      `TableSkeleton: unknown prop(s) ${Object.keys(rest).join(", ")}. ` +
      "Did you mean `columns`? Column count has fallen back to the default.",
    );
  }

  return (
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
};

export default TableSkeleton;
