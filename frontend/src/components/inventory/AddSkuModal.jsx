import { useEffect, useMemo, useRef, useState } from 'react';
import { PackagePlus, AlertTriangle, CheckCircle2, Loader2, Save } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { inventoryApi } from '../../services/inventory';

/**
 * Add a single SKU to the catalogue.
 *
 * THE DUPLICATE CHECK RUNS AS THE CODE IS TYPED, not when Save is pressed. A
 * SKU code is a business key: a second row for the same code is not a new
 * product, it is two answers to "how much of this do we have", and the moment
 * to say so is while the person still has the code in their head — not after
 * they have filled in eight more fields.
 *
 * It asks the SERVER, through the same function the save uses, rather than
 * scanning the loaded page. The table holds one page of a several-thousand-SKU
 * catalogue, so a local check would clear almost every duplicate there is.
 */

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none '
  + 'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

const Field = ({ label, hint, children, required }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">
      {label} {required && <span className="text-error-500">*</span>}
    </label>
    {children}
    {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
  </div>
);

const EMPTY = {
  skuCode: '', brand: '', msilCode: '', description: '', uom: 'PCS',
  category: '', vendorName: '', status: 'Active', boxNo: '',
  leadTime: '', safetyFactor: '', moq: '',
};

export const AddSkuModal = ({ brands = [], canSetBoxNo = false, onClose, onCreated }) => {
  const [form, setForm] = useState(() => ({ ...EMPTY, brand: brands.length === 1 ? brands[0] : '' }));
  const [saving, setSaving] = useState(false);

  /** null = not asked yet, otherwise the server's answer for the typed code. */
  const [availability, setAvailability] = useState(null);
  const [checking, setChecking] = useState(false);
  // Guards against a slow early request landing after a fast later one and
  // reporting the wrong code's answer.
  const checkSeq = useRef(0);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const code = form.skuCode.trim();
  const msil = form.msilCode.trim();

  useEffect(() => {
    if (!code) { setAvailability(null); setChecking(false); return undefined; }

    const seq = ++checkSeq.current;
    setChecking(true);
    // Debounced: a check per keystroke would be a request per character on a
    // field people paste into anyway.
    const timer = setTimeout(async () => {
      try {
        const result = await inventoryApi.checkSkuAvailable({
          skuCode: code, brand: form.brand, msilCode: msil,
        });
        if (seq === checkSeq.current) setAvailability(result);
      } catch {
        // A failed check must not block the form — the save re-checks anyway,
        // and that check is the one that counts.
        if (seq === checkSeq.current) setAvailability(null);
      } finally {
        if (seq === checkSeq.current) setChecking(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [code, msil, form.brand]);

  const taken = Boolean(availability?.exists);
  const msilTaken = Boolean(availability?.msilClash);
  const otherBrands = availability?.otherBrands ?? [];

  const problems = useMemo(() => {
    const list = [];
    if (!code) list.push('A SKU code is required.');
    if (!form.brand) list.push('Choose a brand.');
    if (taken) list.push('That SKU code already exists.');
    if (msilTaken) list.push('That MSIL code already belongs to another SKU.');
    for (const [key, label] of [['leadTime', 'Lead time'], ['safetyFactor', 'Safety factor'], ['moq', 'MOQ']]) {
      const raw = String(form[key] ?? '').trim();
      if (raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) list.push(`${label} must be a number of zero or more.`);
    }
    return list;
  }, [code, form, taken, msilTaken]);

  const handleSave = async () => {
    if (problems.length) { toast.error(problems[0]); return; }

    setSaving(true);
    try {
      const payload = {
        skuCode: code,
        brand: form.brand,
        // Blank fields are omitted rather than sent as empty strings, so the
        // schema defaults apply and a new SKU is not filled with "".
        ...(msil ? { msilCode: msil } : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(form.uom.trim() ? { uom: form.uom.trim() } : {}),
        ...(form.category.trim() ? { category: form.category.trim() } : {}),
        ...(form.vendorName.trim() ? { vendorName: form.vendorName.trim() } : {}),
        ...(form.status ? { status: form.status } : {}),
        // Only sent by someone who may set one — a new SKU has no mapping to
        // disturb, which is why this is offered at all (see sku.service.js).
        ...(canSetBoxNo && form.boxNo.trim() ? { boxNo: form.boxNo.trim() } : {}),
        ...(String(form.leadTime).trim() !== '' ? { leadTime: Number(form.leadTime) } : {}),
        ...(String(form.safetyFactor).trim() !== '' ? { safetyFactor: Number(form.safetyFactor) } : {}),
        ...(String(form.moq).trim() !== '' ? { moq: Number(form.moq) } : {}),
      };

      const { item, warnings } = await inventoryApi.createItem(payload);
      toast.success(`${item.skuCode} added to the catalogue.`);
      for (const w of warnings) toast(w, { icon: '⚠️', duration: 8000 });
      onCreated?.(item);
      onClose?.();
    } catch (err) {
      const data = err.response?.data;
      toast.error(data?.message || 'The SKU could not be created.');
      // A 409 arrives with the row that already holds the code — showing it
      // beats a message the user has to go and verify.
      if (data?.code === 'SKU_EXISTS' || data?.code === 'MSIL_EXISTS') {
        setAvailability({
          exists: data.code === 'SKU_EXISTS',
          sameBrand: data.code === 'SKU_EXISTS' ? data.existing : null,
          msilClash: data.code === 'MSIL_EXISTS' ? data.existing : null,
          otherBrands: [],
        });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={saving ? () => {} : onClose} size="lg" title="Add a SKU to the catalogue">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label="SKU Code"
            required
            hint="The business key. It cannot be changed afterwards — orders and stock movements refer to it by name."
          >
            <input
              value={form.skuCode}
              onChange={set('skuCode')}
              placeholder="e.g. 14405M-10"
              autoFocus
              className={`${inputCls} font-mono ${taken ? 'border-error-400 focus:border-error-500 focus:ring-error-500' : ''}`}
            />
          </Field>

          <Field label="Brand" required hint="Decides which catalogue the SKU lives in.">
            <select value={form.brand} onChange={set('brand')} className={inputCls}>
              <option value="">Choose a brand…</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </Field>
        </div>

        {/* The live answer, in the same place every time so it is never missed. */}
        {code && (
          <div className="min-h-[38px]">
            {checking ? (
              <p className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 size={13} className="animate-spin" /> Checking the catalogue…
              </p>
            ) : taken ? (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-error-50 border border-error-200">
                <AlertTriangle size={15} className="text-error-600 shrink-0 mt-0.5" />
                <p className="text-xs text-error-800">
                  <strong>{availability.sameBrand.skuCode}</strong> already exists under{' '}
                  {availability.sameBrand.brand}
                  {availability.sameBrand.description ? ` — ${availability.sameBrand.description}` : ''}
                  {availability.sameBrand.status ? ` (${availability.sameBrand.status})` : ''}.
                  Edit that SKU instead of creating a second one.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="flex items-center gap-2 text-xs text-success-700">
                  <CheckCircle2 size={14} /> {code} is available under {form.brand || 'this brand'}.
                </p>
                {otherBrands.length > 0 && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-warning-50 border border-warning-200">
                    <AlertTriangle size={15} className="text-warning-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-warning-900">
                      This code also exists under{' '}
                      <strong>{otherBrands.map((o) => o.brand).join(', ')}</strong>. That is allowed,
                      but a sheet naming this SKU without a brand cannot say which is meant, and the
                      import will report it as ambiguous.
                    </p>
                  </div>
                )}
              </div>
            )}
            {msilTaken && (
              <div className="mt-2 flex items-start gap-2 p-2.5 rounded-lg bg-error-50 border border-error-200">
                <AlertTriangle size={15} className="text-error-600 shrink-0 mt-0.5" />
                <p className="text-xs text-error-800">
                  MSIL code <strong>{msil}</strong> already belongs to{' '}
                  {availability.msilClash.skuCode}. Two SKUs sharing one MSIL code cannot be told
                  apart by the Fresh Inventory import.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-slate-100 pt-4">
          <Field label="MSIL Code" hint="Optional. Used to find this SKU when a sheet gives no SKU code.">
            <input
              value={form.msilCode}
              onChange={set('msilCode')}
              placeholder="e.g. MA0LU004000"
              className={`${inputCls} font-mono ${msilTaken ? 'border-error-400' : ''}`}
            />
          </Field>
          <Field label="Description" hint="The product name shown wherever this SKU appears.">
            <input value={form.description} onChange={set('description')} placeholder="e.g. 3/8 inch drive socket set" className={inputCls} />
          </Field>
          <Field label="Category" hint="Comma-separated.">
            <input value={form.category} onChange={set('category')} placeholder="e.g. Impact Sockets" className={inputCls} />
          </Field>
          <Field label="Unit of measure">
            <input value={form.uom} onChange={set('uom')} placeholder="PCS" className={inputCls} />
          </Field>
          <Field label="Vendor">
            <input value={form.vendorName} onChange={set('vendorName')} className={inputCls} />
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={set('status')} className={inputCls}>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Discontinued">Discontinued</option>
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-slate-100 pt-4">
          <Field label="Lead time" hint="Days">
            <input type="number" min="0" step="any" value={form.leadTime} onChange={set('leadTime')} className={inputCls} />
          </Field>
          <Field label="Safety factor">
            <input type="number" min="0" step="any" value={form.safetyFactor} onChange={set('safetyFactor')} className={inputCls} />
          </Field>
          <Field label="MOQ" hint="Units">
            <input type="number" min="0" step="1" value={form.moq} onChange={set('moq')} className={inputCls} />
          </Field>
          {canSetBoxNo && (
            <Field label="Box number" hint="The picking box.">
              <input value={form.boxNo} onChange={set('boxNo')} placeholder="e.g. B-12" className={inputCls} />
            </Field>
          )}
        </div>

        <p className="text-[11px] text-slate-400">
          Stock is not set here. A new SKU starts at zero and moves only through the stock
          ledger — Update stock, an adjustment, or an import.
        </p>

        <div className="flex justify-end gap-2 pt-1 border-t border-slate-100">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            size="sm"
            onClick={handleSave}
            loading={saving}
            disabled={problems.length > 0 || checking}
            title={problems[0]}
          >
            {!saving && <PackagePlus size={15} className="mr-2" />}Add SKU
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default AddSkuModal;
