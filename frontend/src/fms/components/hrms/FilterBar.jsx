import { Search, X } from "lucide-react";
import { twMerge } from "tailwind-merge";

import { Button } from "../ui/Button";
import { SearchableSelect } from "./SearchableSelect";

/**
 * The search-plus-filters row that sits above every HRMS list.
 *
 * The reference repeats this shape verbatim on each list page - an Input with a
 * search icon, then two to four Selects, each resetting the page to 1 on change.
 * Resetting the page is the part that gets forgotten when it is hand-written
 * each time: filter on page 4, get an empty table, and the cause is invisible.
 * Doing it here means it cannot be missed.
 *
 *   <FilterBar
 *     search={filters.search}
 *     onSearchChange={(v) => setFilters(f => ({ ...f, search: v }))}
 *     filters={[
 *       { key: 'departmentId', placeholder: 'Department', options: deptOptions },
 *       { key: 'status',       placeholder: 'Status',     options: STATUS_OPTIONS },
 *     ]}
 *     values={filters}
 *     onChange={(key, value) => setFilters(f => ({ ...f, [key]: value }))}
 *     onReset={() => setFilters({})}
 *   />
 */
export function FilterBar({
  search = "",
  onSearchChange,
  searchPlaceholder = "Search…",
  filters = [],
  values = {},
  onChange,
  onReset,
  children,
  className,
}) {
  // A reset control that does nothing is worse than none, so it only appears
  // once something is actually filtered.
  const active =
    Boolean(search) || filters.some((f) => values[f.key] !== undefined && values[f.key] !== null);

  return (
    <div className={twMerge("flex flex-wrap items-end gap-3", className)}>
      {onSearchChange && (
        <div className="relative min-w-[240px] flex-1 max-w-sm">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none transition-all placeholder-slate-400 text-slate-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>
      )}

      {filters.map((f) => (
        <SearchableSelect
          key={f.key}
          className={f.width ?? "w-48"}
          value={values[f.key] ?? null}
          onChange={(v) => onChange?.(f.key, v)}
          options={f.options ?? []}
          placeholder={f.placeholder}
          loading={f.loading}
          disabled={f.disabled}
        />
      ))}

      {children}

      {active && onReset && (
        <Button variant="ghost" onClick={onReset} className="text-slate-500">
          <X size={14} className="mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
}

export default FilterBar;
