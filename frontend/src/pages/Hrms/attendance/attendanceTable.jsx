import { AlertCircle } from "lucide-react";

/**
 * Shared table pieces for the three Attendance tabs.
 *
 * ---------------------------------------------------------------------------
 * Density, without forking the shared table
 * ---------------------------------------------------------------------------
 * `HrmsDataTable` pads its cells `px-6 py-4`, which is right for the employee
 * directory and far too airy next to the reference's `size="middle"` tables —
 * seven columns of times and tags at that height turn a fortnight of
 * attendance into a page and a half of scrolling.
 *
 * The table already merges `col.className` over its own classes with
 * `twMerge`, and `twMerge` resolves conflicting padding utilities in favour of
 * the later one. So passing `px-4 py-2.5` per column tightens these tables and
 * changes nothing for Employees, Org Structure or Leave. No prop was added to
 * the shared component and no other screen is touched.
 */
export const CELL = "px-4 py-2.5 align-top";
export const HEAD_CELL = "px-4 py-2.5";

/** The reference paginates attendance and corrections at 15 rows. */
export const PAGE_SIZE = 15;

/**
 * The derived status, as `attendance-status.tsx` renders it.
 *
 * A tag, and beneath it the hint in small muted type — the reference shows the
 * hint BOTH in a tooltip and as a permanently visible second line
 * (`attendance-status.tsx:118-129`), because "Half day" alone does not tell
 * someone why. The second line is kept; the tooltip is folded into `title`, so
 * the same text is available to a pointer and to a screen reader without
 * needing a tooltip library.
 *
 * An icon marks the two cautionary states, so a row reads at a glance.
 */
const TONES = {
  success: "bg-success-50 text-success-600 border-success-200",
  warning: "bg-warning-50 text-warning-600 border-warning-200",
  primary: "bg-primary-50 text-primary-700 border-primary-200",
  neutral: "bg-slate-100 text-slate-600 border-slate-200",
};

export function StatusCell({ derived }) {
  if (!derived) return <span className="text-slate-400">—</span>;

  const cautionary = derived.kind === "half_day" || derived.kind === "present_partial";

  return (
    <div className="flex flex-col gap-1">
      <span
        title={derived.hint ?? undefined}
        className={`inline-flex w-fit items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${
          TONES[derived.tone] ?? TONES.neutral
        }`}
      >
        {cautionary && <AlertCircle size={11} className="shrink-0" />}
        {derived.label}
      </span>
      {derived.hint && (
        <span className="text-[10.5px] text-slate-500 leading-[1.3]">{derived.hint}</span>
      )}
    </div>
  );
}

export default StatusCell;
