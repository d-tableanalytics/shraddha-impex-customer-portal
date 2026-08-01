import { useEffect, useState } from 'react';
import { Save, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { inventoryApi } from '../../services/inventory';

/**
 * Bulk planning editor — IMS Module M1.
 *
 * Applies ONE set of values to every selected SKU. The case it exists for is
 * the seasonal switch: when the season turns, an entire category moves from
 * Normal to Peak together, and doing that a row at a time is hundreds of round
 * trips and hundreds of audit entries for what is one business decision.
 *
 * Only fields that are genuinely uniform across a selection appear here.
 * Daily consumption and the per-SKU identity fields (description, box no, item
 * parameter, category) are deliberately absent: writing one consumption rate
 * across a mixed selection would wipe the per-SKU rates that Max Level is
 * derived from, and the damage would not surface until the health bands came
 * back wrong.
 *
 * A field left blank is NOT sent. That is what makes "set the season on 300
 * SKUs" possible without also flattening their individual lead times.
 *
 * Nothing computed is editable here or anywhere else — Max Level, Available %,
 * Total Available and Available for Sale are derived from these inputs and the
 * ledger, so a stored value can never drift from the formula that produced it.
 */

const SEASONS = ['Low', 'Normal', 'Peak'];
const STATUSES = ['Active', 'Inactive', 'Discontinued'];
const NUMERIC = ['leadTime', 'safetyFactor', 'moq'];

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

const Field = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">{label}</label>
    {children}
  </div>
);

export const BulkPlanningEditor = ({ open, skuCodes = [], onClose, onDone }) => {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  // Reopening must not carry the previous edit's values or its outcome.
  useEffect(() => {
    if (open) { setForm({}); setResult(null); }
  }, [open]);

  // Clearing a field REMOVES it from the payload rather than sending an empty
  // value, which the server would otherwise try to store.
  const set = (key, value) => setForm((prev) => {
    if (value === '') {
      const next = { ...prev };
      delete next[key];
      return next;
    }
    return { ...prev, [key]: value };
  });

  const touched = Object.keys(form);

  const save = async () => {
    if (!touched.length) {
      toast.error('Set at least one field to apply.');
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form };
      for (const n of NUMERIC) if (n in payload) payload[n] = Number(payload[n]);

      const data = await inventoryApi.bulkUpdatePlanning(skuCodes, payload);
      setResult(data);
      toast.success(`Updated ${data.modified} of ${skuCodes.length} SKU(s).`);
      onDone?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'The bulk update failed.');
    } finally {
      setSaving(false);
    }
  };

  const partial = result && (result.blocked?.length > 0 || result.skipped?.length > 0);

  return (
    <Modal isOpen={open} onClose={onClose} title={`Edit ${skuCodes.length} SKU(s)`} size="md">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-slate-500">
          Only the fields you fill in are changed. Leave a field blank to keep each SKU&apos;s own value.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Current Season">
            <select className={inputCls} value={form.currentSeason ?? ''}
              onChange={(e) => set('currentSeason', e.target.value)}>
              <option value="">Leave unchanged</option>
              {SEASONS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>

          <Field label="Status">
            <select className={inputCls} value={form.status ?? ''}
              onChange={(e) => set('status', e.target.value)}>
              <option value="">Leave unchanged</option>
              {STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>

          <Field label="Lead Time (days)">
            <input type="number" min="0" className={inputCls} placeholder="Leave unchanged"
              value={form.leadTime ?? ''} onChange={(e) => set('leadTime', e.target.value)} />
          </Field>

          <Field label="Safety Factor">
            <input type="number" min="0" step="0.1" className={inputCls} placeholder="Leave unchanged"
              value={form.safetyFactor ?? ''} onChange={(e) => set('safetyFactor', e.target.value)} />
          </Field>

          <Field label="MOQ">
            <input type="number" min="0" className={inputCls} placeholder="Leave unchanged"
              value={form.moq ?? ''} onChange={(e) => set('moq', e.target.value)} />
          </Field>

          <Field label="Vendor">
            <input className={inputCls} placeholder="Leave unchanged"
              value={form.vendorName ?? ''} onChange={(e) => set('vendorName', e.target.value)} />
          </Field>
        </div>

        <p className="text-[11px] text-slate-400">
          Lead time, safety factor and season all feed Max Level, so the health band is
          recalculated for every SKU changed. Daily consumption stays per-SKU and is edited
          from the row itself.
        </p>

        {/* A partial outcome is stated, never swallowed — a count smaller than
            the selection has to say which rows were left alone, and why. */}
        {partial && (
          <div className="p-3 rounded-lg bg-warning-50 border border-warning-100 text-xs text-warning-800">
            {result.blocked?.length > 0 && (
              <p>
                <strong>{result.blocked.length}</strong> skipped — still holding stock, so they
                cannot be retired: {result.blocked.slice(0, 6).map((b) => b.skuCode).join(', ')}
                {result.blocked.length > 6 ? '…' : ''}
              </p>
            )}
            {result.skipped?.length > 0 && (
              <p className="mt-1">
                <strong>{result.skipped.length}</strong> not found in the brands you can access:{' '}
                {result.skipped.slice(0, 6).join(', ')}{result.skipped.length > 6 ? '…' : ''}
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
          <Button onClick={save} disabled={saving || !touched.length}>
            {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
            Apply to {skuCodes.length}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default BulkPlanningEditor;
