import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  RotateCcw, Boxes, PackageX, AlertTriangle, TrendingDown,
  CheckCircle2, Clock, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from 'recharts';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { SkeletonLoader } from '../../components/ui/SkeletonLoader';
import { PageHeader } from '../../components/common/PageHeader';
import { useDashboardStore } from '../../store/dashboardStore';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { hasPermission, canUseInventoryMaster, PERMISSIONS } from '../../utils/permissions';
import { formatAvailablePercent, bandLabel } from '../../utils/inventoryFormat';

/**
 * Inventory Dashboard — IMS Module M5.
 *
 * A PRESENTATION LAYER. Every number rendered here arrives already computed by
 * the Balance Engine (M3) or the Health Engine (M4). This file contains no
 * threshold, no formula and no classification — if it did, the dashboard would
 * eventually disagree with the Health screen, and there would be no way to say
 * which was right.
 *
 * Band colours match the Health screen exactly, and status is conveyed by
 * colour AND label — red/green alone fails the most common colour-vision
 * deficiency, and this is a screen people scan quickly.
 */

const BAND_COLOURS = {
  'Out of Stock': '#b91c1c',
  Critical: '#ef4444',
  Low: '#f59e0b',
  Healthy: '#22c55e',
  // The workbook's own 'Greater then 100%' fill, so the ERP and the sheet
  // read the same. It was blue here, which said nothing about the source.
  Overstock: '#c48aa6',
  Unknown: '#cbd5e1',
};

const REASON_LABELS = {
  NO_BALANCE: 'No stock movement yet',
  NO_CONSUMPTION: 'No daily consumption',
  NO_LEAD_TIME: 'No lead time',
  NO_SAFETY_FACTOR: 'No safety factor',
  NOT_ACTIVE: 'SKU not active',
};

const nf = (n) => (n === null || n === undefined ? '—' : n.toLocaleString());

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

/** KPI tile. Clicking navigates into the Health screen pre-filtered. */
const Kpi = ({ label, value, sub, icon: Icon, tone = 'slate', onClick }) => {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    red: 'bg-error-50 text-error-600',
    amber: 'bg-warning-50 text-warning-600',
    green: 'bg-success-50 text-success-600',
    blue: 'bg-primary-50 text-primary-600',
  };
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      onClick={onClick}
      className={`text-left w-full ${onClick ? 'hover:shadow-md hover:-translate-y-0.5 transition-all' : ''}`}
    >
      <Card className="h-full">
        <CardContent className="p-4 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${tones[tone]}`}>
            <Icon size={19} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider truncate">{label}</p>
            <p className="text-xl font-black text-slate-900 tabular-nums leading-tight">{value}</p>
            {sub && <p className="text-[11px] text-slate-400 font-medium truncate">{sub}</p>}
          </div>
        </CardContent>
      </Card>
    </Wrapper>
  );
};

const Panel = ({ title, subtitle, children, action }) => (
  <Card className="h-full">
    <CardContent className="p-5 flex flex-col gap-4 h-full">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          {subtitle && <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </CardContent>
  </Card>
);

const EmptyPanel = ({ children }) => (
  <div className="flex-1 flex items-center justify-center py-8 text-center">
    <p className="text-xs text-slate-500 max-w-xs leading-relaxed">{children}</p>
  </div>
);

const DashboardSkeleton = () => (
  <div className="flex flex-col gap-6">
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4">
      {Array.from({ length: 7 }).map((_, i) => (
        <Card key={i}><CardContent className="p-4 h-[76px]"><SkeletonLoader variant="text" className="w-2/3" /><SkeletonLoader variant="text" className="w-1/2 mt-2" /></CardContent></Card>
      ))}
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}><CardContent className="p-5 h-64"><SkeletonLoader variant="text" className="w-1/3" /></CardContent></Card>
      ))}
    </div>
  </div>
);

export const InventoryDashboard = () => {
  const navigate = useNavigate();
  const { user } = useUserStore();
  const {
    data, loading, error, cached, filters, categories,
    setFilters, resetFilters, fetchDashboard, fetchCategories,
  } = useDashboardStore();

  useEffect(() => {
    fetchDashboard();
    fetchCategories();
  }, [fetchDashboard, fetchCategories]);

  if (user && !(hasPermission(user, PERMISSIONS.VIEW_INVENTORY) && canUseInventoryMaster(user))) {
    return <Navigate to="/" replace />;
  }

  const brands = allowedBrands(user);
  const toHealth = (band) =>
    navigate(`/inventory/health${band ? `?band=${encodeURIComponent(band)}` : ''}`);

  const k = data?.kpis;
  const s = data?.summary;
  const hasHealth = (k?.projectedSkus ?? 0) > 0;

  const bandSlices = (data?.healthDistribution?.byCount ?? [])
    .filter((d) => d.count > 0)
    .map((d) => ({ ...d, label: bandLabel(d.band) }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory Dashboard"
        actions={
          <div className="flex items-center gap-2">
            {data && (
              <span className="text-[11px] text-slate-400 font-medium hidden sm:inline">
                as at {new Date(data.asAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                {cached && ' · cached'}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={resetFilters}>
              <RotateCcw size={15} className="mr-2" />Reset
            </Button>
          </div>
        }
      />

      {/* Filters. Stock is not split by storage location in this portal, so
          there is no location control here or anywhere else in Inventory. */}
      <Card>
        <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Category</label>
            <select value={filters.category} onChange={(e) => setFilters({ category: e.target.value })} className={inputCls}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Activity from</label>
            <input type="date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })} className={inputCls} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Activity to</label>
            <input type="date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })} className={inputCls} />
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-error-50 border border-error-200 text-sm text-error-700 font-medium">
          {error}
        </div>
      )}

      {data?.filters?.categoryTruncated && (
        <div className="px-4 py-3 rounded-lg bg-warning-50 border border-warning-200 text-xs text-warning-800">
          This category covers too many SKUs to filter efficiently, so the figures below are unfiltered by category.
        </div>
      )}

      {loading && !data ? <DashboardSkeleton /> : data && (
        <>
          {/* ── KPI cards ─────────────────────────────────────────────── */}
          {/* Overstock and Unknown are deliberately not surfaced as KPI tiles.
              Both bands are still computed, still filterable on the Health
              screen and still exported — only the headline tile is gone. */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            <Kpi label="Total SKUs" value={nf(k.totalSkus)} sub={`${nf(k.projectedSkus)} classified`} icon={Boxes} />
            <Kpi label="Out of Stock" value={nf(k.outOfStock)} icon={PackageX} tone="red" onClick={() => toHealth('Out of Stock')} />
            <Kpi label="Critical" value={nf(k.critical)} icon={AlertTriangle} tone="red" onClick={() => toHealth('Critical')} />
            <Kpi label="Low" value={nf(k.low)} icon={TrendingDown} tone="amber" onClick={() => toHealth('Low')} />
            <Kpi label="Healthy" value={nf(k.healthy)} icon={CheckCircle2} tone="green" onClick={() => toHealth('Healthy')} />
          </div>

          {/* ── Inventory summary — Balance projection only ────────────── */}
          <Panel
            title="Inventory Summary"
            subtitle={
              'Summed from the balance projection'
            }
          >
            <div className="grid grid-cols-3 gap-3">
              {[
                ['On Hand', s.onHand, 'text-slate-900'],
                ['Reserved', s.reserved, 'text-slate-600'],
                ['Available', s.available, 'text-primary-700'],
              ].map(([label, value, tone]) => (
                <div key={label} className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
                  <span className={`block text-lg font-black tabular-nums ${tone}`}>{nf(value)}</span>
                </div>
              ))}
            </div>
          </Panel>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* ── Health distribution ─────────────────────────────────── */}
            <Panel title="Health Distribution" subtitle="SKU count per band, from the health projection">
              {!hasHealth ? (
                <EmptyPanel>
                  No SKUs have been classified yet. Build the health projection to populate this.
                </EmptyPanel>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      {/* `label` carries the display name so the legend and
                          tooltip read it; `band` is kept for the colour lookup
                          and stays the server's own value. */}
                      <Pie
                        data={bandSlices}
                        dataKey="count" nameKey="label" innerRadius={55} outerRadius={85} paddingAngle={2}
                      >
                        {bandSlices.map((d) => (
                          <Cell key={d.band} fill={BAND_COLOURS[d.band]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v, n) => [`${v.toLocaleString()} SKUs`, n]} />
                      <Legend verticalAlign="bottom" height={36} iconType="circle" iconSize={8} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Panel>

            {/* ── Coverage distribution — precomputed coverageDays ─────── */}
            <Panel title="Coverage Distribution" subtitle="Days of stock cover, grouped from precomputed values">
              {!data.coverageDistribution.length ? (
                <EmptyPanel>
                  Coverage needs a daily consumption figure and a lead time. No SKU has both yet.
                </EmptyPanel>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.coverageDistribution} margin={{ top: 5, right: 5, bottom: 5, left: -20 }}>
                      <XAxis dataKey="bucket" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip formatter={(v) => [`${v.toLocaleString()} SKUs`, 'Count']} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]} fill="#0d6b70" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Panel>
          </div>

          {/* ── Planning completion ───────────────────────────────────── */}
          <Panel
            title="Planning Completion"
            subtitle="Share of classified SKUs that have the inputs a stock target needs"
            action={
              <span className="text-2xl font-black text-slate-900 tabular-nums">
                {k.planningCompletionPercent === null ? '—' : `${k.planningCompletionPercent}%`}
              </span>
            }
          >
            <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-success-500 transition-all"
                style={{ width: `${k.planningCompletionPercent ?? 0}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
              <span><strong className="text-slate-900">{nf(data.planning.plannable)}</strong> ready to plan</span>
              <span><strong className="text-slate-900">{nf(data.planning.unplannable)}</strong> missing data</span>
            </div>
            {data.planning.gaps.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-1">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">What is missing</p>
                {data.planning.gaps.map((g) => (
                  <div key={g.reason} className="flex items-center justify-between text-xs">
                    <span className="text-slate-600">{REASON_LABELS[g.reason] || g.reason}</span>
                    <span className="font-bold text-slate-800 tabular-nums">{nf(g.count)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* ── Top critical ─────────────────────────────────────────── */}
            <Panel
              title="Most Critical Items"
              subtitle="Lowest cover against target, from the health projection"
              action={<Button size="sm" variant="ghost" onClick={() => toHealth('Critical')}>View all</Button>}
            >
              {!data.topCritical.length ? (
                <EmptyPanel>Nothing is below its reorder level right now.</EmptyPanel>
              ) : (
                <div className="overflow-x-auto -mx-5 px-5">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200">
                      <tr>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px]">SKU</th>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px] text-right">On Hand</th>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px] text-right">Target</th>
                        <th className="py-2 font-bold text-slate-500 uppercase text-[10px] text-right">Avail %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.topCritical.map((r) => (
                        <tr key={`${r.brand}-${r.skuCode}`}>
                          <td className="py-2 pr-3">
                            <span className="font-bold text-slate-800">{r.skuCode}</span>
                            <span className="ml-2 inline-block w-2 h-2 rounded-full align-middle" style={{ background: BAND_COLOURS[r.band] }} title={bandLabel(r.band)} />
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-slate-700">{nf(r.onHand)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{r.maxLevel === null ? '—' : Math.round(r.maxLevel).toLocaleString()}</td>
                          <td className="py-2 text-right tabular-nums font-bold text-error-600">
                            {formatAvailablePercent(r.replenishmentPercent)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {/* ── Overstock ────────────────────────────────────────────── */}
            <Panel
              title="Most Overstocked Items"
              subtitle="Furthest above target — capital tied up, not a shortage"
              action={<Button size="sm" variant="ghost" onClick={() => toHealth('Overstock')}>View all</Button>}
            >
              {!data.topOverstock.length ? (
                <EmptyPanel>Nothing is above its stock target.</EmptyPanel>
              ) : (
                <div className="overflow-x-auto -mx-5 px-5">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200">
                      <tr>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px]">SKU</th>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px] text-right">On Hand</th>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px] text-right">Target</th>
                        <th className="py-2 font-bold text-slate-500 uppercase text-[10px] text-right">Avail %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.topOverstock.map((r) => (
                        <tr key={`${r.brand}-${r.skuCode}`}>
                          <td className="py-2 pr-3 font-bold text-slate-800">{r.skuCode}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-slate-700">{nf(r.onHand)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{r.maxLevel === null ? '—' : Math.round(r.maxLevel).toLocaleString()}</td>
                          <td className="py-2 text-right tabular-nums font-bold text-primary-600">
                            {formatAvailablePercent(r.replenishmentPercent, { decimals: 0 })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          {/* ── Recent activity — Stock Ledger only ───────────────────── */}
          <Panel
            title="Recent Stock Activity"
            subtitle="Straight from the stock ledger — nothing is inferred"
            action={
              hasPermission(user, PERMISSIONS.VIEW_STOCK_LEDGER) && (
                <Button size="sm" variant="ghost" onClick={() => navigate('/inventory/ledger')}>Open ledger</Button>
              )
            }
          >
            {!data.activity.movements.length ? (
              <EmptyPanel>
                {data.activity.totalMovements === 0
                  ? 'The ledger has no movements yet. Stock activity appears here as it is posted.'
                  : 'No movements in the selected date range.'}
              </EmptyPanel>
            ) : (
              <>
                <div className="overflow-x-auto -mx-5 px-5">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200">
                      <tr>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px]">When</th>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px]">SKU</th>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px]">Type</th>
                        <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px] text-right">Qty</th>
                        <th className="py-2 font-bold text-slate-500 uppercase text-[10px]">Reference</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.activity.movements.map((m) => (
                        <tr key={m.transactionId}>
                          <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">
                            {new Date(m.effectiveDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                          </td>
                          <td className="py-2 pr-3 font-bold text-slate-800">{m.skuCode}</td>
                          <td className="py-2 pr-3 text-slate-600">{m.movementType}</td>
                          <td className={`py-2 pr-3 text-right tabular-nums font-bold ${m.quantity > 0 ? 'text-success-700' : 'text-error-600'}`}>
                            <span className="inline-flex items-center gap-0.5">
                              {m.quantity > 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                              {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                            </span>
                          </td>
                          <td className="py-2 text-slate-500 truncate max-w-32">{m.referenceId || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* The data window, so a thin feed explains itself rather than
                    looking like a fault. */}
                <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                  <Clock size={11} />
                  {nf(data.activity.totalMovements)} movements recorded
                  {data.activity.earliestMovement &&
                    ` since ${new Date(data.activity.earliestMovement).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                </p>
              </>
            )}
          </Panel>

          {data.freshness.healthComputedOldest && (
            <p className="text-[11px] text-slate-400 text-center">
              Health last computed between{' '}
              {new Date(data.freshness.healthComputedOldest).toLocaleString('en-IN')} and{' '}
              {new Date(data.freshness.healthComputedNewest).toLocaleString('en-IN')}.
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default InventoryDashboard;
