import { Link } from "react-router-dom";
import { ChevronRight, Home } from "lucide-react";
import { twMerge } from "tailwind-merge";

/**
 * Breadcrumb trail for HRMS pages.
 *
 * ---------------------------------------------------------------------------
 * DEVIATION FROM THE REFERENCE - noted deliberately
 * ---------------------------------------------------------------------------
 * DTA HRMS has no breadcrumb system. Searching its frontend finds exactly ONE
 * use, on the Operations project page, and Operations is out of scope (AD-5).
 * Its pages orient the user with a plain title instead.
 *
 * This is therefore an ADDITION, requested for the Phase 1 shell, not a parity
 * feature. It matters more here than it did there: HRMS is a section inside a
 * larger portal rather than the whole application, so a user needs to see where
 * they are relative to the portal they came from.
 *
 * Items: `[{ label, to? }]`. The last item is the current page and is never a
 * link - a link to where you already are is noise.
 */
export function Breadcrumb({ items = [], className }) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={twMerge("mb-3", className)}>
      <ol className="flex items-center gap-1.5 text-xs text-slate-500 flex-wrap">
        <li>
          <Link
            to="/"
            className="flex items-center gap-1 hover:text-slate-800 transition-colors"
            aria-label="Portal home"
          >
            <Home size={13} />
          </Link>
        </li>

        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1.5">
              <ChevronRight size={13} className="text-slate-300 shrink-0" />
              {isLast || !item.to ? (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={twMerge("truncate", isLast && "text-slate-800 font-semibold")}
                >
                  {item.label}
                </span>
              ) : (
                <Link to={item.to} className="hover:text-slate-800 transition-colors truncate">
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumb;
