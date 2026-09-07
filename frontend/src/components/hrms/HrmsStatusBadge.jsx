import { Badge } from "../ui/Badge";

/**
 * Status pill for HRMS records.
 *
 * `ui/StatusBadge` maps the booking lifecycle - Dispatched, PO Received - and
 * pulls its labels from `constants/bookingLifecycle`. None of that vocabulary
 * applies here, so this is a separate map rather than a widened one: putting
 * both in one component would mean a booking status and an employment status
 * could silently collide on a shared word.
 *
 * Covers the statuses the shared employee and workflow enums define. Anything
 * unrecognised renders neutral with its raw value, so a new status is visible
 * rather than invisible.
 *
 * `variant` must be one Badge implements: primary | success | warning | danger
 * | neutral. The red one is `danger` — only its Tailwind PALETTE is called
 * `error` (`bg-error-50`), and writing `variant: "error"` here silently renders
 * a colourless pill, because Badge looks the name up and clsx drops the
 * `undefined`. That is what happened to `rejected` and `suspended`.
 */
const STATUS_MAP = {
  // employment
  invited: { label: "Invited", variant: "neutral" },
  active: { label: "Active", variant: "success" },
  probation: { label: "Probation", variant: "warning" },
  notice: { label: "Notice period", variant: "warning" },
  exited: { label: "Exited", variant: "neutral" },
  suspended: { label: "Suspended", variant: "danger" },
  inactive: { label: "Inactive", variant: "neutral" },

  // approval workflows
  pending: { label: "Pending", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  rejected: { label: "Rejected", variant: "danger" },
  cancelled: { label: "Cancelled", variant: "neutral" },
  draft: { label: "Draft", variant: "neutral" },
  submitted: { label: "Submitted", variant: "primary" },
  completed: { label: "Completed", variant: "success" },
  in_progress: { label: "In progress", variant: "primary" },
};

const titleise = (s) =>
  String(s ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

export const HrmsStatusBadge = ({ status, className }) => {
  const key = String(status ?? "").toLowerCase().trim();
  const config = STATUS_MAP[key] ?? { label: titleise(status) || "Unknown", variant: "neutral" };

  return (
    <Badge variant={config.variant} className={className}>
      {config.label}
    </Badge>
  );
};

export default HrmsStatusBadge;
