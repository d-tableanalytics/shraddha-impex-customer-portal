import { useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowUpRight, Target } from 'lucide-react';
import { useDashboardStats } from '../../store/homeDashboardStore';
import { Card, CardContent } from '../ui/Card';
import { SkeletonLoader } from '../ui/SkeletonLoader';
import { WidgetHeader } from './WidgetHeader';
import { SERIES } from './dashboardPalette';

// Booking-to-Order conversion. Hero: a ring gauge of the conversion rate.
// Right: a segmented fulfilment bar (confirmed | indent | in list) over total
// booked, and a legend of clickable chips. Colours come from the dashboard's
// shared palette, so these quantities match the trend chart beside them.
const COLORS = SERIES;

// Text printed INSIDE a bar segment is near-black or white by the fill's
// luminance — never the series colour — and the same in both themes.
const INK = { dark: '#0f172a', light: '#ffffff' };

export const ConversionSummary = () => {
  const navigate = useNavigate();
  // Shared with the other dashboard widgets: one request between them.
  const { stats, loading } = useDashboardStats();

  // The fulfilment bar's width, for deciding which values fit inside it.
  const barRef = useRef(null);
  const [barWidth, setBarWidth] = useState(0);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;
    setBarWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setBarWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  const booked = stats?.totalBooked ?? 0;
  const confirmed = stats?.totalConfirmed ?? 0;
  const pending = stats?.totalPending ?? 0;
  const reserved = stats?.totalReserved ?? 0; // in selection list, awaiting confirmation
  const rate = stats?.conversionRate ?? 0;

  // Gauge geometry
  const SIZE = 160, STROKE = 14;
  const R = (SIZE - STROKE) / 2;
  const C = 2 * Math.PI * R;
  const dash = C * Math.min(100, Math.max(0, rate)) / 100;

  const pct = (v) => (booked > 0 ? (v / booked) * 100 : 0);
  const share = (v) => `${Math.round(pct(v))}%`;

  const chips = [
    { key: 'booked', label: 'Booked', value: booked, color: COLORS.booked, hint: 'total demand', path: '/orders/history' },
    { key: 'confirmed', label: 'Confirmed', value: confirmed, color: COLORS.confirmed, hint: 'fulfilled', path: '/orders/history' },
    { key: 'pending', label: 'Indent', value: pending, color: COLORS.pending, hint: 'awaiting stock', path: '/orders/indent-history' },
    { key: 'reserved', label: 'In List', value: reserved, color: COLORS.reserved, hint: 'awaiting confirm', path: '/orders/new' },
  ];

  // The three parts of booked demand, as shares of it. A part at zero draws nothing.
  const segments = [
    { label: 'Confirmed', value: confirmed, pct: pct(confirmed), color: COLORS.confirmed, ink: INK.dark },
    { label: 'Pending', value: pending, pct: pct(pending), color: COLORS.pending, ink: INK.dark },
    { label: 'In List', value: reserved, pct: pct(reserved), color: COLORS.reserved, ink: INK.light },
  ].filter((s) => s.pct > 0);

  // A value is printed inside its block only when it fits with padding, judged
  // against the bar's measured width — clipping it would be worse than leaving
  // it to the tooltip and the legend chips below.
  const labelFits = (s) =>
    (barWidth * s.pct) / 100 - 2 >= s.value.toLocaleString().length * 7 + 16;

  const barLabel = segments.length
    ? `Booked demand: ${segments.map((s) => `${s.label} ${s.value.toLocaleString()} (${share(s.value)})`).join(', ')}`
    : 'No booked demand yet';

  return (
    <Card className="rounded-2xl border-slate-200/80">
      <CardContent className="p-5 sm:p-6">
        <WidgetHeader
          icon={Target}
          accent="emerald"
          title="Booking Conversion"
          subtitle="How booked demand is turning into confirmed orders"
        />

        {loading ? (
          <div className="mt-6 flex flex-col items-center gap-8 lg:flex-row" aria-busy="true">
            <SkeletonLoader variant="circular" className="h-40 w-40 shrink-0" />
            <div className="flex w-full flex-1 flex-col gap-4">
              <SkeletonLoader variant="text" className="h-3.5 w-1/3" />
              <SkeletonLoader variant="text" className="h-7 w-full rounded-md" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                {chips.map((c) => <SkeletonLoader key={c.key} className="h-21.5 rounded-xl" />)}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-6 flex flex-col items-center gap-8 lg:flex-row">
            {/* Ring gauge — hero conversion rate. The track is a light step of
                the same green, so the whole ring reads as one meter. */}
            <div
              className="relative shrink-0"
              style={{ width: SIZE, height: SIZE }}
              role="img"
              aria-label={`${rate}% of booked demand converted`}
            >
              <svg width={SIZE} height={SIZE} className="-rotate-90" aria-hidden="true">
                <defs>
                  <linearGradient id="dashGaugeFill" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#34d399" />
                    <stop offset="100%" stopColor={COLORS.confirmed} />
                  </linearGradient>
                </defs>
                <circle
                  cx={SIZE / 2} cy={SIZE / 2} r={R}
                  fill="none" strokeWidth={STROKE}
                  className="dash-gauge-track"
                />
                <motion.circle
                  cx={SIZE / 2} cy={SIZE / 2} r={R}
                  fill="none" stroke="url(#dashGaugeFill)" strokeWidth={STROKE}
                  strokeLinecap={dash > 0 ? 'round' : 'butt'}
                  initial={{ strokeDasharray: `0 ${C}` }}
                  animate={{ strokeDasharray: `${dash} ${C - dash}` }}
                  transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[34px] font-bold leading-none tracking-tight text-slate-900">{rate}%</span>
                <span className="mt-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Converted</span>
              </div>
            </div>

            {/* Fulfilment breakdown */}
            <div className="w-full min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-sm font-semibold text-slate-700">Demand fulfilment</span>
                <span className="text-xs font-medium text-slate-500">
                  <span className="font-bold text-slate-800">{confirmed.toLocaleString()}</span> confirmed of{' '}
                  <span className="font-bold text-slate-800">{booked.toLocaleString()}</span> booked
                </span>
              </div>

              {/* Segmented bar over total booked: confirmed | pending | in-list.
                  Each part is its own block with a 2px gap; its value is printed
                  inside only when the block is wide enough to hold it. */}
              <div ref={barRef} className="mt-3 flex h-7 w-full rounded-md bg-slate-100" role="img" aria-label={barLabel}>
                {segments.map((s, idx, arr) => {
                  const gap = idx < arr.length - 1 ? 2 : 0;
                  return (
                    <div
                      key={s.label}
                      className="flex h-full items-center rounded-sm transition-[width] duration-700"
                      // No padding on the block itself: a 1% part must stay 1% wide.
                      // A minimum of 3px keeps a tiny non-zero part visible.
                      style={{ width: `calc(${s.pct}% - ${gap}px)`, minWidth: 3, marginRight: gap, backgroundColor: s.color }}
                      title={`${s.label}: ${s.value.toLocaleString()} (${share(s.value)})`}
                    >
                      {labelFits(s) && (
                        <span className="px-2 text-[11px] font-bold" style={{ color: s.ink }}>{s.value.toLocaleString()}</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Legend chips (identity never colour-alone): each opens the
                  screen behind its number. */}
              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                {chips.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => navigate(c.path)}
                    className="group rounded-xl border border-slate-200/80 bg-slate-50/60 px-3.5 py-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                        <span className="truncate text-xs font-semibold text-slate-600">{c.label}</span>
                      </span>
                      <ArrowUpRight size={14} aria-hidden="true" className="shrink-0 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    <p className="mt-1.5 text-xl font-bold text-slate-900">{c.value.toLocaleString()}</p>
                    <p className="text-[11px] font-medium text-slate-400">{c.hint}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ConversionSummary;
