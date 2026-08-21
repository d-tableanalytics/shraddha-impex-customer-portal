import { useEffect, useState } from 'react';
import { PackagePlus, AlertCircle, Save } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { inventoryApi } from '../../services/inventory';

/**
 * Ask for the MOQ of every SKU an import has just created.
 *
 * WHY THIS EXISTS. A SKU created by an import lands with the schema default MOQ
 * of 0, which reads as "no minimum" and is indistinguishable from a deliberate
 * 0. That is fine for a SKU nobody has thought about and wrong for one that has
 * just entered the catalogue — so the import records what it created and the
 * admin is asked, rather than a figure being invented for them.
 *
 * NOTHING IS LOST BY CLOSING THIS. The pending list lives on the import job,
 * not in this component: closing, reloading or navigating away leaves the
 * remaining SKUs queued, and the import screen shows them again. That is what
 * makes the "are you sure" on close a warning rather than a trap — the stock
 * and the SKUs are already imported and correct either way.
 *
 * Answers are saved as a batch, and a partial batch is accepted: filling in
 * three of ten and saving leaves seven queued rather than failing the lot.
 */
export const NewSkuMoqModal = ({ jobId, skus = [], onClose, onSaved }) => {
  // Keyed by SKU so a value survives the list shrinking after a partial save.
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setValues((prev) => {
      const next = {};
      for (const s of skus) next[s.skuCode] = prev[s.skuCode] ?? '';
      return next;
    });
  }, [skus]);

  if (!jobId || skus.length === 0) return null;

  const setValue = (skuCode) => (e) => {
    setTouched(true);
    setValues((v) => ({ ...v, [skuCode]: e.target.value }));
  };

  /**
   * A MOQ is a whole number of units, at least 1.
   *
   * Zero is rejected deliberately: 0 is exactly the value this prompt exists to
   * stop being left behind, so accepting it would defeat the point. The same
   * rule is enforced server-side.
   */
  const problemWith = (raw) => {
    const value = String(raw ?? '').trim();
    if (!value) return 'Required';
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Not a number';
    if (!Number.isInteger(n)) return 'Whole numbers only';
    if (n < 1) return 'Must be 1 or more';
    return null;
  };

  const filled = skus.filter((s) => String(values[s.skuCode] ?? '').trim() !== '');
  const invalid = filled.filter((s) => problemWith(values[s.skuCode]));
  const ready = filled.filter((s) => !problemWith(values[s.skuCode]));

  const handleSave = async () => {
    if (invalid.length) {
      toast.error(`Fix ${invalid.length} value(s) before saving.`);
      return;
    }
    if (ready.length === 0) {
      toast.error('Enter an MOQ for at least one SKU.');
      return;
    }

    setSaving(true);
    try {
      const res = await inventoryApi.setImportMoq(
        jobId,
        ready.map((s) => ({ skuCode: s.skuCode, moq: Number(values[s.skuCode]) })),
      );
      // Server-side rejections are surfaced individually — a silent partial
      // save is how a SKU ends up believed-configured and is not.
      for (const err of res.errors) toast.error(err);
      if (res.applied.length) {
        toast.success(`MOQ set for ${res.applied.length} SKU(s).`);
      }
      setTouched(false);
      onSaved?.(res.pendingMoqSkus);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save the MOQ values.');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    // The queue is server-side, so closing loses only what has been typed here.
    if (touched && !window.confirm(
      'Close without saving? The values you have typed will be lost — the SKUs stay '
      + 'on the list and you will be asked again.',
    )) return;
    onClose?.();
  };

  return (
    <Modal
      isOpen
      onClose={handleClose}
      title={`Set MOQ for ${skus.length} new SKU${skus.length === 1 ? '' : 's'}`}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2 p-3 rounded-lg bg-primary-50 border border-primary-200">
          <PackagePlus size={16} className="text-primary-600 shrink-0 mt-0.5" />
          <p className="text-xs text-primary-900 leading-relaxed">
            These SKUs were <strong>created by this import</strong> and have no minimum order
            quantity yet. The stock has already been imported — this only sets the MOQ.
            You can save some now and the rest later.
          </p>
        </div>

        <div className="max-h-[45vh] overflow-y-auto -mx-1 px-1">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200">
                <th className="py-2 pr-3">SKU</th>
                <th className="py-2 pr-3">Brand</th>
                <th className="py-2 pr-3 text-right">Imported Qty</th>
                <th className="py-2 w-32">MOQ *</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {skus.map((s) => {
                const problem = String(values[s.skuCode] ?? '').trim()
                  ? problemWith(values[s.skuCode])
                  : null;
                return (
                  <tr key={s.skuCode}>
                    <td className="py-2 pr-3">
                      <span className="font-bold text-slate-900">{s.skuCode}</span>
                      {/* Enough detail to know WHICH SKU is being configured
                          without opening the inventory master in another tab. */}
                      {(s.description || s.msilCode) && (
                        <span className="block text-[11px] text-slate-400 truncate max-w-64">
                          {s.description || `MSIL ${s.msilCode}`}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs font-semibold text-slate-600">{s.brand}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                      {Number(s.quantity || 0).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={values[s.skuCode] ?? ''}
                        onChange={setValue(s.skuCode)}
                        placeholder="e.g. 10"
                        className={`w-full px-2 py-1.5 text-sm border rounded-lg outline-none focus:ring-1 ${
                          problem
                            ? 'border-error-400 focus:border-error-500 focus:ring-error-500'
                            : 'border-slate-300 focus:border-primary-500 focus:ring-primary-500'
                        }`}
                      />
                      {problem && (
                        <span className="text-[10px] font-semibold text-error-600">{problem}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {skus.length > ready.length && (
          <div className="flex items-start gap-2 text-[11px] text-slate-500">
            <AlertCircle size={13} className="shrink-0 mt-0.5" />
            <span>
              {ready.length} of {skus.length} filled in. Anything left blank stays on the list
              and you will be asked again — nothing is lost.
            </span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={handleClose} disabled={saving}>
            Later
          </Button>
          <Button size="sm" onClick={handleSave} loading={saving} disabled={ready.length === 0}>
            {!saving && <Save size={15} className="mr-2" />}
            Save {ready.length > 0 ? `${ready.length} ` : ''}MOQ
            {ready.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default NewSkuMoqModal;
