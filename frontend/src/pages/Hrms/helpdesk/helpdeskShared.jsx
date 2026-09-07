import { Badge } from "../../../components/ui/Badge";
import {
  TICKET_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
  RESOLVER_TEAM_LABELS,
  formatSla,
} from "../../../services/hrms";

/**
 * Small pieces the helpdesk tabs share.
 */

/** The reference's antd palette, translated: blue/gold/purple/green/default. */
const STATUS = {
  open: "primary",
  assigned: "warning",
  in_progress: "primary",
  resolved: "success",
  closed: "neutral",
};

const PRIORITY = {
  low: "neutral",
  normal: "primary",
  high: "warning",
  urgent: "danger",
};

/** Colour is never the only signal — the word is always there too. */
export function TicketStatusBadge({ status }) {
  return (
    <Badge variant={STATUS[status] ?? "neutral"}>
      {TICKET_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function PriorityBadge({ priority }) {
  return (
    <Badge variant={PRIORITY[priority] ?? "neutral"}>
      {TICKET_PRIORITY_LABELS[priority] ?? priority}
    </Badge>
  );
}

export function TeamBadge({ resolverModule }) {
  return (
    <Badge variant="neutral">{RESOLVER_TEAM_LABELS[resolverModule] ?? resolverModule}</Badge>
  );
}

/**
 * The SLA countdown.
 *
 * A live ticket shows how long is left; a breached one says so. The reference
 * renders only the breach, so a ticket an hour from breaching looks the same as
 * one raised a minute ago.
 */
export function SlaIndicator({ ticket }) {
  const settled = ticket.status === "resolved" || ticket.status === "closed";
  if (settled) return <span className="text-xs text-slate-400">—</span>;

  const urgent = !ticket.slaBreached && ticket.slaHoursRemaining < 4;
  const tone = ticket.slaBreached
    ? "text-error-600"
    : urgent
      ? "text-warning-600"
      : "text-slate-500";

  return <span className={`text-xs font-medium ${tone}`}>{formatSla(ticket)}</span>;
}

/** Subject, number and category in one cell. */
export function TicketIdentity({ ticket }) {
  return (
    <div className="leading-tight">
      <div className="font-medium text-slate-900">{ticket.subject}</div>
      <div className="text-xs text-slate-500">
        <span className="font-mono">{ticket.ticketNumber}</span>
        {ticket.categoryName ? ` · ${ticket.categoryName}` : ""}
      </div>
    </div>
  );
}

/** A labelled value in the detail grid. */
export function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children ?? "—"}</dd>
    </div>
  );
}
