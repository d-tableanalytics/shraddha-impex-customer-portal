import { useEffect, useState } from 'react';
import { Trash2, AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { inventoryApi } from '../../services/inventory';

/**
 * Remove a SKU from the catalogue.
 *
 * THE DIALOG ASKS THE SERVER WHAT THIS WOULD COST BEFORE OFFERING THE BUTTON.
 * A SKU code is a business key — orders, ledger movements, counts and
 * reservations refer to it BY NAME — so deleting one that has been used does
 * not remove those references, it makes them unresolvable. The server refuses
 * such a delete outright; this screen finds that out first so the answer is an
 * explanation rather than a rejection after the fact.
 *
 * When the SKU cannot go, the dialog says what is holding it and points at
 * Discontinued, which is what retiring a SKU has always meant here. A refusal
 * that does not offer the alternative just gets retried.
 *
 * The code must be typed to confirm. Not ceremony: the delete also removes the
 * SKU's health row, its zero balances, its open alerts and its product content
 * INCLUDING THE IMAGE FILES, and none of that comes back.
 */
export const DeleteSkuModal = ({ skuCode, brand, onClose, onDeleted }) => {
  const [refs, setRefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    inventoryApi
      .skuReferences(skuCode, brand)
      .then((r) => { if (!cancelled) setRefs(r); })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err.response?.data?.message || 'Could not check what uses this SKU.');
        onClose?.();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skuCode, brand, onClose]);

  const deletable = refs?.deletable === true;
  const confirmed = typed.trim().toLowerCase() === String(skuCode).toLowerCase();

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await inventoryApi.deleteItem(skuCode, brand);
      toast.success(res.message || `${skuCode} was removed.`);
      onDeleted?.(skuCode);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'The SKU could not be deleted.');
      // The refusal carries the current reference counts — adopt them so the
      // dialog reflects reality rather than the read it opened with.
      const refreshed = err.response?.data?.references;
      if (refreshed) setRefs({ ...refs, ...refreshed });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal isOpen onClose={deleting ? () => {} : onClose} size="md" title={`Delete ${skuCode}?`}>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm font-semibold">Checking what uses this SKU…</span>
        </div>
      ) : deletable ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-error-50 border border-error-200">
            <ShieldAlert size={16} className="text-error-600 shrink-0 mt-0.5" />
            <div className="text-xs text-error-900 leading-relaxed">
              <p>
                Nothing references <strong>{skuCode}</strong>, so it can be removed. This deletes
                the catalogue entry permanently, along with:
              </p>
              <ul className="mt-1.5 ml-4 list-disc space-y-0.5">
                <li>its stock health row and any zero balances</li>
                <li>any open inventory alerts for it are closed (alerts are never deleted)</li>
                <li>its product description, videos and <strong>image files</strong></li>
              </ul>
              <p className="mt-1.5 font-semibold">None of this can be undone.</p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">
              Type <span className="font-mono text-slate-900">{skuCode}</span> to confirm
            </label>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={skuCode}
              autoFocus
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-error-500 focus:ring-1 focus:ring-error-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onClose} disabled={deleting}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              loading={deleting}
              disabled={!confirmed}
              title={confirmed ? undefined : 'Type the SKU code to confirm.'}
            >
              {!deleting && <Trash2 size={15} className="mr-2" />}Delete permanently
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-50 border border-warning-200">
            <AlertTriangle size={16} className="text-warning-600 shrink-0 mt-0.5" />
            <div className="text-xs text-warning-900 leading-relaxed">
              <p>
                <strong>{skuCode}</strong> cannot be deleted — it is part of the business's
                history. Records refer to a SKU by its code, so removing it would leave them
                pointing at nothing.
              </p>
              <p className="mt-1.5 font-semibold">It is referenced by:</p>
              <ul className="mt-1 ml-4 list-disc space-y-0.5">
                {(refs?.blocking ?? []).map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            To take it out of use, set its <strong>status to Discontinued</strong> in the panel
            behind this dialog. That retires the SKU everywhere it is offered while leaving its
            bookings, movements and counts intact and resolvable.
          </p>

          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={onClose}>Got it</Button>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default DeleteSkuModal;
