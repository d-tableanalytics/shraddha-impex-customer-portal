import { Badge } from "./Badge";

/**
 * Status badge for indents.
 *
 * Deliberately separate from StatusBadge: that one maps 'Pending' onto the order
 * lifecycle and renders it as "PO Received", which is wrong here — an indent's
 * 'Pending' means the quantity is still awaiting stock.
 */
export const IndentStatusBadge = ({ status, className }) => {
  const config = {
    pending: { label: "Awaiting Stock", variant: "warning" },
    "partially confirmed": { label: "Partially Confirmed", variant: "primary" },
  }[(status || "").toLowerCase()] || { label: status || "Unknown", variant: "neutral" };

  return (
    <Badge variant={config.variant} className={className}>
      {config.label}
    </Badge>
  );
};

export default IndentStatusBadge;
