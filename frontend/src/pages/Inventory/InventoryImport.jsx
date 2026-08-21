import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Upload, FileSpreadsheet, Download, Loader2, CheckCircle2, XCircle,
  AlertTriangle, Ban, PlayCircle, RotateCcw, ChevronRight, History,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { PageHeader } from '../../components/common/PageHeader';
import { useImportStore } from '../../store/importStore';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { hasPermission, canUseInventoryMaster, PERMISSIONS } from '../../utils/permissions';
import { NewSkuMoqModal } from '../../components/inventory/NewSkuMoqModal';

/**
 * Inventory Import — IMS Module M9.
 *
 * The wizard the blueprint defines, in order:
 *
 *   choose type → upload → preview → confirm → process → summary
 *
 * NOTHING IS WRITTEN UNTIL CONFIRM. Everything on the preview step is staged
 * server-side and can be abandoned without trace, which is the point of having
 * a preview at all.
 *
 * This screen validates nothing itself. Every error shown here was produced by
 * the server against the template registry — a second copy of the rules in the
 * browser would eventually disagree with the one that matters.
 */

const STATUS_STYLE = {
  Pending: 'bg-slate-100 text-slate-600',
  Validated: 'bg-primary-50 text-primary-700',
  Processing: 'bg-warning-50 text-warning-700',
  Completed: 'bg-success-50 text-success-700',
  Partial: 'bg-warning-50 text-warning-700',
  Failed: 'bg-error-50 text-error-700',
  Cancelled: 'bg-slate-100 text-slate-400',
};

const CATEGORY_LABEL = {
  file: 'File', template: 'Template', required: 'Missing value', format: 'Wrong format',
  enum: 'Not an allowed value', reference: 'Unknown reference', duplicate: 'Duplicate',
  range: 'Out of range', permission: 'Not permitted', processing: 'Rejected on import',
};

const STEPS = ['Choose', 'Upload', 'Preview', 'Process', 'Summary'];

const nf = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtCell = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return v instanceof Date ? new Date(v).toLocaleDateString('en-IN') : JSON.stringify(v);
  return String(v);
};

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

const Stat = ({ label, value, tone = 'text-slate-900' }) => (
  <div className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
    <span className={`block text-lg font-black tabular-nums ${tone}`}>{value}</span>
  </div>
);

const Steps = ({ current }) => (
  <div className="flex items-center gap-1 overflow-x-auto">
    {STEPS.map((label, i) => {
      const n = i + 1;
      const done = current > n;
      const active = current === n;
      return (
        <div key={label} className="flex items-center gap-1 shrink-0">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold ${
            active ? 'bg-primary-600 text-white'
              : done ? 'bg-success-50 text-success-700' : 'bg-slate-100 text-slate-400'
          }`}
          >
            {done ? <CheckCircle2 size={12} /> : <span className="w-3 text-center">{n}</span>}
            {label}
          </span>
          {i < STEPS.length - 1 && <ChevronRight size={13} className="text-slate-300" />}
        </div>
      );
    })}
  </div>
);

export const InventoryImport = () => {

  const { user } = useUserStore();
  const {
    types, fetchTypes,
    step, importType, file, uploadPercent, uploading, job,
    preview, errors, showInvalidOnly, error, duplicateWarning,
    setImportType, setFile, clearError, dismissDuplicate, reset,
    upload, loadPreview, toggleInvalidOnly, confirm, confirming, cancel, resume,
    stopPolling, downloadTemplate,
    history, historyTotal, historyPages, historyLoading, historyFilters,
    setHistoryFilters, fetchHistory,
  } = useImportStore();

  /**
   * SKUs this import CREATED that still need an MOQ.
   *
   * Seeded from the job (the server is the source of truth and survives a
   * reload) and narrowed locally as they are answered, so a partial save
   * updates the screen without refetching the whole job.
   */
  const [pendingMoq, setPendingMoq] = useState(null);
  const [moqOpen, setMoqOpen] = useState(false);

  const jobPendingMoq = job?.pendingMoqSkus ?? [];
  const outstandingMoq = pendingMoq ?? jobPendingMoq;

  // Opens itself the moment a finished import reports new SKUs. Reopened by
  // hand afterwards from the summary card — closing is never destructive.
  useEffect(() => {
    if (jobPendingMoq.length > 0) setMoqOpen(true);
  }, [jobPendingMoq.length]);

  const fileInput = useRef(null);
  const [brand, setBrand] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [errorsOpen, setErrorsOpen] = useState(false);

  useEffect(() => { fetchTypes(); fetchHistory(); }, [fetchTypes, fetchHistory]);
  useEffect(() => { if (error) { toast.error(error); clearError(); } }, [error, clearError]);
  // A poll left running after the user navigates away would keep hitting the
  // server for a job nobody is watching.
  useEffect(() => stopPolling, [stopPolling]);

  if (user && !(hasPermission(user, PERMISSIONS.VIEW_INVENTORY) && canUseInventoryMaster(user))) {
    return <Navigate to="/" replace />;
  }

  const brands = allowedBrands(user);
  const allowedTypes = types.filter((t) => t.allowed);
  const selected = types.find((t) => t.importType === importType) || null;

  const handleUpload = async (force = false) => {
    const res = await upload({ brand, force });
    if (res.ok) {
      toast.success(`${nf(res.job.validRows)} of ${nf(res.job.totalRows)} row(s) ready to import.`);
      fetchHistory();
    }
  };

  const handleConfirm = async () => {
    const res = await confirm();
    if (res.ok) toast.success('Import started.');
  };

  const handleCancel = async () => {
    const res = await cancel(cancelReason || null);
    if (res.ok) { toast.success('Import cancelled. Nothing was written.'); setCancelOpen(false); setCancelReason(''); fetchHistory(); }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory Import"
        actions={step > 1 && (
          <Button size="sm" variant="secondary" onClick={() => { reset(); fetchHistory(); }}>
            <RotateCcw size={15} className="mr-2" />Start over
          </Button>
        )}
      />

      <Card>
        <CardContent className="p-4"><Steps current={step} /></CardContent>
      </Card>

      {/* ── 1. Choose and upload ───────────────────────────────────────── */}
      {step === 1 && (
        <Card>
          <CardContent className="p-5 flex flex-col gap-5">
            {allowedTypes.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-500">
                Your account cannot import inventory data.
              </div>
            ) : (
              <>
                <div>
                  <h3 className="text-sm font-bold text-slate-800 mb-3">What are you importing?</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {allowedTypes.map((t) => (
                      <button
                        key={t.importType}
                        type="button"
                        onClick={() => setImportType(t.importType)}
                        className={`text-left p-3 rounded-lg border transition-colors ${
                          importType === t.importType
                            ? 'border-primary-400 bg-primary-50/60'
                            : 'border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <span className="block text-sm font-bold text-slate-800">{t.label}</span>
                        <span className="block text-[11px] text-slate-500 mt-0.5 leading-snug">{t.description}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {selected && (
                  <>
                    {/* The template is generated from the same definition the
                        validator uses, so its headers always match. */}
                    <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg bg-slate-50 border border-slate-100">
                      <FileSpreadsheet size={16} className="text-slate-400" />
                      <span className="text-xs text-slate-600 flex-1">
                        Start from the template — its header row is the one the importer expects.
                      </span>
                      <Button size="xs" variant="secondary" onClick={() => downloadTemplate(selected.importType)}>
                        <Download size={13} className="mr-1.5" />Template
                      </Button>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-slate-100">
                            <th className="text-left py-2 pr-3 font-bold text-slate-500 uppercase text-[10px]">Column</th>
                            <th className="text-left py-2 pr-3 font-bold text-slate-500 uppercase text-[10px]">Required</th>
                            <th className="text-left py-2 font-bold text-slate-500 uppercase text-[10px]">Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selected.columns.map((c) => (
                            <tr key={c.header} className="border-b border-slate-50">
                              <td className="py-1.5 pr-3 font-semibold text-slate-700">{c.header}</td>
                              <td className="py-1.5 pr-3">
                                {c.required
                                  ? <span className="text-error-600 font-bold">Yes</span>
                                  : <span className="text-slate-400">No</span>}
                              </td>
                              <td className="py-1.5 text-slate-500">
                                {c.note}
                                {c.allowed && <span className="block text-slate-400">One of: {c.allowed.join(', ')}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
                      {brands.length > 1 && (
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">
                            Brand {importType === 'inventory-master' ? '' : '(optional)'}
                          </label>
                          <select className={inputCls} value={brand} onChange={(e) => setBrand(e.target.value)}>
                            <option value="">From the file</option>
                            {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                          </select>
                          {/* The master sheet has no Brand column, so a SKU it
                              has to CREATE can only get its brand from here. */}
                          {importType === 'inventory-master' && (
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                              Needed only if the file contains SKUs that do not exist yet — they are
                              created under this brand. Existing SKUs take their own.
                            </p>
                          )}
                        </div>
                      )}

                      <div className="flex flex-col gap-1.5 sm:col-span-2">
                        <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">File</label>
                        <input
                          ref={fileInput}
                          type="file"
                          accept=".xlsx,.xls,.csv"
                          className={inputCls}
                          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                        />
                        <span className="text-[11px] text-slate-400">
                          .xlsx, .xls or .csv, up to 40 MB. Very large files import faster as CSV.
                        </span>
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <Button onClick={() => handleUpload(false)} disabled={!file || uploading}>
                        <Upload size={15} className="mr-2" />Upload and validate
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── 2. Uploading ───────────────────────────────────────────────── */}
      {step === 2 && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <Loader2 size={26} className="animate-spin text-primary-600" />
            <p className="text-sm font-semibold text-slate-700">
              {uploadPercent < 100 ? 'Uploading…' : 'Reading and checking every row…'}
            </p>
            <div className="w-full max-w-md h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-primary-600 transition-all" style={{ width: `${uploadPercent}%` }} />
            </div>
            <p className="text-[11px] text-slate-400">Nothing is written to inventory yet.</p>
          </CardContent>
        </Card>
      )}

      {/* ── 3. Preview ─────────────────────────────────────────────────── */}
      {step === 3 && job && (
        <>
          <Card>
            <CardContent className="p-5 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-800">{job.fileName}</h3>
                  <p className="text-[11px] text-slate-400">{job.jobId} · {selected?.label ?? job.importType}</p>
                </div>
                <span className={`px-2 py-1 rounded-md text-[11px] font-bold ${STATUS_STYLE[job.status]}`}>{job.status}</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Rows read" value={nf(job.totalRows)} />
                <Stat label="Will import" value={nf(job.validRows)} tone="text-success-700" />
                <Stat label="Rejected" value={nf(job.invalidRows)} tone={job.invalidRows ? 'text-error-600' : 'text-slate-900'} />
                <Stat label="Batches" value={nf(job.chunksTotal)} />
              </div>

              {job.fileErrors?.length > 0 && (
                <div className="p-3 rounded-lg bg-error-50 border border-error-100 flex gap-2">
                  <AlertTriangle size={15} className="text-error-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-error-700">
                    {job.fileErrors.map((e) => <p key={e}>{e}</p>)}
                  </div>
                </div>
              )}

              {job.invalidRows > 0 && (
                <div className="p-3 rounded-lg bg-warning-50 border border-warning-100 flex flex-wrap items-center gap-2">
                  <AlertTriangle size={15} className="text-warning-600 shrink-0" />
                  <span className="text-xs text-warning-800 flex-1">
                    {nf(job.invalidRows)} row(s) will be skipped. The other {nf(job.validRows)} will import.
                  </span>
                  <Button size="xs" variant="secondary" onClick={() => setErrorsOpen(true)}>
                    See why
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-primary-600"
                    checked={showInvalidOnly}
                    onChange={toggleInvalidOnly}
                  />
                  Show only rejected rows
                </label>

                <div className="ml-auto flex gap-2">
                  <Button variant="secondary" onClick={() => setCancelOpen(true)}>
                    <Ban size={15} className="mr-2" />Cancel
                  </Button>
                  <Button onClick={handleConfirm} disabled={confirming || job.validRows === 0}>
                    {confirming ? <Loader2 size={15} className="mr-2 animate-spin" /> : <PlayCircle size={15} className="mr-2" />}
                    Import {nf(job.validRows)} row(s)
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/60">
                      <th className="text-left px-3 py-2 font-bold text-slate-500 uppercase text-[10px]">Row</th>
                      <th className="text-left px-3 py-2 font-bold text-slate-500 uppercase text-[10px]">Status</th>
                      {preview.columns.map((c) => (
                        <th key={c.field} className="text-left px-3 py-2 font-bold text-slate-500 uppercase text-[10px] whitespace-nowrap">
                          {c.header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.rowNumber} className={`border-b border-slate-50 ${r.valid ? '' : 'bg-error-50/40'}`}>
                        <td className="px-3 py-2 tabular-nums text-slate-400">{r.rowNumber}</td>
                        <td className="px-3 py-2">
                          {r.valid
                            ? <CheckCircle2 size={14} className="text-success-600" />
                            : (
                              <span className="inline-flex items-center gap-1 text-error-600" title={r.validationErrors?.join(' ')}>
                                <XCircle size={14} />
                                <span className="font-semibold">{r.validationErrors?.length}</span>
                              </span>
                            )}
                        </td>
                        {preview.columns.map((c) => (
                          <td key={c.field} className="px-3 py-2 text-slate-700 whitespace-nowrap max-w-48 truncate">
                            {/* A rejected row has no normalised data, so the raw
                                cell is shown — it is what the user must fix. */}
                            {fmtCell(r.data ? r.data[c.field] : r.raw?.[preview.columns.indexOf(c)])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {preview.pagination && preview.pagination.pages > 1 && (
                <div className="flex items-center justify-center gap-3 py-3 border-t border-slate-100">
                  <Button size="xs" variant="secondary" disabled={preview.pagination.page <= 1}
                    onClick={() => loadPreview(preview.pagination.page - 1)}>Previous</Button>
                  <span className="text-[11px] font-semibold text-slate-500">
                    Page {preview.pagination.page} of {preview.pagination.pages}
                  </span>
                  <Button size="xs" variant="secondary" disabled={preview.pagination.page >= preview.pagination.pages}
                    onClick={() => loadPreview(preview.pagination.page + 1)}>Next</Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ── 4. Processing ──────────────────────────────────────────────── */}
      {step === 4 && job && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <Loader2 size={26} className="animate-spin text-primary-600" />
            <p className="text-sm font-semibold text-slate-700">
              Importing {nf(job.processedRows)} of {nf(job.validRows)} row(s)…
            </p>
            <div className="w-full max-w-md h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary-600 transition-all"
                style={{ width: `${job.validRows ? Math.round((job.processedRows / job.validRows) * 100) : 0}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-400">
              Batch {nf(job.chunksDone)} of {nf(job.chunksTotal)}. You can leave this page — the import keeps running.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 5. Summary ─────────────────────────────────────────────────── */}
      {step === 5 && job && (
        <Card>
          <CardContent className="p-5 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {job.status === 'Completed'
                  ? <CheckCircle2 size={20} className="text-success-600" />
                  : job.status === 'Failed' ? <XCircle size={20} className="text-error-600" />
                    : <AlertTriangle size={20} className="text-warning-600" />}
                <div>
                  <h3 className="text-sm font-bold text-slate-800">
                    {job.status === 'Completed' ? 'Import complete'
                      : job.status === 'Failed' ? 'Import failed'
                        : job.status === 'Cancelled' ? 'Import cancelled' : 'Imported with rejections'}
                  </h3>
                  <p className="text-[11px] text-slate-400">{job.jobId} · {job.fileName}</p>
                </div>
              </div>
              <span className={`px-2 py-1 rounded-md text-[11px] font-bold ${STATUS_STYLE[job.status]}`}>{job.status}</span>
            </div>

            {/* New SKUs still without an MOQ. Shown on the card as well as in
                the modal, so closing the prompt does not hide the fact that
                the catalogue has SKUs nobody has configured yet. */}
            {outstandingMoq.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg bg-warning-50 border border-warning-200">
                <AlertTriangle size={16} className="text-warning-600 shrink-0" />
                <p className="text-xs text-warning-900 flex-1 min-w-48 leading-relaxed">
                  <strong>{nf(outstandingMoq.length)} new SKU(s)</strong> were created by this
                  import and still have no minimum order quantity. The stock is imported — only
                  the MOQ is outstanding.
                </p>
                <Button size="sm" onClick={() => setMoqOpen(true)}>Set MOQ</Button>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Rows read" value={nf(job.totalRows)} />
              <Stat label="Imported" value={nf(job.successfulRows)} tone="text-success-700" />
              <Stat label="Rejected at check" value={nf(job.invalidRows)} tone={job.invalidRows ? 'text-error-600' : 'text-slate-900'} />
              <Stat label="Failed on import" value={nf(job.failedRows)} tone={job.failedRows ? 'text-error-600' : 'text-slate-900'} />
            </div>

            {job.fileErrors?.length > 0 && (
              <div className="p-3 rounded-lg bg-error-50 border border-error-100 text-xs text-error-700">
                {job.fileErrors.map((e) => <p key={e}>{e}</p>)}
              </div>
            )}

            {/* What the import produced downstream, so the trail from a
                spreadsheet to its movements is one click long. */}
            {job.producedRefs?.length > 0 && (
              <div className="text-xs text-slate-600">
                <span className="font-bold text-slate-500 uppercase text-[10px] tracking-wide">Produced</span>
                <ul className="mt-1 space-y-0.5">
                  {job.producedRefs.map((r) => (
                    <li key={`${r.kind}-${r.id}`} className="font-mono">
                      {r.kind === 'ledgerBatch' ? 'Ledger batch' : r.kind === 'count' ? 'Count session' : r.kind}: {r.id}
                    </li>
                  ))}
                </ul>
                {job.importType === 'physical-count' && (
                  <p className="mt-2 text-[11px] text-warning-700 font-semibold">
                    The count is submitted and waiting for approval. Nothing has been posted to the ledger.
                  </p>
                )}
              </div>
            )}

            <p className="text-[11px] text-slate-400">
              Took {job.processingMs ? `${(job.processingMs / 1000).toFixed(1)}s` : '—'}.
            </p>

            <div className="flex flex-wrap gap-2">
              {(job.invalidRows > 0 || job.failedRows > 0) && (
                <Button variant="secondary" onClick={() => setErrorsOpen(true)}>
                  <AlertTriangle size={15} className="mr-2" />Error report
                </Button>
              )}
              <Button className="ml-auto" onClick={() => { reset(); fetchHistory(); }}>
                <Upload size={15} className="mr-2" />Import another file
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── History ────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <div className="p-4 flex flex-wrap items-center gap-3 border-b border-slate-100">
            <History size={15} className="text-slate-400" />
            <h3 className="text-sm font-bold text-slate-800">Import history</h3>
            <select
              className={`${inputCls} w-auto ml-auto`}
              value={historyFilters.importType}
              onChange={(e) => setHistoryFilters({ importType: e.target.value })}
            >
              <option value="">All types</option>
              {types.map((t) => <option key={t.importType} value={t.importType}>{t.label}</option>)}
            </select>
            <select
              className={`${inputCls} w-auto`}
              value={historyFilters.status}
              onChange={(e) => setHistoryFilters({ status: e.target.value })}
            >
              <option value="">All statuses</option>
              {Object.keys(STATUS_STYLE).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {historyLoading ? (
            // TableSkeleton renders <tr>, so it needs a table around it — loose
            // in a <div> the browser hoists the rows out and React reports an
            // invalid-nesting error.
            <table className="w-full text-sm">
              <tbody><TableSkeleton rows={5} columns={7} cellClass="px-4 py-3" /></tbody>
            </table>
          ) : history.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-400">No imports yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">Job</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">Type</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">File</th>
                    <th className="text-right px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">Rows</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">By</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {history.map((j) => (
                    <tr key={j.jobId} className="border-b border-slate-50 hover:bg-slate-50/60">
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{j.jobId}</td>
                      <td className="px-4 py-3 text-slate-700">{j.label}</td>
                      <td className="px-4 py-3 text-slate-600 max-w-48 truncate" title={j.fileName}>{j.fileName}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className="text-success-700 font-bold">{nf(j.successfulRows)}</span>
                        <span className="text-slate-400"> / {nf(j.totalRows)}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {j.startedBy?.user || '—'}
                        <span className="block text-[10px] text-slate-400">{fmtDate(j.createdAt)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-1 rounded-md text-[11px] font-bold ${STATUS_STYLE[j.status]}`}>
                          {j.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {j.status === 'Processing' && (
                          <Button size="xs" variant="ghost" onClick={() => resume(j.jobId)}>Resume</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {historyPages > 1 && (
            <div className="flex items-center justify-center gap-3 py-3 border-t border-slate-100">
              <Button size="xs" variant="secondary" disabled={historyFilters.page <= 1}
                onClick={() => setHistoryFilters({ page: historyFilters.page - 1 })}>Previous</Button>
              <span className="text-[11px] font-semibold text-slate-500">
                Page {historyFilters.page} of {historyPages} · {nf(historyTotal)} import(s)
              </span>
              <Button size="xs" variant="secondary" disabled={historyFilters.page >= historyPages}
                onClick={() => setHistoryFilters({ page: historyFilters.page + 1 })}>Next</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Duplicate file ─────────────────────────────────────────────── */}
      <Modal isOpen={Boolean(duplicateWarning)} onClose={dismissDuplicate} title="This file was already imported" size="sm">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-600">{duplicateWarning}</p>
          <p className="text-xs text-slate-500">
            Importing it again applies its rows a second time — a stock movement file would post
            every movement twice. Only continue if that is what you intend.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={dismissDuplicate}>Cancel</Button>
            <Button onClick={() => { dismissDuplicate(); handleUpload(true); }}>Import it again</Button>
          </div>
        </div>
      </Modal>

      {/* ── Cancel ─────────────────────────────────────────────────────── */}
      <Modal isOpen={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this import" size="sm">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-600">
            Nothing has been written yet, so cancelling discards the staged rows and leaves inventory untouched.
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Reason (optional)</label>
            <input className={inputCls} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>Keep it</Button>
            <Button onClick={handleCancel}>Cancel import</Button>
          </div>
        </div>
      </Modal>

      {/* ── Error report ───────────────────────────────────────────────── */}
      <Modal isOpen={errorsOpen} onClose={() => setErrorsOpen(false)} title="Error report" size="xl">
        <div className="flex flex-col gap-4">
          {Object.keys(errors.byCategory || {}).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {Object.entries(errors.byCategory).map(([cat, n]) => (
                <span key={cat} className="px-2 py-1 rounded-md bg-slate-100 text-[11px] font-bold text-slate-600">
                  {CATEGORY_LABEL[cat] ?? cat}: {n}
                </span>
              ))}
            </div>
          )}

          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-100">
                  <th className="text-left px-2 py-2 font-bold text-slate-500 uppercase text-[10px]">Row</th>
                  <th className="text-left px-2 py-2 font-bold text-slate-500 uppercase text-[10px]">Column</th>
                  <th className="text-left px-2 py-2 font-bold text-slate-500 uppercase text-[10px]">Problem</th>
                </tr>
              </thead>
              <tbody>
                {(errors.errors || []).map((e) => (
                  <tr key={e._id} className="border-b border-slate-50">
                    <td className="px-2 py-1.5 tabular-nums text-slate-400">{e.rowNumber ?? '—'}</td>
                    <td className="px-2 py-1.5 text-slate-600">{e.column ?? '—'}</td>
                    <td className="px-2 py-1.5 text-slate-700">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-slate-400">
            Row numbers match the data rows in your file, counting from the first row below the header.
          </p>
        </div>
      </Modal>

      {moqOpen && outstandingMoq.length > 0 && (
        <NewSkuMoqModal
          jobId={job?.jobId}
          skus={outstandingMoq}
          onClose={() => setMoqOpen(false)}
          onSaved={(remaining) => {
            setPendingMoq(remaining);
            if (remaining.length === 0) setMoqOpen(false);
          }}
        />
      )}
    </div>
  );
};

export default InventoryImport;
