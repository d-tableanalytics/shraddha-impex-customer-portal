import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  FileBarChart, Camera, GitCompareArrows, RotateCcw,
  ArrowUpRight, ArrowDownRight, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Pagination } from '../../components/ui/Pagination';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { PageHeader } from '../../components/common/PageHeader';
import { useReportStore } from '../../store/reportStore';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { hasPermission, canUseInventoryMaster, canConfigureInventory, PERMISSIONS } from '../../utils/permissions';
import { formatAvailablePercent, bandLabel } from '../../utils/inventoryFormat';

/**
 * Inventory Reports — IMS Module M6.
 *
 * A presentation shell over the report APIs. It renders what the server
 * aggregated and computes nothing: no totals, no percentages, no bands, no
 * comparisons. Every figure on screen came from a projection.
 */

const REPORTS = [
  { key: 'inventory-summary', label: 'Inventory Summary', blurb: 'Current position by brand and location' },
  { key: 'balances', label: 'Stock Balances', blurb: 'On hand, reserved and available per SKU' },
  { key: 'health', label: 'Stock Health', blurb: 'Bands, coverage and planning gaps' },
  { key: 'movements', label: 'Stock Movements', blurb: 'Ledger history over a date range' },
  { key: 'aging', label: 'Inventory Aging', blurb: 'Time since stock was last issued' },
];

const BAND_DOT = {
  'Out of Stock': 'bg-error-600', Critical: 'bg-error-500', Low: 'bg-warning-500',
  Healthy: 'bg-success-500', Overstock: 'bg-[#c48aa6]', Unknown: 'bg-slate-300',
};

const REASON_LABELS = {
  NO_BALANCE: 'No stock movement yet', NO_CONSUMPTION: 'No daily consumption',
  NO_LEAD_TIME: 'No lead time', NO_SAFETY_FACTOR: 'No safety factor', NOT_ACTIVE: 'SKU not active',
};

const nf = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const rnd = (n, dp = 1) => (n === null || n === undefined ? '—' : (Math.round(n * 10 ** dp) / 10 ** dp).toLocaleString());
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

const Field = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">{label}</label>
    {children}
  </div>
);

const Stat = ({ label, value, tone = 'text-slate-900' }) => (
  <div className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
    <span className={`block text-lg font-black tabular-nums ${tone}`}>{value}</span>
  </div>
);

const Th = ({ children, right }) => (
  <th className={`px-4 py-3 font-bold text-slate-600 uppercase text-[10px] ${right ? 'text-right' : ''}`}>{children}</th>
);
const Td = ({ children, right, bold }) => (
  <td className={`px-4 py-3 ${right ? 'text-right tabular-nums' : ''} ${bold ? 'font-bold text-slate-900' : 'text-slate-600'}`}>{children}</td>
);

const Empty = ({ children }) => (
  <div className="py-12 text-center">
    <p className="text-sm text-slate-600 font-semibold">Nothing to show</p>
    <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">{children}</p>
  </div>
);

export const InventoryReports = () => {
  const { user } = useUserStore();
  const {
    reportKey, data, loading, error, filters,
    setReport, setFilters, resetFilters, fetchReport,
    snapshots, fetchSnapshots, createSnapshot, generating,
    comparison, comparing, compareFrom, compareTo, setCompare, runComparison,
  } = useReportStore();

  const [tab, setTab] = useState('reports');
  const [snapModal, setSnapModal] = useState(false);
  const [snapForm, setSnapForm] = useState({ snapshotDate: '', brand: '', frequency: 'adhoc', rebuild: false });

  useEffect(() => { fetchReport(); }, [fetchReport]);
  useEffect(() => { fetchSnapshots(); }, [fetchSnapshots]);

  if (user && !(hasPermission(user, PERMISSIONS.VIEW_INVENTORY) && canUseInventoryMaster(user))) {
    return <Navigate to="/" replace />;
  }

  const brands = allowedBrands(user);
  const canSnapshot = canConfigureInventory(user);

  const handleGenerate = async () => {
    const res = await createSnapshot({
      snapshotDate: snapForm.snapshotDate || null,
      brand: snapForm.brand || null,
      frequency: snapForm.frequency,
      rebuild: snapForm.rebuild,
    });
    if (res.success) {
      toast.success(`Snapshot ${res.result.runId} captured — ${nf(res.result.rowCount)} rows.`);
      setSnapModal(false);
      setSnapForm({ snapshotDate: '', brand: '', frequency: 'adhoc', rebuild: false });
    } else if (res.code === 'SNAPSHOT_EXISTS') {
      // Recoverable: offer the rebuild rather than making the user guess.
      toast.error(`${res.error} Tick "rebuild" to replace it.`);
      setSnapForm((f) => ({ ...f, rebuild: true }));
    } else {
      toast.error(res.error);
    }
  };

  const handleCompare = async () => {
    const res = await runComparison();
    if (!res.success) toast.error(res.error);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory Reports"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={resetFilters}>
              <RotateCcw size={15} className="mr-2" />Reset
            </Button>
            {canSnapshot && (
              <Button size="sm" onClick={() => setSnapModal(true)}>
                <Camera size={15} className="mr-2" />Take Snapshot
              </Button>
            )}
          </div>
        }
      />

      <div className="flex gap-2 border-b border-slate-200">
        {[
          { id: 'reports', label: 'Reports', icon: FileBarChart },
          { id: 'snapshots', label: 'Snapshots', icon: Camera },
          { id: 'compare', label: 'Compare', icon: GitCompareArrows },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-bold border-b-2 -mb-px transition-colors ${
              tab === t.id ? 'border-primary-600 text-primary-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <t.icon size={15} />{t.label}
          </button>
        ))}
      </div>

      {/* ══════════════════ REPORTS ══════════════════ */}
      {tab === 'reports' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {REPORTS.map((r) => (
              <button
                key={r.key}
                onClick={() => setReport(r.key)}
                className={`text-left p-3 rounded-lg border transition-all ${
                  reportKey === r.key
                    ? 'border-primary-400 bg-primary-50/50 shadow-sm'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <span className="block text-sm font-bold text-slate-800">{r.label}</span>
                <span className="block text-[11px] text-slate-500 mt-0.5 leading-snug">{r.blurb}</span>
              </button>
            ))}
          </div>

          <Card>
            <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              {brands.length > 1 && (
                <Field label="Brand">
                  <select value={filters.brand} onChange={(e) => setFilters({ brand: e.target.value })} className={inputCls}>
                    <option value="">All brands</option>
                    {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </Field>
              )}

              {['balances', 'movements'].includes(reportKey) && (
                <Field label="SKU">
                  <input value={filters.skuCode} onChange={(e) => setFilters({ skuCode: e.target.value })} placeholder="Exact SKU" className={inputCls} />
                </Field>
              )}

              {reportKey === 'health' && (
                <Field label="Band">
                  <select value={filters.band} onChange={(e) => setFilters({ band: e.target.value })} className={inputCls}>
                    <option value="">All bands</option>
                    {Object.keys(BAND_DOT).map((b) => <option key={b} value={b}>{bandLabel(b)}</option>)}
                  </select>
                </Field>
              )}

              {reportKey === 'movements' && (
                <>
                  <Field label="From">
                    <input type="date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })} className={inputCls} />
                  </Field>
                  <Field label="To">
                    <input type="date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })} className={inputCls} />
                  </Field>
                </>
              )}
            </CardContent>
          </Card>

          {error && (
            <div className="px-4 py-3 rounded-lg bg-error-50 border border-error-200 text-sm text-error-700 font-medium">
              {error}
            </div>
          )}

          {data?.categoryTruncated && (
            <div className="px-4 py-3 rounded-lg bg-warning-50 border border-warning-200 text-xs text-warning-800">
              This category covers too many SKUs to filter efficiently — results are unfiltered by category.
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              {loading && !data ? (
                <table className="w-full text-sm"><tbody><TableSkeleton rows={8} columns={6} cellClass="px-4 py-3" /></tbody></table>
              ) : !data ? (
                <Empty>Choose a report to run.</Empty>
              ) : (
                <>
                  {/* ── Inventory Summary ────────────────────────────── */}
                  {reportKey === 'inventory-summary' && (
                    <div className="p-5 flex flex-col gap-5">
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <Stat label="SKUs in catalogue" value={nf(data.catalogueSkus)} />
                        <Stat label="On Hand" value={nf(data.totals?.onHand)} />
                        <Stat label="Reserved" value={nf(data.totals?.reserved)} />
                        <Stat label="Available" value={nf(data.totals?.available)} tone="text-primary-700" />
                        <Stat label="Locations" value={nf(data.byLocation?.length)} />
                      </div>

                      <div>
                        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">By brand</h4>
                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                          <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 border-b border-slate-200">
                              <tr><Th>Brand</Th><Th right>SKUs</Th><Th right>On Hand</Th><Th right>Reserved</Th><Th right>Available</Th></tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {data.byBrand?.map((r) => (
                                <tr key={r.brand}>
                                  <Td bold>{r.brand}</Td>
                                  <Td right>{nf(r.skuCount)}</Td>
                                  <Td right>{nf(r.onHand)}</Td>
                                  <Td right>{nf(r.reserved)}</Td>
                                  <Td right>{nf(r.available)}</Td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div>
                        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">By location</h4>
                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                          <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 border-b border-slate-200">
                              <tr><Th>Location</Th><Th>Brand</Th><Th right>SKUs</Th><Th right>On Hand</Th><Th right>Available</Th></tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {data.byLocation?.map((r) => (
                                <tr key={`${r.locationCode}-${r.brand}`}>
                                  <Td bold>{r.locationCode || '—'}</Td>
                                  <Td>{r.brand}</Td>
                                  <Td right>{nf(r.skuCount)}</Td>
                                  <Td right>{nf(r.onHand)}</Td>
                                  <Td right>{nf(r.available)}</Td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Aging ────────────────────────────────────────── */}
                  {reportKey === 'aging' && (
                    <div className="p-5 flex flex-col gap-5">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <Stat label="Dead stock SKUs" value={nf(data.deadStock?.count)} tone="text-error-600" />
                        <Stat label="Dead stock units" value={nf(data.deadStock?.onHand)} tone="text-error-600" />
                        <Stat label="Threshold" value={`${nf(data.deadStockDays)}d`} />
                        <Stat label="Rows" value={nf(data.pagination?.total)} />
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Aged on <strong>last issued</strong>, not last movement — a SKU repeatedly reserved
                        and released by expiring bookings never physically left the shelf.
                        The {nf(data.deadStockDays)}-day threshold comes from inventory configuration.
                      </p>
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                        {data.buckets?.map((b) => (
                          <div key={b.bucket} className="p-3 rounded-lg border border-slate-200">
                            <span className="block text-[10px] font-bold text-slate-400 uppercase">{b.bucket}</span>
                            <span className="block text-base font-black text-slate-800 tabular-nums">{nf(b.count)}</span>
                            <span className="block text-[10px] text-slate-400">{nf(b.onHand)} units</span>
                          </div>
                        ))}
                      </div>
                      <div className="overflow-x-auto border border-slate-200 rounded-lg">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-slate-50 border-b border-slate-200">
                            <tr><Th>SKU</Th><Th>Location</Th><Th right>On Hand</Th><Th right>Days since issue</Th><Th>Last issued</Th></tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {data.rows?.map((r) => (
                              <tr key={`${r.skuCode}-${r.locationCode}`}>
                                <Td bold>{r.skuCode}</Td>
                                <Td>{r.locationCode || '—'}</Td>
                                <Td right>{nf(r.onHand)}</Td>
                                <Td right>{r.daysSinceIssue === null ? 'never' : nf(r.daysSinceIssue)}</Td>
                                <Td>{fmtDate(r.lastIssuedAt)}</Td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ── Balances / Health / Movements ────────────────── */}
                  {['balances', 'health', 'movements'].includes(reportKey) && (
                    <>
                      {reportKey === 'health' && data.summary?.planningGaps?.length > 0 && (
                        <div className="p-5 pb-0 flex flex-wrap gap-2">
                          {data.summary.planningGaps.map((g) => (
                            <span key={g.reason} className="px-2.5 py-1 rounded-md bg-slate-100 text-[11px] font-semibold text-slate-600">
                              {REASON_LABELS[g.reason] || g.reason}: {nf(g.count)}
                            </span>
                          ))}
                        </div>
                      )}
                      {reportKey === 'movements' && data.summary?.byType?.length > 0 && (
                        <div className="p-5 pb-0 flex flex-wrap gap-2">
                          {data.summary.byType.map((t) => (
                            <span key={t.movementType} className="px-2.5 py-1 rounded-md bg-slate-100 text-[11px] font-semibold text-slate-600">
                              {t.movementType}: {nf(t.count)} ({t.net > 0 ? '+' : ''}{nf(t.net)})
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-slate-50 border-b border-slate-200">
                            <tr>
                              {reportKey === 'balances' && <><Th>SKU</Th><Th>Location</Th><Th right>On Hand</Th><Th right>Reserved</Th><Th right>Available</Th><Th>Last movement</Th></>}
                              {reportKey === 'health' && <><Th>SKU</Th><Th>Band</Th><Th right>On Hand</Th><Th right>Max Level</Th><Th right>Available %</Th><Th right>Cover</Th></>}
                              {reportKey === 'movements' && <><Th>Date</Th><Th>Txn</Th><Th>SKU</Th><Th>Type</Th><Th right>Qty</Th><Th>Reference</Th></>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {data.rows?.map((r, i) => (
                              <tr key={r.transactionId || `${r.skuCode}-${r.locationCode || i}`} className="hover:bg-slate-50">
                                {reportKey === 'balances' && (<>
                                  <Td bold>{r.skuCode}</Td><Td>{r.locationCode || '—'}</Td>
                                  <Td right>{nf(r.onHand)}</Td><Td right>{nf(r.reserved)}</Td>
                                  <Td right>{nf(r.available)}</Td><Td>{fmtDate(r.lastMovementAt)}</Td>
                                </>)}
                                {reportKey === 'health' && (<>
                                  <Td bold>{r.skuCode}</Td>
                                  <Td><span className="inline-flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${BAND_DOT[r.band] || 'bg-slate-300'}`} />{bandLabel(r.band)}</span></Td>
                                  <Td right>{nf(r.onHand)}</Td><Td right>{rnd(r.maxLevel, 0)}</Td>
                                  <Td right>{formatAvailablePercent(r.replenishmentPercent)}</Td>
                                  <Td right>{r.coverageDays === null ? '—' : `${rnd(r.coverageDays)}d`}</Td>
                                </>)}
                                {reportKey === 'movements' && (<>
                                  <Td>{fmtDate(r.effectiveDate)}</Td>
                                  <Td><span className="font-mono text-[11px]">{r.transactionId}</span></Td>
                                  <Td bold>{r.skuCode}</Td><Td>{r.movementType}</Td>
                                  <Td right><span className={`inline-flex items-center gap-0.5 font-bold ${r.quantity > 0 ? 'text-success-700' : 'text-error-600'}`}>
                                    {r.quantity > 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                                    {r.quantity > 0 ? `+${r.quantity}` : r.quantity}
                                  </span></Td>
                                  <Td>{r.referenceId || '—'}</Td>
                                </>)}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {!data.rows?.length && (
                        <Empty>
                          {reportKey === 'movements'
                            ? 'No movements in this range. The ledger fills as stock workflows post to it.'
                            : 'No rows match these filters.'}
                        </Empty>
                      )}

                      {data.pagination?.total > 0 && (
                        <div className="px-5 py-4 border-t border-slate-200 bg-slate-50/60">
                          <Pagination
                            page={filters.page} pageSize={filters.limit}
                            totalItems={data.pagination.total}
                            onPageChange={(page) => setFilters({ page })}
                          />
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ══════════════════ SNAPSHOTS ══════════════════ */}
      {tab === 'snapshots' && (
        <Card>
          <CardContent className="p-0">
            {!snapshots.length ? (
              <Empty>
                No snapshots yet. A snapshot freezes the current balance and health projections
                so historical positions can be compared later.
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <Th>Run</Th><Th>Date</Th><Th>Trigger</Th><Th>Scope</Th>
                      <Th right>Rows</Th><Th right>On Hand</Th><Th>Integrity</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {snapshots.map((s) => (
                      <tr key={s.runId} className="hover:bg-slate-50">
                        <Td bold><span className="font-mono text-xs">{s.runId}</span></Td>
                        <Td>{fmtDate(s.snapshotDate)}</Td>
                        <Td>{s.trigger}{s.frequency !== 'adhoc' && ` · ${s.frequency}`}</Td>
                        <Td>{s.scopeBrand || 'All brands'}</Td>
                        <Td right>{nf(s.rowCount)}</Td>
                        <Td right>{nf(s.totals?.onHand)}</Td>
                        <Td>
                          {s.missingHealthCount > 0 ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-warning-700">
                              <AlertTriangle size={11} />{nf(s.missingHealthCount)} without health
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-success-700">
                              <CheckCircle2 size={11} />complete
                            </span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ══════════════════ COMPARE ══════════════════ */}
      {tab === 'compare' && (
        <>
          <Card>
            <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
              <Field label="From snapshot">
                <select value={compareFrom} onChange={(e) => setCompare({ compareFrom: e.target.value })} className={inputCls}>
                  <option value="">Choose…</option>
                  {snapshots.map((s) => <option key={s.runId} value={s.runId}>{s.runId} · {fmtDate(s.snapshotDate)}</option>)}
                </select>
              </Field>
              <Field label="To snapshot">
                <select value={compareTo} onChange={(e) => setCompare({ compareTo: e.target.value })} className={inputCls}>
                  <option value="">Choose…</option>
                  {snapshots.map((s) => <option key={s.runId} value={s.runId}>{s.runId} · {fmtDate(s.snapshotDate)}</option>)}
                </select>
              </Field>
              <Button onClick={handleCompare} loading={comparing} disabled={!compareFrom || !compareTo}>
                {!comparing && <GitCompareArrows size={15} className="mr-2" />}Compare
              </Button>
            </CardContent>
          </Card>

          {comparison && (
            <>
              <Card>
                <CardContent className="p-5 flex flex-col gap-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
                    <Stat label="Compared" value={nf(comparison.summary.compared)} />
                    <Stat label="Unchanged" value={nf(comparison.summary.unchanged)} />
                    <Stat label="Balance moved" value={nf(comparison.summary.balanceChanged)} />
                    <Stat label="Band changed" value={nf(comparison.summary.healthChanged)} />
                    <Stat label="Planning changed" value={nf(comparison.summary.planningChanged)} />
                    <Stat label="Net on hand" value={`${comparison.summary.netOnHand > 0 ? '+' : ''}${nf(comparison.summary.netOnHand)}`}
                      tone={comparison.summary.netOnHand >= 0 ? 'text-success-700' : 'text-error-600'} />
                    <Stat label="Net available" value={`${comparison.summary.netAvailable > 0 ? '+' : ''}${nf(comparison.summary.netAvailable)}`} />
                  </div>
                  <p className="text-[11px] text-slate-500">
                    {comparison.from.runId} ({fmtDate(comparison.from.snapshotDate)}) →{' '}
                    {comparison.to.runId} ({fmtDate(comparison.to.snapshotDate)})
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-0">
                  {!comparison.changes.length ? (
                    <Empty>Nothing changed between these two snapshots.</Empty>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-50 border-b border-slate-200">
                          <tr>
                            <Th>SKU</Th><Th>Status</Th><Th right>On Hand</Th>
                            <Th right>Available</Th><Th>Band</Th><Th right>Cover</Th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {comparison.changes.map((c) => (
                            <tr key={`${c.skuCode}-${c.locationCode}`} className="hover:bg-slate-50">
                              <Td bold>{c.skuCode}<span className="block text-[10px] text-slate-400">{c.locationCode}</span></Td>
                              <Td>{c.status}</Td>
                              <Td right>
                                {nf(c.onHand.from)} → {nf(c.onHand.to)}
                                {c.onHand.delta !== 0 && (
                                  <span className={`block text-[10px] font-bold ${c.onHand.delta > 0 ? 'text-success-700' : 'text-error-600'}`}>
                                    {c.onHand.delta > 0 ? '+' : ''}{nf(c.onHand.delta)}
                                  </span>
                                )}
                              </Td>
                              <Td right>{nf(c.available.from)} → {nf(c.available.to)}</Td>
                              <Td>
                                {c.band.changed ? (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-bold">
                                    <span className={`w-2 h-2 rounded-full ${BAND_DOT[c.band.from] || 'bg-slate-300'}`} />
                                    {c.band.from ? bandLabel(c.band.from) : '—'} →
                                    <span className={`w-2 h-2 rounded-full ${BAND_DOT[c.band.to] || 'bg-slate-300'}`} />
                                    {c.band.to ? bandLabel(c.band.to) : '—'}
                                  </span>
                                ) : <span className="text-slate-400 text-[11px]">{c.band.to ? bandLabel(c.band.to) : '—'}</span>}
                                {c.formulaVersion.from !== c.formulaVersion.to && (
                                  <span className="block text-[10px] text-warning-700 font-bold">
                                    formula {c.formulaVersion.from} → {c.formulaVersion.to}
                                  </span>
                                )}
                              </Td>
                              <Td right>{c.coverageDays.delta === null ? '—' : `${c.coverageDays.delta > 0 ? '+' : ''}${rnd(c.coverageDays.delta)}d`}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {comparison.truncated && (
                        <p className="px-5 py-3 text-[11px] text-slate-500 border-t border-slate-200">
                          Showing the first {comparison.changes.length} changes — narrow by brand to see the rest.
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}

      <Modal isOpen={snapModal} onClose={() => setSnapModal(false)} title="Take Inventory Snapshot">
        <div className="flex flex-col gap-4">
          <p className="text-xs text-slate-600 leading-relaxed">
            A snapshot copies the current balance and health projections into an immutable record.
            It calculates nothing — whatever the projections say right now is what gets frozen.
          </p>
          <Field label="Snapshot date">
            <input type="date" value={snapForm.snapshotDate}
              onChange={(e) => setSnapForm((f) => ({ ...f, snapshotDate: e.target.value }))}
              className={inputCls} />
          </Field>
          {brands.length > 1 && (
            <Field label="Brand (optional)">
              <select value={snapForm.brand} onChange={(e) => setSnapForm((f) => ({ ...f, brand: e.target.value }))} className={inputCls}>
                <option value="">All brands</option>
                {brands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
          )}
          <Field label="Frequency label">
            <select value={snapForm.frequency} onChange={(e) => setSnapForm((f) => ({ ...f, frequency: e.target.value }))} className={inputCls}>
              {['adhoc', 'daily', 'weekly', 'monthly'].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Field>
          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={snapForm.rebuild}
              onChange={(e) => setSnapForm((f) => ({ ...f, rebuild: e.target.checked }))}
              className="mt-0.5 w-4 h-4 text-primary-600 rounded border-slate-300 focus:ring-primary-500" />
            <span>
              <strong>Rebuild</strong> — replace an existing snapshot for this date. The old run is
              superseded, never edited, so its rows stay readable.
            </span>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setSnapModal(false)}>Cancel</Button>
            <Button size="sm" onClick={handleGenerate} loading={generating}>
              {!generating && <Camera size={15} className="mr-2" />}Take Snapshot
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default InventoryReports;
