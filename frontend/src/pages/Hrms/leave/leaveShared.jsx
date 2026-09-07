import { Badge } from "../../../components/ui/Badge";
import { formatDay, formatDays } from "../../../services/hrms";

/**
 * Small pieces the leave tabs share.
 *
 * Kept local to the module rather than promoted: nothing outside Leave renders
 * a leave status or a leave range, and a shared component with one consumer is
 * a shared component nobody can change safely.
 */

const STATUS = {
  pending: { label: "Pending", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  rejected: { label: "Rejected", variant: "danger" },
  cancelled: { label: "Cancelled", variant: "neutral" },
};

/** Colour is never the only signal — the word is always there too. */
export function LeaveStatusBadge({ status }) {
  const meta = STATUS[status] ?? { label: status, variant: "neutral" };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

/** `5 Jan 2026` for one day, `5 – 9 Jan 2026` for a range. */
export function LeaveRange({ startDate, endDate }) {
  if (startDate === endDate) return <span>{formatDay(startDate)}</span>;
  return (
    <span>
      {formatDay(startDate)} <span className="text-slate-400">–</span> {formatDay(endDate)}
    </span>
  );
}

const UNIT_LABEL = {
  full_day: "Full day",
  half_day: "Half day",
  hour: "Hourly",
  mixed: "Mixed",
};

/** "2 days · Full day", or "0.25 days · Hourly 10:00–12:00". */
export function LeaveDuration({ request }) {
  const unit = UNIT_LABEL[request.durationUnit] ?? request.durationUnit;
  const window =
    request.durationUnit === "hour" && request.hourFrom
      ? ` ${request.hourFrom}–${request.hourTo}`
      : "";
  const half =
    request.durationUnit === "half_day" && request.halfDayPeriod
      ? ` (${request.halfDayPeriod === "first" ? "1st" : "2nd"} half)`
      : "";

  return (
    <span className="whitespace-nowrap">
      <span className="font-semibold text-slate-800">{formatDays(request.durationValue)}</span>
      <span className="text-slate-400"> · </span>
      <span className="text-slate-500">
        {unit}
        {half}
        {window}
      </span>
    </span>
  );
}

/** The leave type, in its own colour when one is configured. */
export function LeaveTypeChip({ code, name, color }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-800"
      title={name ?? code}
    >
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10"
        style={{ background: color ?? "#94a3b8" }}
      />
      {code ?? "—"}
    </span>
  );
}
