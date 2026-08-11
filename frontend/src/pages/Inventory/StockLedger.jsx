import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Search, X, Loader2, RotateCcw, ArrowDownRight, ArrowUpRight, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Pagination } from '../../components/ui/Pagination';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { PageHeader } from '../../components/common/PageHeader';
import { ExportButton } from '../../components/inventory/ExportButton';
import { useLedgerStore } from '../../store/ledgerStore';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { hasPermission, PERMISSIONS } from '../../utils/permissions';
import { DateField } from "../../components/ui/DateField";

/**
 * Stock Ledger — IMS Module M2, blueprint screen S6.
 *
 * The investigation screen: "why is this number wrong?". Every movement carries
 * its own before/after figures, so the running history is read straight off each
 * row — no balance is computed here, and none should be. That belongs to M3.
 *
 * The server refuses an unbounded ledger query, so the screen always sends at
 * least a date range.
 */

const CLASS_STYLES = {
  PHYSICAL: 'bg-primary-50 text-primary-700',
  ALLOCATION: 'bg-indigo-50 text-indigo-700',
};

const SORT_OPTIONS = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'posted-desc', label: 'Recently posted' },
];

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const fmtDateTime = (d) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/** Signed quantity, coloured by direction and always showing its sign. */
const Quantity = ({ value }) => (
  <span
    className={`inline-flex items-center gap-1 font-bold tabular-nums ${
      value > 0 ? 'text-success-700' : 'text-error-600'
    }`}
  >
    {value > 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
    {value > 0 ? `+${value}` : value}
  </span>
);

const Field = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">{label}</label>
    {children}
  </div>
);

/**
 * Workflow keys are internal; these are what the action was, in the words
 * someone would use for it. An unmapped key falls through unchanged rather
 * than being hidden, so a new workflow is visible rather than blank.
 */
const ACTION_LABEL = {
  import: 'Import',
  'stock-update': 'Stock update',
  'stock-adjustment': 'Stock adjustment',
  'stock-count': 'Stock count',
  'booking-confirm': 'Booking confirmed',
  'po-settlement-release': 'PO expired — stock released',
  'po-settlement-consume': 'PO raised — stock issued',
  'po-expiry': 'PO expired',
  reversal: 'Reversal',
  reserve: 'Reservation',
  'sales-desk-edit': 'Sales desk edit',
};
const actionLabel = (w) => ACTION_LABEL[w] ?? (w || 'Posting');

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

/** Batch drill-through: every movement written by one posting request. */
const BatchPanel = ({ batch, onClose }) => (
  <motion.aside
    initial={{ x: '100%' }}
    animate={{ x: 0 }}
    exit={{ x: '100%' }}
    transition={{ type: 'spring', stiffness: 320, damping: 34 }}
    className="fixed right-0 top-0 h-full w-full max-w-2xl bg-white border-l border-slate-200 shadow-enterprise-lg z-50 flex flex-col"
  >
    <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Posting Batch</p>
        <h3 className="text-lg font-black text-slate-900 font-mono truncate">{batch.batchId}</h3>
        <p className="text-xs font-semibold text-slate-500 mt-0.5">
          {batch.workflowType} · {batch.lineCount} movement{batch.lineCount === 1 ? '' : 's'} · {batch.status}
        </p>
      </div>
      <button
        onClick={onClose}
        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0"
      >
        <X size={18} />
      </button>
    </div>

    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase">Posted</p>
          <p className="font-semibold text-slate-800">{fmtDateTime(batch.postedAt)}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase">Net Quantity</p>
          <p className="font-semibold text-slate-800 tabular-nums">{batch.totalQuantity}</p>
        </div>
        <div className="col-span-2">
          <p className="text-[10px] font-bold text-slate-400 uppercase">Idempotency Key</p>
          <p className="font-mono text-xs text-slate-600 break-all">{batch.idempotencyKey}</p>
        </div>
        {batch.referenceId && (
          <div className="col-span-2">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Source Document</p>
            <p className="font-semibold text-slate-800">
              {batch.referenceType} · {batch.referenceId}
            </p>
          </div>
        )}
      </div>

      <div>
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Movements</h4>
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 font-bold text-slate-600 uppercase text-[10px]">Txn</th>
                <th className="px-3 py-2 font-bold text-slate-600 uppercase text-[10px]">SKU</th>
                <th className="px-3 py-2 font-bold text-slate-600 uppercase text-[10px]">Type</th>
                <th className="px-3 py-2 font-bold text-slate-600 uppercase text-[10px] text-right">Qty</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batch.movements.map((m) => (
                <tr key={m.transactionId}>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{m.transactionId}</td>
                  <td className="px-3 py-2 font-bold text-slate-800">{m.skuCode}</td>
                  <td className="px-3 py-2 text-slate-600 text-xs">{m.movementType}</td>
                  <td className="px-3 py-2 text-right"><Quantity value={m.quantity} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </motion.aside>
);

export const StockLedger = () => {
  const { user } = useUserStore();
  const {
    movements, groups, grouped, setGrouped, total, loading, error, movementTypes, filters,
    setFilters, resetFilters, fetchMovements, fetchMovementTypes,
    selectedBatch, batchLoading, openBatch, closeBatch,
  } = useLedgerStore();

  const [skuTerm, setSkuTerm] = useState('');

  // True from the first keystroke, not only once the request is in flight.
  // The search box waits 300ms before firing, and during that pause the old
  // rows sat there looking like the filter had been ignored. This spans the
  // debounce window and the request as one continuous "working" state.
  const filtering = loading || skuTerm !== filters.skuCode;

  // One fetch on mount, then one per settled SKU term. The debounce skips its
  // first run so mounting costs a single request.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const timer = setTimeout(() => setFilters({ skuCode: skuTerm }), 300);
    return () => clearTimeout(timer);
    // setFilters is a stable store action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuTerm]);

  useEffect(() => {
    fetchMovements();
    fetchMovementTypes();
  }, [fetchMovements, fetchMovementTypes]);

  // A ledger row IS a transaction, so the selection is transaction ids — not
  // SKUs. Selecting two movements of one SKU and exporting by SKU would pull in
  // every other movement that SKU ever had.
  //
  // Declared above the permission guard, not below it: `user` is null on the
  // first render, so the guard does not fire and this hook runs. Once the user
  // loads without the permission the guard returns early, and React sees fewer
  // hooks than last render — which throws instead of redirecting.
  const [picked, setPicked] = useState(() => new Set());

  // The route is guarded server-side on every request; this only avoids
  // rendering a screen the user could not populate.
  if (user && !hasPermission(user, PERMISSIONS.VIEW_STOCK_LEDGER)) {
    return <Navigate to="/" replace />;
  }

  const togglePick = (txn) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(txn)) next.delete(txn); else next.add(txn);
    return next;
  });

  const pageTxns = movements.map((m) => m.transactionId);
  const allOnPagePicked = pageTxns.length > 0 && pageTxns.every((t) => picked.has(t));

  // The ledger has no "every matching row" endpoint and does not need one —
  // exporting without a selection already covers the whole filter. So this
  // checkbox takes the page, and says so.
  const togglePage = () => setPicked((prev) => {
    const next = new Set(prev);
    if (allOnPagePicked) pageTxns.forEach((t) => next.delete(t));
    else pageTxns.forEach((t) => next.add(t));
    return next;
  });

  const brands = allowedBrands(user);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Stock Ledger"
        actions={(
          <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-slate-200 overflow-hidden">
            {[[true, 'Grouped'], [false, 'All movements']].map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => setGrouped(value)}
                className={`px-3 py-1.5 text-xs font-bold transition-colors ${
                  grouped === value ? 'bg-primary-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <ExportButton
            exportType="stock-movements"
            selectionKey="transactionIds"
            filters={{
              brand: filters.brand, skuCode: filters.skuCode,
              movementType: filters.movementType,
              dateFrom: filters.from, dateTo: filters.to,
            }}
            selected={[...picked]}
          />
          <Button variant="outline" size="sm" onClick={() => { setSkuTerm(''); resetFilters(); }}>
            <RotateCcw size={15} className="mr-2" />
            Reset Filters
          </Button>
          </div>
        )}
      />

      <Card>
        <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="SKU">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                type="text"
                value={skuTerm}
                onChange={(e) => setSkuTerm(e.target.value)}
                placeholder="Exact SKU code"
                className={`${inputCls} pl-9`}
              />
            </div>
          </Field>

          <Field label="From">
            <DateField
              value={filters.from}
              onChange={(v) => setFilters({ from: v })}
              max={filters.to || undefined}
              placeholder="Start date"
            />
          </Field>

          <Field label="To">
            <DateField
              value={filters.to}
              onChange={(v) => setFilters({ to: v })}
              min={filters.from || undefined}
              placeholder="End date"
            />
          </Field>

          <Field label="Movement Type">
            <select
              value={filters.movementType}
              onChange={(e) => setFilters({ movementType: e.target.value })}
              className={inputCls}
            >
              <option value="">All types</option>
              {movementTypes.map((t) => (
                <option key={t.type} value={t.type}>{t.label}</option>
              ))}
            </select>
          </Field>

          {brands.length > 1 && (
            <Field label="Brand">
              <select
                value={filters.brand}
                onChange={(e) => setFilters({ brand: e.target.value })}
                className={inputCls}
              >
                <option value="">All brands</option>
                {brands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
          )}

          <Field label="Reference">
            <input
              type="text" value={filters.referenceId}
              onChange={(e) => setFilters({ referenceId: e.target.value })}
              placeholder="Booking or document id"
              className={inputCls}
            />
          </Field>

          <Field label="Batch">
            <input
              type="text" value={filters.batchId}
              onChange={(e) => setFilters({ batchId: e.target.value })}
              placeholder="BAT-2026-000001"
              className={inputCls}
            />
          </Field>

          <Field label="Sort">
            <select
              value={filters.sort}
              onChange={(e) => setFilters({ sort: e.target.value })}
              className={inputCls}
            >
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        </CardContent>
      </Card>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-error-50 border border-error-200 text-sm text-error-700 font-medium">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {picked.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 px-5 py-3 bg-primary-50 border-b border-primary-100">
              <span className="text-sm font-bold text-primary-900">
                {picked.size.toLocaleString()} movement{picked.size === 1 ? '' : 's'} selected
              </span>
              <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setPicked(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {grouped ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Action</th>
                    <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">When</th>
                    <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Items</th>
                    <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Lines</th>
                    <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Net Qty</th>
                    <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtering && <TableSkeleton rows={groups.length || 8} columns={6} cellClass="px-5 py-4" />}

                  {!filtering && groups.map((g) => (
                    <tr
                      key={g.batchId}
                      onClick={() => openBatch(g.batchId)}
                      className="hover:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <td className="px-5 py-4">
                        <span className="font-bold text-slate-800">{actionLabel(g.workflowType)}</span>
                        <span className="block font-mono text-[11px] text-slate-400">{g.batchId}</span>
                      </td>
                      <td className="px-5 py-4 text-slate-600 text-xs whitespace-nowrap">{fmtDate(g.postedAt)}</td>
                      <td className="px-5 py-4">
                        <span className="text-slate-700">
                          {g.skuCount === 1 ? g.sampleSkus[0] : `${g.skuCount.toLocaleString()} SKUs`}
                        </span>
                        {g.skuCount > 1 && (
                          <span className="block text-[11px] text-slate-400 truncate max-w-56">
                            {g.sampleSkus.join(', ')}{g.skuCount > g.sampleSkus.length ? '…' : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-right tabular-nums text-slate-700">
                        {g.movementCount.toLocaleString()}
                        {/* A filtered view shows how much of the posting matched,
                            so a big posting never looks small. */}
                        {g.batchLineCount > g.movementCount && (
                          <span className="block text-[11px] text-slate-400">of {g.batchLineCount.toLocaleString()}</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-right"><Quantity value={g.netQuantity} /></td>
                      <td className="px-5 py-4 text-xs text-slate-500">
                        {g.user?.name || (g.actorType === 'system' ? 'System' : '—')}
                      </td>
                    </tr>
                  ))}

                  {!filtering && groups.length === 0 && !error && (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500 font-medium">
                        No postings match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="pl-5 pr-2 py-4 w-10">
                    <input
                      type="checkbox"
                      aria-label="Select every movement on this page"
                      className="w-4 h-4 accent-primary-600 cursor-pointer"
                      checked={allOnPagePicked}
                      onChange={togglePage}
                    />
                  </th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Transaction</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Date</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">SKU</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Type</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Qty</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Before</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">After</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Reference</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Actor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtering && <TableSkeleton rows={movements.length || 10} columns={10} cellClass="px-5 py-4" />}

                {!filtering && movements.map((m) => (
                  <tr
                    key={m.transactionId}
                    className={`transition-colors ${picked.has(m.transactionId) ? 'bg-primary-50/60' : 'hover:bg-slate-50'}`}
                  >
                    <td className="pl-5 pr-2 py-4">
                      <input
                        type="checkbox"
                        aria-label={`Select ${m.transactionId}`}
                        className="w-4 h-4 accent-primary-600 cursor-pointer"
                        checked={picked.has(m.transactionId)}
                        onChange={() => togglePick(m.transactionId)}
                      />
                    </td>
                    <td className="px-5 py-4">
                      <button
                        onClick={() => openBatch(m.batchId)}
                        className="font-mono text-[11px] font-bold text-primary-700 hover:underline"
                        title="Open the posting batch"
                      >
                        {m.transactionId}
                      </button>
                      <span className="block font-mono text-[10px] text-slate-400">{m.batchId}</span>
                    </td>
                    <td className="px-5 py-4">
                      <span className="font-semibold text-slate-700">{fmtDate(m.effectiveDate)}</span>
                      {m.backdated && (
                        <span
                          className="ml-1.5 inline-flex items-center gap-1 text-[10px] font-bold text-warning-700"
                          title={`Posted ${fmtDateTime(m.postedAt)}`}
                        >
                          <Clock size={10} /> backdated
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <span className="font-bold text-slate-900">{m.skuCode}</span>
                      <span className="block text-[11px] text-slate-400 font-medium">
                        {m.brand}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <span className={`inline-flex px-2 py-1 rounded-md text-[11px] font-bold ${CLASS_STYLES[m.movementClass] || 'bg-slate-100 text-slate-600'}`}>
                        {m.movementType}
                      </span>
                      {m.reasonCode && (
                        <span className="block text-[10px] text-slate-400 font-semibold mt-0.5">
                          {m.reasonCode}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right"><Quantity value={m.quantity} /></td>
                    <td className="px-5 py-4 text-right text-slate-500 tabular-nums">
                      {m.beforeQuantity ?? '—'}
                    </td>
                    <td className="px-5 py-4 text-right font-semibold text-slate-800 tabular-nums">
                      {m.afterQuantity ?? '—'}
                    </td>
                    <td className="px-5 py-4">
                      {m.referenceId ? (
                        <>
                          <span className="text-[11px] font-bold text-slate-600 uppercase">{m.referenceType}</span>
                          <span className="block font-mono text-[11px] text-slate-500">{m.referenceId}</span>
                        </>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-4">
                      {m.actorType === 'system' ? (
                        <span className="text-[11px] font-bold text-slate-500 uppercase">System</span>
                      ) : (
                        <span className="text-slate-700 font-medium">{m.user?.name || '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}

                {!filtering && movements.length === 0 && !error && (
                  <tr>
                    <td colSpan={10} className="px-6 py-12 text-center">
                      <p className="text-slate-600 font-semibold">No movements in this range</p>
                      <p className="text-slate-500 text-xs mt-1 max-w-md mx-auto">
                        The ledger records stock movements as they are posted. It stays empty
                        until the stock workflows begin writing to it.
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          )}

          {total > 0 && (
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/60 rounded-b-xl">
              <Pagination
                page={filters.page}
                pageSize={filters.limit}
                totalItems={total}
                onPageChange={(page) => setFilters({ page })}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <AnimatePresence>
        {(selectedBatch || batchLoading) && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closeBatch}
              className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40"
            />
            {selectedBatch ? (
              <BatchPanel batch={selectedBatch} onClose={closeBatch} />
            ) : (
              <motion.aside
                initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
                transition={{ type: 'spring', stiffness: 320, damping: 34 }}
                className="fixed right-0 top-0 h-full w-full max-w-2xl bg-white border-l border-slate-200 shadow-enterprise-lg z-50 flex items-center justify-center"
              >
                <div className="flex flex-col items-center gap-3 text-slate-400">
                  <Loader2 className="animate-spin" size={28} />
                  <p className="text-sm font-semibold">Loading batch…</p>
                </div>
              </motion.aside>
            )}
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

export default StockLedger;
