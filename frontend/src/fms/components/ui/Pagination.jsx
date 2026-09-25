import { useId, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

// Page numbers to render: always the first and last page, plus a window around
// the current one. Gaps become an ellipsis so the bar keeps a stable width on
// big tables.
const buildPageList = (page, totalPages) => {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const pages = new Set([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  const withGaps = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) withGaps.push(`gap-${p}`);
    withGaps.push(p);
  });
  return withGaps;
};

const navBtn =
  "h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 " +
  "hover:bg-slate-50 hover:text-slate-900 hover:border-slate-300 transition-colors " +
  "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-slate-200";

const pageBtn =
  "h-9 min-w-9 px-2.5 inline-flex items-center justify-center rounded-lg border text-sm font-bold transition-colors";

/**
 * Reusable pagination bar.
 *
 * Layout: the visible range on the left; first / prev / numbered pages / next /
 * last in the middle; a "Go to page" box on the right so the user can jump
 * straight to any page instead of stepping through them.
 *
 * @param {number}   page       Current page (1-based).
 * @param {number}   pageSize   Rows per page.
 * @param {number}   totalItems Total rows across all pages — must count the same
 *                              unit the table renders (e.g. grouped rows, not
 *                              the flat records behind them).
 */
export const Pagination = ({ page, pageSize, totalItems, onPageChange, className = "" }) => {
  const [jump, setJump] = useState("");
  // Unique per instance — a page can show several tables, each with its own bar.
  const jumpId = useId();

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const from = totalItems === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, totalItems);

  // Clamp rather than reject — typing 999 on a 12-page table lands on page 12.
  const goTo = (value) => {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) return;
    const target = Math.min(Math.max(parsed, 1), totalPages);
    if (target !== current) onPageChange(target);
    setJump("");
  };

  return (
    <div
      className={`flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 text-sm ${className}`}
    >
      {/* Range summary */}
      <p className="text-slate-500 font-medium order-2 lg:order-1">
        Showing <span className="font-bold text-slate-800">{from}</span>
        {"-"}
        <span className="font-bold text-slate-800">{to}</span> of{" "}
        <span className="font-bold text-slate-800">{totalItems}</span> entries
      </p>

      {/* Controls stay visible on a single page (the arrows simply sit disabled)
          so a short table never looks like it has no pagination at all. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 order-1 lg:order-2">
        <nav className="flex items-center gap-1" aria-label="Pagination">
          <button
            type="button"
            disabled={current <= 1}
            onClick={() => onPageChange(1)}
            className={navBtn}
            title="First page"
            aria-label="First page"
          >
            <ChevronsLeft size={16} />
          </button>
          <button
            type="button"
            disabled={current <= 1}
            onClick={() => onPageChange(current - 1)}
            className={navBtn}
            title="Previous page"
            aria-label="Previous page"
          >
            <ChevronLeft size={16} />
          </button>

          {buildPageList(current, totalPages).map((p) =>
            typeof p === "number" ? (
              <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                aria-current={p === current ? "page" : undefined}
                className={`${pageBtn} ${
                  p === current
                    ? "bg-primary-600 border-primary-600 text-white shadow-sm"
                    : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900 hover:border-slate-300"
                }`}
              >
                {p}
              </button>
            ) : (
              <span
                key={p}
                aria-hidden="true"
                className="h-9 w-6 inline-flex items-end justify-center text-slate-400 font-bold select-none"
              >
                ...
              </span>
            ),
          )}

          <button
            type="button"
            disabled={current >= totalPages}
            onClick={() => onPageChange(current + 1)}
            className={navBtn}
            title="Next page"
            aria-label="Next page"
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            disabled={current >= totalPages}
            onClick={() => onPageChange(totalPages)}
            className={navBtn}
            title="Last page"
            aria-label="Last page"
          >
            <ChevronsRight size={16} />
          </button>
        </nav>

        {/* Direct jump — type a page number, press Enter or hit Go. Pointless
            when everything already fits on one page, so it hides there. */}
        {totalPages > 1 && (
          <div className="flex items-center gap-2 lg:pl-4 lg:border-l lg:border-slate-200">
            <label className="text-slate-500 font-medium whitespace-nowrap" htmlFor={jumpId}>
              Go to page
            </label>
            <div className="flex items-center rounded-lg border border-slate-200 bg-white overflow-hidden focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/20">
              <input
                id={jumpId}
                type="number"
                min={1}
                max={totalPages}
                value={jump}
                onChange={(e) => setJump(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    goTo(jump);
                  }
                }}
                placeholder={String(current)}
                aria-label={`Page number, 1 to ${totalPages}`}
                className="h-9 w-14 px-2 text-center text-sm font-bold text-slate-800 outline-none bg-transparent placeholder:text-slate-400 placeholder:font-medium [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span className="h-9 px-2 inline-flex items-center text-xs font-semibold text-slate-400 bg-slate-50 border-l border-slate-200 whitespace-nowrap">
                of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => goTo(jump)}
                disabled={jump === ""}
                className="h-9 px-3 text-sm font-bold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Go
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Pagination;
