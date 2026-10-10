import { useState } from "react";
import { PackageCheck, Receipt, Loader2 } from "lucide-react";
import { BOOKING_LIFECYCLE } from "../../constants/bookingLifecycle";

const stageLabel = (key) => BOOKING_LIFECYCLE.find((s) => s.key === key)?.label || key || "—";

/**
 * INDENT-TO-BOOKING ALLOCATIONS, under a booking's line items.
 *
 * A line short of stock at booking time keeps its remainder on the booking's
 * indent. Each later receipt that covers part of it is an "inward allocation"
 * on the same line: its own quantity, its own status and its own pick list, so
 * the warehouse can pick and dispatch it separately from what was confirmed at
 * booking time. The line's confirmed quantity already includes them.
 *
 * Shared by the customer's Booking History drawer and the sales desk drawer.
 * Each passes its lines in this shape:
 *   { lineId, skuCode, bookedQty, confirmedQty, pendingQty, allocations }
 *
 * Renders nothing when no line has an allocation.
 *
 * @param {Function} [onStatusChange] (lineId, seq, status) => Promise<{success}>.
 *        Omitted for readers who may not move it; they see the stage as text.
 * @param {Function} [onViewPicklist] (line, allocation). Omitted when there is no
 *        document to show yet (the customer's copy needs a raised PO).
 */
export const AllocationsSection = ({ lines, onStatusChange, onViewPicklist }) => {
  const [busy, setBusy] = useState(null);
  const withAllocations = (lines || []).filter((l) => l.allocations?.length);
  if (withAllocations.length === 0) return null;

  const change = async (line, a, status) => {
    setBusy(`${line.lineId}:${a.seq}`);
    await onStatusChange(line.lineId, a.seq, status);
    setBusy(null);
  };

  return (
    <div className="bg-white border border-emerald-200 rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-emerald-100 flex items-center gap-2">
        <PackageCheck size={18} className="text-emerald-600" />
        <h3 className="text-sm font-bold text-slate-800">Indent-to-Booking Allocations</h3>
        <span className="text-[11px] text-slate-500">
          stock that arrived later against this booking's indent
        </span>
      </div>

      <div className="divide-y divide-slate-100">
        {withAllocations.map((line) => {
          const allocated = line.allocations.reduce((n, a) => n + (a.quantity || 0), 0);
          const initial = (line.confirmedQty || 0) - allocated;
          return (
            <div key={line.lineId || line.skuCode} className="px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <span className="font-mono text-sm font-bold text-slate-800">{line.skuCode}</span>
                <span className="text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
                  <span>Booked <b className="text-slate-700">{line.bookedQty ?? "—"}</b></span>
                  <span>Initially confirmed <b className="text-slate-700">{initial}</b></span>
                  <span>Allocated <b className="text-emerald-700">{allocated}</b></span>
                  <span>Pending indent <b className="text-amber-600">{line.pendingQty || 0}</b></span>
                </span>
              </div>

              {/* Scrolls sideways rather than wrapping: the drawer is narrow,
                  and five columns squeezed into it broke every label in two. */}
              <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full min-w-[640px] text-sm whitespace-nowrap">
                <thead className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                  <tr className="border-b border-slate-100">
                    <th className="py-2 pr-4 text-left">Allocation</th>
                    <th className="py-2 px-4 text-right">Inward qty allocated</th>
                    <th className="py-2 px-4 text-left">Received</th>
                    <th className="py-2 px-4 text-left">Status</th>
                    <th className="py-2 pl-4 text-right">Picklist</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {line.allocations.map((a) => {
                    const key = `${line.lineId}:${a.seq}`;
                    return (
                      <tr key={a.seq}>
                        <td className="py-2.5 pr-4 font-semibold text-slate-700">
                          Inward allocation {a.seq}
                          {a.indentNumber && (
                            <span className="block text-[10px] font-normal text-slate-400">
                              from {a.indentNumber}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-right font-bold text-emerald-700">{a.quantity}</td>
                        <td className="py-2.5 px-4 text-slate-600">
                          {new Date(a.at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                        </td>
                        <td className="py-2.5 px-4">
                          {onStatusChange ? (
                            <span className="inline-flex items-center gap-1.5">
                              <select
                                value={a.status || "PO Received"}
                                disabled={busy === key}
                                onChange={(e) => change(line, a, e.target.value)}
                                className="text-xs font-semibold border border-slate-300 rounded-lg px-2 py-1 bg-white outline-none focus:border-primary-500"
                              >
                                {BOOKING_LIFECYCLE.map((s) => (
                                  <option key={s.key} value={s.key}>{s.label}</option>
                                ))}
                              </select>
                              {busy === key && <Loader2 size={12} className="animate-spin text-slate-400" />}
                            </span>
                          ) : (
                            <span className="text-xs font-semibold text-slate-700">{stageLabel(a.status)}</span>
                          )}
                        </td>
                        <td className="py-2.5 pl-4 text-right">
                          {onViewPicklist ? (
                            <button
                              type="button"
                              onClick={() => onViewPicklist(line, a)}
                              className="inline-flex items-center gap-1 text-xs font-bold text-primary-700 hover:underline"
                            >
                              <Receipt size={12} /> View picklist
                            </button>
                          ) : (
                            <span className="text-[11px] text-slate-400">after PO</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AllocationsSection;
