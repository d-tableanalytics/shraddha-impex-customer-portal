import { useDeferredValue, useState } from 'react';
import {
  ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { Card, CardContent } from '../ui/Card';
import { DEFAULT_TREND_RANGE, useDashboardTrend } from '../../store/homeDashboardStore';
import { Loader2, Download } from 'lucide-react';

const COLORS = { order: '#6366f1', confirmed: '#10b981', confirmedEdge: '#059669', pending: '#f59e0b' };

// Custom tooltip — shows demand vs fulfilled and the pending gap for the month.
const TrendTooltip = ({ active, payload, label }) => {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const items = [
    { label: 'Booking', value: row.booked, color: COLORS.booked },
    { label: 'Confirmed', value: row.confirmed, color: COLORS.confirmed },
    { label: 'Unfulfilled', value: row.unfulfilled, color: COLORS.pending },
  ];
  return (
    <div className="rounded-xl bg-white shadow-lg border border-slate-100 px-3.5 py-2.5">
      <p className="text-[11px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">{label}</p>
      <div className="flex flex-col gap-1">
        {items.map((it) => (
          <div key={it.label} className="flex items-center justify-between gap-6 text-xs">
            <span className="flex items-center gap-1.5 font-semibold text-slate-600">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: it.color }} />
              {it.label}
            </span>
            <span className="font-black text-slate-900 tabular-nums">{(it.value ?? 0).toLocaleString()}</span>
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
  // chart keeps its spinner rather than flashing "no data".
  const trend = useDeferredValue(latestTrend);
  const loading = trendLoading || trend !== latestTrend;

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
    <Card className="h-full">
      <CardContent className="p-6 h-full flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="font-bold text-slate-800">Demand vs Fulfilment</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExport}
              disabled={loading || trend.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 hover:bg-primary-100 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Export as CSV"
            >
              <Download size={14} />
              Export
            </button>
            <select
              value={range}
              onChange={(e) => setRange(e.target.value)}
              className="text-xs bg-slate-50 text-slate-600 border border-slate-200 font-bold px-2 py-1.5 rounded-md outline-none cursor-pointer focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            >
              {RANGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <div className="flex-1 min-h-65 flex items-center justify-center text-slate-300">
            <Loader2 className="animate-spin" size={32} />
          </div>
        ) : trend.length === 0 ? (
          <div className="flex-1 min-h-65 flex items-center justify-center text-slate-400 text-sm">
            No order data available yet
          </div>
        ) : (
          <div className="flex-1 min-h-65 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={trend}
                margin={{ top: 10, right: 8, left: -12, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="fillBooked" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.booked} stopOpacity={0.22}/>
                    <stop offset="100%" stopColor={COLORS.booked} stopOpacity={0.02}/>
                  </linearGradient>
                  <linearGradient id="fillConfirmed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.confirmed} stopOpacity={0.45}/>
                    <stop offset="100%" stopColor={COLORS.confirmed} stopOpacity={0.06}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef2f7" />
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
                  width={32}
                />
                <Tooltip content={<TrendTooltip />} cursor={{ stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Legend
                  verticalAlign="top"
                  align="right"
                  height={28}
                  iconType="circle"
                  wrapperStyle={{ fontSize: 12, fontWeight: 600 }}
                />
                {/* Booked = demand ceiling (indigo line + faint fill) */}
                <Area
                  name="Book" dataKey="booked" type="monotone"
                  stroke={COLORS.booked} strokeWidth={2} fill="url(#fillBooked)"
                  dot={{ r: 3, fill: COLORS.booked, strokeWidth: 0 }}
                  activeDot={{ r: 5 }} animationDuration={1000}
                />
                {/* Confirmed = fulfilled portion (emerald filled area under the ceiling) */}
                <Area
                  name="Confirmed" dataKey="confirmed" type="monotone"
                  stroke={COLORS.confirmedEdge} strokeWidth={2} fill="url(#fillConfirmed)"
                  dot={{ r: 3, fill: COLORS.confirmedEdge, strokeWidth: 0 }}
                  activeDot={{ r: 5 }} animationDuration={1000}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
