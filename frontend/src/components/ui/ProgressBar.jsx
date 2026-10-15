/**
 * A progress bar for anything that takes noticeable time.
 *
 * Determinate when the work reports real progress (an upload's bytes, an
 * import job's processed rows): pass `value` 0–100 and the percentage is shown.
 * Indeterminate when it cannot (a single request the server answers when it is
 * done): leave `value` undefined and the bar sweeps instead — never a made-up
 * percentage that stalls at 99.
 *
 * Replaces the bars that were copied inline into the import wizard and the
 * product-image uploads.
 *
 * @param {number}  [value]   0–100, or undefined for indeterminate.
 * @param {string}  [label]   What is happening ("Uploading file…").
 * @param {string}  [detail]  Secondary line ("120 of 480 rows").
 * @param {'primary'|'success'|'warning'} [tone]
 */
const TONES = {
  primary: "bg-primary-600",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
};

export const ProgressBar = ({ value, label, detail, tone = "primary", className = "" }) => {
  const determinate = Number.isFinite(value);
  const pct = determinate ? Math.max(0, Math.min(100, Math.round(value))) : null;

  return (
    <div className={`w-full ${className}`}>
      {(label || determinate) && (
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          {label && <span className="text-xs font-semibold text-slate-700">{label}</span>}
          {determinate && <span className="text-xs font-bold text-slate-500 tabular-nums">{pct}%</span>}
        </div>
      )}
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label={label || "Working"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? pct : undefined}
      >
        {determinate ? (
          <div className={`h-full rounded-full transition-all duration-300 ${TONES[tone]}`} style={{ width: `${pct}%` }} />
        ) : (
          <div className={`absolute inset-y-0 w-1/3 rounded-full ${TONES[tone]} animate-[progress-sweep_1.2s_ease-in-out_infinite]`} />
        )}
      </div>
      {detail && <p className="mt-1 text-[11px] text-slate-500">{detail}</p>}
    </div>
  );
};

export default ProgressBar;
