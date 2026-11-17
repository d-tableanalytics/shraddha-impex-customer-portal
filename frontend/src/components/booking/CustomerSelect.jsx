import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Search, Loader2, X, UserPlus, Building2, Check } from "lucide-react";
import { customersApi } from "../../services/users";

/**
 * Select Customer — the first field on Create Booking for a Sales Person or
 * Admin, who book on a customer's behalf.
 *
 * A searchable dropdown over the accounts Customer Management manages (the
 * server returns live Customer accounts only), matched on the customer's
 * name, contact name, company and email as typed. Picking one hands the whole
 * record to the caller, because the booking form applies THAT customer's
 * rules — MOQ, MSIL, brand access — rather than the staff member's.
 *
 * "+ Add Customer" goes to Customer Management with the Add form open and a
 * way back: after the account is created, Customer Management returns here
 * with `?customer=<id>` and the page selects it (see CustomerOrders).
 */

const SEARCH_DEBOUNCE_MS = 250;

/** How a customer reads in the list and the field: master name, then contact. */
export const customerDisplayName = (c) => c?.customerName || c?.user || c?.company || c?.email || "";

export const CustomerSelect = ({
  value,
  onChange,
  disabled = false,
  // Where "+ Add Customer" comes back to. Defaults to this page; Edit Details
  // passes a Sales Desk link that reopens the booking and the form.
  returnTo: returnPath = null,
  // The line under an empty field, explaining what selecting does here.
  hint = "The booking is created on this customer's account and appears in their Booking History.",
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const requestSeq = useRef(0);

  // Close on a click anywhere else.
  useEffect(() => {
    const onDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Search as typed, after a pause. An empty box lists the first customers so
  // a small customer base can be browsed without typing anything.
  useEffect(() => {
    if (!open) return undefined;
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    setSearching(true);
    setError(null);
    const timer = setTimeout(async () => {
      try {
        const found = await customersApi.search(query.trim(), { signal: controller.signal });
        if (seq !== requestSeq.current) return;
        setResults(found);
      } catch (err) {
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        setResults([]);
        setError(err.response?.data?.message || "Could not load customers.");
      } finally {
        if (seq === requestSeq.current) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  const select = (customer) => {
    onChange(customer);
    setQuery("");
    setOpen(false);
  };

  const clear = () => {
    onChange(null);
    setQuery("");
    setOpen(true);
    inputRef.current?.focus();
  };

  const addCustomer = () => {
    const returnTo = returnPath || `${location.pathname}${location.search || ""}`;
    navigate(`/admin/customers?add=1&returnTo=${encodeURIComponent(returnTo)}`);
  };

  return (
    <div ref={containerRef} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor="booking-customer" className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">
          Select Customer <span className="text-red-500" aria-hidden="true">*</span>
        </label>
        <button
          type="button"
          onClick={addCustomer}
          disabled={disabled}
          className="inline-flex items-center gap-1 text-[11px] font-bold text-[#1a5b9e] hover:text-[#15467a] disabled:opacity-50"
          title="Create the customer in Customer Management, then come back and select them"
        >
          <UserPlus size={13} aria-hidden="true" /> + Add Customer
        </button>
      </div>

      {value ? (
        <div
          className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3.5 py-2.5"
          data-testid="selected-customer"
        >
          <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
            <Check size={15} className="text-emerald-700" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black text-slate-800 truncate" title={customerDisplayName(value)}>
              {customerDisplayName(value)}
            </p>
            <p className="text-[11px] text-slate-500 truncate">
              {[value.company, value.email].filter(Boolean).join(" · ") || "—"}
              {value.customerCategory ? ` · ${String(value.customerCategory).toUpperCase() === "MSIL" ? "MSIL" : "Customer"}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={clear}
            disabled={disabled}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-white transition-colors disabled:opacity-50"
            aria-label="Change customer"
            title="Change customer"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            id="booking-customer"
            ref={inputRef}
            type="text"
            value={query}
            disabled={disabled}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && results.length === 1) { e.preventDefault(); select(results[0]); }
            }}
            placeholder="Search by customer name or company…"
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls="booking-customer-options"
            className="w-full pl-10 pr-9 py-3 border border-slate-200/80 rounded-xl outline-none focus:border-[#1a5b9e] focus:ring-2 focus:ring-[#1a5b9e]/20 text-slate-800 font-semibold placeholder-slate-300 transition-all bg-slate-50/50 focus:bg-white disabled:opacity-60"
          />
          {searching && (
            <Loader2 size={14} aria-label="Searching customers" className="absolute right-3.5 top-1/2 -translate-y-1/2 animate-spin text-slate-400" />
          )}

          {open && (
            <ul
              id="booking-customer-options"
              role="listbox"
              aria-label="Customers"
              className="absolute z-30 left-0 right-0 mt-1 max-h-72 overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg py-1"
            >
              {error ? (
                <li className="px-3.5 py-3 text-xs text-red-600">{error}</li>
              ) : results.length === 0 && !searching ? (
                <li className="px-3.5 py-3 text-xs text-slate-500">
                  {query.trim()
                    ? <>No customer matches “{query.trim()}”. Use <strong>+ Add Customer</strong> to create one.</>
                    : "No active customers yet. Use + Add Customer to create one."}
                </li>
              ) : (
                results.map((c) => (
                  <li key={c._id} role="option" aria-selected={false}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => select(c)}
                      className="w-full text-left px-3.5 py-2.5 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none flex items-start gap-3"
                    >
                      <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center shrink-0 mt-0.5">
                        <Building2 size={13} className="text-slate-500" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-800 truncate">{customerDisplayName(c)}</p>
                        <p className="text-[11px] text-slate-500 truncate">
                          {[c.company, c.email].filter(Boolean).join(" · ") || "—"}
                        </p>
                      </div>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
      {!value && hint && (
        <span className="text-[11px] text-slate-400 font-medium">{hint}</span>
      )}
    </div>
  );
};

export default CustomerSelect;
