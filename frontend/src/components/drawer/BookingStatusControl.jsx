import { ArrowRight } from "lucide-react";
import toast from "react-hot-toast";
import { ERPButton } from "../ui/ERPButton";
import {
  BOOKING_LIFECYCLE,
  TERMINAL_STATUSES,
  nextStageOf,
  normalizeStatus,
  stageLabel,
} from "../../constants/bookingLifecycle";

/**
 * Moving a booking through its stages: a dropdown (to correct a stage set by
 * mistake) and a button for the usual next step.
 *
 * Lives on the SALES DESK — booking status is managed there (decided
 * 2026-10-19); Booking History only shows it. Behind `manage_orders`, which the
 * server enforces on the route.
 *
 * @param {string}   status    The booking's current status.
 * @param {boolean}  busy
 * @param {Function} onChange  (newStatus) — the caller sends it.
 */
export const BookingStatusControl = ({ status, busy = false, onChange }) => {
  if (TERMINAL_STATUSES.includes(status)) {
    return <span className="text-xs font-bold text-red-600">{stageLabel(status)}</span>;
  }
  const next = nextStageOf(status);
  const current = normalizeStatus(status);
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="booking-stage">Set booking status</label>
      <select
        id="booking-stage"
        value={current}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg px-2.5 py-2
                   outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed bg-white"
      >
        {BOOKING_LIFECYCLE.map((stage) => (
          <option key={stage.key} value={stage.key}>{stage.label}</option>
        ))}
      </select>
      {next ? (
        <ERPButton variant="primary" size="sm" disabled={busy} loading={busy} onClick={() => onChange(next)}>
          {!busy && <>Move to {stageLabel(next)}<ArrowRight size={16} className="ml-2" /></>}
          {busy && "Updating…"}
        </ERPButton>
      ) : (
        <span className="text-xs font-bold text-emerald-600">Delivered — lifecycle complete</span>
      )}
    </div>
  );
};

/**
 * Tell the user what the status change did — including when the customer was
 * NOT emailed, since staff who are not told assume the customer knows.
 * `res` is the server's answer: { success, changed, message, notified, notifyError, error }.
 */
export const reportStatusChange = (res, newStatus) => {
  if (!res?.success) {
    toast.error(res?.error || "Failed to update status");
    return;
  }
  if (res.changed === false) {
    toast(res.message || "The booking was already at this status.");
    return;
  }
  if (res.notified === "sent") {
    toast.success(`Moved to ${stageLabel(newStatus)} — the customer has been emailed.`);
  } else if (res.notified === "failed" || res.notified === "skipped") {
    toast.error(
      `Moved to ${stageLabel(newStatus)}, but the customer was NOT emailed — `
        + `${res.notifyError || "see the timeline"}. You can resend it from Booking History.`,
      { duration: 8000 },
    );
  } else {
    toast.success(`Moved to ${stageLabel(newStatus)}`);
  }
};

export default BookingStatusControl;
