import { useEffect, useState } from "react";
import { Timer, AlertTriangle } from "lucide-react";
import { formatRemaining, MINUTE, DAY } from "../../utils/poCountdown";

/**
 * Time left to raise the PO before the booking is auto-cancelled and its
 * reserved stock returned to inventory.
 *
 * `dueAt` is an absolute timestamp from the server, so the countdown stays
 * correct as it ticks without refetching. Bookings whose PO is already raised
 * pass dueAt = null and render nothing — they are no longer at risk.
 */

export const PoCountdown = ({ dueAt, className = "" }) => {
  const [now, setNow] = useState(() => Date.now());

  // A minute is plenty for a multi-day countdown and costs nothing.
  useEffect(() => {
    if (!dueAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(id);
  }, [dueAt]);

  if (!dueAt) return null;

  const remaining = new Date(dueAt).getTime() - now;
  const overdue = remaining <= 0;
  // Under two days is worth flagging; the job cancels at the deadline.
  const urgent = !overdue && remaining < 2 * DAY;

  const tone = overdue
    ? "bg-error-50 text-error-600 border-error-200"
    : urgent
      ? "bg-warning-50 text-warning-600 border-warning-200"
      : "bg-slate-50 text-slate-600 border-slate-200";

  return (
    <span
      title={
        overdue
          ? "The PO deadline has passed — this booking will be auto-cancelled on the next run and its stock returned."
          : `PO must be raised by ${new Date(dueAt).toLocaleString()}`
      }
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border tabular-nums ${tone} ${className}`}
    >
      {overdue ? <AlertTriangle size={12} /> : <Timer size={12} />}
      {formatRemaining(remaining)}
    </span>
  );
};

export default PoCountdown;
