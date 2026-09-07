import { twMerge } from "tailwind-merge";

/**
 * A completion bar with its count beside it.
 *
 * The reference uses AntD's `<Progress size="small" format={() => "n / m"} />`
 * in both the Checklists table and the new-hire portal. This is the same thing
 * in Shraddha's own primitives — one component rather than the two slightly
 * different bars that would otherwise appear.
 *
 * `role="progressbar"` with the aria value attributes so the number is
 * available to a screen reader, not only to the eye.
 */
export function ProgressBar({ completed = 0, total = 0, className, showCount = true }) {
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  const done = total > 0 && completed >= total;

  return (
    <div className={twMerge("flex items-center gap-2", className)}>
      <div
        role="progressbar"
        aria-valuenow={completed}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`${completed} of ${total} tasks complete`}
        className="relative flex-1 h-1.5 rounded-full bg-slate-200 overflow-hidden"
      >
        <div
          className={twMerge(
            "absolute inset-y-0 left-0 rounded-full transition-all",
            done ? "bg-success-600" : "bg-primary-600",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {showCount && (
        <span className="text-[11px] font-semibold text-slate-600 tabular-nums whitespace-nowrap">
          {completed} / {total}
        </span>
      )}
    </div>
  );
}

export default ProgressBar;
