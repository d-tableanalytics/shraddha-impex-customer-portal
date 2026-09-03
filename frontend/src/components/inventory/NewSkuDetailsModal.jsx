import { useEffect, useMemo, useState } from 'react';
import { PackagePlus, AlertCircle, Save } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

/**
 * Ask for the mandatory details of every SKU an import is about to CREATE.
 *
 * WHY BEFORE THE IMPORT, NOT AFTER. A SKU created by a bulk sheet carries a code
 * and a quantity and nothing else. Its MOQ, lead time and safety factor land on
 * the schema default of 0 and its box number on null — each of which reads as a
 * deliberate answer and is not one. Max Level is DAC x LeadTime x SafetyFactor,
 * so it computes to zero: the SKU is permanently "over-stocked", never
 * reorders, and the warehouse has nowhere to pick it from. Asking afterwards
 * leaves the catalogue in that state for as long as it takes someone to come
 * back, so the import is held here instead.
 *
 * NOTHING IS LOST BY CLOSING THIS. The list and the answers live on the import
 * job, not in this component: closing, reloading or returning tomorrow shows
 * the same SKUs with whatever has already been saved still filled in. What
 * closing does NOT do is let the import through — the Import button on the
 * preview stays disabled until every SKU is answered, and the server refuses to
 * confirm the job regardless of what the screen allows.
 *
 * The rules below mirror newSku.rules.js so a bad value is caught as it is
 * typed. They are not the authority: every entry is re-checked server-side, and
 * a rejection is surfaced rather than swallowed.
 */

/** The six, in the order the server lists them. */
const FIELDS = [
  // A dropdown, not a text box: the brand decides which catalogue the SKU is
  // created in, and a typo would file a real part under a brand nobody looks at.
  { field: 'brand', label: 'Brand', hint: 'Catalogue', type: 'brand' },
  // Zero is a REAL answer here — a new part with none on the shelf yet — which
  // is why it carries min="0" while the three planning figures below do not.
  { field: 'availableStock', label: 'Available Stock', placeholder: 'e.g. 25', hint: 'Units', type: 'number', step: '1', min: '0' },
  { field: 'moq', label: 'MOQ', placeholder: 'e.g. 10', hint: 'Units', type: 'number', step: '1', min: '1' },
  // No `min` on the two decimals: the rule is "greater than zero", which a
  // min attribute cannot express, and min="0" would advertise a value the
  // validator below and the server both refuse.
  { field: 'leadTime', label: 'Lead Time', placeholder: 'e.g. 45', hint: 'Days', type: 'number', step: 'any' },
  { field: 'safetyFactor', label: 'Safety Factor', placeholder: 'e.g. 1.2', hint: 'Multiplier', type: 'number', step: 'any' },
  { field: 'boxNo', label: 'Box Number', placeholder: 'e.g. B-12', hint: 'Picking box', type: 'text' },
];

/**
 * What is wrong with one value, or null.
 *
 * Zero is rejected for the three numbers deliberately: 0 is exactly the value
 * this prompt exists to stop being left behind, and any zero collapses the Max
 * Level to nothing. The same rule is enforced server-side.
 */
const problemWith = (field, raw) => {
  const value = String(raw ?? '').trim();
  if (!value) return 'Required';
  // Free text — the server checks the brand against the real list and against
  // what this uploader may write to.
  if (field === 'boxNo' || field === 'brand') return null;

  const n = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(n)) return 'Not a number';

  // Opening stock: a whole number of units, and zero is allowed. Negative is
  // not — on this sheet a negative quantity is a deduction, and a SKU being
  // created has nothing to deduct from.
  if (field === 'availableStock') {
    if (!Number.isInteger(n)) return 'Whole numbers only';
    return n < 0 ? 'Cannot be negative' : null;
  }

  if (field === 'moq' && !Number.isInteger(n)) return 'Whole numbers only';
  if (n <= 0) return field === 'moq' ? 'Must be 1 or more' : 'Must be more than 0';
  return null;
};

/**
 * Is every field of one new SKU filled in and valid?
 *
 * Exported because the preview screen asks the same question to decide whether
 * the Import button may be enabled. One definition, so the button and this
 * modal can never disagree about which SKUs are still outstanding — and both
 * are only a mirror of newSku.rules.js, which is what the server enforces.
 */
export const isNewSkuAnswered = (entry) =>
  FIELDS.every((f) => !problemWith(f.field, entry?.[f.field]));

export const NewSkuDetailsModal = ({
  isOpen, jobId, skus = [], brands = [], saving = false, onSave, onClose,
}) => {
  /**
   * Keyed by SKU, seeded from what the job already holds.
   *
   * Re-seeded whenever the job's list changes — a saved answer comes back on
   * the job, so the field shows the stored value rather than the typed one and
   * the two can never drift.
   */
  const [values, setValues] = useState({});

  useEffect(() => {
    setValues((prev) => {
      const next = {};
      for (const s of skus) {
        const stored = {
          // Prefilled by the server where the upload already knew them: brand
          // from the Brand chosen on the upload form, stock from the sheet's
          // Quantity column. Null means nobody has said, so the field is blank
          // and has to be filled in.
          brand: s.brand ?? '',
          availableStock: s.availableStock ?? '',
          moq: s.moq ?? '',
          leadTime: s.leadTime ?? '',
          safetyFactor: s.safetyFactor ?? '',
          boxNo: s.boxNo ?? '',
        };
        // A stored answer wins over a half-typed one, so a partial save is
        // reflected exactly as the server recorded it.
        const typed = prev[s.skuCode] || {};
        next[s.skuCode] = Object.fromEntries(
          FIELDS.map((f) => [f.field, stored[f.field] !== '' && stored[f.field] !== null
            ? String(stored[f.field])
            : (typed[f.field] ?? '')]),
        );
      }
      return next;
    });
  }, [skus]);

  const setValue = (skuCode, field) => (e) => {
    const next = e.target.value;
    setValues((v) => ({ ...v, [skuCode]: { ...(v[skuCode] || {}), [field]: next } }));
  };

  // A SKU is saved whole or not at all: a half-filled row would sit on the list
  // looking answered and still block the import.
  const ready = useMemo(
    () => skus.filter((s) => isNewSkuAnswered(values[s.skuCode])),
    [skus, values],
  );
  const outstanding = skus.length - ready.length;

  if (!jobId || skus.length === 0) return null;

  const handleSave = async () => {
    if (ready.length === 0) {
      toast.error('Fill in all four fields for at least one SKU.');
      return;
    }

    const entries = ready.map((s) => ({
      skuCode: s.skuCode,
      ...Object.fromEntries(FIELDS.map((f) => [f.field, String(values[s.skuCode][f.field]).trim()])),
    }));

    const res = await onSave?.(entries);
    if (!res?.ok) {
      toast.error(res?.message || 'The details could not be saved.');
      return;
    }
    // Server-side rejections are surfaced one by one — a silent partial save is
    // how a SKU ends up believed-configured and is not.
    for (const err of res.errors || []) toast.error(err);
    if (res.applied?.length) {
      toast.success(`Details saved for ${res.applied.length} new SKU(s).`);
    }
    if (res.ready) onClose?.();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      title={`${skus.length} new SKU${skus.length === 1 ? '' : 's'} need${skus.length === 1 ? 's' : ''} more information`}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2 p-3 rounded-lg bg-primary-50 border border-primary-200">
          <PackagePlus size={16} className="text-primary-600 shrink-0 mt-0.5" />
          <p className="text-xs text-primary-900 leading-relaxed">
            These SKUs are <strong>not in the Inventory Master yet</strong> and this file will
            create them. Each one needs a <strong>Brand</strong>, its
            <strong> Available Stock</strong>, and an <strong>MOQ</strong>,
            <strong> Lead Time</strong>, <strong>Safety Factor</strong> and
            <strong> Box Number</strong> before the import can run — without them the SKU has no
            reorder point and no picking location. Brand and stock are filled in already where the
            upload form or the sheet supplied them. SKUs already in the master are unaffected and
            import as usual.
          </p>
        </div>

        <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white z-10">
              <tr className="text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200">
                {/* Brand and Available Stock used to sit here as read-only
                    columns. They are answers now, so they are inputs below —
                    showing them twice would beg the question of which one
                    counts. */}
                <th className="py-2 pr-3">SKU</th>
                {FIELDS.map((f) => (
                  <th key={f.field} className="py-2 pr-3 w-32">{f.label} *</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {skus.map((s) => {
                const row = values[s.skuCode] || {};
                return (
                  <tr key={s.skuCode} className="align-top">
                    <td className="py-2 pr-3">
                      <span className="font-bold text-slate-900">{s.skuCode}</span>
                      {/* Enough detail to know WHICH SKU is being described
                          without opening the file in another window. */}
                      {(s.description || s.msilCode) && (
                        <span className="block text-[11px] text-slate-400 truncate max-w-48">
                          {s.description || `MSIL ${s.msilCode}`}
                        </span>
                      )}
                      {s.rowNumber && (
                        <span className="block text-[10px] text-slate-300">Row {s.rowNumber}</span>
                      )}
                    </td>
                    {FIELDS.map((f) => {
                      // Shown only once something has been typed and then
                      // emptied or mistyped — an untouched row is incomplete,
                      // not wrong, and marking it red on open is just noise.
                      const problem = String(row[f.field] ?? '').trim()
                        ? problemWith(f.field, row[f.field])
                        : null;
                      return (
                        <td key={f.field} className="py-2 pr-3">
                          {f.type === 'brand' ? (
                            <select
                              value={row[f.field] ?? ''}
                              onChange={setValue(s.skuCode, f.field)}
                              aria-label={`Brand for ${s.skuCode}`}
                              aria-invalid={Boolean(problem)}
                              className={`w-full px-2 py-1.5 text-sm border rounded-lg outline-none focus:ring-1 ${
                                problem
                                  ? 'border-error-400 focus:border-error-500 focus:ring-error-500'
                                  : 'border-slate-300 focus:border-primary-500 focus:ring-primary-500'
                              }`}
                            >
                              <option value="">Choose…</option>
                              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                              {/* A brand the server prefilled that this user's
                                  list does not contain would otherwise render
                                  as an empty select and be silently changed on
                                  save. */}
                              {row[f.field] && !brands.includes(row[f.field]) && (
                                <option value={row[f.field]}>{row[f.field]}</option>
                              )}
                            </select>
                          ) : (
                            <input
                              type={f.type}
                              step={f.step}
                              min={f.min}
                              value={row[f.field] ?? ''}
                              onChange={setValue(s.skuCode, f.field)}
                              placeholder={f.placeholder}
                              aria-label={`${f.label} for ${s.skuCode}`}
                              aria-invalid={Boolean(problem)}
                              className={`w-full px-2 py-1.5 text-sm border rounded-lg outline-none focus:ring-1 ${
                                problem
                                  ? 'border-error-400 focus:border-error-500 focus:ring-error-500'
                                  : 'border-slate-300 focus:border-primary-500 focus:ring-primary-500'
                              }`}
                            />
                          )}
                          {problem
                            ? <span className="text-[10px] font-semibold text-error-600">{problem}</span>
                            : <span className="text-[10px] text-slate-400">{f.hint}</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-start gap-2 text-[11px] text-slate-500">
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          <span>
            {outstanding === 0
              ? 'All new SKUs are complete. Save to continue with the import.'
              : `${ready.length} of ${skus.length} complete. The import stays disabled until all `
                + `${skus.length} are filled in — nothing you have saved is lost by closing this.`}
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Later
          </Button>
          <Button size="sm" onClick={handleSave} loading={saving} disabled={ready.length === 0}>
            {!saving && <Save size={15} className="mr-2" />}
            Save {ready.length > 0 ? `${ready.length} ` : ''}SKU{ready.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default NewSkuDetailsModal;
