import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, ArrowRight, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';

import { Button } from '../ui/Button';
import { inventoryApi } from '../../services/inventory';
import { formatRupees } from '../../constants/pricing';

/**
 * The Pricing side of Update Stock — a SKU's four tier prices.
 *
 * Same two rules as the stock side:
 *
 *   1. The current prices are fetched when the panel opens, never taken from
 *      the list row (which does not carry them at all — prices are opt-in on
 *      the server and the inventory list never asks).
 *
 *   2. Every change is spelled out before it is saved: "₹1,250.00 → ₹1,300.00",
 *      or "remove price" for a cleared cell. Only changed tiers are sent, so an
 *      untouched field can never overwrite a figure someone else just set.
 *
 * Stock is not read or written here.
 */

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none tabular-nums ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

const toInput = (price) => (price === null || price === undefined ? '' : String(price));

/*
 * The same reading the server applies (parsePriceInput in config/pricing.js):
 * digits, optionally grouped 1,250,000 or 12,50,000. "12,5" or "1.250,50" is
 * refused rather than turned into a different amount.
 */
const MAX_PRICE = 100_000_000;
const AMOUNT = [/^\d+(\.\d+)?$/, /^\d{1,3}(,\d{3})+(\.\d+)?$/, /^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/];

/** What a typed value means: unchanged, a new price, a removal, or a problem. */
export const readCell = (raw, current) => {
  const text = String(raw ?? '').trim().replace(/^(₹|rs\.?|inr)\s*/i, '');
  if (text === '') {
    return current === null ? { change: false } : { change: true, to: null };
  }
  if (!AMOUNT.some((re) => re.test(text))) {
    return { problem: 'Enter an amount in digits, e.g. 1250.50 or 1,250.50.' };
  }
  const to = Math.round(Number(text.replace(/,/g, '')) * 100) / 100;
  if (!(to > 0)) return { problem: 'A price must be at least ₹0.01. Clear the field to remove the price.' };
  if (to > MAX_PRICE) return { problem: `A price must be at most ₹${MAX_PRICE.toLocaleString('en-IN')}.` };
  return to === current ? { change: false } : { change: true, to };
};

export const SkuPricingPanel = ({ skuCode, brand, onClose, onDone, onBusyChange }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [values, setValues] = useState({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setData(null);

    inventoryApi
      .getSkuPricing(skuCode, brand)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setValues(Object.fromEntries(res.priceTypes.map((t) => [t.key, toInput(res.prices[t.key])])));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.message || 'Could not read the current prices.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [skuCode, brand]);

  useEffect(() => { onBusyChange?.(saving); }, [saving, onBusyChange]);

  const cells = useMemo(() => {
    if (!data) return {};
    return Object.fromEntries(
      data.priceTypes.map((t) => [t.key, readCell(values[t.key], data.prices[t.key])]),
    );
  }, [data, values]);

  const changed = Object.entries(cells).filter(([, c]) => c.change);
  const hasProblem = Object.values(cells).some((c) => c.problem);
  const ready = !saving && !hasProblem && changed.length > 0;

  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    try {
      const prices = Object.fromEntries(changed.map(([key, c]) => [key, c.to]));
      const res = await inventoryApi.updateSkuPricing(skuCode, { brand, prices });
      toast.success(res.message || 'Prices updated.');
      onDone?.(res.data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'The price update failed.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-slate-500">
        <Loader2 size={18} className="animate-spin mr-2" /> Reading current prices…
      </div>
    );
  }
  if (loadError) {
    return <div className="p-3 rounded-lg bg-error-50 border border-error-200 text-sm text-error-700">{loadError}</div>;
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-slate-500">
        {data.itemDescription || data.skuCode} · {data.brand}
        {data.msilCode ? ` · MSIL ${data.msilCode}` : ''}
      </p>

      <div className="flex flex-col gap-3">
        {data.priceTypes.map((t) => {
          const current = data.prices[t.key];
          const cell = cells[t.key] || {};
          return (
            <div key={t.key} className="grid grid-cols-1 sm:grid-cols-[1fr_10rem] gap-x-3 gap-y-1.5 items-start">
              <div className="flex flex-col">
                <label htmlFor={`price-${t.key}`} className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">
                  {t.label}
                </label>
                <span className="text-[11px] text-slate-400">
                  {t.description} · now {current === null ? 'no price' : formatRupees(current)}
                </span>
              </div>
              <input
                id={`price-${t.key}`}
                type="text"
                inputMode="decimal"
                className={`${inputCls} ${cell.problem ? 'border-error-400' : ''}`}
                value={values[t.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [t.key]: e.target.value }))}
                placeholder="No price"
              />
              {cell.problem && (
                <p className="sm:col-span-2 flex gap-1.5 text-[11px] text-error-700">
                  <AlertTriangle size={12} className="shrink-0 mt-px" />{cell.problem}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* The consequence, spelled out before it is committed. */}
      {changed.length > 0 && !hasProblem && (
        <div className="flex flex-col gap-1.5 p-3 rounded-lg border bg-slate-50 border-slate-200">
          {changed.map(([key, c]) => {
            const label = data.priceTypes.find((t) => t.key === key)?.label ?? key;
            return (
              <div key={key} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-32 font-bold text-slate-600">{label}</span>
                <span className="tabular-nums text-slate-400">{formatRupees(data.prices[key], { dash: 'no price' })}</span>
                <ArrowRight size={13} className="text-slate-400" />
                {c.to === null
                  ? <span className="px-2 py-0.5 rounded-md font-bold bg-warning-100 text-warning-800">remove price</span>
                  : <span className="tabular-nums font-black text-slate-900">{formatRupees(c.to)}</span>}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-slate-400">
        INR per piece. Bookings already priced keep the rate they were given, through to the
        PO. The new figure applies to bookings priced from now on. Stock is not affected.
        Recorded against your name.
      </p>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} disabled={!ready}>
          {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
          Save prices
        </Button>
      </div>
    </div>
  );
};

export default SkuPricingPanel;
