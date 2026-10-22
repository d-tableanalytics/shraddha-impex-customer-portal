import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Search, X, RotateCcw, Upload, Download, Warehouse, Ship, Lock, PackageCheck,
  CalendarClock, Info, ClipboardList, BarChart3, AlertTriangle, RefreshCw, Trash2, Pencil,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Pagination } from '../../components/ui/Pagination';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { PageHeader } from '../../components/common/PageHeader';
import { ImportUpcomingModal } from '../../components/inventory/ImportUpcomingModal';
import { IndentReservationSection } from '../../components/inventory/IndentReservationSection';
import { inventoryApi } from '../../services/inventory';
import { onStockUpdated, onUpcomingUpdated } from '../../services/socketService';
import { queryKeys, STALE } from '../../lib/queryKeys';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { hasPermission, PERMISSIONS } from '../../utils/permissions';
import { exportToExcel } from '../../utils/exportUtils';
import {
  STATUS, STATUS_ORDER, STATUS_HELP, formatDate, formatDateTime, relativeArrival, daysUntil,
  indentLinesFor, indentSummary, toYmd,
} from '../../utils/upcomingStock';

const errorOf = (err, fallback) => err?.response?.data?.message || err?.message || fallback;

/**
 * Upcoming Stock — stock that has been ordered but not received, and how much
 * of it has already been promised.
 *
 *   Remaining Upcoming = Upcoming Stock − Reserved Stock
 *
 * Served by GET /inventory/upcoming (backend upcomingStock.service.js), which
 * links it to the live inventory: Actual Stock is the on-hand balance, and stock
 * received into the inventory takes quantity off the upcoming shipments by
 * itself. Follows the Inventory Master / Health layout so it reads as part of
 * the same module.
 *
 * Who can do what: anyone with view_inventory reads; import / correct shipment
 * lines needs manage_inventory_master; reserving (for an indent or directly)
 * needs assign_indent_stock. The server enforces all of it.
 */

const PAGE_SIZE = 10;

const SORT_OPTIONS = [
  { value: 'eta-asc', label: 'Arriving soonest' },
  { value: 'remaining-asc', label: 'Least remaining' },
  { value: 'remaining-desc', label: 'Most remaining' },
  { value: 'reserved-desc', label: 'Most reserved' },
  { value: 'actual-asc', label: 'Least actual stock' },
  { value: 'sku-asc', label: 'SKU (A–Z)' },
];

const ARRIVAL_OPTIONS = [
  { value: '', label: 'Any arrival date' },
  { value: 'overdue', label: 'Overdue' },
  { value: '7', label: 'Next 7 days' },
  { value: '30', label: 'Next 30 days' },
  { value: 'later', label: 'Later than 30 days' },
];

const SORTERS = {
  'eta-asc': (a, b) => (a.nextEta || '9').localeCompare(b.nextEta || '9'),
  'remaining-asc': (a, b) => a.remaining - b.remaining,
  'remaining-desc': (a, b) => b.remaining - a.remaining,
  'reserved-desc': (a, b) => b.reserved - a.reserved,
  'actual-asc': (a, b) => a.actual - b.actual,
  'sku-asc': (a, b) => a.skuCode.localeCompare(b.skuCode),
};

const inArrivalWindow = (item, windowKey) => {
  if (!windowKey) return true;
  if (!item.nextEta) return false;
  const d = daysUntil(item.nextEta);
  if (windowKey === 'overdue') return d < 0;
  if (windowKey === 'later') return d > 30;
  return d >= 0 && d <= Number(windowKey);
};

/* Segment colours for the position bar — one meaning each, used everywhere. */
const SEGMENTS = {
  actual: { dot: 'bg-success-500', label: 'Actual stock' },
  reserved: { dot: 'bg-warning-500', label: 'Reserved upcoming' },
  remaining: { dot: 'bg-primary-500', label: 'Remaining upcoming' },
};

const StatusChip = ({ status }) => {
  const s = STATUS[status] || STATUS['No Inbound'];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-bold whitespace-nowrap ${s.chip}`}
      title={STATUS_HELP[status]}
    >
      <span aria-hidden="true">{s.mark}</span>
      {status}
    </span>
  );
};

/** Reserved vs remaining share of the upcoming quantity. */
const ReserveBar = ({ item, className = 'w-20' }) => (
  <div className={`flex h-1.5 rounded-full overflow-hidden bg-slate-100 ${className}`}>
    {item.upcoming > 0 && (
      <>
        <div className={SEGMENTS.reserved.dot} style={{ width: `${(item.reserved / item.upcoming) * 100}%` }} />
        <div className={SEGMENTS.remaining.dot} style={{ width: `${(item.remaining / item.upcoming) * 100}%` }} />
      </>
    )}
  </div>
);

/**
 * Summary tile, the Inventory Master pattern. `meter` (0–1) adds a thin bar for
 * the two figures that are a SHARE of upcoming stock, so reserved vs remaining
 * reads at a glance rather than by dividing two numbers.
 */
const SummaryCard = ({ icon: Icon, tone, label, value, hint, meter, meterTone }) => (
  <Card>
    <CardContent className="p-5 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${tone}`}>
        <Icon size={22} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">{label}</p>
        <h3 className="text-2xl font-bold text-slate-900 tabular-nums">{value.toLocaleString()}</h3>
        {hint && <p className="text-[11px] text-slate-400 font-medium truncate">{hint}</p>}
        {meter !== undefined && (
          <div className="h-1 mt-2 rounded-full bg-slate-100 overflow-hidden" aria-hidden="true">
            <div className={`h-full rounded-full ${meterTone}`} style={{ width: `${Math.min(100, Math.max(0, meter * 100))}%` }} />
          </div>
        )}
      </div>
    </CardContent>
  </Card>
);

/** Indent coverage filter options for the table. */
const INDENT_FILTERS = [
  { value: '', label: 'Any indent status' },
  { value: 'open', label: 'Indents left short' },
  { value: 'covered', label: 'All indents covered' },
  { value: 'none', label: 'No open indents' },
];

const matchesIndentFilter = (stats, key) => {
  if (!key) return true;
  const s = stats || { count: 0, covered: 0 };
  if (key === 'none') return s.count === 0;
  if (key === 'covered') return s.count > 0 && s.covered === s.count;
  return s.count > s.covered; // 'open': some indent the upcoming stock does not fully cover
};

/** Arrival windows the shipments card groups by. `d` is null for "no date set". */
const ARRIVAL_BUCKETS = [
  { key: 'overdue', label: 'Overdue', test: (d) => d !== null && d < 0, tone: 'text-error-600' },
  { key: 'week', label: 'Next 7 days', test: (d) => d !== null && d >= 0 && d <= 7, tone: 'text-primary-600' },
  { key: 'month', label: 'Next 30 days', test: (d) => d !== null && d > 7 && d <= 30, tone: 'text-slate-500' },
  { key: 'later', label: 'Later', test: (d) => d !== null && d > 30, tone: 'text-slate-400' },
  { key: 'nodate', label: 'Date not set', test: (d) => d === null, tone: 'text-slate-400' },
];

/** Only SKU and quantity are required on import, so a reference may be blank. */
const refLabel = (ref) => ref || 'No reference';

/** The Edit form's starting values for one entry — what it compares against on save. */
const editableOf = (s, item) => ({
  orderedQty: String(s.orderedQty),
  eta: s.eta ? toYmd(s.eta) : '',
  ref: s.ref || '',
  supplier: s.supplier && s.supplier !== '—' ? s.supplier : '',
  // The server sends the SKU code as the product when it has no description.
  product: item.product && item.product !== item.skuCode ? item.product : '',
});

/** The Indents cell: how many of this SKU's indents the FIFO allocation fully covers. */
const IndentCoverage = ({ stats }) => {
  if (!stats || stats.count === 0) return <span className="text-[11px] font-medium text-slate-300">No indents</span>;
  const short = stats.count - stats.covered;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      {short === 0 ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-success-50 text-success-700 whitespace-nowrap">
          <span aria-hidden="true">●</span>All covered
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-primary-50 text-primary-700 whitespace-nowrap">
          <ClipboardList size={11} />{short} left short
        </span>
      )}
      <span className="text-[11px] text-slate-400 font-medium whitespace-nowrap">
        {stats.covered}/{stats.count} covered (FIFO)
      </span>
    </span>
  );
};

const PANEL_TABS = [
  { key: 'indents', label: 'Indents', icon: ClipboardList },
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'shipments', label: 'Shipments', icon: Ship },
];

/** Section heading used inside the panel's tabs. */
const PanelHeading = ({ children }) => (
  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">{children}</h4>
);

/**
 * SKU detail drawer — the full breakdown, in tabs so the one thing the desk is
 * doing (usually reserving against an indent) is not buried under a scroll of
 * everything else. The four position figures stay pinned above the tabs, so
 * every tab is read against the same numbers.
 */
const UpcomingPanel = ({
  item, indentLines, refreshing, canManage, initialTab, onClose, onChanged,
}) => {
  const [tab, setTab] = useState(initialTab || 'indents');
  // An open shipment-line action: { id, mode: 'edit', form, original } or
  // { id, mode: 'cancel' | 'delete', value }.
  const [editing, setEditing] = useState(null);
  const [savingLine, setSavingLine] = useState(false);

  const saveLine = async () => {
    if (!editing || savingLine) return;
    setSavingLine(true);
    try {
      if (editing.mode === 'edit') {
        // Send only what was changed; a blank optional field clears it.
        const changes = Object.fromEntries(
          Object.entries(editing.form).filter(([k, v]) => String(v).trim() !== String(editing.original[k]).trim()),
        );
        if (Object.keys(changes).length === 0) { setEditing(null); return; }
        if ('orderedQty' in changes && String(changes.orderedQty).trim() === '') {
          toast.error('Quantity is required.');
          return;
        }
        await inventoryApi.updateUpcomingShipment(editing.id, changes);
        toast.success('Upcoming stock entry updated.');
      } else if (editing.mode === 'delete') {
        await inventoryApi.deleteUpcomingShipment(editing.id, editing.value);
        toast.success(`Upcoming stock entry ${editing.ref} deleted. Actual stock is unchanged.`);
      } else {
        const out = await inventoryApi.cancelUpcomingShipment(editing.id, editing.value);
        toast.success(`${out.cancelledQty.toLocaleString()} ${item.uom} no longer expected on this line.`);
      }
      setEditing(null);
      await onChanged();
    } catch (err) {
      toast.error(errorOf(err, 'The shipment line could not be changed.'));
    } finally {
      setSavingLine(false);
    }
  };
  const total = item.actual + item.upcoming;
  const pct = (v) => (total ? `${(v / total) * 100}%` : '0%');
  const shortIndents = indentLines.filter((l) => l.outstanding > 0).length;

  // Escape closes the panel, as it does a modal.
  useEffect(() => {
    // Skipped while a modal is open over it — the Modal locks body scroll, which is the tell.
    const onKey = (e) => { if (e.key === 'Escape' && document.body.style.overflow !== 'hidden') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const counts = {
    indents: indentLines.length || null,
    shipments: item.shipmentCount || null,
  };

  return (
    <motion.aside
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      role="dialog"
      aria-label={`${item.skuCode} upcoming stock`}
      className="fixed right-0 top-0 h-full w-full max-w-xl bg-white border-l border-slate-200 shadow-enterprise-lg z-50 flex flex-col"
    >
      <div className="px-6 pt-4 pb-0 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{item.brand} · {item.category}</p>
            <h3 className="text-lg font-black text-slate-900 truncate">{item.skuCode}</h3>
            <p className="text-xs font-semibold text-slate-500 truncate">{item.product}</p>
          </div>
          <div className="flex items-start gap-2 shrink-0">
            <StatusChip status={item.status} />
            <button onClick={onClose} aria-label="Close" className="p-1.5 -mt-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Pinned position — the same four figures as the page's summary cards. */}
        <div className="grid grid-cols-4 gap-2 mt-3">
          {[
            ['Actual', item.actual, 'text-slate-800'],
            ['Upcoming', item.upcoming, 'text-slate-800'],
            ['Reserved', item.reserved, 'text-warning-700'],
            ['Remaining', item.remaining, 'text-primary-700'],
          ].map(([l, v, tone]) => (
            <div key={l} className="bg-white px-3 py-2 rounded-lg border border-slate-200">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{l}</span>
              <span className={`block text-base font-black tabular-nums ${tone}`}>{v.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <ReserveBar item={item} className="w-full mt-2" />

        <div role="tablist" aria-label="SKU details" className="flex gap-1 mt-3 -mb-px overflow-x-auto">
          {PANEL_TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(key)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 whitespace-nowrap transition-colors ${
                  active ? 'border-primary-600 text-primary-700' : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Icon size={14} />
                {label}
                {counts[key] && (
                  <span className={`px-1.5 rounded-full text-[10px] tabular-nums ${active ? 'bg-primary-100 text-primary-700' : 'bg-slate-100 text-slate-500'}`}>
                    {counts[key]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6" role="tabpanel">
        {tab === 'indents' && (
          <IndentReservationSection
            item={item} lines={indentLines} refreshing={refreshing}
          />
        )}

        {tab === 'overview' && (
          <>
            <div>
              <PanelHeading>Actual vs upcoming</PanelHeading>
              <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100">
                <div className={SEGMENTS.actual.dot} style={{ width: pct(item.actual) }} title={`Actual: ${item.actual}`} />
                <div className={SEGMENTS.reserved.dot} style={{ width: pct(item.reserved) }} title={`Reserved: ${item.reserved}`} />
                <div className={SEGMENTS.remaining.dot} style={{ width: pct(item.remaining) }} title={`Remaining: ${item.remaining}`} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {[['actual', item.actual], ['reserved', item.reserved], ['remaining', item.remaining]].map(([k, v]) => (
                  <span key={k} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                    <span className={`w-2 h-2 rounded-full ${SEGMENTS[k].dot}`} />
                    {SEGMENTS[k].label} <span className="text-slate-800 tabular-nums">{v.toLocaleString()}</span>
                  </span>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Available after arrival</span>
                <span className="block text-xl font-black text-slate-900 tabular-nums">{item.projected.toLocaleString()}</span>
                <span className="text-[11px] text-slate-400">actual + remaining upcoming</span>
              </div>
              <div className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Next arrival</span>
                <span className="block text-base font-black text-slate-900">{formatDate(item.nextEta)}</span>
                <span className={`text-[11px] font-bold ${item.status === 'Delayed' ? 'text-error-600' : 'text-slate-400'}`}>
                  {relativeArrival(item.nextEta)}
                </span>
              </div>
            </div>

            <div>
              <PanelHeading>How this was calculated</PanelHeading>
              <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 font-mono text-[12px] leading-relaxed text-slate-700 overflow-x-auto">
                <div>
                  Upcoming  = {item.shipments.map((s) => s.qty.toLocaleString()).join(' + ') || '0'} = {item.upcoming.toLocaleString()}
                  <span className="text-slate-400"> ({item.shipmentCount} shipment{item.shipmentCount === 1 ? '' : 's'})</span>
                </div>
                <div>
                  Demand    = {indentLines.map((l) => l.requiredQty.toLocaleString()).join(' + ') || '0'} = {(item.demand ?? 0).toLocaleString()}
                  <span className="text-slate-400"> ({indentLines.length} open indent{indentLines.length === 1 ? '' : 's'})</span>
                </div>
                <div>
                  Reserved  = FIFO, oldest indent first = <strong>{item.reserved.toLocaleString()}</strong>
                  <span className="text-slate-400">
                    {' '}(the smaller of upcoming and demand{shortIndents > 0 ? `; ${shortIndents} indent${shortIndents === 1 ? '' : 's'} left short` : ''})
                  </span>
                </div>
                <div className="mt-2 pt-2 border-t border-slate-200">
                  Remaining = {item.upcoming.toLocaleString()} − {item.reserved.toLocaleString()} = <strong>{item.remaining.toLocaleString()}</strong>
                </div>
                <div>
                  Available after arrival = {item.actual.toLocaleString()} actual + {item.remaining.toLocaleString()} remaining = <strong>{item.projected.toLocaleString()}</strong>
                </div>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">{STATUS_HELP[item.status]}</p>
            </div>
          </>
        )}

        {tab === 'shipments' && (
          <div>
            <PanelHeading>Inbound shipments · {item.upcoming.toLocaleString()} {item.uom}</PanelHeading>
            {item.shipments.length === 0 && <p className="text-xs text-slate-500">No shipment recorded.</p>}
            {/* A timeline: soonest first, overdue called out. */}
            <ol className="relative ml-2 border-l-2 border-slate-100 flex flex-col gap-4">
              {/* Already earliest-first from the server, entries with no date last. */}
              {item.shipments.map((s) => {
                const d = s.eta ? daysUntil(s.eta) : null;
                const tone = d === null ? 'bg-slate-200' : d < 0 ? 'bg-error-500' : d <= 7 ? 'bg-primary-500' : 'bg-slate-300';
                return (
                  <li key={s.id} className="pl-5 relative">
                    <span aria-hidden="true" className={`absolute -left-[7px] top-1.5 w-3 h-3 rounded-full ring-4 ring-white ${tone}`} />
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`text-sm font-bold font-mono ${s.ref ? 'text-slate-800' : 'text-slate-400'}`}>{refLabel(s.ref)}</p>
                        <p className="text-[11px] text-slate-500 truncate">{s.supplier}</p>
                        <p className="text-[11px] text-slate-400 truncate">Source: {s.source}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-black text-slate-900 tabular-nums">{s.qty.toLocaleString()} {item.uom}</p>
                        {s.receivedQty > 0 && (
                          <p className="text-[11px] font-semibold text-success-700 tabular-nums">
                            {s.receivedQty.toLocaleString()} of {s.orderedQty.toLocaleString()} received
                          </p>
                        )}
                        <p className={`text-[11px] font-semibold ${s.eta ? 'text-slate-600' : 'text-slate-400'}`}>
                          {s.eta ? formatDate(s.eta) : 'Arrival date not set'}
                          {s.etaRevised && <span className="text-slate-400 font-medium"> · revised</span>}
                        </p>
                        <p className={`text-[11px] font-bold ${d !== null && d < 0 ? 'text-error-600' : 'text-slate-400'}`}>{relativeArrival(s.eta)}</p>
                      </div>
                    </div>
                    {canManage && (editing?.id === s.id ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 p-2 rounded-lg border border-slate-200 bg-slate-50/60">
                        {editing.mode === 'edit' ? (
                          <div className="w-full grid grid-cols-2 gap-2">
                            {[
                              ['orderedQty', `Quantity (${item.uom})`, 'number', s.receivedQty > 0 ? `At least ${s.receivedQty} (already arrived)` : 'Required'],
                              ['eta', 'Expected arrival', 'date', 'Optional'],
                              ['ref', 'PO / shipment ref', 'text', 'Optional'],
                              ['supplier', 'Supplier', 'text', 'Optional'],
                            ].map(([field, label, type, hint]) => (
                              <label key={field} className="flex flex-col gap-0.5 text-[11px] font-semibold text-slate-600">
                                {label}
                                <input
                                  type={type}
                                  min={type === 'number' ? Math.max(1, s.receivedQty) : undefined}
                                  value={editing.form[field]}
                                  onChange={(e) => setEditing({ ...editing, form: { ...editing.form, [field]: e.target.value } })}
                                  placeholder={hint}
                                  className="px-2 py-1 text-xs font-normal bg-white border border-slate-300 rounded-md outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                                />
                              </label>
                            ))}
                            <label className="col-span-2 flex flex-col gap-0.5 text-[11px] font-semibold text-slate-600">
                              Product description <span className="font-normal text-slate-400">(saved to Inventory Master for {item.skuCode})</span>
                              <input
                                value={editing.form.product}
                                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, product: e.target.value } })}
                                placeholder="Optional"
                                maxLength={200}
                                className="px-2 py-1 text-xs font-normal bg-white border border-slate-300 rounded-md outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                              />
                            </label>
                          </div>
                        ) : (
                          <input
                            aria-label={`Reason for ${editing.mode === 'delete' ? 'deleting' : 'cancelling'} ${refLabel(s.ref)}`}
                            value={editing.value}
                            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                            placeholder={editing.mode === 'delete'
                              ? `Delete this entry (${s.qty.toLocaleString()} ${item.uom}) — reason (optional)`
                              : `Cancel the ${s.qty.toLocaleString()} still expected — reason (optional)`}
                            className="flex-1 min-w-40 px-2 py-1 text-xs bg-white border border-slate-300 rounded-md outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                          />
                        )}
                        <Button size="xs" variant={editing.mode === 'edit' ? 'primary' : 'danger'} onClick={saveLine} loading={savingLine}>
                          {{ edit: 'Save changes', cancel: 'Cancel remaining', delete: 'Delete entry' }[editing.mode]}
                        </Button>
                        {editing.mode === 'delete' && (
                          <p className="w-full text-[11px] text-slate-500">
                            Removes this entry from upcoming stock. Actual stock is not changed.
                          </p>
                        )}
                        <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>Keep</Button>
                      </div>
                    ) : (
                      <div className="mt-1 flex gap-3">
                        <button
                          type="button"
                          onClick={() => setEditing({ id: s.id, mode: 'edit', original: editableOf(s, item), form: editableOf(s, item) })}
                          aria-label={`Edit upcoming stock entry ${refLabel(s.ref)}`}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-primary-700"
                        >
                          <Pencil size={11} />Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing({ id: s.id, mode: 'cancel', value: '' })}
                          className="text-[11px] font-bold text-slate-500 hover:text-error-600"
                        >
                          Cancel remaining
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing({ id: s.id, ref: refLabel(s.ref), mode: 'delete', value: '' })}
                          aria-label={`Delete upcoming stock entry ${refLabel(s.ref)}`}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-error-600"
                        >
                          <Trash2 size={11} />Delete
                        </button>
                      </div>
                    ))}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

      </div>

      <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex items-center gap-2">
        <span className="text-xs text-slate-500">
          <strong className="text-primary-700 tabular-nums">{item.remaining.toLocaleString()}</strong> remaining after FIFO
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </motion.aside>
  );
};

export const UpcomingStock = () => {
  const { user } = useUserStore();
  const canManage = hasPermission(user, PERMISSIONS.MANAGE_INVENTORY_MASTER);

  /**
   * The list. Re-read from the server on every visit (it is reserved from),
   * with the last copy shown under the "Refreshing…" bar meanwhile; and again
   * whenever stock moves or upcoming stock changes anywhere, so a receipt
   * posted on another screen shows up here without a reload.
   */
  const query = useQuery({
    queryKey: queryKeys.upcomingStock.list(),
    queryFn: inventoryApi.upcomingStock,
    staleTime: STALE.upcomingStock,
  });
  const reload = () => query.refetch();
  useEffect(() => onStockUpdated(() => query.refetch()), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onUpcomingUpdated(() => query.refetch()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const lastImport = query.data?.lastImport ?? null;
  const initialLoading = query.isPending;
  const loadError = query.isError ? errorOf(query.error, 'Upcoming stock could not be loaded.') : null;

  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [status, setStatus] = useState('');
  const [arrival, setArrival] = useState('');
  const [sort, setSort] = useState('eta-asc');
  const [page, setPage] = useState(1);

  const [indentFilter, setIndentFilter] = useState('');

  // The open panel and the tab it opened on. A row click opens on Indents when
  // the SKU has any, otherwise on Overview; the row's Reserve always opens Indents.
  const [selectedKey, setSelectedKey] = useState(null);
  const [panelTab, setPanelTab] = useState('indents');
  const [importOpen, setImportOpen] = useState(false);

  // The server already scopes the list to these brands; this is the filter's option list.
  const brands = allowedBrands(user);

  const totals = useMemo(() => items.reduce((t, i) => ({
    actual: t.actual + i.actual,
    upcoming: t.upcoming + i.upcoming,
    reserved: t.reserved + i.reserved,
    remaining: t.remaining + i.remaining,
  }), { actual: 0, upcoming: 0, reserved: 0, remaining: 0 }), [items]);

  // Per-SKU indent coverage: how many open indents each SKU has, how many are
  // covered. The indents come with the list — every SKU's open ones, the same
  // records Indent History shows.
  const indentStats = useMemo(
    () => new Map(items.map((i) => [i.key, indentSummary(indentLinesFor(i))])),
    [items],
  );

  // Everything except the status filter, so the chips count what the other filters leave.
  const preStatus = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((i) => (!brand || i.brand === brand)
      && inArrivalWindow(i, arrival)
      && matchesIndentFilter(indentStats.get(i.key), indentFilter)
      && (!term || i.skuCode.toLowerCase().includes(term) || i.product.toLowerCase().includes(term)));
  }, [items, search, brand, arrival, indentFilter, indentStats]);

  // What needs a decision today, across everything (not just the filtered view).
  const attention = useMemo(() => {
    let short = 0;
    indentStats.forEach((s) => { short += s.count - s.covered; });
    return { delayed: items.filter((i) => i.status === 'Delayed').length, short };
  }, [items, indentStats]);

  const statusCounts = useMemo(
    () => preStatus.reduce((c, i) => ({ ...c, [i.status]: (c[i.status] || 0) + 1 }), {}),
    [preStatus],
  );

  const filtered = useMemo(
    () => preStatus.filter((i) => !status || i.status === status).sort(SORTERS[sort]),
    [preStatus, status, sort],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Upcoming shipments grouped by PO / container, soonest first.
  // Position per brand for the Actual vs Upcoming card, on one shared scale.
  const byBrand = useMemo(() => {
    const m = new Map();
    items.forEach((i) => {
      const b = m.get(i.brand) || { brand: i.brand, skus: 0, actual: 0, reserved: 0, remaining: 0 };
      b.skus += 1; b.actual += i.actual; b.reserved += i.reserved; b.remaining += i.remaining;
      m.set(i.brand, b);
    });
    return [...m.values()];
  }, [items]);
  const brandScale = Math.max(0, ...byBrand.map((b) => b.actual + b.reserved + b.remaining));

  const pipeline = useMemo(() => {
    // Grouped by reference AND date: entries without a reference are not one
    // shipment just because they share a blank, and a blank date stays blank.
    const byRef = new Map();
    items.forEach((i) => i.shipments.forEach((s) => {
      const key = s.ref ? `ref:${s.ref}` : `none:${s.eta ? toYmd(s.eta) : ''}`;
      const g = byRef.get(key) || { key, ref: s.ref, eta: s.eta, supplier: s.supplier, qty: 0, skus: 0 };
      g.qty += s.qty;
      g.skus += 1;
      if (s.eta && (!g.eta || new Date(s.eta) < new Date(g.eta))) g.eta = s.eta;
      byRef.set(key, g);
    }));
    const at = (g) => (g.eta ? new Date(g.eta).getTime() : Infinity);
    return [...byRef.values()].sort((a, b) => at(a) - at(b) || 0);
  }, [items]);

  // A SKU that leaves the list (all of it arrived) closes its panel.
  const selected = selectedKey ? items.find((i) => i.key === selectedKey) ?? null : null;
  const selectedIndents = useMemo(() => (selected ? indentLinesFor(selected) : []), [selected]);

  const openPanel = (key, tab) => {
    setPanelTab(tab || ((indentStats.get(key)?.count || 0) > 0 ? 'indents' : 'overview'));
    setSelectedKey(key);
  };

  const withFilter = (setter) => (v) => { setter(v); setPage(1); };
  const resetFilters = () => {
    setSearch(''); setBrand(''); setStatus(''); setArrival(''); setIndentFilter(''); setSort('eta-asc'); setPage(1);
  };

  // The filters currently narrowing the table, each removable on its own.
  const activeFilters = [
    search.trim() && { key: 'search', label: `“${search.trim()}”`, clear: () => withFilter(setSearch)('') },
    brand && { key: 'brand', label: brand, clear: () => withFilter(setBrand)('') },
    status && { key: 'status', label: status, clear: () => withFilter(setStatus)('') },
    arrival && { key: 'arrival', label: ARRIVAL_OPTIONS.find((o) => o.value === arrival)?.label, clear: () => withFilter(setArrival)('') },
    indentFilter && { key: 'indents', label: INDENT_FILTERS.find((o) => o.value === indentFilter)?.label, clear: () => withFilter(setIndentFilter)('') },
  ].filter(Boolean);

  // The SKU whose upcoming entries the row's Delete is about to remove.
  const [deleteFor, setDeleteFor] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = async () => {
    if (!deleteFor || deleting) return;
    setDeleting(true);
    try {
      const out = await inventoryApi.deleteUpcomingSku({ brand: deleteFor.brand, skuCode: deleteFor.skuCode });
      toast.success(
        `Deleted ${out.entries} upcoming entr${out.entries === 1 ? 'y' : 'ies'} for ${out.skuCode}. Actual stock is unchanged.`,
      );
      if (selectedKey === deleteFor.key) setSelectedKey(null);
      setDeleteFor(null);
    } catch (err) {
      toast.error(errorOf(err, 'The upcoming stock could not be deleted.'));
    } finally {
      setDeleting(false);
    }
    await reload();
  };

  const handleExport = () => {
    const ok = exportToExcel(filtered, [
      { key: 'skuCode', label: 'SKU' },
      { key: 'brand', label: 'Brand' },
      { key: 'product', label: 'Product' },
      { key: 'actual', label: 'Actual Stock' },
      { key: 'upcoming', label: 'Upcoming Stock' },
      { key: 'reserved', label: 'Reserved' },
      { key: 'remaining', label: 'Remaining' },
      { key: 'projected', label: 'Available After Arrival' },
      { key: 'nextEta', label: 'Expected Arrival', format: (v) => formatDate(v) },
      { key: 'status', label: 'Stock Status' },
    ], 'upcoming-stock');
    if (ok) toast.success(`Exported ${filtered.length} SKU${filtered.length === 1 ? '' : 's'}.`);
    else toast.error('The export could not be created.');
  };

  const reservedPct = totals.upcoming ? Math.round((totals.reserved / totals.upcoming) * 100) : 0;
  const positionTotal = totals.actual + totals.upcoming;
  const seg = (v) => (positionTotal ? `${(v / positionTotal) * 100}%` : '0%');
  const colCount = 10;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Upcoming Stock"
        subtitle="Stock that is ordered but not yet received. Reserve it for customers before it lands, and see what is still free."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {canManage && (
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <Upload size={15} className="mr-2" />Import Upcoming Stock
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleExport} disabled={filtered.length === 0}>
              <Download size={15} className="mr-2" />Export
            </Button>
          </div>
        )}
      />

      {query.isFetching && query.data && <ProgressBar label="Refreshing…" />}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
        <SummaryCard icon={Warehouse} tone="bg-slate-100 text-slate-600" label="Actual Stock" value={totals.actual} hint={`On hand across ${items.length} SKUs`} />
        <SummaryCard icon={Ship} tone="bg-primary-50 text-primary-600" label="Upcoming Stock" value={totals.upcoming} hint={`${pipeline.length} inbound shipments`} />
        <SummaryCard
          icon={Lock} tone="bg-warning-50 text-warning-600" label="Reserved Upcoming" value={totals.reserved}
          hint={`${reservedPct}% of upcoming is reserved`}
          meter={totals.upcoming ? totals.reserved / totals.upcoming : 0} meterTone="bg-warning-500"
        />
        <SummaryCard
          icon={PackageCheck} tone="bg-success-50 text-success-600" label="Remaining Upcoming" value={totals.remaining}
          hint={`${100 - reservedPct}% free to reserve`}
          meter={totals.upcoming ? totals.remaining / totals.upcoming : 0} meterTone="bg-primary-500"
        />
      </div>

      {/* What needs a decision — each one a shortcut to the filtered list. */}
      {(attention.delayed > 0 || attention.short > 0) && (
        <div className="flex flex-wrap items-center gap-2 -mt-2">
          <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mr-1">Needs attention</span>
          {[
            attention.delayed > 0 && {
              key: 'delayed', icon: AlertTriangle, tone: 'text-error-700 border-error-200 bg-error-50 hover:bg-error-100',
              text: `${attention.delayed} SKU${attention.delayed === 1 ? '' : 's'} with a delayed shipment`,
              active: status === 'Delayed',
              apply: () => { withFilter(setStatus)(status === 'Delayed' ? '' : 'Delayed'); },
            },
            attention.short > 0 && {
              key: 'short', icon: ClipboardList, tone: 'text-primary-700 border-primary-200 bg-primary-50 hover:bg-primary-100',
              text: `${attention.short} indent${attention.short === 1 ? '' : 's'} not fully covered by upcoming stock`,
              active: indentFilter === 'open',
              apply: () => { withFilter(setIndentFilter)(indentFilter === 'open' ? '' : 'open'); },
            },
          ].filter(Boolean).map(({ key, icon: Icon, tone, text, active, apply }) => (
            <button
              key={key}
              type="button"
              onClick={apply}
              aria-pressed={active}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold transition-colors ${tone} ${
                active ? 'ring-2 ring-offset-1 ring-slate-400' : ''
              }`}
            >
              <Icon size={13} />{text}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Actual vs upcoming on one bar, then the status chips that filter the list — the Health screen's pattern. */}
        <Card className="lg:col-span-2">
          <CardContent className="p-5 flex flex-col gap-4 h-full">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Actual vs Upcoming</p>
                <p className="text-sm text-slate-600 mt-0.5">
                  Remaining upcoming adds{' '}
                  <strong className="text-slate-900 tabular-nums">
                    {totals.actual ? `${Math.round((totals.remaining / totals.actual) * 100)}%` : '—'}
                  </strong>{' '}
                  on top of actual stock once received.
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Available after arrival</p>
                <p className="text-xl font-black text-slate-900 tabular-nums">{(totals.actual + totals.remaining).toLocaleString()}</p>
              </div>
            </div>

            <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100">
              <div className={SEGMENTS.actual.dot} style={{ width: seg(totals.actual) }} title={`Actual: ${totals.actual}`} />
              <div className={SEGMENTS.reserved.dot} style={{ width: seg(totals.reserved) }} title={`Reserved upcoming: ${totals.reserved}`} />
              <div className={SEGMENTS.remaining.dot} style={{ width: seg(totals.remaining) }} title={`Remaining upcoming: ${totals.remaining}`} />
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 -mt-1">
              {[['actual', totals.actual], ['reserved', totals.reserved], ['remaining', totals.remaining]].map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                  <span className={`w-2 h-2 rounded-full ${SEGMENTS[k].dot}`} />
                  {SEGMENTS[k].label}
                  <span className="text-slate-800 tabular-nums">{v.toLocaleString()}</span>
                  <span className="text-slate-400">({positionTotal ? Math.round((v / positionTotal) * 100) : 0}%)</span>
                </span>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
              {STATUS_ORDER.filter((s) => s !== 'No Inbound' || statusCounts[s]).map((s) => {
                const n = statusCounts[s] || 0;
                const active = status === s;
                return (
                  <button
                    key={s}
                    onClick={() => withFilter(setStatus)(active ? '' : s)}
                    title={STATUS_HELP[s]}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors ${
                      active ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${STATUS[s].dot}`} />
                    {s}
                    <span className={active ? 'text-slate-300' : 'text-slate-400'}>{n}</span>
                  </button>
                );
              })}
            </div>

            {/* Per-brand split, pinned to the bottom so the card ends level with
                the Inbound Shipments card beside it. One scale across brands,
                so the bar lengths compare. Clicking a brand filters the table. */}
            {byBrand.length > 0 && (
              <div className="mt-auto pt-4 border-t border-slate-100">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2.5">By brand</p>
                <div className="flex flex-col gap-2.5">
                  {byBrand.map((b) => {
                    const w = (v) => `${brandScale ? (v / brandScale) * 100 : 0}%`;
                    const active = brand === b.brand;
                    return (
                      <button
                        key={b.brand}
                        type="button"
                        onClick={() => withFilter(setBrand)(active ? '' : b.brand)}
                        aria-pressed={active}
                        title={`Show only ${b.brand}`}
                        className={`grid grid-cols-[4.5rem_1fr_auto] items-center gap-3 text-left rounded-md -mx-1.5 px-1.5 py-1 transition-colors ${
                          active ? 'bg-slate-100' : 'hover:bg-slate-50'
                        }`}
                      >
                        <span className="text-xs font-bold text-slate-700 truncate">{b.brand}</span>
                        <span className="flex h-2 rounded-full overflow-hidden bg-slate-100">
                          <span className={SEGMENTS.actual.dot} style={{ width: w(b.actual) }} />
                          <span className={SEGMENTS.reserved.dot} style={{ width: w(b.reserved) }} />
                          <span className={SEGMENTS.remaining.dot} style={{ width: w(b.remaining) }} />
                        </span>
                        <span className="text-[11px] font-semibold text-slate-500 tabular-nums whitespace-nowrap text-right">
                          {b.skus} SKU{b.skus === 1 ? '' : 's'} · <span className="text-primary-700 font-bold">{b.remaining.toLocaleString()}</span> free
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 flex flex-col gap-3">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <CalendarClock size={14} />Inbound shipments
            </p>
            <div className="flex flex-col gap-3 -mx-1 max-h-64 overflow-y-auto">
              {pipeline.length === 0 && <p className="text-xs text-slate-500 py-2 px-1">No shipments recorded.</p>}
              {/* Grouped by arrival window, each with its unit total. */}
              {ARRIVAL_BUCKETS.map((b) => {
                const group = pipeline.filter((g) => b.test(g.eta ? daysUntil(g.eta) : null));
                if (group.length === 0) return null;
                const units = group.reduce((s, g) => s + g.qty, 0);
                return (
                  <div key={b.key}>
                    <div className="flex items-center justify-between px-1 pb-1 border-b border-slate-100">
                      <span className={`text-[10px] font-bold uppercase tracking-wider ${b.tone}`}>{b.label}</span>
                      <span className="text-[10px] font-bold text-slate-400 tabular-nums">{units.toLocaleString()} units</span>
                    </div>
                    <div className="flex flex-col divide-y divide-slate-50">
                      {group.map((g) => (
                        <div key={g.key} className="flex items-center justify-between gap-3 py-1.5 px-1">
                          <div className="min-w-0">
                            <p className={`text-xs font-bold font-mono truncate ${g.ref ? 'text-slate-800' : 'text-slate-400'}`}>{refLabel(g.ref)}</p>
                            <p className="text-[11px] text-slate-400 truncate">{g.skus} SKU{g.skus === 1 ? '' : 's'} · {g.qty.toLocaleString()} units</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-[11px] font-semibold text-slate-600">{formatDate(g.eta)}</p>
                            <p className={`text-[11px] font-bold ${b.tone}`}>{relativeArrival(g.eta)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-col lg:flex-row justify-between items-center gap-4 rounded-t-xl">
            <div className="relative w-full lg:w-80">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                type="text"
                placeholder="Search by SKU or product..."
                value={search}
                onChange={(e) => withFilter(setSearch)(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 text-sm font-medium text-slate-800 bg-white"
              />
            </div>

            <div className="flex flex-wrap gap-2 w-full lg:w-auto">
              {brands.length > 1 && (
                <select
                  value={brand}
                  onChange={(e) => withFilter(setBrand)(e.target.value)}
                  className="px-3 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-white outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
                >
                  <option value="">All Brands</option>
                  {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
              <select
                value={arrival}
                onChange={(e) => withFilter(setArrival)(e.target.value)}
                className="px-3 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-white outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
              >
                {ARRIVAL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select
                value={indentFilter}
                onChange={(e) => withFilter(setIndentFilter)(e.target.value)}
                aria-label="Filter by indent coverage"
                className="px-3 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-white outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
              >
                {INDENT_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select
                value={sort}
                onChange={(e) => withFilter(setSort)(e.target.value)}
                className="px-3 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-white outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
              >
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <Button variant="outline" size="sm" onClick={resetFilters}>
                <RotateCcw size={14} className="mr-2" />Reset
              </Button>
            </div>
          </div>

          {/* What the table is showing, and what is narrowing it. */}
          <div className="px-5 py-2.5 border-b border-slate-100 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-slate-500">
              Showing <strong className="text-slate-800 tabular-nums">{filtered.length}</strong> of {items.length} SKUs
            </span>
            {activeFilters.map((f) => (
              <span key={f.key} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold">
                {f.label}
                <button
                  type="button"
                  onClick={f.clear}
                  aria-label={`Remove filter ${f.label}`}
                  className="p-0.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-200"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {activeFilters.length > 1 && (
              <button type="button" onClick={resetFilters} className="font-bold text-primary-700 hover:underline">
                Clear all
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">SKU</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Product</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Actual Stock</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Upcoming Stock</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Reserved</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Remaining</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Indents</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Expected Arrival</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Stock Status</th>
                  <th className="px-5 py-4 w-px" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pageRows.map((i) => {
                  const overdue = i.nextEta && daysUntil(i.nextEta) < 0;
                  return (
                    <tr
                      key={i.key}
                      onClick={() => openPanel(i.key)}
                      className={`transition-colors cursor-pointer ${selectedKey === i.key ? 'bg-primary-50/60' : 'hover:bg-slate-50'}`}
                    >
                      {/* A red edge on delayed rows, so they stand out in any sort order. */}
                      <td className={`px-5 py-4 border-l-[3px] ${i.status === 'Delayed' ? 'border-error-500' : 'border-transparent'}`}>
                        <span className="font-bold text-slate-900 whitespace-nowrap">{i.skuCode}</span>
                        <span className="block text-[11px] text-slate-400 font-medium">{i.brand}</span>
                      </td>
                      <td className="px-5 py-4">
                        <span className="block text-slate-700 font-medium truncate max-w-64" title={i.product}>{i.product}</span>
                        <span className="block text-[11px] text-slate-400 font-medium">{i.category}</span>
                      </td>
                      <td className="px-5 py-4 text-right tabular-nums">
                        {i.actual === 0
                          ? <span className="font-bold text-error-600" title="Out of stock — only upcoming stock can be reserved">0</span>
                          : <span className="font-semibold text-slate-800">{i.actual.toLocaleString()}</span>}
                      </td>
                      <td className="px-5 py-4 text-right font-semibold text-slate-800 tabular-nums">{i.upcoming.toLocaleString()}</td>
                      <td className="px-5 py-4 text-right font-semibold text-slate-500 tabular-nums">{i.reserved.toLocaleString()}</td>
                      <td className="px-5 py-4 text-right">
                        <span className="font-bold text-primary-700 tabular-nums">{i.remaining.toLocaleString()}</span>
                        <ReserveBar item={i} className="w-20 ml-auto mt-1.5" />
                      </td>
                      <td className="px-5 py-4"><IndentCoverage stats={indentStats.get(i.key)} /></td>
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span className="block font-semibold text-slate-700">{formatDate(i.nextEta)}</span>
                        <span className={`block text-[11px] font-bold ${overdue ? 'text-error-600' : 'text-slate-400'}`}>
                          {relativeArrival(i.nextEta)}
                          {i.shipmentCount > 1 && <span className="font-medium text-slate-400"> · +{i.shipmentCount - 1} more</span>}
                        </span>
                      </td>
                      <td className="px-5 py-4"><StatusChip status={i.status} /></td>
                      <td className="px-5 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => setDeleteFor(i)}
                            title="Delete this SKU's upcoming stock entries (actual stock is not changed)"
                            aria-label={`Delete upcoming stock for ${i.skuCode}`}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 ml-1.5 rounded-lg text-[11px] font-bold
                                       text-error-600 border border-error-200 bg-white hover:bg-error-50
                                       hover:border-error-300 transition-colors"
                          >
                            <Trash2 size={13} />
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {initialLoading && <TableSkeleton rows={6} columns={colCount} cellClass="px-5 py-4" />}

                {!initialLoading && loadError && !query.data && (
                  <tr>
                    <td colSpan={colCount} className="px-6 py-12 text-center">
                      <p className="text-error-600 font-semibold">{loadError}</p>
                      <Button size="sm" variant="outline" className="mt-3" onClick={reload}>
                        <RefreshCw size={14} className="mr-2" />Try again
                      </Button>
                    </td>
                  </tr>
                )}

                {!initialLoading && !(loadError && !query.data) && pageRows.length === 0 && (
                  <tr>
                    <td colSpan={colCount} className="px-6 py-12 text-center">
                      {items.length === 0 ? (
                        <>
                          <p className="text-slate-600 font-semibold">No upcoming stock recorded</p>
                          <p className="text-slate-500 text-xs mt-1">Import an upcoming stock file to add shipments.</p>
                        </>
                      ) : (
                        <>
                          <p className="text-slate-600 font-semibold">No SKUs match these filters</p>
                          <p className="text-slate-500 text-xs mt-1">Clear a filter, or import an upcoming stock file to add shipments.</p>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {filtered.length > 0 && (
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/60 rounded-b-xl">
              <Pagination page={safePage} pageSize={PAGE_SIZE} totalItems={filtered.length} onPageChange={setPage} />
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-start gap-2 px-4 py-3 rounded-lg bg-slate-50 border border-slate-200">
        <Info size={16} className="text-slate-500 shrink-0 mt-0.5" />
        <p className="text-xs text-slate-600 leading-relaxed flex-1 min-w-60">
          <strong>Internal analysis only.</strong> Reserved is worked out automatically: each SKU&apos;s upcoming stock
          is shared out over its open indents oldest first (FIFO), earliest arrival first, and Remaining is what is left.
          It is a simulation — no stock is reserved, no booking or indent is changed, and no email or notification is
          sent. Actual stock is the live on-hand figure; when goods are received into inventory the upcoming quantity
          falls by itself, and the allocation is recalculated.
          {lastImport && (
            <> Last import: <span className="font-semibold">{lastImport.fileName}</span> · {formatDateTime(lastImport.importedAt)}.</>
          )}
        </p>
        <Button size="xs" variant="secondary" onClick={reload} disabled={query.isFetching}>
          <RefreshCw size={12} className={`mr-1.5 ${query.isFetching ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </div>

      <AnimatePresence>
        {selected && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setSelectedKey(null)}
              className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40"
            />
            <UpcomingPanel
              key={selected.key}
              item={selected}
              indentLines={selectedIndents}
              refreshing={query.isFetching}
              canManage={canManage}
              initialTab={panelTab}
              onClose={() => setSelectedKey(null)}
              onChanged={reload}
            />
          </>
        )}
      </AnimatePresence>

      <ImportUpcomingModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={reload}
        templateBrand={brands[0] || ''}
      />

      <ConfirmationDialog
        isOpen={Boolean(deleteFor)}
        onClose={() => setDeleteFor(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        variant="danger"
        title="Delete upcoming stock"
        confirmText="Delete"
        description={deleteFor
          ? `Delete all ${deleteFor.shipmentCount} upcoming entr${deleteFor.shipmentCount === 1 ? 'y' : 'ies'} for `
            + `${deleteFor.skuCode} (${deleteFor.upcoming.toLocaleString()} ${deleteFor.uom}: `
            + `${deleteFor.shipments.map((s) => refLabel(s.ref)).join(', ')})? The SKU leaves this list. `
            + 'Actual stock in the inventory is not changed. To remove just one entry, open the SKU\'s Shipments tab.'
          : ''}
      />
    </div>
  );
};

export default UpcomingStock;
