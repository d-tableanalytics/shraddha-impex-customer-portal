import { Badge } from "./Badge";

// Labels come from the lifecycle definition rather than being spelled out here,
// so the badge, the timeline and the status email all call a stage the same
// thing. The stored value is still 'PO Received'; the customer reads
// "Booking Received", which is what actually happened from their side.
import { stageLabel } from "../../constants/bookingLifecycle";

export const StatusBadge = ({ status, className }) => {
  const getBadgeConfig = (s) => {
    const normalizedStatus = (s || "").toLowerCase();
    switch (normalizedStatus) {
      case "draft":
        return { label: "Draft", variant: "neutral" };
      case "pending":
      case "booked":
      case "po received":
        return { label: stageLabel("PO Received"), variant: "warning" };
      case "ready":
      case "ready for dispatch":
        return { label: "Ready for Dispatch", variant: "primary" };
      case "dispatched":
        return { label: "Dispatched", variant: "primary" };
      case "delivered":
      case "completed":
        return { label: "Delivered", variant: "success" };
      case "cancelled":
        return { label: "Cancelled", variant: "neutral" };
      default:
        return { label: s || "Unknown", variant: "neutral" };
    }
  };

  const { label, variant } = getBadgeConfig(status);

  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
};
