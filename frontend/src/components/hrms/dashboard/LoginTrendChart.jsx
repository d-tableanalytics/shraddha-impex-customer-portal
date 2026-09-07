import { useMemo } from "react";

import { LOGIN_TREND_RANGE_LIST } from "@shared/constants/dashboard.js";

/**
 * Sign-ins per day.
 *
 * The reference renders a Recharts area chart with a 7d/14d/30d switch. This
 * portal already ships Recharts, but a sparkline of at most 30 integers does not
 * need a charting library, a responsive container and a tooltip portal — an
 * inline SVG is a fraction of the weight and behaves identically at every
 * breakpoint.
 *
 * 🔴 The data behind this requires `audit-logs:view:org`. The reference gates
 * the endpoint on `dashboard:view:self`, which is in the baseline, so any
 * employee can read company-wide authentication volume from the home page. When
 * the caller lacks the audit grant the server returns nothing and this card is
 * not rendered at all.
 */
export function LoginTrendChart({ data = [], range, onRangeChange }) {
  const { path, area, peak, total } = useMemo(() => {
    if (data.length === 0) return { path: "", area: "", peak: 0, total: 0 };

    const values = data.map((d) => d.logins);
    const peakValue = Math.max(...values, 1);
    const width = 100;
    const height = 32;
    const step = data.length > 1 ? width / (data.length - 1) : width;

    const points = values.map((v, i) => {
      const x = i * step;
      // SVG y grows downward, so a taller bar is a smaller y.
      const y = height - (v / peakValue) * height;
      return [Number(x.toFixed(2)), Number(y.toFixed(2))];
    });

    const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");

    return {
      path: line,
      area: `${line} L${width},${height} L0,${height} Z`,
      peak: peakValue,
      total: values.reduce((sum, v) => sum + v, 0),
    };
  }, [data]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-2xl font-bold text-slate-900 tabular-nums leading-none">
            {total.toLocaleString("en-IN")}
          </span>
          <span className="text-[11px] text-slate-500 mt-1">
            sign-ins · peak {peak.toLocaleString("en-IN")} in a day
          </span>
        </div>

        <div
          role="group"
          aria-label="Chart range"
          className="flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-lg"
        >
          {LOGIN_TREND_RANGE_LIST.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={range === value}
              onClick={() => onRangeChange?.(value)}
              className={`px-2.5 py-1 text-[11px] font-bold rounded-md transition-colors ${
                range === value
                  ? "bg-white text-primary-700 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {data.length === 0 ? (
        <p className="text-xs text-slate-400 py-6 text-center">No sign-ins in this window.</p>
      ) : (
        <svg
          viewBox="0 0 100 32"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${total} sign-ins over the last ${range}, peaking at ${peak} in one day`}
          className="w-full h-20"
        >
          <path d={area} className="fill-primary-100" />
          <path
            d={path}
            fill="none"
            className="stroke-primary-600"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}

      {data.length > 0 && (
        <div className="flex justify-between text-[10px] text-slate-400 tabular-nums">
          <span>{data[0]?.date?.slice(5)}</span>
          <span>{data[data.length - 1]?.date?.slice(5)}</span>
        </div>
      )}
    </div>
  );
}

export default LoginTrendChart;
