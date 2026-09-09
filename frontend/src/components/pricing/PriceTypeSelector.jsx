import { useEffect, useState } from "react";
import { IndianRupee, Loader2, AlertTriangle, Check, ShieldAlert, Ban } from "lucide-react";

import { useSalesStore } from "../../store/salesStore";
import { PRICE_TYPES, formatRupees } from "../../constants/pricing";

/**
 * Choose the rate a customer is being offered.
 *
 * THE ONE PLACE IN THE APPLICATION THAT SHOWS MORE THAN ONE PRICE FOR A SKU.
 * It is rendered only for a holder of view_pricing, and the request behind it
 * (GET /sales/bookings/:id/pricing) is refused to anyone else — so a screen
 * that forgets to check the permission gets an error, not a leak.
 *
 * Each tier is shown with what it TOTALS for this booking, not just its name,
 * because the choice being made is commercial and "Trader" alone does not say
 * what it costs. The count of lines a tier cannot rate is on the card for the
 * same reason: MSIL covers about 400 SKUs of the 7,700 in the catalogue, so
 * choosing it on an ordinary booking is usually a mistake, and the card is
 * where that becomes visible rather than after the PO is raised.
 *
 * `value` / `onChange` — controlled, holding a price type key or null. Null is
 * a real choice ("no pricing on this PO"), which is what every PO raised before
 * this feature existed carries.
 */
export const PriceTypeSelector = ({
  orderId,
  value,
  onChange,
  customerCategory = null,
  disabled = false,
}) => {
  const { pricing, pricingLoading, loadPricing } = useSalesStore();
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;
    loadPricing(orderId).then((res) => {
      if (cancelled) return;
      setError(res.success ? null : res);
    });
    return () => { cancelled = true; };
  }, [orderId, loadPricing]);

  // MSIL customers buy on the MSIL schedule. Suggested, never forced — the desk
  // may legitimately quote an MSIL-registered account something else, and a
  // preselection it cannot change would be a rule nobody agreed to.
  const suggested = customerCategory === "MSIL" ? "msil" : null;

  if (pricingLoading && !pricing) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-slate-400">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm font-semibold">Loading prices…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200">
        <ShieldAlert size={16} className="text-slate-400 shrink-0 mt-0.5" />
        <p className="text-xs text-slate-600 leading-relaxed">
          {error.forbidden
            ? "This account can raise the purchase order but is not authorised to see or set prices. The PO will be raised without pricing."
            : error.error}
        </p>
      </div>
    );
  }

  if (!pricing) return null;

  const totals = pricing.totals || {};
  const lines = pricing.lines || [];
  const selectedTotal = value ? totals[value] : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
        {PRICE_TYPES.map((type) => {
          const total = totals[type.key] || { amount: 0, pricedLines: 0, unpricedLines: 0 };
          const active = value === type.key;
          const unrated = total.unpricedLines;
          return (
            <button
              key={type.key}
              type="button"
              disabled={disabled}
              onClick={() => onChange(type.key)}
              className={`text-left px-3 py-2.5 rounded-lg border transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                active
                  ? "border-primary-500 bg-primary-50 ring-1 ring-primary-500/30"
                  : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs font-bold ${active ? "text-primary-800" : "text-slate-700"}`}>
                  {type.label}
                </span>
                {active && <Check size={14} className="text-primary-600 shrink-0" />}
                {!active && suggested === type.key && (
                  <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1 py-0.5">
                    Suggested
                  </span>
                )}
              </div>
              <div className={`text-sm font-black mt-0.5 ${active ? "text-primary-900" : "text-slate-800"}`}>
                {formatRupees(total.amount)}
              </div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">
                {unrated > 0
                  ? `${total.pricedLines} of ${lines.length} lines rated`
                  : `all ${lines.length} line${lines.length === 1 ? "" : "s"} rated`}
              </div>
            </button>
          );
        })}

        {/* An explicit choice, not the absence of one. A PO can legitimately go
            out unpriced — every one raised before this feature did. */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          className={`text-left px-3 py-2.5 rounded-lg border transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
            value === null || value === undefined || value === ""
              ? "border-slate-400 bg-slate-100 ring-1 ring-slate-400/30"
              : "border-slate-200 bg-white hover:border-slate-300"
          }`}
        >
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
            <Ban size={13} /> No pricing
          </div>
          <div className="text-[10px] font-semibold text-slate-400 mt-1.5">
            Raise the PO without rates
          </div>
        </button>
      </div>

      {selectedTotal?.unpricedLines > 0 && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200">
          <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-900 leading-relaxed">
            <strong>{selectedTotal.unpricedLines}</strong> of {lines.length} line(s) have no{" "}
            {PRICE_TYPES.find((t) => t.key === value)?.label} rate on file. They will show a dash
            on the picklist and are not in the total.
          </p>
        </div>
      )}

      {/* The lines at the chosen rate. This is the "clearly show the selected
          price type and the corresponding price" half of the requirement —
          a total alone does not let anyone check a quote. */}
      {value && (
        /* A booking can carry a hundred SKUs, and this table used to render
           every one of them at full height — pushing the Confirm & Lock
           buttons off the bottom of a dialog that already scrolls, so the
           person pricing the order had to scroll past the whole catalogue to
           reach the action.

           Capped and scrolled instead. The column headers and the TOTAL are
           sticky to the top and bottom of that scroller: a running total that
           scrolls out of sight is the one number you always want on screen
           while checking a long list.

           The dividers on the sticky cells are inset box-shadows rather than
           borders. A table defaults to `border-collapse: collapse`, and a
           collapsed border does not travel with a sticky cell — it stays
           behind and the header loses its underline the moment you scroll.
           A shadow paints with the cell. */
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          {/* No `overscroll-contain`: this list sits inside the Sales Desk
               drawer, whose body is the page scroller. Containing the
               overscroll here would stop the drawer dead whenever the
               pointer happened to be over these rows. Reaching the end of
               the list now carries on scrolling the panel, as it should. */}
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] font-bold text-slate-500 uppercase">
                  <th className="px-3 py-2 sticky top-0 z-10 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">SKU</th>
                  <th className="px-3 py-2 text-right sticky top-0 z-10 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">Qty</th>
                  <th className="px-3 py-2 text-right sticky top-0 z-10 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">Rate</th>
                  <th className="px-3 py-2 text-right sticky top-0 z-10 bg-slate-50 shadow-[inset_0_-1px_0_0_rgb(226_232_240)]">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((line) => (
                  <tr key={line.id} className="text-xs">
                    <td className="px-3 py-1.5 font-mono font-semibold text-slate-700">
                      {line.skuCode}
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-600">{line.quantity}</td>
                    <td className="px-3 py-1.5 text-right text-slate-600">
                      {formatRupees(line.prices?.[value])}
                    </td>
                    <td className="px-3 py-1.5 text-right font-bold text-slate-800">
                      {formatRupees(line.amounts?.[value])}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-xs">
                  {/* Just "Total". The chosen schedule is already named on the
                      selected card above and on the label beside the heading, so
                      repeating it here only crowds the row. */}
                  <td
                    colSpan={3}
                    className="px-3 py-2 text-right font-bold text-slate-600 sticky bottom-0 bg-slate-50 shadow-[inset_0_1px_0_0_rgb(226_232_240)]"
                  >
                    <span className="inline-flex items-center gap-1">
                      <IndianRupee size={12} />
                      Total
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-black text-slate-900 sticky bottom-0 bg-slate-50 shadow-[inset_0_1px_0_0_rgb(226_232_240)]">
                    {formatRupees(selectedTotal?.amount)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default PriceTypeSelector;
