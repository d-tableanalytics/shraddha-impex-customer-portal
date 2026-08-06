import React, { useState, useEffect, useRef } from "react";
import { Search, Loader2 } from "lucide-react";
import { useProductStore } from "../../store/productStore";

export const Autocomplete = ({
  label,
  placeholder = "Type code (e.g. E-12345)...",
  value,
  onChange,
  error,
}) => {
  const [inputValue, setInputValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);

  const searchResults = useProductStore((state) => state.searchResults);
  const searching = useProductStore((state) => state.searching);
  const searchProducts = useProductStore((state) => state.searchProducts);
  const clearSearchResults = useProductStore(
    (state) => state.clearSearchResults,
  );

  const containerRef = useRef(null);

  // Sync state if value changes externally (e.g., cart clearing)
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // Click outside listener to collapse suggestion menu
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
      {label && (
        <label className="text-xs font-semibold text-slate-700 select-none">
          {label}
        </label>
      )}

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
        <div className="absolute top-[100%] left-0 right-0 z-50 mt-1 bg-white border border-slate-200 rounded-lg shadow-enterprise-lg max-h-60 overflow-y-auto">
          {searching && searchResults.length === 0 ? (
            <div className="px-4 py-3 text-xs text-slate-500 flex items-center gap-2">
              <Loader2 size={12} className="animate-spin text-primary-600" />
              Searching database...
            </div>
          ) : !searching && searchResults.length === 0 ? (
            <div className="px-4 py-3 text-xs text-slate-500 italic">
              No matching products found (try 'E')
            </div>
          ) : (
            <ul className="py-1">
              {searchResults.map((product) => (
                <li
                  key={product.code}
                  onClick={() => handleSelect(product)}
                  className="px-4 py-2 hover:bg-slate-50 cursor-pointer flex flex-col gap-0.5 border-b border-slate-100 last:border-0 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-primary-900 bg-primary-50 px-1.5 py-0.5 rounded">
                      {product.code}
                    </span>
                    <span className="text-xs font-semibold text-slate-500">
                      Stock: {product.availableStock} {product.unit}
                    </span>
                  </div>
                  <span className="text-sm font-medium text-slate-700 truncate">
                    {product.name}
                  </span>
                  <span className="text-xs text-slate-400">
                    {product.brand} · {product.category}
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
