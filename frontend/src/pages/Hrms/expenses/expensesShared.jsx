import { Badge } from "../../../components/ui/Badge";
import { CLAIM_STATUS_LABELS, formatMoney } from "../../../services/hrms";

/**
 * Small pieces the expense tabs share.
 *
 * Components only — the date and money helpers live in `services/hrms/expenses`
 * alongside the API they format the output of, so this file stays one kind of
 * thing.
 *
 * Local to the module, for the same reason the leave ones are: nothing outside
 * Expenses renders a claim status, and a shared component with one consumer is
 * a shared component nobody can change safely.
 */

/**
 * The reference's six statuses and their colours, translated from its antd
 * palette: default/blue/gold/cyan/green/red.
 *
 * `manager_approved` and `finance_approved` are both "on the way" rather than
 * finished, so both read as in-progress and only `reimbursed` reads as done —
 * otherwise a half-approved claim looks paid.
 */
const STATUS = {
  draft: "neutral",
  submitted: "primary",
  manager_approved: "warning",
  finance_approved: "primary",
  reimbursed: "success",
  rejected: "danger",
};

/** Colour is never the only signal — the word is always there too. */
export function ClaimStatusBadge({ status }) {
  return (
    <Badge variant={STATUS[status] ?? "neutral"}>
      {CLAIM_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/**
 * Money, right-aligned and tabular.
 *
 * `tabular-nums` keeps the decimal points in a column, which is the whole
 * reason a currency column is readable at a glance.
 */
export function Money({ value, className = "" }) {
  return (
    <span className={`block text-right tabular-nums ${className}`}>{formatMoney(value)}</span>
  );
}
