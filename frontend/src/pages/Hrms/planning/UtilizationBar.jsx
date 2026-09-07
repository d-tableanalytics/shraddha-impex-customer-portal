import { twMerge } from "tailwind-merge";

/**
 * Actual headcount against planned headcount.
 *
 * The reference renders AntD's `<Progress percent={...} size="small" />` in
 * both the Utilization column and the Actual Headcount tile. This is that, in
 * Shraddha's own primitives.
 *
 * NOT `performance/ProgressMeter`, despite looking similar: there, over 100% of
 * a target is over-delivery and turns green. Here, more people than were
 * planned for is over-hiring against a signed-off budget — the opposite
 * reading. So the bar is clamped and the label is not, and the colour above
 * plan is a warning rather than a success.
 */
export function UtilizationBar({ actual = 0, planned = 0, className }) {
  const percent = planned ? Math.round((actual / planned) * 100) : 0;
  const width = Math.max(0, Math.min(100, percent));
  const over = planned > 0 && actual > planned;

  return (
    <div className={twMerge("flex items-center gap-2", className)}>
      <div
        role="progressbar"
        aria-valuenow={actual}
        aria-valuemin={0}
        aria-valuemax={planned}
        aria-label={`${actual} of ${planned} planned`}
        className="relative flex-1 h-1.5 rounded-full bg-slate-200 overflow-hidden"
      >
        <div
          className={twMerge(
            "absolute inset-y-0 left-0 rounded-full transition-all",
            over ? "bg-warning-500" : percent >= 100 ? "bg-success-600" : "bg-primary-600",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
      <span
        className={twMerge(
          "text-[11px] font-semibold tabular-nums whitespace-nowrap",
          over ? "text-warning-600" : "text-slate-600",
        )}
      >
        {percent}%
      </span>
    </div>
  );
}

export default UtilizationBar;
