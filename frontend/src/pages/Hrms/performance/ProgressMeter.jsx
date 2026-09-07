import { twMerge } from "tailwind-merge";

/**
 * A percentage bar with its number beside it.
 *
 * The reference uses AntD's `<Progress size="small" />` in the Goals table and
 * the calibration strip. This is the same thing in Shraddha's own primitives.
 *
 * The bar is CLAMPED at 100 while the label is not: a goal at 140% of target is
 * genuinely over-delivered, and hiding that behind a full bar would lose the
 * only interesting thing about it.
 */
export function ProgressMeter({ percent = 0, className }) {
  const value = Number.isFinite(percent) ? percent : 0;
  const width = Math.max(0, Math.min(100, value));
  const over = value > 100;

  return (
    <div className={twMerge("flex items-center gap-2", className)}>
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${value}% of target`}
        className="relative flex-1 h-1.5 rounded-full bg-slate-200 overflow-hidden"
      >
        <div
          className={twMerge(
            "absolute inset-y-0 left-0 rounded-full transition-all",
            over ? "bg-success-600" : value >= 100 ? "bg-success-600" : "bg-primary-600",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
      <span
        className={twMerge(
          "text-[11px] font-semibold tabular-nums whitespace-nowrap",
          over ? "text-success-600" : "text-slate-600",
        )}
      >
        {value}%
      </span>
    </div>
  );
}

export default ProgressMeter;
