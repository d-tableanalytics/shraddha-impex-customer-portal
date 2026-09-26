import { useEffect, useMemo, useState } from 'react';
import {
  ClipboardList, CheckCircle2, AlertCircle, ArrowRight, Loader2, PauseCircle, PlayCircle, Undo2,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { Button } from '../ui/Button';
import { IndentStatusBadge } from '../ui/IndentStatusBadge';
import { useUpcomingStockStore } from '../../store/upcomingStockStore';
import {
  INDENT_RESERVATION_STATUS, reservationStatusFor, indentSummary,
  formatDate, formatDateTime, relativeArrival, daysUntil,
} from '../../utils/upcomingStockMock';

/**
 * Reserve upcoming stock against a SPECIFIC indent — DEMO, inside the Upcoming
 * Stock detail panel.
 *
 * An indent is an open Reservation (status Pending / Partially Confirmed): the
 * part of a booking that stock could not cover. A SKU can have several, from
 * different customers or different bookings, so the desk picks which one each
 * reservation is for. The same flow serves one indent or many.
 *
 * Per indent the desk can:
 *   • Confirm Reservation — hold a quantity of upcoming stock for it, never
 *     more than it still needs, nor more than is free;
 *   • Keep Pending        — record that it should NOT be reserved for yet;
 *   • Release             — hand a reservation back.
 *
 * The indent's own status is never changed here. It stays Pending / Partially
 * Confirmed, exactly as the server holds it — those statuses describe the
 * booking the indent came from, and only the booking flow moves them. What this
 * adds is a separate RESERVATION status against upcoming stock.
 *
 * Indents are listed oldest first, the queue order the server's auto-booker
 * serves (indentAvailability.service.js), so the desk sees who has waited
 * longest.
 */

const ReservationChip = ({ status }) => {
  const s = INDENT_RESERVATION_STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold whitespace-nowrap ${s.chip}`}>
      <span aria-hidden="true">{s.mark}</span>{status}
    </span>
  );
};

/** Reserved share of what the indent requires. */
const CoverBar = ({ line, className = '' }) => (
  <div className={`h-1.5 rounded-full overflow-hidden bg-slate-100 ${className}`}>
    <div
      className={INDENT_RESERVATION_STATUS[line.reservationStatus].bar}
      style={{ width: `${line.requiredQty ? Math.min(100, (line.reservedQty / line.requiredQty) * 100) : 0}%`, height: '100%' }}
    />
  </div>
);

const Tile = ({ label, children, tone = 'text-slate-900', hint }) => (
  <div className="bg-slate-50/70 p-3 rounded-lg border border-slate-100 min-w-0">
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
    <div className={`text-base font-black tabular-nums ${tone}`}>{children}</div>
    {hint && <p className="text-[11px] text-slate-400 font-medium">{hint}</p>}
  </div>
);

const BeforeAfter = ({ before, after }) => (
  <span className="inline-flex items-center gap-1.5">
    {after !== undefined && after !== before ? (
      <>
        <span className="text-sm text-slate-400 line-through">{before.toLocaleString()}</span>
        <ArrowRight size={12} className="text-slate-300" />
        {after.toLocaleString()}
      </>
    ) : before.toLocaleString()}
  </span>
);

const raisedAgo = (iso) => {
  if (!iso) return '';
  const d = -daysUntil(iso);
  if (d <= 0) return 'raised today';
  return `raised ${d} day${d === 1 ? '' : 's'} ago`;
};

export const IndentReservationSection = ({ item, lines, live, userName }) => {
  const reserve = useUpcomingStockStore((s) => s.reserve);
  const keepPending = useUpcomingStockStore((s) => s.keepPending);
  const resumeIndent = useUpcomingStockStore((s) => s.resumeIndent);
  const release = useUpcomingStockStore((s) => s.release);

  // The default is the oldest indent that still needs stock and has not been
  // kept pending. It FOLLOWS the list until the user picks one: live indents
  // arrive a moment after the panel opens, and one may be older than every
  // demo line.
  const firstOpen = lines.find((l) => l.outstanding > 0 && !l.hold)
    || lines.find((l) => l.outstanding > 0)
    || lines[0]
    || null;
  const [picked, setPicked] = useState(null);
  const [qty, setQty] = useState('');
  const [saving, setSaving] = useState(false);
  const [holding, setHolding] = useState(false);
  const [holdNote, setHoldNote] = useState('');
  const [releasing, setReleasing] = useState(null);

  const line = lines.find((l) => l.lineId === picked) || firstOpen;
  const lineId = line?.lineId ?? null;
  const summary = useMemo(() => indentSummary(lines), [lines]);

  // A different SKU is a different queue.
  useEffect(() => { setPicked(null); setQty(''); setHolding(false); }, [item.key]);

  const suggested = line ? Math.min(line.outstanding, item.remaining) : 0;

  // Prefill with what can actually be covered whenever the choice changes, and
  // close any half-finished Keep Pending — it belonged to the other indent.
  useEffect(() => {
    setQty(suggested > 0 ? String(suggested) : '');
    setHolding(false);
    setHoldNote('');
    setReleasing(null);
  }, [lineId]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = Number(qty);
  const error = useMemo(() => {
    if (!line || qty === '') return null;
    if (!Number.isInteger(n) || n <= 0) return 'Enter a whole quantity above 0.';
    if (n > line.outstanding) return `This indent needs only ${line.outstanding.toLocaleString()} more.`;
    if (n > item.remaining) return `Only ${item.remaining.toLocaleString()} upcoming stock is free to reserve.`;
    return null;
  }, [line, qty, n, item.remaining]);

  const valid = Boolean(line) && qty !== '' && !error && n > 0;
  const after = valid
    ? {
      reserved: line.reservedQty + n,
      open: line.outstanding - n,
      upcomingRemaining: item.remaining - n,
      status: reservationStatusFor(line.reservedQty + n, line.requiredQty),
    }
    : null;

  const nextShipment = [...item.shipments].sort((a, b) => a.eta.localeCompare(b.eta))[0];

  const confirm = async () => {
    if (!valid) return;
    setSaving(true);
    await new Promise((r) => setTimeout(r, 450));
    const res = reserve({ key: item.key, qty: n, indent: line, by: userName });
    setSaving(false);
    if (!res.success) { toast.error(res.error); return; }
    toast.success(`Reserved ${n.toLocaleString()} × ${item.skuCode} against indent ${line.indentNumber} (${line.customer}).`);
    // Stay on this indent, so its new status is what the user sees next —
    // otherwise a now-full indent would hand the selection to the next in line.
    setPicked(line.lineId);
    const left = line.outstanding - n;
    setQty(left > 0 ? String(Math.min(left, item.remaining - n)) : '');
  };

  const confirmHold = () => {
    const res = keepPending({ key: item.key, indent: line, note: holdNote.trim(), by: userName });
    if (!res.success) { toast.error(res.error); return; }
    toast.success(`Indent ${line.indentNumber} kept pending — no upcoming stock reserved for it.`);
    setPicked(line.lineId);
    setHolding(false);
    setHoldNote('');
  };

  const resume = () => {
    resumeIndent(item.key, line.lineId);
    setPicked(line.lineId);
    toast.success(`Indent ${line.indentNumber} is open for reservation again.`);
  };

  const releaseOne = (r) => {
    release(item.key, r.id);
    setReleasing(null);
    setPicked(line.lineId);
    toast.success(`Released ${r.qty.toLocaleString()} from indent ${line.indentNumber}.`);
  };

  const liveNote = live.state === 'loading'
    ? <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" />Checking Indent History…</span>
    : live.state === 'ready'
      ? `${live.count.toLocaleString()} live indent${live.count === 1 ? '' : 's'} from Indent History`
      : 'Indent History could not be read — showing demo indents';

  const shortfall = summary.open - item.remaining;

  return (
    <div>
      <div className="flex items-end justify-between gap-3 mb-3">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
          <ClipboardList size={14} />
          Indents for this SKU{lines.length > 0 && ` · ${lines.length}`}
        </h4>
        <span className="text-[11px] text-slate-400 font-medium">{liveNote}</span>
      </div>

      {lines.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/50 px-4 py-6 text-center">
          <p className="text-sm font-semibold text-slate-600">No open indent for this SKU</p>
          <p className="text-[11px] text-slate-500 mt-1">
            An indent is raised when a booking cannot be covered from stock. Reserve without one from the Reserve Stock button.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Demand against supply, across every open indent. */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/50 px-4 py-3">
            <div className="grid grid-cols-4 gap-3">
              {[
                ['Required', summary.required, 'text-slate-900'],
                ['Reserved', summary.reserved, 'text-success-700'],
                ['Still open', summary.open, 'text-slate-900'],
                ['Upcoming free', item.remaining, 'text-primary-700'],
              ].map(([label, v, tone]) => (
                <div key={label} className="min-w-0">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
                  <span className={`block text-sm font-black tabular-nums ${tone}`}>{v.toLocaleString()}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              {summary.covered} of {summary.count} indent{summary.count === 1 ? '' : 's'} fully reserved
              {summary.held > 0 && ` · ${summary.held} kept pending`}
              {' · '}
              {summary.open === 0
                ? 'nothing left to reserve.'
                : shortfall > 0
                  ? <span className="font-semibold text-warning-700">upcoming stock is {shortfall.toLocaleString()} short of open demand.</span>
                  : <span className="font-semibold text-success-700">upcoming stock covers all open demand.</span>}
            </p>
          </div>

          {/* The choice. Oldest first — the order the queue is served in. */}
          <div role="radiogroup" aria-label="Open indents for this SKU" className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-72 overflow-y-auto">
            {lines.map((l) => {
              const active = l.lineId === lineId;
              return (
                <button
                  key={l.lineId}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPicked(l.lineId)}
                  className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ${
                    active ? 'bg-primary-50/60' : 'hover:bg-slate-50'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1 w-3.5 h-3.5 rounded-full border-2 shrink-0 ${active ? 'border-primary-600 bg-primary-600 ring-2 ring-primary-100' : 'border-slate-300 bg-white'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-bold text-slate-900 font-mono">{l.indentNumber}</span>
                      {l.source === 'live' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary-100 text-primary-700 uppercase tracking-wide">Live</span>
                      )}
                      <ReservationChip status={l.reservationStatus} />
                    </span>
                    <span className="block text-xs font-semibold text-slate-600 truncate">{l.customer}</span>
                    <span className="block text-[11px] text-slate-400">
                      {formatDate(l.raisedAt)} · {raisedAgo(l.raisedAt)}
                    </span>
                    {l.hold && (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-warning-700 mt-0.5">
                        <PauseCircle size={11} className="shrink-0" />
                        <span className="truncate">Kept pending{l.hold.note ? ` — ${l.hold.note}` : ''}</span>
                      </span>
                    )}
                  </span>
                  <span className="text-right shrink-0 w-24">
                    <span className="block text-sm font-black text-slate-900 tabular-nums">
                      {l.reservedQty.toLocaleString()}
                      <span className="text-slate-400 font-bold"> / {l.requiredQty.toLocaleString()}</span>
                    </span>
                    <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wide">reserved / required</span>
                    <CoverBar line={l} className="mt-1.5" />
                  </span>
                </button>
              );
            })}
          </div>

          {line && (
            <div className="rounded-lg border border-slate-200 overflow-hidden">
              {/* Indent number / details */}
              <div className="px-4 py-3 bg-slate-50/60 border-b border-slate-100 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Reserving against indent</p>
                  <p className="text-sm font-black text-slate-900 font-mono">{line.indentNumber}</p>
                  <p className="text-xs font-semibold text-slate-600 truncate">{line.customer}</p>
                  <p className="text-[11px] text-slate-400">
                    Raised {formatDate(line.raisedAt)}
                    {line.poNumber && <> · PO <span className="font-mono">{line.poNumber}</span></>}
                    {line.scheduledDate && <> · promised for {formatDate(line.scheduledDate)}</>}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <IndentStatusBadge status={line.status} />
                  <ReservationChip status={line.reservationStatus} />
                </div>
              </div>

              <div className="p-4 flex flex-col gap-4">
                {line.hold && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-50 border border-warning-200">
                    <PauseCircle size={16} className="text-warning-600 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-warning-800">Kept pending — no upcoming stock reserved for the open quantity</p>
                      <p className="text-[11px] text-warning-800/80">
                        {line.hold.by} · {formatDateTime(line.hold.at)}{line.hold.note && ` · ${line.hold.note}`}
                      </p>
                      <p className="text-[11px] text-warning-800/70 mt-0.5">Confirming a reservation below takes it off hold.</p>
                    </div>
                    <Button size="xs" variant="outline" onClick={resume} className="shrink-0 bg-white">
                      <PlayCircle size={13} className="mr-1" />Resume
                    </Button>
                  </div>
                )}

                {/* SKU / Product */}
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">SKU / Product</p>
                    <p className="text-sm font-bold text-slate-900">{item.skuCode}</p>
                    <p className="text-xs text-slate-500 truncate">{item.product}</p>
                  </div>
                  {nextShipment && (
                    <p className="text-[11px] text-slate-400 text-right shrink-0">
                      Next arrival <span className="font-mono font-semibold text-slate-600">{nextShipment.ref}</span>
                      <span className="block">{formatDate(nextShipment.eta)} · {relativeArrival(nextShipment.eta)}</span>
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Tile label="Indent required qty">{line.requiredQty.toLocaleString()}</Tile>
                  <Tile label="Reserved for this indent" tone="text-success-700">
                    <BeforeAfter before={line.reservedQty} after={after?.reserved} />
                  </Tile>
                  <Tile label="Available upcoming stock" tone="text-primary-700" hint={`of ${item.upcoming.toLocaleString()} upcoming`}>
                    <BeforeAfter before={item.remaining} after={after?.upcomingRemaining} />
                  </Tile>
                  <Tile label="Remaining qty on indent" tone={after && after.open === 0 ? 'text-success-700' : 'text-slate-900'}>
                    <BeforeAfter before={line.outstanding} after={after?.open} />
                  </Tile>
                </div>

                {/* Quantity to be reserved */}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="indent-reserve-qty" className="text-xs font-semibold text-slate-700 select-none">
                    Quantity to be reserved ({item.uom})
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="indent-reserve-qty"
                      type="number"
                      min="1"
                      max={Math.min(line.outstanding, item.remaining) || undefined}
                      value={qty}
                      onChange={(e) => setQty(e.target.value)}
                      disabled={line.outstanding === 0 || item.remaining === 0}
                      placeholder={line.outstanding === 0 ? 'Fully reserved' : `Up to ${Math.min(line.outstanding, item.remaining).toLocaleString()}`}
                      className={`w-40 px-3 py-2 text-sm bg-white border rounded-lg shadow-sm outline-none tabular-nums
                        focus:ring-1 disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed ${
                        error ? 'border-error-500 focus:border-error-500 focus:ring-error-500' : 'border-slate-300 focus:border-primary-500 focus:ring-primary-500'
                      }`}
                    />
                    {suggested > 0 && [
                      ['50%', Math.max(1, Math.floor(suggested / 2))],
                      ['Max', suggested],
                    ].filter(([, v], i, arr) => i === arr.length - 1 || v !== suggested).map(([label, v]) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setQty(String(v))}
                        className={`px-2 py-1 rounded-md border text-[11px] font-bold transition-colors ${
                          Number(qty) === v
                            ? 'border-primary-300 bg-primary-50 text-primary-700'
                            : 'border-slate-200 text-slate-600 hover:bg-primary-50 hover:text-primary-700 hover:border-primary-300'
                        }`}
                      >
                        {label} · {v.toLocaleString()}
                      </button>
                    ))}
                  </div>
                  {error && <span className="text-xs text-error-500 font-medium">{error}</span>}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50/70 border border-slate-100 px-3 py-2.5">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Reservation status</span>
                  <span className="inline-flex items-center gap-1.5">
                    <ReservationChip status={line.reservationStatus} />
                    {after && after.status !== line.reservationStatus && (
                      <><ArrowRight size={12} className="text-slate-300" /><ReservationChip status={after.status} /></>
                    )}
                  </span>
                </div>

                {line.outstanding === 0 ? (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-success-50 border border-success-100">
                    <CheckCircle2 size={16} className="text-success-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-success-700">
                      This indent is fully covered by upcoming stock. Release a reservation below to change it.
                    </p>
                  </div>
                ) : item.remaining === 0 && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-50 border border-warning-200">
                    <AlertCircle size={16} className="text-warning-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-warning-800">
                      No upcoming stock is free for this SKU. Release another indent&apos;s reservation, import a new
                      shipment, or keep this indent pending.
                    </p>
                  </div>
                )}

                {/* Keep Pending — the explicit "not yet". */}
                {holding ? (
                  <div className="flex flex-col gap-2 p-3 rounded-lg border border-warning-200 bg-warning-50/50">
                    <label htmlFor="indent-hold-note" className="text-xs font-semibold text-slate-700">
                      Keep {line.indentNumber} pending — reason (optional)
                    </label>
                    <input
                      id="indent-hold-note"
                      value={holdNote}
                      onChange={(e) => setHoldNote(e.target.value)}
                      placeholder="e.g. Waiting for the customer's revised PO"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                    />
                    <p className="text-[11px] text-slate-500">
                      Nothing is reserved and the indent stays {line.status}. You can reserve for it at any time.
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => { setHolding(false); setHoldNote(''); }}>Cancel</Button>
                      <Button size="sm" variant="secondary" onClick={confirmHold}>
                        <PauseCircle size={15} className="mr-2" />Keep Pending
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col-reverse sm:flex-row gap-2">
                    {line.outstanding > 0 && !line.hold && (
                      <Button variant="outline" onClick={() => setHolding(true)} className="sm:w-auto">
                        <PauseCircle size={16} className="mr-2" />Keep Pending
                      </Button>
                    )}
                    <Button onClick={confirm} loading={saving} disabled={!valid} className="flex-1">
                      {!saving && <CheckCircle2 size={16} className="mr-2" />}
                      Confirm Reservation
                    </Button>
                  </div>
                )}

                {/* What is already held against THIS indent. */}
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                    Reserved against {line.indentNumber} · {line.reservedQty.toLocaleString()} {item.uom}
                  </p>
                  {line.reservations.length === 0 ? (
                    <p className="text-[11px] text-slate-500">Nothing reserved against this indent yet.</p>
                  ) : (
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                      {line.reservations.map((r) => (
                        <div key={r.id} className="px-3 py-2 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-black text-slate-900 tabular-nums">{r.qty.toLocaleString()} {item.uom}</p>
                            <p className="text-[11px] text-slate-500">{formatDateTime(r.reservedAt)} · {r.by}</p>
                          </div>
                          {releasing === r.id ? (
                            <span className="flex gap-1.5 shrink-0">
                              <Button size="xs" variant="danger" onClick={() => releaseOne(r)}>Release</Button>
                              <Button size="xs" variant="ghost" onClick={() => setReleasing(null)}>Keep</Button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setReleasing(r.id)}
                              className="p-1.5 rounded-lg text-slate-300 hover:text-error-600 hover:bg-error-50 transition-colors shrink-0"
                              title="Release this reservation"
                              aria-label={`Release ${r.qty} reserved against ${line.indentNumber}`}
                            >
                              <Undo2 size={15} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default IndentReservationSection;
