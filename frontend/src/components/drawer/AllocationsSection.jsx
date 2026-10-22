import { useState } from "react";
import { PackageCheck, Receipt, Loader2 } from "lucide-react";
import { BOOKING_LIFECYCLE } from "../../constants/bookingLifecycle";
import { allocationBatches } from "../../utils/allocationBatches";

const stageLabel = (key) => BOOKING_LIFECYCLE.find((s) => s.key === key)?.label || key || "—";
const fmtDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/**
 * INDENT-TO-BOOKING ALLOCATIONS, under a booking's line items.
 *
 * A line short of stock at booking time keeps its remainder on the booking's
 * indent. When stock arrives, everything it covers for this booking in one run
 * — however many indents and SKUs — is ONE inward allocation: one number, one
 * status, one pick list with every SKU in it, picked and dispatched together.
 * A later run is a separate allocation. Inside each, the rows still say which
 * SKU and which indent every unit came from. See utils/allocationBatches.js.
 *
 * The lines' confirmed quantities already include their allocations; the
 * summary at the top splits them back out per SKU.
 *
 * Shared by the customer's Booking History drawer and the sales desk drawer.
 * Each passes its lines in this shape:
 *   { lineId, skuCode, bookedQty, confirmedQty, pendingQty, allocations }
 *
 * Renders nothing when no line has an allocation.
 *
 * @param {Function} [onStatusChange] (batch, status) => Promise<{success}>.
 *        Omitted for readers who may not move it; they see the stage as text.
 * @param {Function} [onViewPicklist] (batch). Omitted when there is no document
 *        to show yet (the customer's copy needs a raised PO).
 * @param {Function} [onCancelAllocation] (line, allocation). Omitted for readers
 *        who may not cancel; offered only on an allocation still at its first
 *        stage, which is the only one the server will cancel.
 */
export const AllocationsSection = ({ lines, onStatusChange, onViewPicklist, onCancelAllocation }) => {
  const [busy, setBusy] = useState(null);
  const withAllocations = (lines || []).filter((l) => l.allocations?.length);
  if (withAllocations.length === 0) return null;

  const batches = allocationBatches(withAllocations);

  const change = async (batch, status) => {
    setBusy(batch.key);
    await onStatusChange(batch, status);
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

      {/* Per SKU: where its booked quantity stands. */}
      <div className="px-5 py-3 border-b border-slate-100 flex flex-col gap-1.5">
        {withAllocations.map((line) => {
          // A cancelled allocation went back to stock and to its indent: it is
          // history, not part of what this line holds.
          const allocated = line.allocations
            .filter((a) => a.status !== "Cancelled")
            .reduce((n, a) => n + (a.quantity || 0), 0);
          const initial = (line.confirmedQty || 0) - allocated;
          return (
            <div key={line.lineId || line.skuCode} className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-sm font-bold text-slate-800">{line.skuCode}</span>
              <span className="text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
                <span>Booked <b className="text-slate-700">{line.bookedQty ?? "—"}</b></span>
                <span>Initially confirmed <b className="text-slate-700">{initial}</b></span>
                <span>Allocated <b className="text-emerald-700">{allocated}</b></span>
                <span>Pending indent <b className="text-amber-600">{line.pendingQty || 0}</b></span>
              </span>
            </div>
          );
        })}
      </div>

      {/* One block per inward allocation (batch). */}
      <div className="divide-y divide-slate-100">
        {batches.map((batch) => (
          <div key={batch.key} className="px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
              <div>
                <p className="text-sm font-bold text-slate-800">Inward allocation {batch.number}</p>
                <p className="text-[11px] text-slate-500">
                  {fmtDate(batch.at)} · {batch.quantity} pcs across {batch.skuCount} SKU{batch.skuCount === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {/* Released with its booking (cancelled, or no PO in 7 days):
                    the units went back to stock, so there is no stage left. */}
                {batch.status === "Cancelled" ? (
                  <span className="text-xs font-semibold text-red-600">Cancelled — stock released</span>
                ) : onStatusChange ? (
                  <span className="inline-flex items-center gap-1.5">
                    <select
                      value={batch.status === "mixed" ? "" : batch.status}
                      disabled={busy === batch.key}
                      onChange={(e) => change(batch, e.target.value)}
                      aria-label={`Status of inward allocation ${batch.number}`}
                      className="text-xs font-semibold border border-slate-300 rounded-lg px-2 py-1 bg-white outline-none focus:border-primary-500"
                    >
                      {batch.status === "mixed" && <option value="" disabled>Mixed — choose…</option>}
                      {BOOKING_LIFECYCLE.map((s) => (
                        <option key={s.key} value={s.key}>{s.label}</option>
                      ))}
                    </select>
                    {busy === batch.key && <Loader2 size={12} className="animate-spin text-slate-400" />}
                  </span>
                ) : (
                  <span className="text-xs font-semibold text-slate-700">
                    {batch.status === "mixed" ? "Mixed" : stageLabel(batch.status)}
                  </span>
                )}
                {onViewPicklist ? (
                  <button
                    type="button"
                    onClick={() => onViewPicklist(batch)}
                    className="inline-flex items-center gap-1 text-xs font-bold text-primary-700 hover:underline whitespace-nowrap"
                  >
                    <Receipt size={12} /> View picklist
                  </button>
                ) : (
                  <span className="text-[11px] text-slate-400 whitespace-nowrap">picklist after PO</span>
                )}
              </div>
            </div>

            {/* Which SKU and which indent each unit came from. */}
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full min-w-120 text-sm whitespace-nowrap">
                <thead className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                  <tr className="border-b border-slate-100">
                    <th className="py-1.5 pr-4 text-left">SKU</th>
                    <th className="py-1.5 px-4 text-left">From indent</th>
                    <th className="py-1.5 pl-4 text-right">Qty allocated</th>
                    {onCancelAllocation && <th className="py-1.5 pl-4"><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {batch.entries.map(({ line, allocation }) => {
                    const cancelled = allocation.status === "Cancelled";
                    const cancellable = !cancelled && (allocation.status || "PO Received") === "PO Received";
                    return (
                      <tr key={`${line.lineId || line.skuCode}:${allocation.seq}`} className={cancelled ? "text-slate-400" : ""}>
                        <td className={`py-2 pr-4 font-mono font-semibold ${cancelled ? "line-through" : "text-slate-700"}`}>{line.skuCode}</td>
                        <td className="py-2 px-4 text-slate-600">
                          <span className={cancelled ? "line-through text-slate-400" : ""}>{allocation.indentNumber || "—"}</span>
                          {cancelled && (
                            <span
                              className="ml-2 text-[11px] font-semibold text-red-600 no-underline"
                              title={allocation.cancellationReason || undefined}
                            >
                              Cancelled{allocation.cancelledAt ? ` ${fmtDate(allocation.cancelledAt)}` : ""} · returned to indent
                            </span>
                          )}
                        </td>
                        <td className={`py-2 pl-4 text-right font-bold ${cancelled ? "line-through text-slate-400" : "text-emerald-700"}`}>{allocation.quantity}</td>
                        {onCancelAllocation && (
                          <td className="py-2 pl-4 text-right">
                            {cancellable && (
                              <button
                                type="button"
                                onClick={() => onCancelAllocation(line, allocation)}
                                className="text-xs font-bold text-red-600 hover:underline"
                              >
                                Cancel
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AllocationsSection;
