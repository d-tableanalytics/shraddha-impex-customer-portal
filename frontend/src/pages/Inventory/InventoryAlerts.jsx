import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  BellOff, Loader2, CheckCircle2, Eye, Archive, SlidersHorizontal,
  AlertTriangle, AlertOctagon, Info, X, Repeat,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { PageHeader } from '../../components/common/PageHeader';
import { useAlertStore } from '../../store/alertStore';
import { useUserStore } from '../../store/userStore';
import { allowedBrands } from '../../utils/brandAccess';
import { hasPermission, canUseInventoryMaster, PERMISSIONS } from '../../utils/permissions';
import { formatAvailablePercent } from '../../utils/inventoryFormat';

/**
 * Inventory Alerts — IMS Module M8.
 *
 * A presentation layer over conditions the server already decided. Nothing here
 * evaluates a threshold, computes a band or raises an alert — the numbers shown
 * beside each row are the projection values captured when it fired, and they are
 * deliberately NOT refreshed, so an alert still explains itself after the stock
 * has moved on.
 */

const SEVERITY = {
  Critical: { cls: 'bg-error-50 text-error-700 border-error-200', dot: 'bg-error-500', Icon: AlertOctagon },
  High: { cls: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500', Icon: AlertTriangle },
  Medium: { cls: 'bg-warning-50 text-warning-700 border-warning-200', dot: 'bg-warning-500', Icon: AlertTriangle },
  Low: { cls: 'bg-sky-50 text-sky-700 border-sky-200', dot: 'bg-sky-500', Icon: Info },
  Info: { cls: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400', Icon: Info },
};

const STATUS_STYLE = {
  Open: 'bg-error-50 text-error-700',
  Acknowledged: 'bg-warning-50 text-warning-700',
  Resolved: 'bg-success-50 text-success-700',
  Closed: 'bg-slate-100 text-slate-400',
};

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const CATEGORIES = ['Stock Health', 'Planning', 'Operations', 'Configuration'];
const STATUSES = ['Open', 'Acknowledged', 'Resolved', 'Closed'];
const DELIVERIES = ['immediate', 'digest', 'silent'];

const nf = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const fmtWhen = (d) => {
  if (!d) return '—';
  const then = new Date(d);
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return then.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none ' +
  'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

const SeverityBadge = ({ severity }) => {
  const s = SEVERITY[severity] || SEVERITY.Info;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-bold ${s.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {severity}
    </span>
  );
};

const Tile = ({ label, value, tone = 'text-slate-900', active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`text-left p-3 rounded-lg border transition-colors ${
      active ? 'border-primary-400 bg-primary-50/60' : 'border-slate-100 bg-slate-50/70 hover:bg-slate-100/70'
    }`}
  >
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
    <span className={`block text-lg font-black tabular-nums ${tone}`}>{value}</span>
  </button>
);

const Row = ({ label, children }) => (
  <div className="flex justify-between gap-4 py-1.5 border-b border-slate-100 last:border-0">
    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">{label}</span>
    <span className="text-sm text-slate-800 text-right">{children}</span>
  </div>
);

export const InventoryAlerts = () => {
  const { user } = useUserStore();
  const {
    alerts, counts, total, pages, loading, error, filters, setFilters, fetchAlerts,
    selected, detailLoading, openAlert, closeDetail,
    acting, act,
    rules, rulesLoading, savingRule, fetchRules, saveRule,
    clearError,
  } = useAlertStore();

  const [rulesOpen, setRulesOpen] = useState(false);
  const [resolveFor, setResolveFor] = useState(null);
  const [note, setNote] = useState('');

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);
  useEffect(() => { if (error) { toast.error(error); clearError(); } }, [error, clearError]);

  if (user && !(hasPermission(user, PERMISSIONS.VIEW_INVENTORY) && canUseInventoryMaster(user))) {
    return <Navigate to="/" replace />;
  }

  const brands = allowedBrands(user);
  // Acting on an alert changes nothing about stock, only who is on the hook for
  // it — so it sits with inventory management rather than stock approval. The
  // server enforces the same pair regardless of what is rendered.
  const canAct = hasPermission(user, PERMISSIONS.MANAGE_INVENTORY_MASTER)
    || hasPermission(user, PERMISSIONS.APPROVE_ADJUSTMENT);
  const canConfigure = hasPermission(user, PERMISSIONS.CONFIGURE_INVENTORY);

  const openRules = () => { setRulesOpen(true); if (!rules.length) fetchRules(); };

  const runAction = async (alertId, action, text = null) => {
    const res = await act(alertId, action, text);
    if (res.ok) toast.success(action === 'acknowledge' ? 'Acknowledged.' : `Alert ${action}d.`);
    return res;
  };

  const handleResolve = async () => {
    if (!note.trim()) { toast.error('Say what was done about it.'); return; }
    const res = await runAction(resolveFor, 'resolve', note.trim());
    if (res.ok) { setResolveFor(null); setNote(''); }
  };

  const active = (counts.byStatus.Open ?? 0) + (counts.byStatus.Acknowledged ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory Alerts"
        actions={canConfigure && (
          <Button size="sm" variant="secondary" onClick={openRules}>
            <SlidersHorizontal size={15} className="mr-2" />Alert Rules
          </Button>
        )}
      />

      {/* Severity tiles double as filters — the most common thing anyone wants
          from this screen is "show me the critical ones". */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile
          label="Needs attention" value={nf(active)} tone="text-slate-900"
          active={!filters.severity && !filters.status}
          onClick={() => setFilters({ severity: '', status: '', activeOnly: true })}
        />
        {SEVERITIES.map((s) => (
          <Tile
            key={s}
            label={s}
            value={nf(counts.bySeverity[s] ?? 0)}
            tone={s === 'Critical' ? 'text-error-600' : s === 'High' ? 'text-orange-600' : 'text-slate-900'}
            active={filters.severity === s}
            onClick={() => setFilters({ severity: filters.severity === s ? '' : s })}
          />
        ))}
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <select
            className={`${inputCls} w-auto min-w-36`}
            value={filters.category}
            onChange={(e) => setFilters({ category: e.target.value })}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c} ({counts.byCategory[c] ?? 0})</option>
            ))}
          </select>

          <select
            className={`${inputCls} w-auto min-w-36`}
            value={filters.status}
            onChange={(e) => setFilters({ status: e.target.value, activeOnly: !e.target.value })}
          >
            <option value="">Open &amp; acknowledged</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s} ({counts.byStatus[s] ?? 0})</option>
            ))}
          </select>

          {brands.length > 1 && (
            <select
              className={`${inputCls} w-auto min-w-32`}
              value={filters.brand}
              onChange={(e) => setFilters({ brand: e.target.value })}
            >
              <option value="">All brands</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          )}

          <span className="ml-auto text-xs font-semibold text-slate-400">
            {nf(total)} alert{total === 1 ? '' : 's'}
          </span>
        </CardContent>
      </Card>

      {/* ── List ───────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <table className="w-full text-sm">
              <tbody><TableSkeleton rows={8} columns={6} cellClass="px-4 py-3" /></tbody>
            </table>
          ) : alerts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-slate-400">
              <BellOff size={28} />
              <p className="text-sm font-semibold">Nothing needs attention.</p>
              <p className="text-xs">Alerts appear here when a stock condition changes.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">Severity</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">Alert</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">SKU</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">Seen</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">Status</th>
                    <th className="text-right px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.alertId} className="border-b border-slate-50 hover:bg-slate-50/60 transition-colors">
                      <td className="px-4 py-3"><SeverityBadge severity={a.severity} /></td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openAlert(a.alertId)}
                          className="text-left font-semibold text-slate-800 hover:text-primary-600"
                        >
                          {a.title}
                        </button>
                        <span className="block text-[11px] text-slate-400">{a.label} · {a.category}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {a.skuCode || <span className="text-slate-300">—</span>}
                        {a.brand && <span className="block text-[10px] text-slate-400">{a.brand}</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {fmtWhen(a.lastSeenAt)}
                        {/* Occurrences distinguish a persistent problem from a
                            noisy rule — the same alert seen 40 times is one
                            condition that has not been dealt with. */}
                        {a.occurrences > 1 && (
                          <span className="inline-flex items-center gap-0.5 ml-1.5 text-[10px] font-bold text-slate-400">
                            <Repeat size={9} />{a.occurrences}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-1 rounded-md text-[11px] font-bold ${STATUS_STYLE[a.status]}`}>
                          {a.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {canAct && a.status === 'Open' && (
                          <Button size="xs" variant="ghost" disabled={acting}
                            onClick={() => runAction(a.alertId, 'acknowledge')}>
                            <Eye size={13} className="mr-1" />Acknowledge
                          </Button>
                        )}
                        {canAct && (a.status === 'Open' || a.status === 'Acknowledged') && (
                          <Button size="xs" variant="ghost" disabled={acting}
                            onClick={() => { setResolveFor(a.alertId); setNote(''); }}>
                            <CheckCircle2 size={13} className="mr-1" />Resolve
                          </Button>
                        )}
                        {canAct && a.status === 'Resolved' && (
                          <Button size="xs" variant="ghost" disabled={acting}
                            onClick={() => runAction(a.alertId, 'close')}>
                            <Archive size={13} className="mr-1" />Close
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button size="sm" variant="secondary" disabled={filters.page <= 1}
            onClick={() => setFilters({ page: filters.page - 1 })}>Previous</Button>
          <span className="text-xs font-semibold text-slate-500">Page {filters.page} of {pages}</span>
          <Button size="sm" variant="secondary" disabled={filters.page >= pages}
            onClick={() => setFilters({ page: filters.page + 1 })}>Next</Button>
        </div>
      )}

      {/* ── Detail drawer ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {(selected || detailLoading) && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-slate-900/30 backdrop-blur-sm flex justify-end"
            onClick={closeDetail}
          >
            <motion.div
              initial={{ x: 400 }} animate={{ x: 0 }} exit={{ x: 400 }}
              transition={{ type: 'spring', damping: 28, stiffness: 260 }}
              className="w-full max-w-md h-full bg-white shadow-2xl overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {detailLoading || !selected ? (
                <div className="flex items-center justify-center h-full text-slate-400">
                  <Loader2 size={22} className="animate-spin" />
                </div>
              ) : (
                <div className="p-5 flex flex-col gap-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <SeverityBadge severity={selected.severity} />
                      <h2 className="mt-2 text-lg font-black text-slate-900">{selected.title}</h2>
                      <p className="text-xs font-mono text-slate-400">{selected.alertId}</p>
                    </div>
                    <button type="button" onClick={closeDetail} className="text-slate-400 hover:text-slate-700">
                      <X size={18} />
                    </button>
                  </div>

                  <p className="text-sm text-slate-700 leading-relaxed">{selected.message}</p>

                  <div>
                    <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">Condition</h3>
                    <Row label="Type">{selected.label}</Row>
                    <Row label="Category">{selected.category}</Row>
                    <Row label="Triggered by">{selected.triggerSource}</Row>
                    {selected.skuCode && <Row label="SKU">{selected.skuCode}</Row>}
                    {selected.brand && <Row label="Brand">{selected.brand}</Row>}
                    <Row label="First seen">{fmtWhen(selected.firstSeenAt)}</Row>
                    <Row label="Last seen">{fmtWhen(selected.lastSeenAt)}</Row>
                    <Row label="Occurrences">{nf(selected.occurrences)}</Row>
                  </div>

                  {/* Values AS THEY WERE when the alert fired. Not refreshed —
                      the point is to explain why it was raised, not what is
                      true now. */}
                  {selected.snapshot && (
                    <div>
                      <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                        Projection values at trigger
                      </h3>
                      {selected.snapshot.band && <Row label="Band">{selected.snapshot.band}</Row>}
                      <Row label="On hand">{nf(selected.snapshot.onHand)}</Row>
                      <Row label="Available">{nf(selected.snapshot.available)}</Row>
                      <Row label="Max level">{nf(selected.snapshot.maxLevel)}</Row>
                      <Row label="Reorder level">{nf(selected.snapshot.reorderLevel)}</Row>
                      <Row label="% of target">
                        {formatAvailablePercent(selected.snapshot.replenishmentPercent)}
                      </Row>
                      <Row label="Days of cover">
                        {selected.snapshot.coverageDays === null ? '—'
                          : Math.round(selected.snapshot.coverageDays)}
                      </Row>
                    </div>
                  )}

                  <div>
                    <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">Handling</h3>
                    <Row label="Status">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-bold ${STATUS_STYLE[selected.status]}`}>
                        {selected.status}
                      </span>
                    </Row>
                    {selected.acknowledgedBy && (
                      <Row label="Acknowledged">
                        {selected.acknowledgedBy.user} · {fmtWhen(selected.acknowledgedAt)}
                      </Row>
                    )}
                    {selected.resolvedAt && (
                      <Row label="Resolved">
                        {selected.autoResolved
                          ? <span className="text-slate-500">automatically — condition cleared</span>
                          : `${selected.resolvedBy?.user || '—'} · ${fmtWhen(selected.resolvedAt)}`}
                      </Row>
                    )}
                    {selected.resolutionNote && <Row label="Note">{selected.resolutionNote}</Row>}
                  </div>

                  {/* Delivery is shown explicitly so nobody has to guess whether
                      anyone was actually told. */}
                  {selected.deliveries?.length > 0 && (
                    <div>
                      <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">Delivery</h3>
                      {selected.deliveries.map((d, i) => (
                        <Row key={`${d.channel}-${i}`} label={d.channel}>
                          <span className={d.status === 'sent' ? 'text-success-700 font-semibold'
                            : d.status === 'failed' ? 'text-error-600 font-semibold' : 'text-slate-400'}>
                            {d.status}
                            {d.recipients ? ` · ${d.recipients} recipient(s)` : ''}
                            {d.reason ? ` · ${d.reason}` : ''}
                          </span>
                        </Row>
                      ))}
                    </div>
                  )}

                  {canAct && selected.allowedTransitions?.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                      {selected.allowedTransitions.includes('Acknowledged') && (
                        <Button size="sm" variant="secondary" disabled={acting}
                          onClick={() => runAction(selected.alertId, 'acknowledge')}>
                          <Eye size={14} className="mr-1.5" />Acknowledge
                        </Button>
                      )}
                      {selected.allowedTransitions.includes('Resolved') && (
                        <Button size="sm" disabled={acting}
                          onClick={() => { setResolveFor(selected.alertId); setNote(''); }}>
                          <CheckCircle2 size={14} className="mr-1.5" />Resolve
                        </Button>
                      )}
                      {selected.allowedTransitions.includes('Closed') && (
                        <Button size="sm" variant="secondary" disabled={acting}
                          onClick={() => runAction(selected.alertId, 'close')}>
                          <Archive size={14} className="mr-1.5" />Close
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Resolve ────────────────────────────────────────────────────── */}
      <Modal isOpen={Boolean(resolveFor)} onClose={() => setResolveFor(null)} title="Resolve alert" size="sm">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-600">
            Resolving records that this was dealt with. If the condition is still true, the next
            evaluation raises a new alert — resolving does not suppress it.
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">
              What was done?
            </label>
            <textarea
              className={`${inputCls} min-h-20`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. PO raised for 500 units, expected 14 Aug"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setResolveFor(null)}>Cancel</Button>
            <Button onClick={handleResolve} disabled={acting}>
              {acting && <Loader2 size={14} className="mr-1.5 animate-spin" />}Resolve
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Rules ──────────────────────────────────────────────────────── */}
      <Modal isOpen={rulesOpen} onClose={() => setRulesOpen(false)} title="Alert rules" size="xl">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-600">
            Rules decide how loudly a condition is announced, not what counts as one — a SKU is
            Critical because the health engine says so. <strong>Digest</strong> records an alert
            without pushing it; <strong>immediate</strong> pushes it to the roles listed.
          </p>

          {rulesLoading ? (
            <div className="flex justify-center py-10 text-slate-400"><Loader2 size={20} className="animate-spin" /></div>
          ) : (
            <div className="overflow-x-auto max-h-104">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-slate-100">
                    <th className="text-left px-3 py-2 text-[11px] font-bold text-slate-500 uppercase">Alert</th>
                    <th className="text-left px-3 py-2 text-[11px] font-bold text-slate-500 uppercase">On</th>
                    <th className="text-left px-3 py-2 text-[11px] font-bold text-slate-500 uppercase">Severity</th>
                    <th className="text-left px-3 py-2 text-[11px] font-bold text-slate-500 uppercase">Delivery</th>
                    <th className="text-left px-3 py-2 text-[11px] font-bold text-slate-500 uppercase">Cooldown</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.alertType} className="border-b border-slate-50">
                      <td className="px-3 py-2">
                        <span className="font-semibold text-slate-800">{r.label}</span>
                        <span className="block text-[10px] text-slate-400">{r.category}</span>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-primary-600"
                          checked={r.enabled}
                          disabled={savingRule === r.alertType}
                          onChange={(e) => saveRule(r.alertType, { enabled: e.target.checked })}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className={`${inputCls} py-1 text-xs`}
                          value={r.severity}
                          disabled={savingRule === r.alertType}
                          onChange={(e) => saveRule(r.alertType, { severity: e.target.value })}
                        >
                          {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className={`${inputCls} py-1 text-xs`}
                          value={r.delivery}
                          disabled={savingRule === r.alertType}
                          onChange={(e) => saveRule(r.alertType, { delivery: e.target.value })}
                        >
                          {DELIVERIES.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={1}
                          className={`${inputCls} py-1 text-xs w-20`}
                          defaultValue={r.cooldownHours}
                          disabled={savingRule === r.alertType}
                          onBlur={(e) => {
                            const n = Number(e.target.value);
                            if (n >= 1 && n !== r.cooldownHours) saveRule(r.alertType, { cooldownHours: n });
                          }}
                        />
                        <span className="ml-1 text-[10px] text-slate-400">h</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
};

export default InventoryAlerts;
