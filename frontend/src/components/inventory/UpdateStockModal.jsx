import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, ArrowRight, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { inventoryApi } from '../../services/inventory';

/**
 * Update Stock — the one hand-operated write into the ledger.
 *
 * The operator types the figure stock SHOULD be; the server works out the
 * difference and posts it as an ADJUSTMENT movement. Nothing here overwrites a
 * balance, so the correction is attributable and reversible.
 *
 * Two things this screen insists on:
 *
 *   1. The "before" figure is fetched when the dialog opens, never taken from
 *      the list row behind it. A row rendered minutes ago would turn a correct
 *      target into a wrong delta, silently.
 *
 *   2. The resulting figure and the delta are shown BEFORE the button is
 *      pressed. "Set to 60" reads harmlessly next to a row showing 355 until
 *      you see it spelled out as −295.
 */

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

const Stat = ({ label, value, tone = 'text-slate-900' }) => (
  <div className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
    <span className={`block text-lg font-black tabular-nums ${tone}`}>{value}</span>
  </div>
);

export const UpdateStockModal = ({ open, skuCode, brand, onClose, onDone }) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [mode, setMode] = useState('set');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open || !skuCode || !brand) return undefined;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setPreview(null);
    setMode('set');
    setQty('');
    setNote('');

    inventoryApi
      .getAdjustmentPreview(skuCode, brand)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        // Pre-filling with the current figure makes "set" the safe default —
        // submitting without editing is refused as a no-op rather than
        // accidentally zeroing the SKU.
        setQty(String(data.balance.onHand));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.message || 'Could not read the current stock position.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open, skuCode, brand]);

  const before = preview?.balance.onHand ?? 0;
  const reserved = preview?.balance.reserved ?? 0;

  const { delta, after, problem } = useMemo(() => {
    if (qty === '' || qty === '-') return { delta: null, after: null, problem: null };
    const n = Number(qty);
    if (!Number.isFinite(n)) return { delta: null, after: null, problem: 'Enter a number.' };
    if (!Number.isInteger(n)) return { delta: null, after: null, problem: 'Stock is tracked in whole units.' };

    const d = mode === 'set' ? n - before : n;
    const a = before + d;

    if (d === 0) return { delta: 0, after: a, problem: 'That is the current figure — nothing would change.' };
    if (a < 0) return { delta: d, after: a, problem: `That would take stock to ${a}. Stock cannot go negative.` };
    if (a < reserved) {
      return {
        delta: d,
        after: a,
        problem: `${reserved} reserved against live bookings — on hand cannot drop below that.`,
      };
    }
    return { delta: d, after: a, problem: null };
  }, [qty, mode, before, reserved]);

  const ready = !problem && delta !== null && delta !== 0 && !saving;

  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    try {
      const res = await inventoryApi.adjustStock(skuCode, {
        brand,
        locationCode: preview.locationCode,
        mode,
        quantity: Number(qty),
        note: note.trim() || null,
      });
      toast.success(res.message || 'Stock updated.');
      onDone?.(res.data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'The stock update failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={`Update Stock — ${skuCode ?? ''}`} size="md">
      {loading ? (
        <div className="flex items-center justify-center py-12 text-slate-500">
          <Loader2 size={18} className="animate-spin mr-2" /> Reading current position…
        </div>
      ) : loadError ? (
        <div className="p-3 rounded-lg bg-error-50 border border-error-200 text-sm text-error-700">{loadError}</div>
      ) : preview && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs text-slate-500">
              {preview.itemDescription || preview.skuCode} · {preview.brand}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Stat label="On Hand" value={before.toLocaleString()} />
            <Stat label="Reserved" value={reserved.toLocaleString()} tone="text-slate-600" />
            <Stat label="Available" value={(before - reserved).toLocaleString()} tone="text-primary-700" />
          </div>

          <div className="flex gap-2">
            {[
              ['set', 'Set to'],
              ['delta', 'Adjust by'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => { setMode(value); setQty(value === 'set' ? String(before) : ''); }}
                className={`flex-1 px-3 py-2 text-xs font-bold rounded-lg border transition-colors ${
                  mode === value
                    ? 'bg-primary-50 border-primary-300 text-primary-700'
                    : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">
              {mode === 'set' ? 'New stock figure' : 'Change (use a minus sign to reduce)'}
            </label>
            <input
              type="number"
              step="1"
              autoFocus
              className={inputCls}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder={mode === 'set' ? String(before) : 'e.g. -5'}
            />
          </div>

          {/* The consequence, spelled out before it is committed. */}
          {delta !== null && delta !== 0 && (
            <div className={`flex items-center justify-center gap-3 p-3 rounded-lg border ${
              problem ? 'bg-error-50 border-error-200' : 'bg-slate-50 border-slate-200'
            }`}>
              <span className="text-lg font-black tabular-nums text-slate-400">{before.toLocaleString()}</span>
              <ArrowRight size={16} className="text-slate-400" />
              <span className={`text-lg font-black tabular-nums ${problem ? 'text-error-700' : 'text-slate-900'}`}>
                {after.toLocaleString()}
              </span>
              <span className={`px-2 py-1 rounded-md text-xs font-bold ${
                delta > 0 ? 'bg-success-100 text-success-700' : 'bg-warning-100 text-warning-800'
              }`}>
                {delta > 0 ? '+' : ''}{delta.toLocaleString()}
              </span>
            </div>
          )}

          {problem && (
            <div className="flex gap-2 p-3 rounded-lg bg-error-50 border border-error-200 text-xs text-error-700">
              <AlertTriangle size={14} className="shrink-0 mt-px" />
              <span>{problem}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Note (optional)</label>
            <input
              className={inputCls}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What happened?"
            />
          </div>

          <p className="text-[11px] text-slate-400">
            This posts an adjustment movement to the stock ledger against your name. Balances,
            health bands and alerts update immediately, and the entry can be reversed but never
            deleted.
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={!ready}>
              {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
              Post adjustment
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default UpdateStockModal;
