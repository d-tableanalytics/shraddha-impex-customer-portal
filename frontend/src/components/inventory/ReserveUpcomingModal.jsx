import { useEffect, useMemo, useState } from 'react';
import { BookmarkPlus, AlertCircle, ArrowRight } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useUpcomingStockStore, nextIndentNo } from '../../store/upcomingStockStore';
import { DEMO_CUSTOMERS, formatDate, relativeArrival } from '../../utils/upcomingStockMock';

/**
 * Reserve (indent) quantity against upcoming stock — DEMO ONLY.
 *
 * Shows the position before and after so the user sees exactly what the
 * reservation does: Remaining Upcoming = Upcoming Stock − Reserved Stock.
 */

const selectCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none '
  + 'focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:bg-slate-50 disabled:text-slate-500';

const Figure = ({ label, before, after, tone = 'text-slate-900' }) => (
  <div className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
    <div className="flex items-center gap-1.5 mt-0.5">
      {after !== undefined && after !== before ? (
        <>
          <span className="text-sm font-semibold text-slate-400 tabular-nums line-through">{before.toLocaleString()}</span>
          <ArrowRight size={12} className="text-slate-300" />
          <span className={`text-base font-black tabular-nums ${tone}`}>{after.toLocaleString()}</span>
        </>
      ) : (
        <span className={`text-base font-black tabular-nums ${tone}`}>{before.toLocaleString()}</span>
      )}
    </div>
  </div>
);

export const ReserveUpcomingModal = ({ open, items, initialKey, userName, onClose }) => {
  const reserve = useUpcomingStockStore((s) => s.reserve);
  const rawItems = useUpcomingStockStore((s) => s.items);

  const [key, setKey] = useState('');
  const [customer, setCustomer] = useState('');
  const [qty, setQty] = useState('');
  const [indentNo, setIndentNo] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  // A fresh form each time it opens, pre-selecting the row it was opened from.
  useEffect(() => {
    if (!open) return;
    setKey(initialKey || '');
    setCustomer('');
    setQty('');
    setNote('');
    setTouched(false);
    setIndentNo(nextIndentNo(rawItems));
    // rawItems only seeds the indent number on open; re-running on every change would wipe the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialKey]);

  const reservable = useMemo(
    () => items.filter((i) => i.remaining > 0 || i.key === initialKey)
      .sort((a, b) => a.skuCode.localeCompare(b.skuCode)),
    [items, initialKey],
  );
  const item = items.find((i) => i.key === key);

  const n = Number(qty);
  const qtyValid = qty !== '' && Number.isInteger(n) && n > 0;
  const qtyError = !item || qty === ''
    ? null
    : !qtyValid
      ? 'Enter a whole quantity above 0.'
      : n > item.remaining
        ? `Only ${item.remaining.toLocaleString()} remaining to reserve.`
        : null;
  const customerError = touched && !customer.trim() ? 'Customer is required.' : null;
  const canSubmit = item && qtyValid && !qtyError && customer.trim() && item.remaining > 0;

  const after = item && qtyValid && !qtyError
    ? { reserved: item.reserved + n, remaining: item.remaining - n }
    : null;

  const submit = async () => {
    setTouched(true);
    if (!canSubmit) return;
    setSaving(true);
    // A beat of latency so the demo feels like a real save.
    await new Promise((r) => setTimeout(r, 450));
    const res = reserve({ key, qty: n, customer: customer.trim(), indentNo: indentNo.trim(), note: note.trim(), by: userName });
    setSaving(false);
    if (!res.success) { toast.error(res.error); return; }
    toast.success(`Reserved ${n.toLocaleString()} × ${item.skuCode} for ${customer.trim()} (${res.reservation.indentNo}).`);
    onClose();
  };

  const quick = item && item.remaining > 0
    ? [['25%', Math.max(1, Math.floor(item.remaining * 0.25))], ['50%', Math.max(1, Math.floor(item.remaining * 0.5))], ['All remaining', item.remaining]]
    : [];

  return (
    <Modal isOpen={open} onClose={onClose} title="Reserve Upcoming Stock" size="lg">
      <div className="flex flex-col gap-5">
        <p className="text-xs text-slate-500 leading-relaxed">
          Reserve quantity from stock that is on its way. The reservation is held as an indent against the
          upcoming shipment and is released to the customer when the stock is received.
        </p>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-slate-700 select-none">SKU</label>
          <select value={key} onChange={(e) => { setKey(e.target.value); setQty(''); }} className={selectCls}>
            <option value="">Select a SKU with upcoming stock…</option>
            {reservable.map((i) => (
              <option key={i.key} value={i.key}>
                {i.skuCode} — {i.product} ({i.remaining.toLocaleString()} remaining)
              </option>
            ))}
          </select>
        </div>

        {item && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Figure label="Actual Stock" before={item.actual} />
              <Figure label="Upcoming" before={item.upcoming} />
              <Figure label="Reserved" before={item.reserved} after={after?.reserved} tone="text-slate-900" />
              <Figure label="Remaining" before={item.remaining} after={after?.remaining} tone="text-primary-700" />
            </div>
            <p className="text-[11px] text-slate-400 -mt-3">
              {item.brand} · next arrival {formatDate(item.nextEta)} ({relativeArrival(item.nextEta)})
              {item.shipmentCount > 1 && ` · ${item.shipmentCount} shipments`}
            </p>

            {item.remaining === 0 && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-50 border border-warning-200">
                <AlertCircle size={16} className="text-warning-600 shrink-0 mt-0.5" />
                <p className="text-xs text-warning-800">
                  All upcoming stock for this SKU is already reserved. Release a reservation from the SKU
                  details to free quantity.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Input
                  label="Customer / Dealer"
                  list="upcoming-customers"
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                  placeholder="Start typing a customer"
                  error={customerError}
                  disabled={item.remaining === 0}
                />
                <datalist id="upcoming-customers">
                  {DEMO_CUSTOMERS.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
              <Input
                label="Reservation Ref"
                value={indentNo}
                onChange={(e) => setIndentNo(e.target.value)}
                helperText="To reserve for an open indent, use the SKU details panel."
                disabled={item.remaining === 0}
              />
              <div className="flex flex-col gap-2">
                <Input
                  label={`Quantity (${item.uom})`}
                  type="number"
                  min="1"
                  max={item.remaining}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder={`Up to ${item.remaining.toLocaleString()}`}
                  error={qtyError}
                  disabled={item.remaining === 0}
                />
                {quick.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {quick.map(([label, v]) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setQty(String(v))}
                        className="px-2 py-1 rounded-md border border-slate-200 text-[11px] font-bold text-slate-600 hover:bg-primary-50 hover:text-primary-700 hover:border-primary-300 transition-colors"
                      >
                        {label} · {v.toLocaleString()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Input
                label="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Against PO 4500128834"
                disabled={item.remaining === 0}
              />
            </div>

            {after && (
              <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 font-mono text-[12px] leading-relaxed text-slate-700">
                <div>Reserved  = {item.reserved.toLocaleString()} + {n.toLocaleString()} = {after.reserved.toLocaleString()}</div>
                <div>
                  Remaining = {item.upcoming.toLocaleString()} − {after.reserved.toLocaleString()} ={' '}
                  <strong className="text-primary-700">{after.remaining.toLocaleString()}</strong>
                </div>
              </div>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 -mx-6 px-6 -mb-2 pt-4">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} loading={saving} disabled={!item || item.remaining === 0}>
            {!saving && <BookmarkPlus size={15} className="mr-2" />}
            Reserve Stock
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default ReserveUpcomingModal;
