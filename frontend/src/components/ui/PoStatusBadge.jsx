import { Lock, Clock } from "lucide-react";

/**
 * PO Pending  → booking is still editable
 * PO Generated (Locked) → booking is frozen
 */
export const PoStatusBadge = ({ locked, poNumber, className = "" }) => {
  if (locked) {
    return (
      <span
        title={poNumber ? `PO ${poNumber} — booking is locked` : "Booking is locked"}
        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-slate-100 text-slate-700 border-slate-300 ${className}`}
      >
        <Lock size={12} /> PO Generated
      </span>
    );
  }
  return (
    <span
      title="No PO yet — this booking can still be edited"
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-warning-50 text-warning-600 border-warning-200 ${className}`}
    >
      <Clock size={12} /> PO Pending
    </span>
  );
};

export default PoStatusBadge;
