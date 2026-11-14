import { useDeferredValue, useState } from 'react';
import {
  ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { Card, CardContent } from '../ui/Card';
import { SkeletonLoader } from '../ui/SkeletonLoader';
import { DEFAULT_TREND_RANGE, useDashboardTrend } from '../../store/homeDashboardStore';
import { Download, TrendingUp, ChevronDown, BarChart3 } from 'lucide-react';
import { WidgetHeader } from './WidgetHeader';
import { SERIES } from './dashboardPalette';

// Shared with the conversion panel, so Booked / Confirmed match across both.
// (`booked` was missing here before, which left the Booked line on recharts'
// fallback colour and its fill gradient black.)
const COLORS = SERIES;

// The two plotted series, in legend order.
const PLOTTED = [
  { key: 'booked', label: 'Booked', color: COLORS.booked },
  { key: 'confirmed', label: 'Confirmed', color: COLORS.confirmed },
];

// Y ticks in full below 10,000, compact (10K, 1.2L) once the axis reaches it.
const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const formatTick = (v) => (Math.abs(v) >= 10000 ? compact.format(v) : v.toLocaleString());

// Custom tooltip — shows demand vs fulfilled and the pending gap for the month.
const TrendTooltip = ({ active, payload, label }) => {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const items = [
    { label: 'Booked', value: row.booked, color: COLORS.booked },
    { label: 'Confirmed', value: row.confirmed, color: COLORS.confirmed },
    { label: 'Unfulfilled', value: row.unfulfilled, color: COLORS.pending },
  ];
  return (
    <div className="min-w-44 rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-lg">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      <div className="flex flex-col gap-1.5">
        {items.map((it) => (
          <div key={it.label} className="flex items-center justify-between gap-6 text-xs">
            <span className="flex items-center gap-2 font-semibold text-slate-600">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: it.color }} />
              {it.label}
            </span>
            <span className="font-bold tabular-nums text-slate-900">{(it.value ?? 0).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const RANGE_OPTIONS = [
  { value: '15d', label: 'Last 15 Days' },
  { value: '1m', label: 'Last 1 Month' },
  { value: '3m', label: 'Last 3 Months' },
  { value: '6m', label: 'Last 6 Months' },
  { value: '12m', label: 'Last 12 Months' },
];

export const RevenueChart = () => {
  const [range, setRange] = useState(DEFAULT_TREND_RANGE);
  // The default range is read from the dashboard's shared payload; any other
  // range is requested once, when it is first chosen.
  const { trend: latestTrend, loading: trendLoading } = useDashboardTrend(range);
  // The chart is the most expensive thing on the dashboard to draw, and it now
  // arrives in the same response as the KPI tiles. Deferring it lets React paint
  // the tiles first and draw the chart in a follow-up render; until then the
  // chart keeps its placeholder rather than flashing "no data".
  const trend = useDeferredValue(latestTrend);
  const loading = trendLoading || trend !== latestTrend;

  // Range totals, shown beside each legend key.
  const totals = trend.reduce(
    (acc, row) => ({ booked: acc.booked + (row.booked || 0), confirmed: acc.confirmed + (row.confirmed || 0) }),
    { booked: 0, confirmed: 0 },
  );
  const rangeLabel = RANGE_OPTIONS.find((o) => o.value === range)?.label;
  const hasData = !loading && trend.length > 0;

  const handleExport = () => {
    if (trend.length === 0) return;

    const headers = Object.keys(trend[0]);
    const csvRows = [headers.join(',')];

    for (const row of trend) {
      const values = headers.map(header => {
        const val = row[header] !== null && row[header] !== undefined ? String(row[header]) : '';
        return `"${val.replace(/"/g, '""')}"`;
      });
      csvRows.push(values.join(','));
    }

    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `order_trend_${range}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Card className="h-full rounded-2xl border-slate-200/80">
      <CardContent className="dash-chart flex h-full flex-col p-5 sm:p-6">
        <WidgetHeader
          icon={TrendingUp}
          accent="indigo"
          title="Demand vs Fulfilment"
          subtitle="Units booked against units confirmed"
          actions={
            <>
              <button
                onClick={handleExport}
                disabled={loading || trend.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 disabled:cursor-not-allowed disabled:opacity-50"
                title="Export as CSV"
              >
                <Download size={14} />
                Export
              </button>
              <div className="relative">
                <select
                  value={range}
                  onChange={(e) => setRange(e.target.value)}
                  aria-label="Date range"
                  className="cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-3 pr-8 text-xs font-semibold text-slate-700 outline-none transition-colors hover:border-slate-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
                >
                  {RANGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            </>
          }
        />

        {/* Legend — always present for the two series — carrying each one's
            total over the selected range. */}
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {PLOTTED.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-0.75 w-4 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="text-xs font-semibold text-slate-500">{s.label}</span>
              {hasData && <span className="text-sm font-bold text-slate-800">{totals[s.key].toLocaleString()}</span>}
            </div>
          ))}
          {hasData && <span className="ml-auto text-[11px] font-medium text-slate-400">Totals · {rangeLabel}</span>}
        </div>

        {loading ? (
          <SkeletonLoader className="mt-3 h-72 w-full rounded-xl opacity-60" aria-busy="true" />
        ) : trend.length === 0 ? (
          <div className="mt-3 flex h-72 flex-col items-center justify-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
              <BarChart3 size={22} aria-hidden="true" />
            </span>
            <p className="text-sm font-medium text-slate-400">No order data available yet</p>
          </div>
        ) : (
          <div className="mt-3 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={trend}
                margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="fillBooked" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.booked} stopOpacity={0.16}/>
                    <stop offset="100%" stopColor={COLORS.booked} stopOpacity={0.01}/>
                  </linearGradient>
                  <linearGradient id="fillConfirmed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.confirmed} stopOpacity={0.2}/>
                    <stop offset="100%" stopColor={COLORS.confirmed} stopOpacity={0.02}/>
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="#eef2f7" />
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: '#64748b', fontWeight: 600 }}
                  dy={10}
                  interval="preserveStartEnd"
                  minTickGap={20}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: '#94a3b8', fontWeight: 500 }}
                  allowDecimals={false}
                  tickFormatter={formatTick}
                  width={44}
                />
                <Tooltip content={<TrendTooltip />} cursor={{ stroke: '#94a3b8', strokeWidth: 1 }} />
                {/* Booked = demand ceiling (indigo line + faint wash) */}
                <Area
                  name="Book" dataKey="booked" type="monotone"
                  stroke={COLORS.booked} strokeWidth={2} fill="url(#fillBooked)"
                  dot={false}
                  activeDot={{ r: 5, strokeWidth: 2 }} animationDuration={900}
                />
                {/* Confirmed = fulfilled portion (emerald, under the ceiling) */}
                <Area
                  name="Confirmed" dataKey="confirmed" type="monotone"
                  stroke={COLORS.confirmed} strokeWidth={2} fill="url(#fillConfirmed)"
                  dot={false}
                  activeDot={{ r: 5, strokeWidth: 2 }} animationDuration={900}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
