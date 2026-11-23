import { useEffect, useRef, useState } from 'react';
import { Unauthorized } from '../../components/common/Unauthorized';
import { Search, X, Loader2, RotateCcw, Clock, Info, ExternalLink } from 'lucide-react';
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
import { inventoryApi } from '../../services/inventory';
import {
  directionStyle, balanceLabel, balanceNote, quantityText, fmtQty,
} from '../../utils/stockActivity';
import { Link } from 'react-router-dom';

/**
 * Stock Ledger — IMS Module M2, blueprint screen S6.
 *
 * The investigation screen: "why is this number wrong?". Every movement carries
 * its own before/after figures, so the running history is read straight off each
 * row — no balance is computed here, and none should be. That belongs to M3.
 *
 * The server refuses an unbounded ledger query, so the screen always sends at
 * least a date range.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SAYING WHAT HAPPENED, NOT WHAT THE DATABASE CALLS IT
 * ────────────────────────────────────────────────────────────────────────
 * This screen used to print the movement type verbatim and colour the quantity
 * by its sign: "RESERVE  +20", in green. Which reads as twenty units arriving.
 * They did not arrive. Twenty units already in the building stopped being
 * available — and the +20 beside it is the BOOKED count going up, not stock.
 *
 * So each row now carries `plain`, written by the server
 * (modules/inventory/activity.service.js), and rendered with the shared styling
 * in utils/stockActivity.js. The Activity Log reads the same sentences from the
 * same mapper; two renderers would be two vocabularies, which is the problem
 * this is fixing.
 *
 * `movementType` has not gone away — it is still shown, quietly, under the
 * label. An investigator needs the database's own word for the row; a client
 * needs the sentence. Both are on the row.
 */


const SORT_OPTIONS = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'posted-desc', label: 'Recently posted' },
];

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const fmtDateTime = (d) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/**
 * A quantity, coloured by DIRECTION rather than by sign — and signed only when
 * the number describes physical stock.
 *
 * Both rules exist for the same reason. A RELEASE is negative yet nothing left
 * the building, so it is not painted red; a RESERVE is positive yet nothing
 * arrived, so it carries no + at all. `balanceKind` is what decides the second,
 * and on a grouped row it is derived from the movement types the posting
 * contains. See `isSigned` in utils/stockActivity.js.
 */
const Quantity = ({ value, direction, balanceKind = 'onHand' }) => {
  const style = directionStyle(direction || (value > 0 ? 'in' : 'out'));
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 font-bold tabular-nums ${style.text}`}>
      <Icon size={13} aria-hidden="true" />
      {quantityText(value, balanceKind)}
    </span>
  );
};

/** The transaction label: Stock In, Stock Out, Booking, Adjustment… */
const TypeChip = ({ plain, movementType }) => {
  const style = directionStyle(plain?.direction);
  return (
    <>
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-bold whitespace-nowrap ${style.chip}`}
      >
        {plain?.label || movementType}
      </span>
      {/* The database's own word for the row, kept for whoever is investigating
          one. Small, grey, and underneath — present without competing. */}
      {plain?.label !== movementType && (
        <span className="block text-[10px] text-slate-400 font-semibold mt-0.5 uppercase tracking-wide">
          {movementType}
        </span>
      )}
    </>
  );
};

/**
 * Before and after, captioned by what they COUNT.
 *
 * An allocation movement's pair is the booked total, not stock on hand. Printing
 * it under a column headed "Before / After" is what let a confirmed booking read
 * as a delivery, so the caption names the balance on every row that has one.
 */
const BalancePair = ({ m }) => {
  if (m.beforeQuantity === null && m.afterQuantity === null) {
    return <span className="text-slate-400">—</span>;
  }
  const kind = balanceLabel(m.plain?.balanceKind);
  return (
    <div className="flex flex-col gap-0.5" title={balanceNote(m.plain?.balanceKind) || undefined}>
      <span className="tabular-nums text-sm whitespace-nowrap">
        <span className="text-slate-400">{fmtQty(m.beforeQuantity)}</span>
        <span className="mx-1.5 text-slate-300">→</span>
        <span className="font-bold text-slate-800">{fmtQty(m.afterQuantity)}</span>
      </span>
      {kind && (
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
          {kind}{m.plain?.balanceKind === 'booked' && ' — stock unchanged'}
        </span>
      )}
    </div>
  );
};

const Field = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">{label}</label>
    {children}
  </div>
);

/**
 * What the posting WAS, in the words someone would use for it.
 *
 * The server sends `action` from the one workflow map the whole feature shares
 * (modules/inventory/activity.service.js). This screen used to keep its own
 * copy of that list — two vocabularies, one of them always a workflow behind.
 * An unmapped workflow falls through as its own key rather than being hidden,
 * so a new one is visible rather than blank.
 */
const actionLabel = (g) => g.action ?? (g.workflowType || 'Posting');

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
          <div className="overflow-x-auto">
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
                    <td className="px-3 py-2 text-slate-600 text-xs">
                      <span className="font-semibold text-slate-700">{m.plain?.label || m.movementType}</span>
                      <span className="block text-[10px] text-slate-400">{m.plain?.description}</span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Quantity value={m.quantity} direction={m.plain?.direction} balanceKind={m.plain?.balanceKind} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </motion.aside>
);

/**
 * Opening stock, what came in, what went out, closing stock — for ONE SKU.
 *
 * Only ever shown when the SKU filter holds a single code, because the four
 * numbers are only meaningful for one item: "opening stock" across a filter
 * matching 900 SKUs is a sum of unrelated balances, and showing it would be
 * worse than showing nothing.
 *
 * PHYSICAL movements only, which is what makes it add up: a booking does not
 * change how much is in the building, so counting one as "out" would leave
 * closing ≠ opening + in − out. Units currently spoken for are reported
 * separately, named as what they are.
 */
const StockSummaryBand = ({ summary, skuCode }) => {
  if (!summary) return null;
  const tiles = [
    { label: 'Opening Stock', value: summary.openingStock, tone: 'text-slate-900' },
    { label: 'Stock In', value: summary.stockIn, tone: 'text-success-700', prefix: '+' },
    { label: 'Stock Out', value: summary.stockOut, tone: 'text-error-600', prefix: '−' },
    { label: 'Closing Stock', value: summary.closingStock, tone: 'text-slate-900' },
  ];
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-5 pt-4 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">
            Stock movement for
          </span>
          <span className="font-black text-slate-900">{skuCode}</span>
          <Link
            to={`/inventory/activity`}
            className="ml-auto inline-flex items-center gap-1 text-xs font-bold text-primary-700 hover:underline"
          >
            Open the activity log <ExternalLink size={12} />
          </Link>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-slate-100">
          {tiles.map((t) => (
            <div key={t.label} className="px-5 py-4">
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{t.label}</p>
              <p className={`text-2xl font-black tabular-nums mt-1 ${t.tone}`}>
                {t.prefix && t.value !== 0 ? t.prefix : ''}{fmtQty(t.value)}
              </p>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/60 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-600 rounded-b-xl">
          <span>
            <span className="font-bold text-slate-700">{fmtQty(summary.openingStock)}</span>
            {' + '}
            <span className="font-bold text-success-700">{fmtQty(summary.stockIn)}</span>
            {' − '}
            <span className="font-bold text-error-600">{fmtQty(summary.stockOut)}</span>
            {' = '}
            <span className="font-bold text-slate-900">{fmtQty(summary.closingStock)}</span>
          </span>
          <span>
            Currently set aside for bookings:{' '}
            <span className="font-bold text-warning-700 tabular-nums">{fmtQty(summary.reserved)}</span>
          </span>
          {summary.derivedFromBalance && (
            <span className="inline-flex items-center gap-1 text-slate-500">
              <Info size={12} aria-hidden="true" />
              No stock transactions in this period — showing the current balance.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

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

  /**
   * The opening/in/out/closing band, which only exists for a single SKU.
   *
   * Kept local to this screen rather than in the ledger store: it is not ledger
   * state, it is a second question about the same filter, and folding it into
   * the store would make every filter change wait on it.
   *
   * The request is keyed on the settled SKU and the date range, and a stale
   * response is discarded — typing a SKU fires several, and the last one typed
   * is not reliably the last one back.
   */
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    if (!filters.skuCode) { setSummary(null); return undefined; }
    let live = true;
    setSummary(null);
    inventoryApi
      .getSkuActivitySummary(filters.skuCode, { from: filters.from, to: filters.to })
      // A failed summary hides a panel; it must not disturb the rows, which are
      // the screen.
      .then((data) => { if (live) setSummary(data); })
      .catch(() => { if (live) setSummary(null); });
    return () => { live = false; };
  }, [filters.skuCode, filters.from, filters.to]);

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
    return <Unauthorized />;
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

      {filters.skuCode && <StockSummaryBand summary={summary} skuCode={filters.skuCode} />}

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
                        <span className="font-bold text-slate-800">{actionLabel(g)}</span>
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
                      <td className="px-5 py-4 text-right">
                        {/* Physical and booked nets, never added together: one
                            posting can do both (raising a PO releases the units
                            AND issues them), and their sum describes no real
                            balance. The signed figure is the stock one; the
                            booked one rides underneath, unsigned. */}
                        {g.netPhysical !== 0 || g.netAllocation === 0 ? (
                          <Quantity value={g.netPhysical ?? g.netQuantity} balanceKind="onHand" />
                        ) : (
                          <Quantity
                            value={g.netAllocation}
                            direction={g.netAllocation > 0 ? 'allocate' : 'release'}
                            balanceKind="booked"
                          />
                        )}
                        {g.netPhysical !== 0 && g.netAllocation !== 0 && (
                          <span className="block text-[11px] text-slate-400 font-semibold">
                            {Math.abs(g.netAllocation).toLocaleString('en-IN')}
                            {g.netAllocation > 0 ? ' booked' : ' released'}
                          </span>
                        )}
                      </td>
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
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Txn ID</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Date</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">SKU</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Transaction</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">What happened</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Quantity</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Balance before → after</th>
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
                      <TypeChip plain={m.plain} movementType={m.movementType} />
                    </td>
                    <td className="px-5 py-4">
                      {/* The sentence the server wrote, and underneath it the
                          action that produced the row where the batch knows it
                          — "PO raised" and "PO expired" are both ISSUE, and
                          without this a client cannot tell them apart. */}
                      <span className="text-slate-800 font-semibold">
                        {m.plain?.description || m.movementType}
                      </span>
                      {m.plain?.action && (
                        <span className="block text-[11px] text-slate-500">{m.plain.action}</span>
                      )}
                      {m.reasonCode && (
                        <span className="block text-[10px] text-slate-400 font-semibold uppercase tracking-wide">
                          {m.reasonCode.replace(/_/g, ' ')}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <Quantity value={m.quantity} direction={m.plain?.direction} balanceKind={m.plain?.balanceKind} />
                    </td>
                    <td className="px-5 py-4"><BalancePair m={m} /></td>
                    <td className="px-5 py-4">
                      {m.referenceId ? (
                        <>
                          <span className="text-[11px] font-bold text-slate-600 uppercase">
                            {m.plain?.referenceLabel || m.referenceType}
                          </span>
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
