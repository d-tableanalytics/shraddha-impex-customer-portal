import { useMemo } from 'react';
import { ClipboardList, Loader2, Ship } from 'lucide-react';

import { IndentStatusBadge } from '../ui/IndentStatusBadge';
import {
  INDENT_RESERVATION_STATUS, indentSummary, formatDate, relativeArrival, daysUntil,
} from '../../utils/upcomingStock';

/**
 * How this SKU's upcoming stock would be shared out over its open indents —
 * the Indents tab of the Upcoming Stock panel. READ-ONLY.
 *
 * The allocation is worked out by the server (allocateFifo in
 * upcomingStock.service.js) every time the list is read: indents oldest first
 * (the order the real FIFO pass serves them), upcoming stock earliest arrival
 * first. Each indent shows how much it would get, what it would still be short
 * of, and which shipment(s) would cover it.
 *
 * INTERNAL ANALYSIS ONLY: nothing here reserves stock, changes an indent or a
 * booking, or tells a customer anything. Where stock really goes when it
 * arrives is decided by Indent Stock Assignment, as before.
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

const raisedAgo = (iso) => {
  if (!iso) return '';
  const d = -daysUntil(iso);
  if (d <= 0) return 'raised today';
  return `raised ${d} day${d === 1 ? '' : 's'} ago`;
};

export const IndentReservationSection = ({ item, lines, refreshing = false }) => {
  const summary = useMemo(() => indentSummary(lines), [lines]);

  return (
    <div>
      <div className="flex items-end justify-between gap-3 mb-3">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
          <ClipboardList size={14} />
          Indents for this SKU{lines.length > 0 && ` · ${lines.length}`}
        </h4>
        <span className="text-[11px] text-slate-400 font-medium">
          {refreshing
            ? <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" />Recalculating…</span>
            : 'FIFO · oldest indent first'}
        </span>
      </div>

      {lines.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/50 px-4 py-6 text-center">
          <p className="text-sm font-semibold text-slate-600">No open indent for this SKU</p>
          <p className="text-[11px] text-slate-500 mt-1">
            All {item.upcoming.toLocaleString()} {item.uom} of upcoming stock is unreserved.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Demand against supply, across every open indent. */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/50 px-4 py-3">
            <div className="grid grid-cols-4 gap-3">
              {[
                ['Indent demand', summary.required, 'text-slate-900'],
                ['Reserved (FIFO)', summary.reserved, 'text-success-700'],
                ['Still short', summary.open, summary.open > 0 ? 'text-warning-700' : 'text-slate-900'],
                ['Remaining', item.remaining, 'text-primary-700'],
              ].map(([label, v, tone]) => (
                <div key={label} className="min-w-0">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
                  <span className={`block text-sm font-black tabular-nums ${tone}`}>{v.toLocaleString()}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              {summary.covered} of {summary.count} indent{summary.count === 1 ? '' : 's'} fully covered
              {' · '}
              {summary.open === 0
                ? <span className="font-semibold text-success-700">upcoming stock covers all open demand.</span>
                : <span className="font-semibold text-warning-700">upcoming stock is {summary.open.toLocaleString()} short of open demand.</span>}
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              Calculated automatically for analysis — no stock is reserved and nothing is sent to customers.
            </p>
          </div>

          {/* The queue, in the order it is served. */}
          <ol aria-label="Open indents in FIFO order" className="border border-slate-200 rounded-lg divide-y divide-slate-100">
            {lines.map((l) => (
              <li key={l.lineId} className="px-4 py-3 flex items-start gap-3">
                <span
                  className="mt-0.5 w-6 h-6 shrink-0 rounded-full bg-slate-100 text-slate-600 text-[11px] font-black flex items-center justify-center tabular-nums"
                  title="Position in the FIFO queue"
                >
                  {l.fifoPosition}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-bold text-slate-900 font-mono">{l.indentNumber}</span>
                    <ReservationChip status={l.reservationStatus} />
                    <IndentStatusBadge status={l.status} />
                  </span>
                  <span className="block text-xs font-semibold text-slate-600 truncate">{l.customer}</span>
                  <span className="block text-[11px] text-slate-400">
                    {formatDate(l.raisedAt)} · {raisedAgo(l.raisedAt)}
                    {l.poNumber && <> · PO <span className="font-mono">{l.poNumber}</span></>}
                  </span>
                  {l.coveredBy.length > 0 && (
                    <span className="block text-[11px] text-slate-500 mt-1">
                      <Ship size={11} className="inline -mt-0.5 mr-1 text-slate-400" />
                      {l.coveredBy.map((c, n) => (
                        <span key={`${c.shipmentId}-${n}`}>
                          {n > 0 && ' + '}
                          <span className="tabular-nums font-semibold">{c.qty.toLocaleString()}</span>
                          {' from '}<span className="font-mono">{c.ref || 'No reference'}</span>
                          {c.eta ? ` (${formatDate(c.eta)}, ${relativeArrival(c.eta)})` : ' (date not set)'}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="text-right shrink-0 w-28">
                  <span className="block text-sm font-black text-slate-900 tabular-nums">
                    {l.reservedQty.toLocaleString()}
                    <span className="text-slate-400 font-bold"> / {l.requiredQty.toLocaleString()}</span>
                  </span>
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wide">reserved / required</span>
                  <CoverBar line={l} className="mt-1.5" />
                  {l.outstanding > 0 && (
                    <span className="block text-[11px] font-bold text-warning-700 mt-1 tabular-nums">
                      {l.outstanding.toLocaleString()} short
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
};

export default IndentReservationSection;
