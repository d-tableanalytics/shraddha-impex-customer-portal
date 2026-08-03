import { useState } from 'react';
import { Download, Loader2, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';

import { Button } from '../ui/Button';
import { inventoryApi } from '../../services/inventory';

/**
 * Export the table, or just the rows picked out of it.
 *
 * The file is built SERVER-SIDE by the existing export service — the same one
 * that already knows each dataset's columns and streams them. Building a second
 * exporter in the browser would mean a second definition of what a column is,
 * and the two would disagree the first time either dataset changed. It also
 * means an export is not limited to the page the user happens to be looking at.
 *
 * "Selected" narrows the SAME query by SKU rather than exporting a client-side
 * copy of the rows, so the file matches what the server holds now, not what the
 * table was showing a few minutes ago.
 */
export const ExportButton = ({
  exportType, filters = {}, selected = [], selectionKey = 'skuCodes', disabled = false,
}) => {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const run = async (onlySelected) => {
    setOpen(false);
    setBusy(true);
    try {
      // Excel only. CSV loses the column formatting the export service applies,
      // and nobody was choosing it deliberately — the choice was just a second
      // click on the way to the same file.
      await inventoryApi.runExport(exportType, {
        ...filters,
        format: 'xlsx',
        // Which key depends on what a row IS: a SKU on the master and health
        // tables, a transaction on the ledger.
        ...(onlySelected ? { [selectionKey]: selected.join(',') } : {}),
      });
      toast.success(
        onlySelected
          ? `${selected.length.toLocaleString()} selected row(s) exported.`
          : 'Export downloaded.',
      );
    } catch (err) {
      toast.error(err.response?.data?.message || 'The export could not be generated.');
    } finally {
      setBusy(false);
    }
  };

  const hasSelection = selected.length > 0;

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || busy}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Download size={15} className="mr-2" />}
        Export
        <ChevronDown size={14} className="ml-1.5 opacity-60" />
      </Button>

      {open && (
        <>
          {/* Click-away. A menu that only closes on a second click on the
              button is a menu people leave open by accident. */}
          <button
            type="button"
            aria-label="Close export menu"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 mt-1 z-40 w-56 rounded-lg border border-slate-200 bg-white shadow-lg py-1">
            {hasSelection && (
              <>
                <button type="button" onClick={() => run(true)}
                  className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                  Selected rows
                  <span className="block text-[11px] text-slate-400">
                    {selected.length.toLocaleString()} row{selected.length === 1 ? '' : 's'}
                  </span>
                </button>
                <div className="my-1 border-t border-slate-100" />
              </>
            )}

            <button type="button" onClick={() => run(false)}
              className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
              All rows
              <span className="block text-[11px] text-slate-400">
                Everything matching the filters
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default ExportButton;
