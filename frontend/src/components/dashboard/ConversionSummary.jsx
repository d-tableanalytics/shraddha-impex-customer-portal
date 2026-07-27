import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ArrowRight } from 'lucide-react';
import { api } from '../../services/api';

// Booking-to-Order conversion. Hero: a donut gauge of the conversion rate.
// Right: a segmented fulfilment bar (confirmed vs pending) over total booked + legend chips.
// Colors — Booked: indigo #6366f1 · Confirmed: emerald #10b981 · Pending: amber #f59e0b
const COLORS = {
  booked: '#6366f1',
  confirmed: '#10b981',
  confirmedEdge: '#059669',
  pending: '#f59e0b',
  reserved: '#64748b', // in selection list, awaiting confirmation
};

export const ConversionSummary = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard/stats')
      .then(r => setStats(r.data.data))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  const booked = stats?.totalBooked ?? 0;
  const confirmed = stats?.totalConfirmed ?? 0;
  const pending = stats?.totalPending ?? 0;
  const reserved = stats?.totalReserved ?? 0; // in selection list, awaiting confirmation
  const rate = stats?.conversionRate ?? 0;

  // Donut geometry
  const SIZE = 148, STROKE = 14;
  const R = (SIZE - STROKE) / 2;
  const C = 2 * Math.PI * R;
  const dash = C * Math.min(100, Math.max(0, rate)) / 100;

  const pct = (v) => (booked > 0 ? (v / booked) * 100 : 0);
  const confirmedPct = pct(confirmed);
  const pendingPct = pct(pending);
  const reservedPct = pct(reserved);

  const chips = [
    { key: 'booked', label: 'Booked', value: booked, color: COLORS.booked, hint: 'total demand', path: '/orders/history' },
    { key: 'confirmed', label: 'Confirmed', value: confirmed, color: COLORS.confirmed, hint: 'fulfilled', path: '/orders/history' },
    { key: 'pending', label: 'Indent', value: pending, color: COLORS.pending, hint: 'awaiting stock', path: '/orders/indent-history' },
    { key: 'reserved', label: 'In List', value: reserved, color: COLORS.reserved, hint: 'awaiting confirm', path: '/orders/new' },
  ];

  return (
    <div className="bg-white p-6 rounded-2xl border border-slate-200/60 shadow-sm">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="font-bold text-slate-800">Booking Conversion</h3>
        </div>
      </div>

      {loading ? (
        <div className="h-40 flex items-center justify-center text-slate-300">
          <Loader2 className="animate-spin" size={28} />
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row items-center gap-8">
          {/* Donut gauge — hero conversion rate */}
          <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
            <svg width={SIZE} height={SIZE} className="-rotate-90">
              <circle
                cx={SIZE / 2} cy={SIZE / 2} r={R}
                fill="none" stroke="#eef2f7" strokeWidth={STROKE}
              />
              <circle
                cx={SIZE / 2} cy={SIZE / 2} r={R}
                fill="none" stroke={COLORS.confirmed} strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={`${dash} ${C - dash}`}
                style={{ transition: 'stroke-dasharray 0.9s ease' }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-3xl font-bold text-slate-900 tracking-tight leading-none">{rate}%</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Converted</span>
            </div>
          </div>

          {/* Fulfilment breakdown */}
          <div className="flex-1 w-full">
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Demand Fulfilment</span>
              <span className="text-xs font-semibold text-slate-400">
                {confirmed.toLocaleString()} <ArrowRight size={11} className="inline mx-0.5 -mt-0.5" /> of {booked.toLocaleString()} booked
              </span>
            </div>

            {/* Segmented bar over total booked: confirmed | pending | in-list (2px gaps
                satisfy the contrast-relief rule; the three segments sum to booked). */}
            <div className="w-full h-5 rounded-lg bg-slate-100 overflow-hidden flex">
              {[
                { pct: confirmedPct, color: COLORS.confirmed, value: confirmed, label: 'Confirmed', align: 'justify-end pr-1.5' },
                { pct: pendingPct, color: COLORS.pending, value: pending, label: 'Pending', align: 'justify-center' },
                { pct: reservedPct, color: COLORS.reserved, value: reserved, label: 'In List', align: 'justify-start pl-1.5' },
              ].filter(s => s.pct > 0).map((s, idx, arr) => (
                <div
                  key={s.label}
                  className={`h-full flex items-center ${s.align}`}
                  style={{ width: `${s.pct}%`, backgroundColor: s.color, marginRight: idx < arr.length - 1 ? 2 : 0 }}
                  title={`${s.label}: ${s.value.toLocaleString()}`}
                >
                  {s.pct > 14 && (
                    <span className="text-[10px] font-black text-white tabular-nums">{s.value.toLocaleString()}</span>
                  )}
                </div>
              ))}
            </div>

            {/* Legend chips (identity never color-alone) */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
              {chips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => navigate(c.path)}
                  className="rounded-xl border border-slate-200/70 bg-slate-50/60 px-3 py-2.5 text-left hover:bg-slate-100 transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider truncate">{c.label}</span>
                  </div>
                  <p className="text-xl font-bold text-slate-900 mt-1 tabular-nums">{c.value.toLocaleString()}</p>
                  <p className="text-[10px] text-slate-400 font-medium">{c.hint}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConversionSummary;
