import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  ClipboardCheck, Plus, X, Loader2, Save, Send, CheckCircle2, XCircle,
  Upload, AlertTriangle, Ban, ArrowUpRight, ArrowDownRight, Clock,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { PageHeader } from '../../components/common/PageHeader';
import { useCountStore } from '../../store/countStore';
import { useUserStore } from '../../store/userStore';
import { useInventoryConfigStore } from '../../store/inventoryStore';
import { allowedBrands } from '../../utils/brandAccess';
import { hasPermission, canUseInventoryMaster, PERMISSIONS } from '../../utils/permissions';

/**
 * Stock Counts — IMS Module M7.
 *
 * The controlled path for verifying physical stock. Nothing on this screen
 * writes an inventory balance: approved variances become ledger movements
 * server-side, and the projections update from those.
 *
 * The variance shown while counting is computed locally for immediate feedback
 * only. The authoritative difference is the server's, measured against the
 * expected quantity frozen when the sheet was generated.
 */

const STATUS_STYLE = {
  Draft: 'bg-slate-100 text-slate-600',
  Counting: 'bg-primary-50 text-primary-700',
  Submitted: 'bg-warning-50 text-warning-700',
  Approved: 'bg-indigo-50 text-indigo-700',
  Rejected: 'bg-error-50 text-error-700',
  Posted: 'bg-success-50 text-success-700',
  Cancelled: 'bg-slate-100 text-slate-400',
};

const STATUSES = ['Draft', 'Counting', 'Submitted', 'Approved', 'Rejected', 'Posted', 'Cancelled'];

const nf = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
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

const Badge = ({ status }) => (
  <span className={`inline-flex px-2 py-1 rounded-md text-[11px] font-bold ${STATUS_STYLE[status] || STATUS_STYLE.Draft}`}>
    {status}
  </span>
);

const Stat = ({ label, value, tone = 'text-slate-900' }) => (
  <div className="bg-slate-50/70 p-3 rounded-lg border border-slate-100">
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
    <span className={`block text-lg font-black tabular-nums ${tone}`}>{value}</span>
  </div>
);

const Diff = ({ value }) => {
  if (value === null || value === undefined) return <span className="text-slate-300">—</span>;
  if (value === 0) return <span className="text-slate-400 font-semibold">0</span>;
  return (
    <span className={`inline-flex items-center gap-0.5 font-bold ${value > 0 ? 'text-success-700' : 'text-error-600'}`}>
      {value > 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {value > 0 ? `+${value}` : value}
    </span>
  );
};

export const StockCounts = () => {
  const { user } = useUserStore();
  const {
    counts, statusCounts, loading, error, filters, setFilters, fetchCounts,
    session, lines, sessionLoading, drafts, saving,
    openSession, closeSession, setDraft, saveDrafts,
    reasonFor, setReason,
    act, createCount, oversold, fetchOversold, resolveOversold,
  } = useCountStore();
  const { config, fetchAll } = useInventoryConfigStore();

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ scope: 'spot', brand: '', category: '', skuCodes: '', includeZeroStock: false, notes: '' });
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => { fetchCounts(); fetchOversold(); }, [fetchCounts, fetchOversold]);
  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (user && !(hasPermission(user, PERMISSIONS.VIEW_INVENTORY) && canUseInventoryMaster(user))) {
    return <Navigate to="/" replace />;
  }

  const brands = allowedBrands(user);
  const canCount = hasPermission(user, PERMISSIONS.PERFORM_COUNT);
  const canApprove = hasPermission(user, PERMISSIONS.APPROVE_COUNT);
  const canPost = hasPermission(user, PERMISSIONS.ADJUST_STOCK);
  const reasonCodes = (config?.reasonCodes || []).filter((r) => r.active);

  // Separation of duties, mirrored for the UI. The server enforces it against
  // the record regardless of what is rendered here.
  const isOwnWork = session &&
    (String(session.submittedBy?._id || session.submittedBy) === String(user?._id) ||
     String(session.counter?._id || session.counter) === String(user?._id));

  const run = async (action, ...args) => {
    const res = await act(action, ...args);
    if (res.success) toast.success('Done.');
    else toast.error(res.error);
    return res;
  };

  const handleCreate = async () => {
    const payload = {
      scope: form.scope,
      brand: form.brand || null,
      category: form.category || null,
      includeZeroStock: form.includeZeroStock,
      notes: form.notes || null,
      skuCodes: form.scope === 'spot'
        ? form.skuCodes.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
        : null,
    };
    const res = await createCount(payload);
    if (res.success) {
      toast.success(`${res.result.countId} created — ${nf(res.result.lineCount)} lines.`);
      setCreateOpen(false);
      openSession(res.result.countId);
    } else {
      toast.error(res.error);
    }
  };

  const handlePost = async () => {
    const res = await run('postCount');
    if (res.success && res.result?.oversold?.length) {
      toast.error(
        `${res.result.oversold.length} SKU(s) now have stock promised but absent. Review the exceptions.`,
        { duration: 8000 },
      );
      fetchOversold();
    }
  };

  const draftDiff = (line) => {
    const raw = drafts[line.skuCode];
    if (raw === '' || raw === undefined || raw === null) return line.difference;
    return Number(raw) - line.expectedQuantity;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Stock Verification"
        actions={canCount && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={15} className="mr-2" />New Count
          </Button>
        )}
      />

      {/* Oversold exceptions sit at the top: stock has been promised that does
          not exist, which outranks anything else on this screen. */}
      {oversold.length > 0 && (
        <Card className="border-error-300">
          <CardContent className="p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <AlertTriangle size={17} className="text-error-600" />
              <h3 className="text-sm font-bold text-error-800">
                {oversold.length} oversold exception{oversold.length === 1 ? '' : 's'}
              </h3>
            </div>
            <p className="text-xs text-slate-600">
              A count left these SKUs with less physical stock than is already reserved against
              confirmed bookings. Reduce or cancel bookings, then record the resolution.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200">
                  <tr>
                    <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px]">SKU</th>
                    <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px] text-right">On Hand</th>
                    <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px] text-right">Reserved</th>
                    <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px] text-right">Shortfall</th>
                    <th className="py-2 pr-3 font-bold text-slate-500 uppercase text-[10px]">Bookings</th>
                    <th className="py-2 font-bold text-slate-500 uppercase text-[10px]"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {oversold.map((o) => (
                    <tr key={o._id}>
                      <td className="py-2 pr-3 font-bold text-slate-800">{o.skuCode}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{nf(o.onHand)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{nf(o.reserved)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums font-bold text-error-600">{nf(o.shortfall)}</td>
                      <td className="py-2 pr-3 text-slate-500">{o.affectedBookings?.length || 0} affected</td>
                      <td className="py-2 text-right">
                        <Button size="sm" variant="outline" onClick={async () => {
                          const r = await resolveOversold(o._id, 'bookings-reduced', 'Resolved from verification screen');
                          if (r.success) toast.success('Resolved.'); else toast.error(r.error);
                        }}>Resolve</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Status filter chips double as the approval queue. */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilters({ status: '' })}
          className={`px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors ${
            !filters.status ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 hover:bg-slate-50 text-slate-700'
          }`}
        >All</button>
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilters({ status: filters.status === s ? '' : s })}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors ${
              filters.status === s ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 hover:bg-slate-50 text-slate-700'
            }`}
          >
            {s}
            <span className={filters.status === s ? 'text-slate-300' : 'text-slate-400'}>
              {statusCounts[s] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-error-50 border border-error-200 text-sm text-error-700 font-medium">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Count</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Scope</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Status</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Lines</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Variances</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs text-right">Net</th>
                  <th className="px-5 py-4 font-bold text-slate-600 uppercase text-xs">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && <TableSkeleton rows={counts.length || 8} columns={7} cellClass="px-5 py-4" />}

                {!loading && counts.map((c) => (
                  <tr key={c.countId} onClick={() => openSession(c.countId)}
                    className="hover:bg-slate-50 transition-colors cursor-pointer">
                    <td className="px-5 py-4">
                      <span className="font-mono text-xs font-bold text-primary-700">{c.countId}</span>
                    </td>
                    <td className="px-5 py-4 text-slate-600">
                      {c.scope}{c.brand && ` · ${c.brand}`}
                    </td>
                    <td className="px-5 py-4"><Badge status={c.status} /></td>
                    <td className="px-5 py-4 text-right tabular-nums text-slate-700">
                      {nf(c.countedLines)}<span className="text-slate-400"> / {nf(c.lineCount)}</span>
                    </td>
                    <td className="px-5 py-4 text-right tabular-nums font-semibold text-slate-800">{nf(c.varianceLines)}</td>
                    <td className="px-5 py-4 text-right"><Diff value={c.netVariance} /></td>
                    <td className="px-5 py-4 text-slate-500 text-xs">{fmtDate(c.createdAt)}</td>
                  </tr>
                ))}

                {!loading && counts.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center">
                      <p className="text-slate-600 font-semibold">No count sessions</p>
                      <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                        A count session verifies physical stock against the system. Variances become
                        ledger adjustments once approved — stock is never edited directly.
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ── Session drawer ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {(session || sessionLoading) && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closeSession} className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40" />
            <motion.aside
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 34 }}
              className="fixed right-0 top-0 h-full w-full max-w-4xl bg-white border-l border-slate-200 shadow-enterprise-lg z-50 flex flex-col"
            >
              {!session ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3 text-slate-400">
                    <Loader2 className="animate-spin" size={28} />
                    <p className="text-sm font-semibold">Loading session…</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                        {session.scope} count
                      </p>
                      <h3 className="text-lg font-black text-slate-900 font-mono">{session.countId}</h3>
                      <div className="mt-1.5 flex items-center gap-2">
                        <Badge status={session.status} />
                        {session.adjustmentId && (
                          <span className="font-mono text-[11px] text-slate-500">{session.adjustmentId}</span>
                        )}
                      </div>
                    </div>
                    <button onClick={closeSession}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0">
                      <X size={18} />
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <Stat label="Lines" value={`${nf(session.countedLines)} / ${nf(session.lineCount)}`} />
                      <Stat label="Variances" value={nf(session.varianceLines)} />
                      <Stat label="Net variance" value={nf(session.netVariance)}
                        tone={session.netVariance > 0 ? 'text-success-700' : session.netVariance < 0 ? 'text-error-600' : 'text-slate-900'} />
                      <Stat label="Movements posted" value={nf(session.postedMovementCount)} />
                    </div>

                    {session.status === 'Rejected' && session.rejectionReason && (
                      <div className="px-3 py-2 rounded-lg bg-error-50 border border-error-200 text-xs text-error-700">
                        <strong>Rejected:</strong> {session.rejectionReason}
                      </div>
                    )}

                    {session.status === 'Posted' && (
                      <div className="px-3 py-2 rounded-lg bg-success-50 border border-success-200 text-xs text-success-800">
                        Posted to the ledger as batch <strong className="font-mono">{session.ledgerBatchId || '—'}</strong>.
                        This session is now immutable — a correction means a new count.
                      </div>
                    )}

                    {lines.some((l) => l.movedDuringCount) && (
                      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning-50 border border-warning-200">
                        <Clock size={14} className="text-warning-600 shrink-0 mt-0.5" />
                        <p className="text-xs text-warning-800">
                          Stock moved on some SKUs while this count was open. Those rows are marked —
                          review them before approving, because the expected figure they were counted
                          against is no longer current.
                        </p>
                      </div>
                    )}

                    <div className="overflow-x-auto -mx-6 px-6">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-50 border-y border-slate-200">
                          <tr>
                            <th className="px-3 py-2.5 font-bold text-slate-600 uppercase text-[10px]">SKU</th>
                            <th className="px-3 py-2.5 font-bold text-slate-600 uppercase text-[10px] text-right">Expected</th>
                            <th className="px-3 py-2.5 font-bold text-slate-600 uppercase text-[10px] text-right">Counted</th>
                            <th className="px-3 py-2.5 font-bold text-slate-600 uppercase text-[10px] text-right">Diff</th>
                            <th className="px-3 py-2.5 font-bold text-slate-600 uppercase text-[10px]">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {lines.map((l) => {
                            const d = draftDiff(l);
                            const editable = session.status === 'Counting' && canCount;
                            return (
                              <tr key={l.skuCode} className={l.movedDuringCount ? 'bg-warning-50/40' : ''}>
                                <td className="px-3 py-2">
                                  <span className="font-bold text-slate-800">{l.skuCode}</span>
                                  {l.movedDuringCount && (
                                    <span className="block text-[10px] font-bold text-warning-700">
                                      moved during count (now {nf(l.balanceAtSubmit)})
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{nf(l.expectedQuantity)}</td>
                                <td className="px-3 py-2 text-right">
                                  {editable ? (
                                    <input
                                      type="number" min="0"
                                      value={drafts[l.skuCode] ?? (l.countedQuantity ?? '')}
                                      onChange={(e) => setDraft(l.skuCode, e.target.value)}
                                      className="w-24 px-2 py-1 text-sm text-right border border-slate-300 rounded-md outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 tabular-nums"
                                    />
                                  ) : (
                                    <span className="tabular-nums font-semibold text-slate-800">{nf(l.countedQuantity)}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right"><Diff value={d} /></td>
                                <td className="px-3 py-2">
                                  {editable && d !== 0 && d !== null ? (
                                    <select
                                      value={reasonFor[l.skuCode] || l.reasonCode || ''}
                                      onChange={(e) => setReason(l.skuCode, e.target.value)}
                                      className="w-full px-2 py-1 text-xs border border-slate-300 rounded-md outline-none focus:border-primary-500"
                                    >
                                      <option value="">Reason required…</option>
                                      {reasonCodes.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                                    </select>
                                  ) : (
                                    <span className="text-xs text-slate-500">{l.reasonCode || '—'}</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Action bar — only the transitions legal from here. */}
                  <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex flex-wrap justify-end gap-2">
                    {session.status === 'Draft' && canCount && (
                      <Button size="sm" onClick={() => run('startCount')} loading={saving}>
                        <ClipboardCheck size={15} className="mr-2" />Start Counting
                      </Button>
                    )}

                    {session.status === 'Counting' && canCount && (
                      <>
                        <Button size="sm" variant="outline" loading={saving} onClick={async () => {
                          const r = await saveDrafts();
                          if (r.success) toast.success(`Saved ${r.saved} line(s).`); else toast.error(r.error);
                        }}>
                          <Save size={15} className="mr-2" />Save Counts
                        </Button>
                        <Button size="sm" loading={saving} onClick={() => run('submitCount', false)}>
                          <Send size={15} className="mr-2" />Submit for Review
                        </Button>
                      </>
                    )}

                    {session.status === 'Submitted' && canApprove && (
                      <>
                        <Button size="sm" variant="danger" onClick={() => setRejectOpen(true)}>
                          <XCircle size={15} className="mr-2" />Reject
                        </Button>
                        <Button size="sm" loading={saving} disabled={isOwnWork}
                          title={isOwnWork ? 'You cannot approve a count you performed or submitted' : undefined}
                          onClick={() => run('reviewCount', 'approve')}>
                          <CheckCircle2 size={15} className="mr-2" />Approve
                        </Button>
                      </>
                    )}

                    {session.status === 'Approved' && canPost && (
                      <Button size="sm" loading={saving} onClick={handlePost}>
                        <Upload size={15} className="mr-2" />Post Adjustments
                      </Button>
                    )}

                    {['Draft', 'Counting', 'Submitted'].includes(session.status) && canApprove && (
                      <Button size="sm" variant="ghost" onClick={async () => {
                        const reason = window.prompt('Why is this count being cancelled?');
                        if (reason) await run('cancelCount', reason);
                      }}>
                        <Ban size={15} className="mr-2" />Cancel
                      </Button>
                    )}
                  </div>

                  {session.status === 'Submitted' && isOwnWork && (
                    <p className="px-6 pb-4 -mt-2 text-[11px] text-warning-700">
                      You counted or submitted this session, so someone else must approve it.
                    </p>
                  )}
                </>
              )}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ── Create session ─────────────────────────────────────────────── */}
      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="New Count Session">
        <div className="flex flex-col gap-4">
          <p className="text-xs text-slate-600 leading-relaxed">
            The sheet captures each SKU's current balance and freezes it. Variances are measured
            against that frozen figure, so stock moving mid-count cannot silently change the result.
          </p>

          <Field label="Scope">
            <select value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))} className={inputCls}>
              <option value="spot">Spot — a named list of SKUs</option>
              <option value="cycle">Cycle — a recurring subset</option>
              <option value="full">Full — everything in scope</option>
            </select>
          </Field>

          {form.scope === 'spot' ? (
            <Field label="SKUs (one per line, or comma separated)">
              <textarea rows={4} value={form.skuCodes}
                onChange={(e) => setForm((f) => ({ ...f, skuCodes: e.target.value }))}
                className={inputCls} placeholder="14405M-10&#10;13405M-8" />
            </Field>
          ) : (
            <Field label="Category (optional)">
              <input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                className={inputCls} placeholder="Impact Sockets" />
            </Field>
          )}

          {brands.length > 1 && (
            <Field label="Brand (optional)">
              <select value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} className={inputCls}>
                <option value="">All brands</option>
                {brands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
          )}

          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={form.includeZeroStock}
              onChange={(e) => setForm((f) => ({ ...f, includeZeroStock: e.target.checked }))}
              className="mt-0.5 w-4 h-4 text-primary-600 rounded border-slate-300 focus:ring-primary-500" />
            <span>Include SKUs with no stock — normally excluded, since confirming thousands of empty
              rows is rarely worth the floor time.</span>
          </label>

          <Field label="Notes">
            <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} className={inputCls} />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate} loading={saving}>Create Session</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={rejectOpen} onClose={() => setRejectOpen(false)} title="Reject Count">
        <div className="flex flex-col gap-4">
          <Field label="Reason">
            <textarea rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
              className={inputCls} placeholder="What needs recounting, and why?" />
          </Field>
          <p className="text-[11px] text-slate-500">
            A rejected count returns to Counting so the figures can be corrected. Nothing is posted.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button variant="danger" size="sm" disabled={!rejectReason.trim()} onClick={async () => {
              const r = await run('reviewCount', 'reject', rejectReason);
              if (r.success) { setRejectOpen(false); setRejectReason(''); }
            }}>Reject Count</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default StockCounts;
