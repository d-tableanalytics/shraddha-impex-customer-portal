import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Upload, Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { inventoryApi } from '../../services/inventory';
import { bandLabel } from '../../utils/inventoryFormat';

/**
 * Upload a list of SKUs and see what stock the catalogue holds for each.
 *
 * READ ONLY, and deliberately separate from Inventory Import. That one writes:
 * it creates SKUs, adds stock and posts to the ledger. This one answers a
 * different question — "what have I actually got for these codes" — and someone
 * checking a supplier's list against their own shelves should not have to go
 * near a screen that can change anything to find out.
 *
 * The file is read in the browser only far enough to pull the codes out of it;
 * the quantities come from the server, because the whole point is to compare a
 * list against what the system really holds.
 */

const CELL = 'px-4 py-2.5';

/**
 * Pull SKU codes out of a workbook.
 *
 * Takes a column called something like "SKU" when the sheet has headers, and
 * falls back to the first column when it does not — a list of codes pasted into
 * a blank sheet is the most common shape this receives, and refusing it for
 * lacking a header would be pedantry.
 */
const readSkuCodes = (rows) => {
  if (rows.length === 0) return [];

  const header = (rows[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const skuIndex = header.findIndex((h) => /^(sku|sku ?code|item ?code|part ?no\.?)$/.test(h));

  const startRow = skuIndex >= 0 ? 1 : 0;
  const column = skuIndex >= 0 ? skuIndex : 0;

  return rows
    .slice(startRow)
    .map((r) => String(r?.[column] ?? '').trim())
    .filter(Boolean);
};

export const SkuLookupModal = ({ open, onClose }) => {
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
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const codes = readSkuCodes(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }));

      if (codes.length === 0) {
        toast.error('No SKU codes were found in that file.');
        setLoading(false);
        return;
      }

      const res = await inventoryApi.lookupSkus(codes);
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
    <Modal isOpen={open} onClose={close} title="Check stock for a list of SKUs" size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-slate-500 leading-relaxed">
          Upload a file of SKU codes to see what is in stock for each. Nothing is changed —
          this only reads. Use <strong>Inventory Import</strong> to create SKUs or add stock.
        </p>

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
                    <th className={`${CELL} text-right`}>On Hand</th>
                    <th className={`${CELL} text-right`}>Reserved</th>
                    <th className={`${CELL} text-right`}>Available</th>
                    <th className={CELL}>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.skuCode} className={r.found ? '' : 'bg-error-50/40'}>
                      <td className={`${CELL} font-bold text-slate-800`}>
                        {r.skuCode}
                        {r.found && r.brand && (
                          <span className="block text-[10px] font-medium text-slate-400">{r.brand}</span>
                        )}
                      </td>
                      <td className={`${CELL} text-right tabular-nums text-slate-700`}>
                        {r.found ? r.onHand.toLocaleString() : '—'}
                      </td>
                      <td className={`${CELL} text-right tabular-nums text-slate-500`}>
                        {r.found ? r.reserved.toLocaleString() : '—'}
                      </td>
                      <td className={`${CELL} text-right tabular-nums font-bold text-primary-700`}>
                        {r.found ? r.available.toLocaleString() : '—'}
                      </td>
                      <td className={`${CELL} text-[11px]`}>
                        {r.found ? (
                          <span className="text-slate-500">{r.band ? bandLabel(r.band) : r.status}</span>
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
