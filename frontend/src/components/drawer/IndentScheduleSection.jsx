import { useEffect, useState } from "react";
import { CalendarClock, Loader2, Save, Info } from "lucide-react";
import toast from "react-hot-toast";

import { useIndentHistoryStore } from "../../store/indentHistoryStore";

/**
 * Schedule when each indented SKU is expected to become available.
 *
 * One save for the whole indent rather than a control per row. An admin
 * scheduling against an inbound delivery sets several dates in one sitting, and
 * saving each separately would send the customer an email per line for what was
 * a single decision.
 *
 * A date here is a PROMISE, and the system treats it as one: until it arrives,
 * that line cannot be moved to the customer's selection list even if stock
 * happens to be on the shelf. Clearing the date withdraws the promise.
 */

const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A Date to the "YYYY-MM-DD" a date input wants, in LOCAL time. */
const toYmd = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const fmt = (value) =>
  new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export const IndentScheduleSection = ({ lines }) => {
  const { scheduleLines } = useIndentHistoryStore();
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  // Reset whenever the drawer shows a different indent, or the data refreshes —
  // a half-typed date from the previous indent must not carry over.
  useEffect(() => {
    const next = {};
    for (const l of lines) next[l._id] = toYmd(l.scheduledDate);
    setDraft(next);
  }, [lines]);

  const changed = lines.filter((l) => (draft[l._id] ?? "") !== toYmd(l.scheduledDate));
  const scheduledCount = lines.filter((l) => l.scheduledDate).length;

  const save = async () => {
    if (changed.length === 0) return;
    setSaving(true);
    try {
      const res = await scheduleLines(
        changed.map((l) => ({ id: l._id, scheduledDate: draft[l._id] || null })),
      );
      if (res.success) toast.success(res.message || "Schedule saved.");
      else toast.error(res.error || "The schedule could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  if (lines.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3 bg-slate-50/70 border-b border-slate-200">
        <CalendarClock size={16} className="text-primary-600 shrink-0" />
        <h3 className="text-sm font-bold text-slate-800">Schedule</h3>
        <span className="text-[11px] text-slate-500">
          {scheduledCount > 0
            ? `${scheduledCount} of ${lines.length} scheduled`
            : "No dates set yet"}
        </span>
        <button
          type="button"
          onClick={save}
          disabled={changed.length === 0 || saving}
          className="ml-auto inline-flex items-center gap-1.5 text-xs font-bold text-white bg-primary-600
                     px-3 py-1.5 rounded-lg hover:bg-primary-700 transition-colors
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? "Saving..." : changed.length ? `Save ${changed.length} change${changed.length === 1 ? "" : "s"}` : "Save"}
        </button>
      </div>

      <div className="px-5 py-3 flex items-start gap-2 bg-primary-50/40 border-b border-primary-100">
        <Info size={14} className="text-primary-600 shrink-0 mt-0.5" />
        <p className="text-[11px] text-slate-600 leading-relaxed">
          The customer is emailed the dates you save here. Until a line&apos;s date arrives it
          cannot be moved to their selection list, even if stock is on hand. Clear a date to
          withdraw the commitment.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
            <tr>
              <th className="px-5 py-2.5">SKU</th>
              <th className="px-5 py-2.5 text-center">Qty</th>
              <th className="px-5 py-2.5">Available from</th>
              <th className="px-5 py-2.5">Currently</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l) => {
              const value = draft[l._id] ?? "";
              const isChanged = value !== toYmd(l.scheduledDate);
              return (
                <tr key={l._id} className={isChanged ? "bg-primary-50/40" : ""}>
                  <td className="px-5 py-3 font-bold text-slate-800">{l.product?.code}</td>
                  <td className="px-5 py-3 text-center font-black text-amber-600">
                    {l.pendingQuantity}
                  </td>
                  <td className="px-5 py-3">
                    <input
                      type="date"
                      min={todayYmd()}
                      value={value}
                      onChange={(e) => setDraft((d) => ({ ...d, [l._id]: e.target.value }))}
                      className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm text-slate-700
                                 bg-white outline-none focus:ring-1 focus:ring-primary-500"
                    />
                  </td>
                  <td className="px-5 py-3 text-xs">
                    {l.scheduledDate ? (
                      <span className="text-slate-600">{fmt(l.scheduledDate)}</span>
                    ) : (
                      <span className="text-slate-400">Not scheduled</span>
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
};

export default IndentScheduleSection;
