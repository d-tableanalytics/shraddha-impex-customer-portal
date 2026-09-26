import { useMemo, useState } from 'react';
import {
  Search, X, RotateCcw, Upload, Download, BookmarkPlus, Warehouse, Ship, Lock, PackageCheck,
  CalendarClock, Info, Undo2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Pagination } from '../../components/ui/Pagination';
import { PageHeader } from '../../components/common/PageHeader';
import { ImportUpcomingModal } from '../../components/inventory/ImportUpcomingModal';
import { ReserveUpcomingModal } from '../../components/inventory/ReserveUpcomingModal';
import { useUpcomingStockStore } from '../../store/upcomingStockStore';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { exportToExcel } from '../../utils/exportUtils';
import {
  derive, STATUS, STATUS_ORDER, STATUS_HELP, formatDate, formatDateTime, relativeArrival, daysUntil,
} from '../../utils/upcomingStockMock';

/**
 * Upcoming Stock — DEMO SCREEN, mock data only.
 *
 * Stock that has been ordered but not received, and how much of it has already
 * been promised. Follows the Inventory Master / Health layout so it reads as
 * part of the same module, but holds its data in the browser
 * (store/upcomingStockStore.js) — no API, no database, and no effect on the
 * live Inventory Master or Inventory Health screens.
 *
 *   Remaining Upcoming = Upcoming Stock − Reserved Stock
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

const SummaryCard = ({ icon: Icon, tone, label, value, hint }) => (
  <Card>
    <CardContent className="p-5 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${tone}`}>
        <Icon size={22} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">{label}</p>
        <h3 className="text-2xl font-bold text-slate-900 tabular-nums">{value.toLocaleString()}</h3>
        {hint && <p className="text-[11px] text-slate-400 font-medium truncate">{hint}</p>}
      </div>
    </CardContent>
  </Card>
);

/**
 * SKU detail drawer — the full breakdown: position, the arithmetic, every
 * inbound shipment and every reservation held against it.
 */
const UpcomingPanel = ({ item, onClose, onReserve, onRelease }) => {
  const [confirming, setConfirming] = useState(null);
  const total = item.actual + item.upcoming;
  const pct = (v) => (total ? `${(v / total) * 100}%` : '0%');

  return (
    <motion.aside
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      className="fixed right-0 top-0 h-full w-full max-w-xl bg-white border-l border-slate-200 shadow-enterprise-lg z-50 flex flex-col"
    >
      <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{item.brand} · {item.category}</p>
          <h3 className="text-lg font-black text-slate-900 truncate">{item.skuCode}</h3>
          <p className="text-xs font-semibold text-slate-500 truncate">{item.product}</p>
          <div className="mt-1.5"><StatusChip status={item.status} /></div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Position</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              ['Actual', item.actual, 'text-slate-800'],
              ['Upcoming', item.upcoming, 'text-slate-800'],
              ['Reserved', item.reserved, 'text-warning-700'],
              ['Remaining', item.remaining, 'text-primary-700'],
            ].map(([l, v, tone]) => (
              <div key={l} className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
                <span className="text-[10px] font-bold text-slate-400 uppercase">{l}</span>
                <span className={`block text-base font-black tabular-nums ${tone}`}>{v.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Actual vs upcoming, on one scale. */}
        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Actual vs upcoming</h4>
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

        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">How this was calculated</h4>
          <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 font-mono text-[12px] leading-relaxed text-slate-700 overflow-x-auto">
            <div>
              Upcoming  = {item.shipments.map((s) => s.qty.toLocaleString()).join(' + ') || '0'} = {item.upcoming.toLocaleString()}
              <span className="text-slate-400"> ({item.shipmentCount} shipment{item.shipmentCount === 1 ? '' : 's'})</span>
            </div>
            <div>
              Reserved  = {item.reservations.map((r) => r.qty.toLocaleString()).join(' + ') || '0'} = {item.reserved.toLocaleString()}
              <span className="text-slate-400"> ({item.reservations.length} indent{item.reservations.length === 1 ? '' : 's'})</span>
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

        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Inbound shipments</h4>
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
            {item.shipments.length === 0 && <p className="px-4 py-3 text-xs text-slate-500">No shipment recorded.</p>}
            {[...item.shipments].sort((a, b) => a.eta.localeCompare(b.eta)).map((s) => {
              const overdue = daysUntil(s.eta) < 0;
              return (
                <div key={s.id} className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-800 font-mono">{s.ref}</p>
                    <p className="text-[11px] text-slate-500 truncate">{s.supplier}</p>
                    <p className="text-[11px] text-slate-400 truncate">Source: {s.source}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-black text-slate-900 tabular-nums">{s.qty.toLocaleString()} {item.uom}</p>
                    <p className="text-[11px] font-semibold text-slate-600">{formatDate(s.eta)}</p>
                    <p className={`text-[11px] font-bold ${overdue ? 'text-error-600' : 'text-slate-400'}`}>{relativeArrival(s.eta)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">
            Reservations (indent) · {item.reserved.toLocaleString()} {item.uom}
          </h4>
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
            {item.reservations.length === 0 && (
              <p className="px-4 py-3 text-xs text-slate-500">Nothing reserved yet — all upcoming stock is free.</p>
            )}
            {item.reservations.map((r) => (
              <div key={r.id} className="px-4 py-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-800 truncate">{r.customer}</p>
                  <p className="text-[11px] text-slate-500">
                    <span className="font-mono">{r.indentNo}</span> · {formatDateTime(r.reservedAt)} · {r.by}
                  </p>
                  {r.note && <p className="text-[11px] text-slate-400 truncate">{r.note}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-sm font-black text-slate-900 tabular-nums">{r.qty.toLocaleString()}</span>
                  {confirming === r.id ? (
                    <>
                      <Button size="xs" variant="danger" onClick={() => { onRelease(r); setConfirming(null); }}>Release</Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>Keep</Button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirming(r.id)}
                      className="p-1.5 rounded-lg text-slate-300 hover:text-error-600 hover:bg-error-50 transition-colors"
                      title="Release this reservation"
                    >
                      <Undo2 size={15} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex items-center gap-2">
        <span className="text-xs text-slate-500">
          <strong className="text-primary-700 tabular-nums">{item.remaining.toLocaleString()}</strong> free to reserve
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
          <Button size="sm" onClick={() => onReserve(item.key)} disabled={item.remaining === 0}>
            <BookmarkPlus size={15} className="mr-2" />Reserve Stock
          </Button>
        </div>
      </div>
    </motion.aside>
  );
};

export const UpcomingStock = () => {
  const { user } = useUserStore();
  const rawItems = useUpcomingStockStore((s) => s.items);
  const imports = useUpcomingStockStore((s) => s.imports);
  const release = useUpcomingStockStore((s) => s.release);
  const resetDemo = useUpcomingStockStore((s) => s.reset);

  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [status, setStatus] = useState('');
  const [arrival, setArrival] = useState('');
  const [sort, setSort] = useState('eta-asc');
  const [page, setPage] = useState(1);

  const [selectedKey, setSelectedKey] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reserveFor, setReserveFor] = useState(undefined); // undefined = closed, '' = no SKU pre-selected

  const brands = allowedBrands(user);

  // Scoped to the brands this user may see, the same rule as the live screens.
  const items = useMemo(() => {
    const scoped = brands.length ? rawItems.filter((i) => brands.includes(i.brand)) : rawItems;
    return scoped.map(derive);
  }, [rawItems, brands.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => items.reduce((t, i) => ({
    actual: t.actual + i.actual,
    upcoming: t.upcoming + i.upcoming,
    reserved: t.reserved + i.reserved,
    remaining: t.remaining + i.remaining,
  }), { actual: 0, upcoming: 0, reserved: 0, remaining: 0 }), [items]);

  // Everything except the status filter, so the chips count what the other filters leave.
  const preStatus = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((i) => (!brand || i.brand === brand)
      && inArrivalWindow(i, arrival)
      && (!term || i.skuCode.toLowerCase().includes(term) || i.product.toLowerCase().includes(term)));
  }, [items, search, brand, arrival]);

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
  const pipeline = useMemo(() => {
    const byRef = new Map();
    items.forEach((i) => i.shipments.forEach((s) => {
      const g = byRef.get(s.ref) || { ref: s.ref, eta: s.eta, supplier: s.supplier, qty: 0, skus: 0 };
      g.qty += s.qty;
      g.skus += 1;
      if (s.eta < g.eta) g.eta = s.eta;
      byRef.set(s.ref, g);
    }));
    return [...byRef.values()].sort((a, b) => a.eta.localeCompare(b.eta));
  }, [items]);

  const selected = selectedKey ? items.find((i) => i.key === selectedKey) : null;

  const withFilter = (setter) => (v) => { setter(v); setPage(1); };
  const resetFilters = () => { setSearch(''); setBrand(''); setStatus(''); setArrival(''); setSort('eta-asc'); setPage(1); };

  const handleRelease = (item) => (r) => {
    release(item.key, r.id);
    toast.success(`Released ${r.qty.toLocaleString()} × ${item.skuCode} (${r.indentNo}).`);
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
  const lastImport = imports[0];
  const colCount = 9;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Upcoming Stock"
        subtitle="Stock that is ordered but not yet received. Reserve it for customers before it lands, and see what is still free."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload size={15} className="mr-2" />Import Upcoming Stock
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={filtered.length === 0}>
              <Download size={15} className="mr-2" />Export
            </Button>
            <Button size="sm" onClick={() => setReserveFor('')}>
              <BookmarkPlus size={15} className="mr-2" />Reserve Stock
            </Button>
          </div>
        )}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
        <SummaryCard icon={Warehouse} tone="bg-slate-100 text-slate-600" label="Actual Stock" value={totals.actual} hint={`On hand across ${items.length} SKUs`} />
        <SummaryCard icon={Ship} tone="bg-primary-50 text-primary-600" label="Upcoming Stock" value={totals.upcoming} hint={`${pipeline.length} inbound shipments`} />
        <SummaryCard icon={Lock} tone="bg-warning-50 text-warning-600" label="Reserved Upcoming" value={totals.reserved} hint={`${reservedPct}% of upcoming is reserved`} />
        <SummaryCard icon={PackageCheck} tone="bg-success-50 text-success-600" label="Remaining Upcoming" value={totals.remaining} hint="Free to reserve" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Actual vs upcoming on one bar, then the status chips that filter the list — the Health screen's pattern. */}
        <Card className="lg:col-span-2">
          <CardContent className="p-5 flex flex-col gap-4">
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
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 flex flex-col gap-3">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <CalendarClock size={14} />Inbound shipments
            </p>
            <div className="flex flex-col divide-y divide-slate-100 -mx-1 max-h-56 overflow-y-auto">
              {pipeline.length === 0 && <p className="text-xs text-slate-500 py-2 px-1">No shipments recorded.</p>}
              {pipeline.map((g) => {
                const d = daysUntil(g.eta);
                return (
                  <div key={g.ref} className="flex items-center justify-between gap-3 py-2 px-1">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-800 font-mono truncate">{g.ref}</p>
                      <p className="text-[11px] text-slate-400 truncate">{g.skus} SKU{g.skus === 1 ? '' : 's'} · {g.qty.toLocaleString()} units</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[11px] font-semibold text-slate-600">{formatDate(g.eta)}</p>
                      <p className={`text-[11px] font-bold ${d < 0 ? 'text-error-600' : d <= 7 ? 'text-primary-600' : 'text-slate-400'}`}>
                        {relativeArrival(g.eta)}
                      </p>
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
                      onClick={() => setSelectedKey(i.key)}
                      className={`transition-colors cursor-pointer ${selectedKey === i.key ? 'bg-primary-50/60' : 'hover:bg-slate-50'}`}
                    >
                      <td className="px-5 py-4">
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
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span className="block font-semibold text-slate-700">{formatDate(i.nextEta)}</span>
                        <span className={`block text-[11px] font-bold ${overdue ? 'text-error-600' : 'text-slate-400'}`}>
                          {relativeArrival(i.nextEta)}
                          {i.shipmentCount > 1 && <span className="font-medium text-slate-400"> · +{i.shipmentCount - 1} more</span>}
                        </span>
                      </td>
                      <td className="px-5 py-4"><StatusChip status={i.status} /></td>
                      <td className="px-5 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          disabled={i.remaining === 0}
                          onClick={() => setReserveFor(i.key)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold
                                     text-slate-600 border border-slate-200 bg-white hover:bg-primary-50
                                     hover:text-primary-700 hover:border-primary-300 transition-colors
                                     disabled:opacity-40 disabled:pointer-events-none"
                        >
                          <BookmarkPlus size={13} />
                          Reserve
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {pageRows.length === 0 && (
                  <tr>
                    <td colSpan={colCount} className="px-6 py-12 text-center">
                      <p className="text-slate-600 font-semibold">No SKUs match these filters</p>
                      <p className="text-slate-500 text-xs mt-1">Clear a filter, or import an upcoming stock file to add shipments.</p>
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
          <strong>Demo data.</strong> Upcoming stock, reservations and imports on this screen are held in this browser
          tab only. They do not change Inventory Master, Inventory Health or the stock ledger.
          {lastImport && (
            <> Last import: <span className="font-semibold">{lastImport.fileName}</span> · {formatDateTime(lastImport.importedAt)}.</>
          )}
        </p>
        <Button
          size="xs" variant="secondary"
          onClick={() => { resetDemo(); resetFilters(); setSelectedKey(null); toast.success('Demo data restored.'); }}
        >
          <RotateCcw size={12} className="mr-1.5" />Reset demo data
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
              onClose={() => setSelectedKey(null)}
              onReserve={(key) => setReserveFor(key)}
              onRelease={handleRelease(selected)}
            />
          </>
        )}
      </AnimatePresence>

      <ImportUpcomingModal open={importOpen} onClose={() => setImportOpen(false)} />

      <ReserveUpcomingModal
        open={reserveFor !== undefined}
        items={items}
        initialKey={reserveFor || ''}
        userName={user?.user || user?.name}
        onClose={() => setReserveFor(undefined)}
      />
    </div>
  );
};

export default UpcomingStock;
