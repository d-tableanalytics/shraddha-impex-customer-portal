import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
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
  // The input the suggestion panel is anchored to, and the panel itself. The
  // panel lives in a portal on document.body — see the note where it renders —
  // so it needs its own ref for the click-outside test.
  const anchorRef = useRef(null);

  /**
   * Where to draw the suggestion panel.
   *
   * IT IS RENDERED IN A PORTAL, POSITIONED FIXED, because the panel used to be
   * an absolutely positioned child of this component and was therefore clipped
   * by any scrolling ancestor. That is not hypothetical: it is what stopped the
   * Sales Desk booking-items table from being given a max height at all — a
   * capped, scrolling table would have swallowed the suggestions the moment a
   * row near the bottom was edited. Taking the panel out of the flow means a
   * container can scroll without the picker paying for it.
   *
   * Measured from the input's viewport rect, and re-measured on any scroll
   * (capture phase, so an ancestor scrolling counts) and on resize. Fixed
   * coordinates are viewport coordinates, so a panel that does not follow its
   * input would simply detach and hang in mid-air.
   */
  const [menuStyle, setMenuStyle] = useState(null);
  const open = isOpen && inputValue.trim().length > 0;

  useLayoutEffect(() => {
    if (!open) { setMenuStyle(null); return undefined; }

    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const MAX_H = 300;
      const GAP = 4;
      const spaceBelow = window.innerHeight - rect.bottom;
      // Flip above only when below genuinely cannot hold it AND above is
      // roomier — otherwise a panel near the bottom of a tall window jumps
      // upward for no gain.
      const flip = spaceBelow < 200 && rect.top > spaceBelow;
      const next = {
        position: "fixed",
        left: rect.left,
        width: rect.width,
        // Never smaller than a couple of rows: an input scrolled almost out of
        // view would otherwise compute a sliver, or a negative height.
        maxHeight: Math.max(140, Math.min(MAX_H, (flip ? rect.top : spaceBelow) - GAP * 2)),
        ...(flip
          ? { bottom: window.innerHeight - rect.top + GAP }
          : { top: rect.bottom + GAP }),
      };
      // Only write when something actually moved. The capture listener also
      // hears the PANEL's own scroll, and a fresh object on every one of those
      // events would re-render the list mid-scroll — exactly while someone is
      // reading it and the next page is loading.
      setMenuStyle((prev) => {
        if (!prev) return next;
        const same = Object.keys(next).length === Object.keys(prev).length
          && Object.keys(next).every((k) => prev[k] === next[k]);
        return same ? prev : next;
      });
    };

    place();
    // `true` = capture, so scrolling ANY ancestor repositions the panel, not
    // just the window. Passive: this never cancels the scroll.
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [open]);

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
      // The panel is a portal on document.body, so it is NOT inside
      // containerRef. Without the second test, clicking a suggestion would
      // count as clicking outside and close the list before the selection
      // registered — the picker would look broken rather than clipped.
      const insideField = containerRef.current?.contains(event.target);
      const insidePanel = listRef.current?.contains(event.target);
      if (!insideField && !insidePanel) setIsOpen(false);
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

      <div className="relative" ref={anchorRef}>
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

      {/* Rendered on document.body rather than here. z-9999 because it now
          sits above every stacking context in the app — the sales drawer is
          z-50, the PO dialog z-[60], the picklist preview z-[70] — and a picker
          drawn under the dialog that opened it is no better than a clipped one.
          The panel is only mounted once its position is known, so it can never
          flash at the top-left corner before being placed. */}
      {open && menuStyle && createPortal(
        <div
          ref={listRef}
          onScroll={handleListScroll}
          style={menuStyle}
          className="z-9999 bg-white border border-slate-200 rounded-lg shadow-xl overflow-y-auto overscroll-contain"
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
                  {/* The SKU and the MSIL code are what the customer matches
                      against their paper list, so neither is truncated. They
                      wrap instead: `items-start` with `gap-3` lets the MSIL
                      keep its place on the right while a long SKU takes the
                      lines it needs, and `break-all` splits codes that have no
                      spaces for a word-boundary break to find. A truncated
                      code is actively dangerous here - two parts differing in
                      their last characters look identical once cut. */}
                  <div className="flex justify-between items-start gap-3">
                    <span className="text-sm font-bold text-slate-800 tracking-wide font-mono break-all leading-snug">
                      {product.code}
                    </span>
                    {showMsilCode && product.msilCode && (
                      <span className="text-xs text-slate-400 font-medium font-mono break-all text-right shrink-0 max-w-[45%] leading-snug">
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
        </div>,
        document.body,
      )}
    </div>
  );
};
export default ProductSearchDropdown;