import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X, Loader2 } from "lucide-react";
import { twMerge } from "tailwind-merge";

/**
 * A type-to-filter single select.
 *
 * ---------------------------------------------------------------------------
 * Why not the existing Autocomplete
 * ---------------------------------------------------------------------------
 * `components/ui/Autocomplete` reads `useProductStore` and searches products
 * directly - it is a product picker, not a select. HRMS needs the same
 * interaction for departments, locations, managers and leave types, so this one
 * is option-driven and knows nothing about what it is listing.
 *
 * Mirrors the reference's `<Select showSearch allowClear>`, which is how every
 * HRMS filter and form picker there behaves.
 *
 * Options: `[{ value, label, hint? }]`. `hint` renders as secondary text, which
 * is what an employee picker needs to disambiguate two people with the same name.
 */
export function SearchableSelect({
  value = null,
  onChange,
  options = [],
  placeholder = "Select…",
  searchPlaceholder = "Type to filter…",
  allowClear = true,
  loading = false,
  disabled = false,
  error,
  label,
  className,
  emptyText = "No matches",
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  const selected = useMemo(
    () => options.find((o) => String(o.value) === String(value)) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        String(o.label).toLowerCase().includes(q) ||
        String(o.hint ?? "").toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);

  const choose = (option) => {
    onChange?.(option ? option.value : null, option);
    setOpen(false);
  };

  return (
    <div className={twMerge("w-full flex flex-col gap-1.5", className)} ref={containerRef}>
      {label && <label className="text-xs font-semibold text-slate-700 select-none">{label}</label>}

      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={twMerge(
            "w-full flex items-center gap-2 px-3 py-2 text-sm bg-white border rounded-lg shadow-sm outline-none transition-all text-left",
            "border-slate-300 hover:border-slate-400",
            "focus:border-primary-500 focus:ring-1 focus:ring-primary-500",
            "disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed",
            error && "border-error-500 focus:border-error-500 focus:ring-error-500",
          )}
        >
          <span className={twMerge("flex-1 truncate", !selected && "text-slate-400")}>
            {selected ? selected.label : placeholder}
          </span>

          {loading && <Loader2 size={14} className="animate-spin text-slate-400 shrink-0" />}

          {allowClear && selected && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Clear selection"
              onClick={(e) => {
                // Clearing must not also reopen the menu.
                e.stopPropagation();
                choose(null);
              }}
              className="p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 shrink-0"
            >
              <X size={13} />
            </span>
          )}

          <ChevronDown
            size={15}
            className={twMerge("text-slate-400 shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>

        {open && (
          <div className="absolute z-30 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-enterprise-lg overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
              <Search size={14} className="text-slate-400 shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full text-sm outline-none placeholder-slate-400"
              />
            </div>

            <ul role="listbox" className="max-h-60 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-6 text-center text-xs text-slate-400">{emptyText}</li>
              ) : (
                filtered.map((o) => {
                  const isSelected = String(o.value) === String(value);
                  return (
                    <li key={o.value} role="option" aria-selected={isSelected}>
                      <button
                        type="button"
                        onClick={() => choose(o)}
                        className={twMerge(
                          "w-full text-left px-3 py-2 text-sm transition-colors",
                          isSelected
                            ? "bg-primary-50 text-primary-800 font-semibold"
                            : "text-slate-700 hover:bg-slate-50",
                        )}
                      >
                        <span className="block truncate">{o.label}</span>
                        {o.hint && (
                          <span className="block text-[11px] text-slate-400 truncate">{o.hint}</span>
                        )}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        )}
      </div>

      {error && <span className="text-xs text-error-500 font-medium">{error}</span>}
    </div>
  );
}

export default SearchableSelect;
