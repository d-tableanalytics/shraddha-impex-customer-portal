import { useRef, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { readSkuCodesFromFile, readCodesFromFile } from '../../utils/skuFile';

/**
 * Upload a list of SKU codes and preview what the system holds for each.
 *
 * READ ONLY, and deliberately separate from Inventory Import. That one writes:
 * it creates SKUs, adds stock and posts to the ledger. This answers a different
 * question — "what have I actually got for these codes" — and someone checking
 * a list should not have to go near a screen that can change anything.
 *
 * GENERIC OVER THE ANSWER. The admin and the customer upload the same kind of
 * file and want the same preview, but not the same figures: an admin needs on
 * hand, reserved and the planning band, while a customer only needs what they
 * can order. Rather than clone the file handling and the preview shell, the
 * caller supplies the lookup call and the columns; everything else is shared.
 *
 * The file is read in the browser only far enough to pull the codes out of it.
 * The quantities always come from the server, because the whole point is to
 * compare a list against what the system really holds.
 *
 * @param {(codes: string[]) => Promise<{data: object[], summary: object}>} lookup
 * @param {{key: string, label: string, align?: 'left'|'right', render: (row) => any}[]} columns
 */

const CELL = 'px-4 py-2.5';

export const SkuLookupModal = ({
  open,
  onClose,
  lookup,
  columns,
  title = 'Check stock for a list of SKUs',
  intro,
  size = 'lg',
  showMsilCode = false,
}) => {
  const fileInput = useRef(null);
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);

  const reset = () => {
    setFileName(''); setRows(null); setSummary(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const handleFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    setLoading(true);
    setRows(null);
    setSummary(null);
    try {
      let res;
      if (showMsilCode) {
        // MSIL users: extract both SKU + MSIL columns from the file.
        const { skuCodes, msilCodes } = await readCodesFromFile(file);
        if (skuCodes.length === 0 && msilCodes.length === 0) {
          toast.error('No SKU or MSIL codes were found in that file.');
          setLoading(false);
          return;
        }
        res = await lookup(skuCodes, msilCodes);
      } else {
        // Non-MSIL users: SKU codes only (original path).
        const codes = await readSkuCodesFromFile(file);
        if (codes.length === 0) {
          toast.error('No SKU codes were found in that file.');
          setLoading(false);
          return;
        }
        res = await lookup(codes);
      }
      setRows(res.data);
      setSummary(res.summary);
    } catch (err) {
      toast.error(err.response?.data?.message || 'That file could not be read.');
    } finally {
      setLoading(false);
    }
  };

  const close = () => { reset(); onClose?.(); };

  return (
    <Modal isOpen={open} onClose={close} title={title} size={size}>
      <div className="flex flex-col gap-4">
        {intro && <p className="text-xs text-slate-500 leading-relaxed">{intro}</p>}

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0
                       file:bg-primary-50 file:text-primary-700 file:font-bold file:text-xs
                       file:cursor-pointer text-slate-500"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          {rows && (
            <Button size="xs" variant="secondary" onClick={reset}>
              <X size={13} className="mr-1" />Clear
            </Button>
          )}
        </div>

        {loading && (
          <div className="flex items-center gap-2 py-8 justify-center text-slate-500 text-sm">
            <Loader2 size={16} className="animate-spin" /> Reading {fileName}…
          </div>
        )}

        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              ['Codes in file', summary.unique, 'text-slate-900'],
              ['Found', summary.found, 'text-success-700'],
              ['Not in catalogue', summary.missing, summary.missing ? 'text-error-700' : 'text-slate-400'],
              ['Total available', summary.totalAvailable, 'text-primary-700'],
            ].map(([label, value, tone]) => (
              <div key={label} className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
                <span className={`block text-lg font-black tabular-nums ${tone}`}>
                  {Number(value).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}

        {summary?.truncated && (
          <p className="text-[11px] text-warning-800 bg-warning-50 border border-warning-200 rounded-lg px-3 py-2">
            The file held more codes than can be checked at once — only the first 5,000 are shown.
          </p>
        )}

        {rows && (
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 sticky top-0">
                  <tr className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    <th className={CELL}>SKU</th>
                    {showMsilCode && <th className={CELL}>MSIL Code</th>}
                    {columns.map((c) => (
                      <th key={c.key} className={`${CELL} ${c.align === 'right' ? 'text-right' : ''}`}>
                        {c.label}
                      </th>
                    ))}
                    <th className={CELL}>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.lookupCode || r.skuCode} className={r.found ? '' : 'bg-error-50/40'}>
                      <td className={`${CELL} font-bold text-slate-800`}>
                        {r.skuCode || '—'}
                        {r.found && r.brand && (
                          <span className="block text-[10px] font-medium text-slate-400">{r.brand}</span>
                        )}
                      </td>
                      {showMsilCode && (
                        <td className={`${CELL} font-medium text-slate-600`}>
                          {r.msilCode || '—'}
                        </td>
                      )}
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={`${CELL} ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.className || 'text-slate-700'}`}
                        >
                          {r.found ? c.render(r) : '—'}
                        </td>
                      ))}
                      <td className={`${CELL} text-[11px]`}>
                        {r.found ? (
                          <span className="text-slate-500">{r.statusLabel ?? r.status}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-error-700 font-semibold whitespace-nowrap">
                            <AlertCircle size={13} /> Not in the catalogue
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {rows && summary?.missing === 0 && (
          <p className="flex items-center gap-2 text-xs text-success-700">
            <CheckCircle2 size={14} /> Every code in the file exists in the catalogue.
          </p>
        )}

        <div className="flex justify-end">
          <Button variant="secondary" onClick={close}>Close</Button>
        </div>
      </div>
    </Modal>
  );
};

export default SkuLookupModal;
