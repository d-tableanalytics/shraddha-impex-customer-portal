import { useRef, useState } from 'react';
import { Upload, Download, X, Loader2, FileSpreadsheet, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useUpcomingStockStore } from '../../store/upcomingStockStore';
import {
  readImportFile, validateImportRows, sampleImportRows, downloadTemplate,
  formatDate, TEMPLATE_HEADERS,
} from '../../utils/upcomingStockMock';

/**
 * Import a temporary upcoming-stock file — DEMO ONLY.
 *
 * The file is read in the browser and validated against the current upcoming
 * list. Valid lines are added as inbound shipments; nothing is sent to the
 * server and Inventory Master is not touched.
 */

const OUTCOME = {
  existing: { label: 'Adds to SKU', chip: 'bg-primary-50 text-primary-700' },
  new: { label: 'New SKU', chip: 'bg-success-50 text-success-700' },
  error: { label: 'Error', chip: 'bg-error-50 text-error-700' },
};

export const ImportUpcomingModal = ({ open, onClose }) => {
  const items = useUpcomingStockStore((s) => s.items);
  const importShipments = useUpcomingStockStore((s) => s.importShipments);

  const fileInput = useRef(null);
  const [fileName, setFileName] = useState('');
  const [lines, setLines] = useState(null);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);

  const reset = () => {
    setLines(null);
    setFileName('');
    if (fileInput.current) fileInput.current.value = '';
  };
  const close = () => { reset(); onClose(); };

  const accept = (result, name) => {
    if (result.error) { toast.error(result.error); reset(); return; }
    if (result.lines.length === 0) { toast.error('The file has no data rows.'); reset(); return; }
    setFileName(name);
    setLines(result.lines);
  };

  const handleFile = async (file) => {
    if (!file) return;
    setReading(true);
    setFileName(file.name);
    try {
      accept(await readImportFile(file, items), file.name);
    } catch {
      toast.error('That file could not be read. Use .xlsx, .xls or .csv.');
      reset();
    } finally {
      setReading(false);
    }
  };

  const loadSample = async () => {
    setReading(true);
    setFileName('upcoming-stock-oct.xlsx');
    await new Promise((r) => setTimeout(r, 500));
    accept(validateImportRows(sampleImportRows(), items), 'upcoming-stock-oct.xlsx');
    setReading(false);
  };

  const valid = (lines || []).filter((l) => l.outcome !== 'error');
  const errors = (lines || []).filter((l) => l.outcome === 'error');
  const summary = lines && [
    ['Rows in file', lines.length, 'text-slate-900'],
    ['Ready to import', valid.length, 'text-success-700'],
    ['New SKUs', valid.filter((l) => l.outcome === 'new').length, 'text-primary-700'],
    ['Errors', errors.length, errors.length ? 'text-error-700' : 'text-slate-400'],
  ];
  const totalQty = valid.reduce((s, l) => s + l.qty, 0);

  const confirm = async () => {
    setImporting(true);
    await new Promise((r) => setTimeout(r, 700));
    const entry = importShipments(valid, fileName);
    setImporting(false);
    toast.success(
      `Imported ${entry.lines} line${entry.lines === 1 ? '' : 's'} · ${entry.qty.toLocaleString()} units of upcoming stock`
      + (entry.created ? ` · ${entry.created} new SKU${entry.created === 1 ? '' : 's'}` : ''),
    );
    close();
  };

  return (
    <Modal isOpen={open} onClose={close} title="Import Upcoming Stock" size="xl">
      <div className="flex flex-col gap-5">
        <p className="text-xs text-slate-500 leading-relaxed">
          Upload a shipment file listing stock that has been ordered but not yet received. Each row is added
          as an upcoming shipment for its SKU; existing reservations are kept. Actual stock is not changed —
          it moves only when the goods are received.
        </p>

        {!lines && !reading && (
          <div className="flex flex-col gap-4">
            <label
              className="flex flex-col items-center justify-center gap-2 p-8 border-2 border-dashed border-slate-300 rounded-xl
                         bg-slate-50/50 hover:bg-primary-50/20 hover:border-primary-300 transition-colors cursor-pointer text-center"
            >
              <FileSpreadsheet size={28} className="text-slate-400" />
              <span className="text-sm font-bold text-slate-700">Choose a file to upload</span>
              <span className="text-[11px] text-slate-400">.xlsx, .xls or .csv · first sheet is read</span>
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="sr-only"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-slate-500">
                Columns: <span className="font-semibold text-slate-600">{TEMPLATE_HEADERS.join(' · ')}</span>.
                Only SKU Code, Upcoming Qty and Expected Arrival are required.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={downloadTemplate}>
                  <Download size={14} className="mr-2" />Template
                </Button>
                <Button variant="secondary" size="sm" onClick={loadSample}>
                  <Sparkles size={14} className="mr-2" />Use sample file
                </Button>
              </div>
            </div>
          </div>
        )}

        {reading && (
          <div className="flex items-center gap-2 py-12 justify-center text-slate-500 text-sm">
            <Loader2 size={16} className="animate-spin" /> Reading {fileName}…
          </div>
        )}

        {lines && !reading && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 text-sm font-bold text-slate-800">
                <FileSpreadsheet size={16} className="text-success-600" />{fileName}
              </span>
              <Button size="xs" variant="secondary" onClick={reset}>
                <X size={13} className="mr-1" />Choose another file
              </Button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {summary.map(([label, value, tone]) => (
                <div key={label} className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
                  <span className={`block text-lg font-black tabular-nums ${tone}`}>{value.toLocaleString()}</span>
                </div>
              ))}
            </div>

            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                    <tr>
                      {['Row', 'SKU', 'Product', 'Qty', 'Expected Arrival', 'Reference', 'Result'].map((h, i) => (
                        <th key={h} className={`px-4 py-3 font-bold text-slate-600 uppercase text-[11px] ${i === 3 ? 'text-right' : ''}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((l) => (
                      <tr key={l.row} className={l.outcome === 'error' ? 'bg-error-50/50' : ''}>
                        <td className="px-4 py-2.5 text-slate-400 tabular-nums">{l.row}</td>
                        <td className="px-4 py-2.5">
                          <span className="font-bold text-slate-900">{l.skuCode || '—'}</span>
                          <span className="block text-[11px] text-slate-400 font-medium">{l.brand}</span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 max-w-64 truncate" title={l.product}>{l.product}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-slate-800 tabular-nums">
                          {l.outcome === 'error' && !l.qty ? '—' : l.qty.toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{formatDate(l.eta)}</td>
                        <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">{l.ref}</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex px-2 py-1 rounded-md text-[11px] font-bold ${OUTCOME[l.outcome].chip}`}>
                            {OUTCOME[l.outcome].label}
                          </span>
                          {l.problems.map((p) => (
                            <span key={p} className="block text-[11px] text-error-700 mt-1">{p}</span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {errors.length > 0 ? (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-50 border border-warning-200">
                <AlertCircle size={16} className="text-warning-600 shrink-0 mt-0.5" />
                <p className="text-xs text-warning-800 leading-relaxed">
                  {errors.length} row{errors.length === 1 ? '' : 's'} will be skipped. Fix {errors.length === 1 ? 'it' : 'them'} in the file and
                  import again, or continue with the {valid.length} valid row{valid.length === 1 ? '' : 's'}.
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-success-50 border border-success-100">
                <CheckCircle2 size={16} className="text-success-600 shrink-0 mt-0.5" />
                <p className="text-xs text-success-700">Every row is valid.</p>
              </div>
            )}
          </>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 -mx-6 px-6 -mb-2 pt-4">
          {lines && valid.length > 0 && (
            <span className="mr-auto text-xs text-slate-500">
              <strong className="text-slate-800 tabular-nums">{totalQty.toLocaleString()}</strong> units across {valid.length} line{valid.length === 1 ? '' : 's'}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={close}>Cancel</Button>
          <Button size="sm" onClick={confirm} loading={importing} disabled={!lines || valid.length === 0}>
            {!importing && <Upload size={15} className="mr-2" />}
            Import {valid.length > 0 ? `${valid.length} line${valid.length === 1 ? '' : 's'}` : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default ImportUpcomingModal;
