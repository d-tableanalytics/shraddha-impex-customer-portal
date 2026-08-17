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
  const clearSearchResults = useProductStore(
    (state) => state.clearSearchResults,
  );

  const containerRef = useRef(null);

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

  const handleInputChange = (e) => {
    const val = e.target.value;
    setInputValue(val);
    setIsOpen(true);
    if (val.trim()) {
      searchProducts(val);
    } else {
      clearSearchResults();
      onChange(null);
    }
  };

  const handleSelect = (product) => {
    setInputValue(product.code);
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
        <div className="absolute top-[100%] left-0 right-0 z-50 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl max-h-[300px] overflow-y-auto">
          {searching && searchResults.length === 0 ? (
            <div className="px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-primary-500" />
              Searching...
            </div>
          ) : !searching && searchResults.length === 0 ? (
            <div className="px-4 py-3 text-sm text-slate-500 italic">
              No matching records found.
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
        </div>
      )}
    </div>
  );
};
export default ProductSearchDropdown;