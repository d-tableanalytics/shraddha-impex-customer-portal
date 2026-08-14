import { CheckCircle2, Circle, Check, Ban, MailCheck, MailWarning, MailX, RefreshCw } from "lucide-react";
import {
  BOOKING_LIFECYCLE,
  TERMINAL_STATUSES,
  normalizeStatus,
  stageLabel,
  fmtStatusDateTime,
} from "../../constants/bookingLifecycle";

/**
 * The booking's lifecycle, with the stage it has reached highlighted.
 *
 * The four stages are always drawn, reached or not, so the customer can see
 * what is still to come rather than only what has happened. `history` — the
 * recorded status events from GET /orders/booking/:id/timeline — supplies the
 * date and time each stage was reached; without it the component still renders,
 * which is what the drawer shows while the timeline is loading.
 *
 * `notifications` is staff-only and comes from the same endpoint. It is drawn
 * beside the stage it belongs to rather than in a separate panel: "Dispatched
 * on 14 Aug" and "the customer was never told" are one fact, and an admin
 * should not have to correlate two lists to see it.
 */

const NOTIFICATION_STYLES = {
  sent: {
    Icon: MailCheck,
    className: "text-emerald-600",
    text: (n) => `Emailed to ${n.recipient || "the customer"}`,
  },
  failed: {
    Icon: MailX,
    className: "text-red-600",
    text: (n) => `Email failed — ${n.error || "the mail server could not be reached"}`,
  },
  skipped: {
    Icon: MailWarning,
    className: "text-amber-600",
    text: (n) => `Not emailed — ${n.reason || "no address on the account"}`,
  },
  pending: {
    Icon: MailWarning,
    className: "text-slate-400",
    text: () => "Email not yet attempted",
  },
  not_applicable: {
    Icon: MailCheck,
    className: "text-slate-400",
    text: (n) => n.reason || "No status email applies to this stage",
  },
};

const NotificationLine = ({ notification, onResend, resending }) => {
  const style = NOTIFICATION_STYLES[notification?.state];
  if (!style) return null;
  const { Icon, className, text } = style;
  const canResend = ["failed", "skipped", "pending"].includes(notification.state);

  return (
    <div className={`flex items-start gap-1.5 mt-1 text-[11px] font-medium ${className}`}>
      <Icon size={12} className="mt-0.5 shrink-0" />
      <span className="leading-snug">
        {text(notification)}
        {notification.attempts > 1 && ` (${notification.attempts} attempts)`}
        {canResend && onResend && (
          <button
            type="button"
            onClick={onResend}
            disabled={resending}
            className="ml-2 inline-flex items-center gap-1 font-bold text-indigo-600
                       hover:text-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={10} className={resending ? "animate-spin" : ""} />
            {resending ? "Sending…" : "Resend"}
          </button>
        )}
      </span>
    </div>
  );
};

export const OrderTimeline = ({
  currentStatus,
  history = [],
  showNotifications = false,
  onResend,
  resendingId = null,
}) => {
  const status = normalizeStatus(currentStatus);
  const isTerminal = TERMINAL_STATUSES.includes(status);
  const currentIdx = BOOKING_LIFECYCLE.findIndex((s) => s.key === status);

  // The recorded event for each stage. The LAST event for a stage wins: a
  // booking sent back a stage and advanced again should show when it most
  // recently reached it, not the first time.
  const eventByStage = new Map();
  for (const event of history) {
    eventByStage.set(normalizeStatus(event.status), event);
  }
  const cancellation = history.find((e) => TERMINAL_STATUSES.includes(e.status));

  return (
    <div className="flex flex-col relative py-2">
      <div className="absolute left-3.5 top-4 bottom-8 w-0.5 bg-slate-200 z-0" />

      {BOOKING_LIFECYCLE.map((stage, idx) => {
        const isCompleted = currentIdx >= 0 && idx <= currentIdx;
        const isCurrent = idx === currentIdx;
        const event = eventByStage.get(stage.key);

        let icon = <Circle size={16} className="text-slate-300 fill-white" />;
        if (isCompleted && !isCurrent) {
          icon = <CheckCircle2 size={16} className="text-primary-600 fill-primary-100" />;
        }
        if (isCurrent) {
          icon = <Check size={16} className="text-white" />;
        }

        return (
          <div key={stage.key} className="flex gap-4 relative z-10 group">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-2 mt-0.5 ${
                isCurrent
                  ? "bg-primary-600 border-primary-600"
                  : isCompleted
                    ? "bg-white border-transparent"
                    : "bg-white border-slate-200"
              }`}
            >
              {icon}
            </div>

            <div className="flex flex-col pb-6 min-w-0">
              <span
                className={`text-sm font-bold ${
                  isCurrent
                    ? "text-primary-700"
                    : isCompleted
                      ? "text-slate-800"
                      : "text-slate-400"
                }`}
              >
                {stage.label}
              </span>

              {isCurrent && (
                <span className="text-[11px] font-semibold text-primary-600 mt-0.5">Current stage</span>
              )}

              {/* When it happened. Only for stages actually reached — a date
                  against a stage still to come would read as a promise. */}
              {isCompleted && event && (
                <span className="text-[11px] text-slate-500 mt-0.5">
                  {fmtStatusDateTime(event.changedAt)}
                  {event.changedByName && event.changedByName !== "System" && (
                    <span className="text-slate-400"> · by {event.changedByName}</span>
                  )}
                </span>
              )}

              {/* The stage description — the same sentence the email carries,
                  so the two never appear to say different things. */}
              <span
                className={`text-[11px] mt-1 leading-snug ${
                  isCurrent ? "text-slate-600" : "text-slate-400"
                }`}
              >
                {stage.description}
              </span>

              {isCurrent && stage.nextStep && (
                <span className="text-[11px] text-slate-500 mt-1 leading-snug italic">
                  {stage.nextStep}
                </span>
              )}

              {showNotifications && event?.notification && (
                <NotificationLine
                  notification={event.notification}
                  onResend={
                    event.id && onResend && !event.derived ? () => onResend(event.id) : null
                  }
                  resending={resendingId === event.id}
                />
              )}
            </div>
          </div>
        );
      })}

      {isTerminal && (
        <div className="flex gap-4 relative z-10 group mt-2">
          <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-2 bg-error-600 border-error-600 mt-0.5">
            <Ban size={15} className="text-white" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-bold text-error-700">{stageLabel(currentStatus)}</span>
            <span className="text-[11px] font-semibold text-error-500 mt-0.5">Booking closed</span>
            {cancellation && (
              <>
                <span className="text-[11px] text-slate-500 mt-0.5">
                  {fmtStatusDateTime(cancellation.changedAt)}
                </span>
                {cancellation.remarks && (
                  <span className="text-[11px] text-slate-400 mt-1 leading-snug">
                    {cancellation.remarks}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
