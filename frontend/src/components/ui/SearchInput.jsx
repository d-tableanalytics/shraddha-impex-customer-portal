import { Search, X, Loader2 } from "lucide-react";
import { twMerge } from "tailwind-merge";

/**
 * The search box the list screens share (Sales Desk, Indent Stock Assignment),
 * so the two look and behave the same: icon on the left, a clear button once
 * something is typed, Escape to clear, and an optional spinner for a refresh
 * running behind the rows already on screen.
 *
 * Presentation only. `onChange` receives the new text; WHAT is searched, and
 * when (debounced, server or client side), stays with each screen.
 */
export const SearchInput = ({
  value,
  onChange,
  onClear,
  placeholder = "Search…",
  label = "Search",
  busy = false,
  busyLabel = "Refreshing",
  className,
}) => {
  const clear = () => (onClear ? onClear() : onChange(""));
  const hasValue = value !== "" && value != null;

  return (
    <div className={twMerge("relative w-full", className)}>
      <Search
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && hasValue) {
            e.preventDefault();
            clear();
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        className={`h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 ${
          hasValue && busy ? "pr-16" : hasValue || busy ? "pr-9" : "pr-3"
        }`}
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {busy && (
          <Loader2 size={14} aria-label={busyLabel} className="animate-spin text-slate-400" />
        )}
        {hasValue && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            title="Clear search (Esc)"
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
};

export default SearchInput;
