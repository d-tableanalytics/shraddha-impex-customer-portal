import { useCallback, useEffect, useState } from 'react';
import { Tag, Plus, Trash2, Loader2, Lock } from 'lucide-react';
import toast from 'react-hot-toast';

import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { inventoryApi } from '../../services/inventory';
import { useUserStore } from '../../store/userStore';

/**
 * Brands — the brand master, on Inventory Configuration beside Stock Locations.
 *
 * Adding a brand here is the whole job: every brand dropdown, filter and
 * account form in both portals builds its options from the same list, so
 * nothing else needs editing. This screen refreshes the signed-in session as
 * soon as a brand is saved; other open screens are told over the socket.
 *
 * A brand is never renamed (its name is stored on every product and order
 * filed under it). One created by mistake can be deleted until something is
 * filed under it.
 */

export const BrandSettings = () => {
  const refreshSession = useUserStore((s) => s.refreshSession);
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [hiddenFromMsil, setHiddenFromMsil] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState(null);

  const load = useCallback(async () => {
    try {
      setBrands(await inventoryApi.listBrands());
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load brands.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const afterChange = async () => {
    await Promise.all([load(), refreshSession()]);
  };

  const create = async () => {
    if (!name.trim()) { toast.error('Enter a brand name.'); return; }
    setSaving(true);
    try {
      const res = await inventoryApi.createBrand({ name: name.trim(), hiddenFromMsil });
      toast.success(res.message || `${name.trim()} created.`, { duration: 6000 });
      setOpen(false);
      setName('');
      setHiddenFromMsil(false);
      await afterChange();
    } catch (err) {
      toast.error(err.response?.data?.message || 'The brand could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const toggleMsil = async (brand) => {
    setBusyKey(brand.key);
    try {
      await inventoryApi.updateBrand(brand.key, { hiddenFromMsil: !brand.hiddenFromMsil });
      toast.success(`${brand.name} is now ${brand.hiddenFromMsil ? 'shown to' : 'hidden from'} MSIL customers.`);
      await afterChange();
    } catch (err) {
      toast.error(err.response?.data?.message || 'The brand could not be updated.');
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (brand) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete the brand ${brand.name}? This cannot be undone.`)) return;
    setBusyKey(brand.key);
    try {
      const res = await inventoryApi.deleteBrand(brand.key);
      toast.success(res.message || `${brand.name} deleted.`);
      await afterChange();
    } catch (err) {
      toast.error(err.response?.data?.message || 'The brand could not be deleted.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        {loading && (
          <div className="flex items-center gap-2 p-3 text-xs text-slate-500">
            <Loader2 size={14} className="animate-spin" /> Loading brands…
          </div>
        )}
        {brands.map((b) => (
          <div key={b.key} className="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-slate-200 bg-white">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-primary-50 text-primary-600">
              <Tag size={17} />
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-slate-800 truncate">
                {b.name}
                {b.system && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase">
                    <Lock size={10} /> Built-in
                  </span>
                )}
              </p>
              <p className="text-[11px] text-slate-500 font-medium">
                {b.products.toLocaleString()} product{b.products === 1 ? '' : 's'}
                {' · '}{b.usersWithAccess.toLocaleString()} account{b.usersWithAccess === 1 ? '' : 's'} with access
              </p>
            </div>

            {b.hiddenFromMsil && (
              <span className="inline-flex px-2 py-1 rounded text-[11px] font-bold bg-warning-50 text-warning-700 shrink-0">
                Hidden from MSIL
              </span>
            )}

            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="sm" variant="ghost" disabled={busyKey === b.key} onClick={() => toggleMsil(b)}>
                {b.hiddenFromMsil ? 'Show to MSIL' : 'Hide from MSIL'}
              </Button>
              {!b.system && b.products === 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyKey === b.key}
                  onClick={() => remove(b)}
                  aria-label={`Delete ${b.name}`}
                >
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus size={15} className="mr-2" />
          Add Brand
        </Button>
      </div>

      <Modal isOpen={open} onClose={saving ? () => {} : () => setOpen(false)} title="Add Brand">
        <div className="flex flex-col gap-4">
          <Input
            label="Brand name"
            placeholder="e.g. Stanley"
            value={name}
            maxLength={30}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
              checked={hiddenFromMsil}
              onChange={(e) => setHiddenFromMsil(e.target.checked)}
            />
            <span>
              Hide from MSIL customers
              <span className="block text-[11px] text-slate-400">The rule IMADA follows today.</span>
            </span>
          </label>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            The brand appears at once in every brand list — inventory, imports, exports, reports,
            bookings and the account forms. Admins and inventory staff see it straight away.
            Customer and Sales accounts see it once it is ticked on their account in User Management.
            The name cannot be changed later.
          </p>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={create} disabled={saving}>
              {saving && <Loader2 size={14} className="mr-2 animate-spin" />}
              Create Brand
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default BrandSettings;
