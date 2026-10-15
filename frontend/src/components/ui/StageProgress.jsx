import { Check, Loader2, X } from "lucide-react";

/**
 * The stages of a multi-step operation, with the current one highlighted:
 * Reading file → Validating rows → Ready, or Uploading → Processing → Done.
 *
 * Stages before the current one show a tick, the current one a spinner (or a
 * cross when it failed), later ones are greyed. Says WHERE a long operation is,
 * which a lone spinner cannot.
 *
 * @param {{key: string, label: string}[]} stages
 * @param {string}  current   Key of the stage now running.
 * @param {boolean} [failed]  The current stage failed.
 * @param {boolean} [done]    Every stage is complete.
 */
export const StageProgress = ({ stages, current, failed = false, done = false, className = "" }) => {
  const at = stages.findIndex((s) => s.key === current);
  return (
    <ol className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`} aria-label="Progress">
      {stages.map((s, i) => {
        const state = done || i < at ? "done" : i === at ? (failed ? "failed" : "active") : "todo";
        return (
          <li key={s.key} className="flex items-center gap-2" aria-current={state === "active" ? "step" : undefined}>
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                state === "done" ? "bg-emerald-500 text-white"
                  : state === "active" ? "bg-primary-100 text-primary-700"
                    : state === "failed" ? "bg-red-100 text-red-600"
                      : "bg-slate-100 text-slate-400"
              }`}
            >
              {state === "done" && <Check size={12} strokeWidth={3} />}
              {state === "active" && <Loader2 size={12} className="animate-spin" />}
              {state === "failed" && <X size={12} strokeWidth={3} />}
              {state === "todo" && <span className="text-[10px] font-bold">{i + 1}</span>}
            </span>
            <span
              className={`text-xs font-semibold whitespace-nowrap ${
                state === "todo" ? "text-slate-400" : state === "failed" ? "text-red-600" : "text-slate-700"
              }`}
            >
              {s.label}
            </span>
            {i < stages.length - 1 && <span className="w-6 h-px bg-slate-200" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
};

export default StageProgress;
