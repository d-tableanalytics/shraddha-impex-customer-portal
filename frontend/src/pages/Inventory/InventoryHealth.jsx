import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Search, X, Loader2, RotateCcw, AlertCircle, HelpCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Pagination } from '../../components/ui/Pagination';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { PageHeader } from '../../components/common/PageHeader';
import { ExportButton } from '../../components/inventory/ExportButton';
import toast from 'react-hot-toast';

import { inventoryApi } from '../../services/inventory';
import { useHealthStore } from '../../store/healthStore';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { hasPermission, PERMISSIONS } from '../../utils/permissions';
import { formatAvailablePercent, exactPercent, bandLabel } from '../../utils/inventoryFormat';

/**
 * Inventory Health — IMS Module M4, blueprint screen.
 *
 * Displays the health projection. It performs NO business calculation: every
 * band, target and percentage arrives computed from the server, because a
 * classification duplicated client-side is a classification that will
 * eventually disagree with the server's.
 *
 * Status is conveyed by colour AND text AND a shape marker — red/green is the
 * most common colour-vision deficiency pairing, and this is a screen people
 * work in all day.
 */

/**
 * Band presentation, matching the source workbook's own legend fills: red
 * below 33%, yellow to 66%, green to 100%, and its dusty pink above that.
 * Overstock was blue here, which told the reader nothing about where the band
 * came from. The hues are toned from the workbook's pure FF0000/FFFF00/00FF00,
 * which are unreadable behind text at this size, but the mapping is identical.
 *
 * No Planning Data is deliberately neutral grey, never alarming red — a SKU
 * with missing inputs is a data gap, not a shortage.
 */
const BANDS = {
  'Out of Stock': { dot: 'bg-error-600', chip: 'bg-error-100 text-error-800', mark: '■' },
  Critical: { dot: 'bg-error-500', chip: 'bg-error-50 text-error-700', mark: '▲' },
  Low: { dot: 'bg-warning-500', chip: 'bg-warning-50 text-warning-700', mark: '◆' },
  Healthy: { dot: 'bg-success-500', chip: 'bg-success-50 text-success-700', mark: '●' },
  Overstock: { dot: 'bg-[#c48aa6]', chip: 'bg-[#f6e9ef] text-[#8a4d68]', mark: '◤' },
  Unknown: { dot: 'bg-slate-300', chip: 'bg-slate-100 text-slate-600', mark: '○' },
};

const BAND_ORDER = ['Out of Stock', 'Critical', 'Low', 'Healthy', 'Overstock', 'Unknown'];

const SORT_OPTIONS = [
  { value: 'percent-asc', label: 'Lowest cover first' },
  { value: 'percent-desc', label: 'Highest cover first' },
  { value: 'coverage-asc', label: 'Fewest days of cover' },
  { value: 'stock-desc', label: 'Most stock' },
  { value: 'stock-asc', label: 'Least stock' },
  { value: 'sku-asc', label: 'SKU (A–Z)' },
];

const REASON_LABELS = {
  NO_BALANCE: 'never had a stock movement',
  NO_CONSUMPTION: 'no daily consumption for the current season',
  NO_LEAD_TIME: 'lead time not set',
  NO_SAFETY_FACTOR: 'safety factor not set',
  NOT_ACTIVE: 'SKU is not active',
};

const BandChip = ({ band }) => {
  const s = BANDS[band] || BANDS.Unknown;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-bold ${s.chip}`}>
      <span aria-hidden="true">{s.mark}</span>
      {bandLabel(band)}
    </span>
  );
};

const num = (v, suffix = '') =>
  v === null || v === undefined ? <span className="text-slate-300">—</span> : `${v.toLocaleString()}${suffix}`;

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

/**
 * Detail drawer. Shows the arithmetic, not just the verdict — a health figure
 * nobody can explain is a health figure nobody trusts.
 */
const HealthPanel = ({ item, onClose }) => (
  <motion.aside
    initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
    transition={{ type: 'spring', stiffness: 320, damping: 34 }}
    className="fixed right-0 top-0 h-full w-full max-w-xl bg-white border-l border-slate-200 shadow-enterprise-lg z-50 flex flex-col"
  >
    <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{item.brand}</p>
        <h3 className="text-lg font-black text-slate-900 truncate">{item.skuCode}</h3>
        <div className="mt-1.5"><BandChip band={item.band} /></div>
      </div>
      <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0">
        <X size={18} />
      </button>
    </div>

    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
      {!item.plannable && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200">
          <HelpCircle size={16} className="text-slate-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold text-slate-700">No stock target can be calculated</p>
            <ul className="text-xs text-slate-600 mt-1 list-disc pl-4">
              {item.notPlannableReasons.map((r) => <li key={r}>{REASON_LABELS[r] || r}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div>
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Position</h4>
        <div className="grid grid-cols-3 gap-3">
          {[['On Hand', item.onHand], ['Reserved', item.reserved], ['Available', item.available]].map(([l, v]) => (
            <div key={l} className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
              <span className="text-[10px] font-bold text-slate-400 uppercase">{l}</span>
              <span className="block text-base font-black text-slate-800 tabular-nums">{v?.toLocaleString() ?? '—'}</span>
            </div>
          ))}
        </div>
      </div>

      {/* The derivation. This is what makes the band explicable. */}
      <div>
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">How this was calculated</h4>
        <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 font-mono text-[12px] leading-relaxed text-slate-700 overflow-x-auto">
          <div>Daily consumption ({item.inputs.currentSeason || 'Normal'}) = {item.inputs.dailyAvgConsumption}</div>
          <div>Lead time = {item.inputs.leadTime} days</div>
          <div>Safety factor = {item.inputs.safetyFactor}</div>
          <div className="mt-2 pt-2 border-t border-slate-200">
            Max Level = {item.maxLevel ?? '—'}
            <span className="text-slate-400"> ({item.formulaVersion})</span>
          </div>
          <div>Reorder Level = {item.reorderLevel ?? '—'}
            <span className="text-slate-400"> (Max × {item.thresholds?.critical}%)</span>
          </div>
          {item.safetyStock !== null && <div>Safety Stock = {item.safetyStock}</div>}
          <div className="mt-2 pt-2 border-t border-slate-200">
            {/* The one place the uncapped figure belongs: this panel exists to
                show the arithmetic, so capping it here would contradict the
                division printed beside it. */}
            Replenishment % = {item.onHand} ÷ {item.maxLevel ?? '—'} × 100 = <strong>{exactPercent(item.replenishmentPercent)}</strong>
          </div>
          <div>Coverage = {item.onHand} ÷ {item.inputs.dailyAvgConsumption} = {item.coverageDays ?? '—'} days</div>
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          Bands: ≤{item.thresholds?.critical}% critical · ≤{item.thresholds?.low}% low ·
          ≤{item.thresholds?.healthy}% healthy · above that, overstock.
          Config scope <span className="font-mono">{item.configScope}</span>.
        </p>
      </div>

      <div>
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Sales view</h4>
        <p className="text-sm text-slate-600">
          Sales coverage is <strong>{item.salesCoveragePercent ?? '—'}%</strong> — available stock against target,
          which is lower than replenishment cover whenever units are reserved.
          Banding deliberately uses on-hand, so a large booking does not trigger a purchase for
          stock already on the shelf.
        </p>
      </div>
    </div>
  </motion.aside>
);

export const InventoryHealth = () => {
  const { user } = useUserStore();
  const {
    items, total, bandCounts, loading, error, filters,
    setFilters, resetFilters, fetchHealth,
    selected, detailLoading, openItem, closeItem,
  } = useHealthStore();

  const [skuTerm, setSkuTerm] = useState('');

  // One fetch on mount, then one per settled term — the debounce skips its
  // first run so mounting costs a single request.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const timer = setTimeout(() => setFilters({ skuCode: skuTerm }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuTerm]);

  useEffect(() => { fetchHealth(); }, [fetchHealth]);

  if (user && !hasPermission(user, PERMISSIONS.VIEW_INVENTORY)) {
    return <Navigate to="/" replace />;
  }

  // Selection is held as SKU codes, not row indexes, so it survives a re-sort,
  // a filter change or a page turn — the identity of a row is its SKU.
  const [picked, setPicked] = useState(() => new Set());
  const [selectingAll, setSelectingAll] = useState(false);

  const togglePick = (skuCode) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(skuCode)) next.delete(skuCode); else next.add(skuCode);
    return next;
  });

  const pageSkus = items.map((h) => h.skuCode);
  const allOnPagePicked = pageSkus.length > 0 && pageSkus.every((sku) => picked.has(sku));

  // The header checkbox takes EVERY row matching the current filter, not just
  // the page — the filter is what the user has already said they mean.
  const toggleAllMatching = async () => {
    if (picked.size > 0) { setPicked(new Set()); return; }
    setSelectingAll(true);
    try {
      const { skuCodes } = await inventoryApi.listHealthCodes({
        skuCode: filters.skuCode, brand: filters.brand,
        band: filters.band, plannable: filters.plannable,
      });
      setPicked(new Set(skuCodes));
      if (skuCodes.length) toast.success(`${skuCodes.length.toLocaleString()} SKU(s) selected.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not select every matching SKU.');
    } finally {
      setSelectingAll(false);
    }
  };

  const brands = allowedBrands(user);
  const totalBanded = BAND_ORDER.reduce((s, b) => s + (bandCounts[b] || 0), 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory Health"
        actions={(
          <div className="flex items-center gap-2">
          <ExportButton
            exportType="stock-health"
            filters={{ brand: filters.brand, band: filters.band, plannable: filters.plannable }}
            selected={[...picked]}
          />
          <Button variant="outline" size="sm" onClick={() => { setSkuTerm(''); resetFilters(); }}>
            <RotateCcw size={15} className="mr-2" />
            Reset
          </Button>
          </div>
        )}
      />

      {/* Band distribution — the proportions are the insight, so one segmented
          bar rather than six separate tiles. Each segment filters the list. */}
      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100">
            {BAND_ORDER.map((b) => {
              const n = bandCounts[b] || 0;
              if (!n || !totalBanded) return null;
              return (
                <div
                  key={b}
                  className={BANDS[b].dot}
                  style={{ width: `${(n / totalBanded) * 100}%` }}
                  title={`${bandLabel(b)}: ${n}`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            {BAND_ORDER.map((b) => {
              const n = bandCounts[b] || 0;
              const active = filters.band === b;
              return (
                <button
                  key={b}
                  onClick={() => setFilters({ band: active ? '' : b })}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors ${
                    active ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${BANDS[b].dot}`} />
                  {bandLabel(b)}
                  <span className={active ? 'text-slate-300' : 'text-slate-400'}>{n.toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">SKU</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                type="text" value={skuTerm} onChange={(e) => setSkuTerm(e.target.value)}
                placeholder="Exact SKU code" className={`${inputCls} pl-9`}
              />
            </div>
          </div>

          {brands.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Brand</label>
              <select value={filters.brand} onChange={(e) => setFilters({ brand: e.target.value })} className={inputCls}>
                <option value="">All brands</option>
                {brands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Plannable</label>
            <select value={filters.plannable} onChange={(e) => setFilters({ plannable: e.target.value })} className={inputCls}>
              <option value="">All SKUs</option>
              <option value="true">Has planning data</option>
              <option value="false">Missing planning data</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Sort</label>
            <select value={filters.sort} onChange={(e) => setFilters({ sort: e.target.value })} className={inputCls}>
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-error-50 border border-error-200 text-sm text-error-700 font-medium">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {picked.size > 0 && (
              <div className="flex flex-wrap items-center gap-3 px-5 py-3 bg-primary-50 border-b border-primary-100">
                <span className="text-sm font-bold text-primary-900">
                  {picked.size.toLocaleString()} SKU{picked.size === 1 ? '' : 's'} selected
                </span>
                <span className="text-[11px] text-primary-700/70">
                  {picked.size > items.length
                    ? 'Everything matching the current filter, across all pages.'
                    : 'Selection is by SKU, so it survives sorting and paging.'}
                </span>
                <Button size="xs" variant="secondary" className="ml-auto" onClick={() => setPicked(new Set())}>
                  Clear
                </Button>
              </div>
            )}

            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="pl-5 pr-2 py-4 w-10">
                    <input
                      type="checkbox"
                      aria-label="Select every SKU matching the current filter"
                      className="w-4 h-4 accent-primary-600 cursor-pointer"
                      checked={picked.size > 0}
                      ref={(el) => { if (el) el.indeterminate = picked.size > 0 && !allOnPagePicked; }}
                      disabled={selectingAll}
                      onChange={toggleAllMatching}
                    />
                  </th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">SKU</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Status</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">On Hand</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Available</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Max Level</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Reorder</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Available %</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Cover</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && items.length === 0 && <TableSkeleton rows={10} columns={9} cellClass="px-5 py-4" />}

                {items.map((h) => (
                  <tr
                    key={`${h.brand}-${h.skuCode}`}
                    onClick={() => openItem(h.skuCode)}
                    className={`transition-colors cursor-pointer ${
                      picked.has(h.skuCode) ? 'bg-primary-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    {/* stopPropagation, or ticking a row also opens its drawer. */}
                    <td className="pl-5 pr-2 py-4" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${h.skuCode}`}
                        className="w-4 h-4 accent-primary-600 cursor-pointer"
                        checked={picked.has(h.skuCode)}
                        onChange={() => togglePick(h.skuCode)}
                      />
                    </td>
                    <td className="px-5 py-4">
                      <span className="font-bold text-slate-900">{h.skuCode}</span>
                      <span className="block text-[11px] text-slate-400 font-medium">{h.brand}</span>
                    </td>
                    <td className="px-5 py-4"><BandChip band={h.band} /></td>
                    <td className="px-5 py-4 text-right font-semibold text-slate-800 tabular-nums">{num(h.onHand)}</td>
                    <td className="px-5 py-4 text-right text-slate-600 tabular-nums">{num(h.available)}</td>
                    <td className="px-5 py-4 text-right text-slate-600 tabular-nums">{num(h.maxLevel)}</td>
                    <td className="px-5 py-4 text-right text-slate-600 tabular-nums">{num(h.reorderLevel)}</td>
                    <td
                      className="px-5 py-4 text-right font-bold text-slate-800 tabular-nums"
                      title={h.replenishmentPercent === null ? undefined : `Exactly ${exactPercent(h.replenishmentPercent)}`}
                    >
                      {h.replenishmentPercent === null
                        ? <span className="text-slate-300">—</span>
                        : formatAvailablePercent(h.replenishmentPercent)}
                    </td>
                    <td className="px-5 py-4 text-right text-slate-600 tabular-nums">
                      {h.coverageDays === null ? <span className="text-slate-300">—</span> : `${h.coverageDays}d`}
                    </td>
                  </tr>
                ))}

                {!loading && items.length === 0 && !error && (
                  <tr>
                    <td colSpan={9} className="px-6 py-12 text-center">
                      <p className="text-slate-600 font-semibold">No SKUs match these filters</p>
                      <p className="text-slate-500 text-xs mt-1 max-w-md mx-auto">
                        Health is projected from stock movements and planning parameters.
                        A SKU appears here once it has been projected.
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {total > 0 && (
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/60 rounded-b-xl">
              <Pagination
                page={filters.page} pageSize={filters.limit} totalItems={total}
                onPageChange={(page) => setFilters({ page })}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* The launch reality: most SKUs lack the inputs a target needs. Stated
          plainly rather than shown as a wall of grey rows with no explanation. */}
      {(bandCounts.Unknown || 0) > 0 && !filters.band && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-slate-50 border border-slate-200">
          <AlertCircle size={16} className="text-slate-500 shrink-0 mt-0.5" />
          <p className="text-xs text-slate-600 leading-relaxed">
            <strong>{(bandCounts.Unknown || 0).toLocaleString()} SKUs</strong> cannot be classified yet —
            they are missing a lead time or a daily consumption figure. Filter to
            “Missing planning data” to work through them.
          </p>
        </div>
      )}

      <AnimatePresence>
        {(selected || detailLoading) && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closeItem}
              className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40"
            />
            {selected ? (
              <HealthPanel item={selected} onClose={closeItem} />
            ) : (
              <motion.aside
                initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
                transition={{ type: 'spring', stiffness: 320, damping: 34 }}
                className="fixed right-0 top-0 h-full w-full max-w-xl bg-white border-l border-slate-200 shadow-enterprise-lg z-50 flex items-center justify-center"
              >
                <div className="flex flex-col items-center gap-3 text-slate-400">
                  <Loader2 className="animate-spin" size={28} />
                  <p className="text-sm font-semibold">Loading health…</p>
                </div>
              </motion.aside>
            )}
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

export default InventoryHealth;
