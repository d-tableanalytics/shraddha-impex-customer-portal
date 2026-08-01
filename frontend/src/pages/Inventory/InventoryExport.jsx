import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Download, Loader2, FileSpreadsheet, FileText, History, Filter,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { PageHeader } from '../../components/common/PageHeader';
import { useExportStore } from '../../store/importStore';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { hasPermission, canUseInventoryMaster, PERMISSIONS } from '../../utils/permissions';

/**
 * Export Centre — IMS Module M9.
 *
 * Every export streams from a projection that already exists. Nothing on this
 * screen — and nothing behind it — recalculates a band, a target or a balance;
 * the columns are the stored fields, and the filters narrow which rows are
 * read. That is what makes an export reproducible: the same filters against the
 * same projections give the same file.
 */

/** Which filters each export accepts. Mirrors the server's own filter map. */
const FILTERS_FOR = {
  'inventory-master': ['brand', 'category', 'status', 'search'],
  'stock-balance': ['brand', 'locationCode', 'skuCode'],
  'stock-health': ['brand', 'band', 'plannable'],
  'stock-movements': ['brand', 'skuCode', 'locationCode', 'movementType', 'dateFrom', 'dateTo'],
  snapshot: ['runId'],
  'stock-counts': ['brand', 'status', 'locationCode', 'dateFrom', 'dateTo'],
  alerts: ['brand', 'severity', 'status', 'dateFrom', 'dateTo'],
};

const OPTIONS = {
  band: ['Out of Stock', 'Critical', 'Low', 'Healthy', 'Overstock', 'Unknown'],
  plannable: ['true', 'false'],
  movementType: ['OPENING', 'RECEIPT', 'ISSUE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'COUNT', 'RESERVE', 'RELEASE', 'REVERSAL'],
  severity: ['Critical', 'High', 'Medium', 'Low', 'Info'],
  status: {
    'inventory-master': ['Active', 'Inactive', 'Discontinued'],
    'stock-counts': ['Draft', 'Counting', 'Submitted', 'Approved', 'Rejected', 'Posted', 'Cancelled'],
    alerts: ['Open', 'Acknowledged', 'Resolved', 'Closed'],
  },
};

const LABELS = {
  brand: 'Brand', category: 'Category', status: 'Status', search: 'SKU starts with',
  skuCode: 'SKU code', locationCode: 'Location', band: 'Health band', plannable: 'Plannable',
  movementType: 'Movement type', severity: 'Severity', runId: 'Snapshot run',
  dateFrom: 'From', dateTo: 'To',
};

const nf = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtBytes = (b) => {
  if (!b) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

export const InventoryExport = () => {
  const { user } = useUserStore();
  const {
    types, snapshotRuns, fetchTypes, download, downloading,
    history, historyLoading, fetchHistory, error, clearError,
  } = useExportStore();

  const [selected, setSelected] = useState('');
  const [format, setFormat] = useState('xlsx');
  const [filters, setFilters] = useState({});

  useEffect(() => { fetchTypes(); fetchHistory(); }, [fetchTypes, fetchHistory]);
  useEffect(() => { if (error) { toast.error(error); clearError(); } }, [error, clearError]);

  if (user && !(hasPermission(user, PERMISSIONS.VIEW_INVENTORY) && canUseInventoryMaster(user))) {
    return <Navigate to="/" replace />;
  }
  if (user && !hasPermission(user, PERMISSIONS.EXPORT_INVENTORY)) {
    return <Navigate to="/inventory/dashboard" replace />;
  }

  const brands = allowedBrands(user);
  const spec = types.find((t) => t.exportType === selected) || null;
  const fields = FILTERS_FOR[selected] || [];

  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));

  const pick = (exportType) => {
    setSelected(exportType);
    // Filters are cleared on switch: a SKU filter left over from the balance
    // export would silently narrow the alert export to nothing.
    setFilters({});
  };

  const handleDownload = async () => {
    const missing = (spec?.requires || []).filter((r) => !filters[r]);
    if (missing.length) {
      toast.error(`Choose a ${missing.map((m) => LABELS[m] ?? m).join(' and ')} first.`);
      return;
    }
    const res = await download(selected, { format, ...filters });
    if (res.ok) toast.success('Download started.');
  };

  const renderField = (key) => {
    if (key === 'runId') {
      return (
        <select className={inputCls} value={filters.runId || ''} onChange={(e) => setFilter('runId', e.target.value)}>
          <option value="">Choose a run…</option>
          {snapshotRuns.map((r) => (
            <option key={r.runId} value={r.runId}>
              {new Date(r.snapshotDate).toLocaleDateString('en-IN')} — {r.runId}
              {r.scopeBrand ? ` (${r.scopeBrand})` : ''} · {nf(r.rowCount)} rows
            </option>
          ))}
        </select>
      );
    }
    if (key === 'brand') {
      return (
        <select className={inputCls} value={filters.brand || ''} onChange={(e) => setFilter('brand', e.target.value)}>
          <option value="">All brands you can see</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      );
    }
    if (key === 'status') {
      const list = OPTIONS.status[selected] || [];
      return (
        <select className={inputCls} value={filters.status || ''} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">All</option>
          {list.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      );
    }
    if (OPTIONS[key]) {
      return (
        <select className={inputCls} value={filters[key] || ''} onChange={(e) => setFilter(key, e.target.value)}>
          <option value="">All</option>
          {OPTIONS[key].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      );
    }
    if (key === 'dateFrom' || key === 'dateTo') {
      return (
        <input type="date" className={inputCls} value={filters[key] || ''} onChange={(e) => setFilter(key, e.target.value)} />
      );
    }
    return (
      <input className={inputCls} value={filters[key] || ''} onChange={(e) => setFilter(key, e.target.value)} />
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Export Centre" />

      <Card>
        <CardContent className="p-5 flex flex-col gap-5">
          <div>
            <h3 className="text-sm font-bold text-slate-800 mb-3">What do you need?</h3>
            {types.length === 0 ? (
              <div className="flex justify-center py-8 text-slate-400"><Loader2 size={20} className="animate-spin" /></div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                {types.map((t) => (
                  <button
                    key={t.exportType}
                    type="button"
                    onClick={() => pick(t.exportType)}
                    className={`text-left p-3 rounded-lg border transition-colors ${
                      selected === t.exportType
                        ? 'border-primary-400 bg-primary-50/60'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <span className="block text-sm font-bold text-slate-800">{t.label}</span>
                    <span className="block text-[11px] text-slate-400 mt-0.5">{t.columns.length} columns</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {spec && (
            <>
              {fields.length > 0 && (
                <div>
                  <h4 className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-2">
                    <Filter size={12} />Narrow it down
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {fields.map((key) => (
                      <div key={key} className="flex flex-col gap-1.5">
                        <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">
                          {LABELS[key] ?? key}
                          {spec.requires?.includes(key) && <span className="text-error-600"> *</span>}
                        </label>
                        {renderField(key)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Format</label>
                  <div className="flex gap-2">
                    {['xlsx', 'csv'].map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFormat(f)}
                        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold transition-colors ${
                          format === f ? 'border-primary-400 bg-primary-50 text-primary-700'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {f === 'xlsx' ? <FileSpreadsheet size={14} /> : <FileText size={14} />}
                        {f.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                <Button className="ml-auto" onClick={handleDownload} disabled={downloading === selected}>
                  {downloading === selected
                    ? <Loader2 size={15} className="mr-2 animate-spin" />
                    : <Download size={15} className="mr-2" />}
                  Download
                </Button>
              </div>

              <div className="text-[11px] text-slate-400">
                <span className="font-bold uppercase tracking-wide text-slate-500">Columns: </span>
                {spec.columns.join(' · ')}
              </div>

              <p className="text-[11px] text-slate-400">
                Only brands your account can see are included, whatever the filters say.
                Large exports stream — the download may take a moment to start.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Download history ───────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <div className="p-4 flex items-center gap-3 border-b border-slate-100">
            <History size={15} className="text-slate-400" />
            <h3 className="text-sm font-bold text-slate-800">Download history</h3>
            <span className="ml-auto text-[11px] text-slate-400">
              Files are streamed, not stored — this is the record of what was taken.
            </span>
          </div>

          {historyLoading ? (
            <table className="w-full text-sm">
              <tbody><TableSkeleton rows={5} columns={6} cellClass="px-4 py-3" /></tbody>
            </table>
          ) : history.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-400">No exports yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">Export</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">Format</th>
                    <th className="text-right px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">Rows</th>
                    <th className="text-right px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">Size</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">By</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.exportId} className="border-b border-slate-50 hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <span className="font-semibold text-slate-800">{r.label}</span>
                        <span className="block font-mono text-[10px] text-slate-400">{r.exportId}</span>
                      </td>
                      <td className="px-4 py-3 uppercase text-xs text-slate-600">{r.format}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">{nf(r.rowCount)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-500 text-xs">{fmtBytes(r.byteCount)}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {r.requestedBy?.user || '—'}
                        <span className="block text-[10px] text-slate-400">{fmtDate(r.createdAt)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-1 rounded-md text-[11px] font-bold ${
                          r.status === 'Completed' ? 'bg-success-50 text-success-700' : 'bg-error-50 text-error-700'
                        }`}
                        >
                          {r.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default InventoryExport;
