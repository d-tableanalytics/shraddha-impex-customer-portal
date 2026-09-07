import { Check } from "lucide-react";

import { Badge } from "../../../components/ui/Badge";
import {
  EXIT_STEPS,
  EXIT_STATUS_LABELS,
  CLEARANCE_STATUS_LABELS,
} from "../../../services/hrms";

/**
 * Small pieces the exit tabs share.
 *
 * Components only — the date helpers live in `services/hrms`, alongside the API
 * whose output they format.
 */

/** The reference's antd palette, translated: blue/cyan/gold/orange/lime/green. */
const EXIT_STATUS = {
  initiated: "primary",
  manager_approved: "primary",
  in_notice: "warning",
  clearance_pending: "warning",
  cleared: "success",
  f_and_f_pending: "warning",
  closed: "success",
  cancelled: "neutral",
};

const CLEARANCE_STATUS = {
  pending: "neutral",
  in_progress: "primary",
  completed: "success",
  waived: "warning",
};

/** Colour is never the only signal — the word is always there too. */
export function ExitStatusBadge({ status }) {
  return (
    <Badge variant={EXIT_STATUS[status] ?? "neutral"}>
      {EXIT_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function ClearanceStatusBadge({ status }) {
  return (
    <Badge variant={CLEARANCE_STATUS[status] ?? "neutral"}>
      {CLEARANCE_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/**
 * The exit's progress through the chain.
 *
 * A cancelled exit shows no progress at all rather than a half-filled track:
 * it did not get part-way, it stopped.
 */
export function ExitProgress({ status }) {
  if (status === "cancelled") {
    return (
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
        This exit was withdrawn.
      </p>
    );
  }

  const current = EXIT_STEPS.findIndex((step) => step.key === status);

  return (
    <ol className="flex flex-wrap items-center gap-y-3" aria-label="Exit progress">
      {EXIT_STEPS.map((step, index) => {
        const done = current > index;
        const active = current === index;
        return (
          <li key={step.key} className="flex items-center">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={[
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                  done
                    ? "border-success-200 bg-success-50 text-success-600"
                    : active
                      ? "border-primary-600 bg-primary-600 text-white"
                      : "border-slate-200 bg-white text-slate-400",
                ].join(" ")}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span
                className={[
                  "text-xs font-medium whitespace-nowrap",
                  active ? "text-slate-900" : done ? "text-slate-600" : "text-slate-400",
                ].join(" ")}
              >
                {step.label}
              </span>
            </div>
            {index < EXIT_STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className={`mx-2 h-px w-6 ${done ? "bg-success-200" : "bg-slate-200"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** How far through the clearances this exit is. */
export function ClearanceProgress({ clearances = [] }) {
  const total = clearances.length;
  if (total === 0) return null;

  const done = clearances.filter(
    (c) => c.status === "completed" || c.status === "waived",
  ).length;
  const percent = Math.round((done / total) * 100);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
        <span>
          {done} of {total} cleared
        </span>
        <span>{percent}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Clearance progress"
      >
        <div
          className="h-full rounded-full bg-success-500 transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** A labelled value in the detail grids both tabs use. */
export function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children ?? "—"}</dd>
    </div>
  );
}
