import React, { useState, useEffect, useRef } from "react";
import { Search, Loader2 } from "lucide-react";
import { useProductStore } from "../../store/productStore";
import { useUserStore } from "../../store/userStore";
import { useShowMsilCode } from "../../hooks/useShowMsilCode";
import { canViewLineItemBoxNo } from "../../utils/permissions";

export const ProductSearchDropdown = ({
  placeholder = "Search Product Code...",
  value,
  onChange,
  error,
}) => {
  const [inputValue, setInputValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);

  const showMsilCode = useShowMsilCode();
  // This dropdown picks the SKU a line item is built from, so it follows the
  // line-item rule: Sales and Admin see the box, the customer placing the order
  // does not.
  const showBoxNo = canViewLineItemBoxNo(useUserStore((s) => s.user));

  const searchResults = useProductStore((state) => state.searchResults);
  const searching = useProductStore((state) => state.searching);
  const searchProducts = useProductStore((state) => state.searchProducts);
  const searchTotal = useProductStore((state) => state.searchTotal);
  const searchHasMore = useProductStore((state) => state.searchHasMore);
  const searchLoadingMore = useProductStore((state) => state.searchLoadingMore);
  const loadMoreSearchResults = useProductStore((state) => state.loadMoreSearchResults);
  const clearSearchResults = useProductStore(
    (state) => state.clearSearchResults,
  );

  const containerRef = useRef(null);
  const listRef = useRef(null);

  // Pull the next page when the list is scrolled near its end. A one-character
  // term matches thousands of SKUs; rendering them all at once would freeze the
  // browser, so they arrive a page at a time and every match stays reachable.
  const handleListScroll = (e) => {
    if (!searchHasMore || searchLoadingMore) return;
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - (scrollTop + clientHeight) < 80) loadMoreSearchResults();
  };

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // What the user has TYPED, as opposed to what the field is displaying. The
  // two differ when the parent pushes a value in (after a selection, or a
  // reset), and searching on the displayed value would fire a pointless request
  // for the full code every time a line is picked.
  const [term, setTerm] = useState("");

  // One request per pause, not one per keystroke. 300ms matches the other
  // search boxes in the app. Without it, typing an 11-character SKU fired
  // eleven catalogue queries, the widest of which is the slowest.
  useEffect(() => {
    if (!term.trim()) {
      clearSearchResults();
      return undefined;
    }
    const timer = setTimeout(() => searchProducts(term), 300);
    return () => clearTimeout(timer);
    // searchProducts and clearSearchResults are stable zustand actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  const handleInputChange = (e) => {
    const val = e.target.value;
    setInputValue(val);
    setTerm(val);
    setIsOpen(true);
    if (!val.trim()) onChange(null);
  };

  const handleSelect = (product) => {
    setInputValue(product.code);
    // Cleared, not set to the code: the debounce watches `term`, and leaving
    // the picked code in it would fire one more search for a line already
    // chosen. Typing again sets it afresh.
    setTerm("");
    setIsOpen(false);
    onChange(product);
  };

  return (
    <div ref={containerRef} className="relative w-full flex flex-col gap-1.5">

      <div className="relative">
        <input
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          className={`w-full pl-9 pr-8 py-2 text-sm bg-white border rounded-lg shadow-sm outline-none transition-all ${
            error
              ? "border-error-500 focus:border-error-500 focus:ring-1 focus:ring-error-500"
              : "border-slate-300 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          }`}
        />

        <div className="absolute left-3 top-2.5 text-slate-400">
          <Search size={16} />
        </div>

        {searching && (
          <div className="absolute right-3 top-2.5 text-slate-400">
            <Loader2 size={16} className="animate-spin text-primary-500" />
          </div>
        )}
      </div>

      {error && (
        <span className="text-xs text-error-500 font-medium">{error}</span>
      )}

      {isOpen && inputValue.trim().length > 0 && (
        <div
          ref={listRef}
          onScroll={handleListScroll}
          className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl max-h-[300px] overflow-y-auto"
        >
          {searching && searchResults.length === 0 ? (
            <div className="px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-primary-500" />
              Searching...
            </div>
          ) : !searching && searchResults.length === 0 ? (
            <div className="px-4 py-3 text-sm text-slate-500 italic">
              No results found.
            </div>
          ) : (
            <ul className="py-1">
              {searchResults.map((product) => (
                <li
                  key={product.id}
                  onClick={() => handleSelect(product)}
                  className="px-4 py-2.5 hover:bg-slate-50 cursor-pointer flex flex-col gap-1 border-b border-slate-100 last:border-0 transition-colors"
                >
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-bold text-slate-800 truncate tracking-wide">
                      {product.code}
                    </span>
                    {showMsilCode && product.msilCode && (
                      <span className="text-xs text-slate-400 font-medium">
                        {product.msilCode}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-500 font-medium tracking-wide">
                    {product.brand?.toUpperCase()} | {product.category || 'Uncategorized'}
                    {showBoxNo && product.boxNo && (
                      <>
                        {' | '}
                        <span className="font-mono font-bold text-slate-600">
                          Box {product.boxNo}
                        </span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Count first, then the loader. Someone typing "1" needs to see that
              6,000 SKUs matched — that is the signal to type more, and without
              it a capped list looks like the whole answer. */}
          {searchResults.length > 0 && (
            <div className="sticky bottom-0 px-4 py-2 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-500 flex items-center justify-between gap-2">
              <span>
                Showing {searchResults.length.toLocaleString()} of{' '}
                {searchTotal.toLocaleString()}
              </span>
              {searchLoadingMore ? (
                <span className="flex items-center gap-1.5 text-primary-600 font-semibold">
                  <Loader2 size={12} className="animate-spin" /> Loading…
                </span>
              ) : searchHasMore ? (
                <span className="text-slate-400">Scroll for more</span>
              ) : (
                <span className="text-slate-400">All matches shown</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
export default ProductSearchDropdown;