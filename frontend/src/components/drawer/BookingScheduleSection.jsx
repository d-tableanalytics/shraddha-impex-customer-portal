import { useEffect, useState } from "react";
import { CalendarClock, Loader2, Save, Info } from "lucide-react";
import toast from "react-hot-toast";

import { DateField } from "../ui/DateField";
import { toYmd, todayYmd, formatDisplayDate } from "../../utils/dateValue";
import { ordersApi } from "../../services/orders";

/**
 * Schedule when each booked SKU is expected to become available.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY THE TWIN OF IndentScheduleSection
 * ---------------------------------------------------------------------------
 * Same layout, same one-save-for-the-whole-booking model, same wording, same
 * date control — and mounted in the mirror-image place:
 *
 *     Indent History  -> IndentDrawer -> IndentScheduleSection
 *     Booking History -> OrderDrawer  -> BookingScheduleSection   (this file)
 *
 * An admin scheduling against an inbound delivery should not have to learn two
 * idioms depending on whether the customer's items happen to be indented or
 * booked, nor go to a different screen for each — and two screens that behave
 * differently for the same decision is how one of them ends up wrong.
 *
 * One save, not a control per row: setting several dates against one delivery is
 * a SINGLE decision, and saving each separately would send the customer an email
 * per line for it.
 *
 * The one real difference is what a date MEANS. On an indent it is also a gate —
 * the line cannot reach the customer's selection list until the date arrives. A
 * booking is already confirmed and its stock already committed, so here the date
 * is a promise the customer is told about and nothing more. The copy below says
 * so rather than copying the indent's sentence, which would be untrue.
 */

const fmt = (value) => formatDisplayDate(new Date(value));

/** Lines a booking can still promise a delivery on. */
const SCHEDULABLE = ["Booked", "PO Received", "Ready for Dispatch"];

export const BookingScheduleSection = ({ orderId, lines, onSaved }) => {
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  // Only lines with a delivery still ahead of them. A delivered or cancelled
  // line has nothing to promise, and the server refuses it anyway — offering the
  // control would be inviting an error.
  const openLines = (lines || []).filter((l) => SCHEDULABLE.includes(l.status));

  // Reset whenever the drawer shows a different booking, or the data refreshes —
  // a half-typed date from the previous booking must not carry over.
  useEffect(() => {
    const next = {};
    for (const l of openLines) next[l._id || l.id] = toYmd(l.scheduledDate);
    setDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, orderId]);

  const idOf = (l) => l._id || l.id;
  const changed = openLines.filter((l) => (draft[idOf(l)] ?? "") !== toYmd(l.scheduledDate));
  const scheduledCount = openLines.filter((l) => l.scheduledDate).length;

  const save = async () => {
    if (changed.length === 0) return;
    setSaving(true);
    try {
      const res = await ordersApi.scheduleBooking(
        orderId,
        changed.map((l) => ({ id: idOf(l), scheduledDate: draft[idOf(l)] || null })),
      );
      toast.success(res.message || "Schedule saved.");
      onSaved?.();
    } catch (err) {
      toast.error(err.response?.data?.message || "The schedule could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  if (openLines.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3 bg-slate-50/70 border-b border-slate-200">
        <CalendarClock size={16} className="text-primary-600 shrink-0" />
        <h3 className="text-sm font-bold text-slate-800">Delivery schedule</h3>
        <span className="text-[11px] text-slate-500">
          {scheduledCount > 0
            ? `${scheduledCount} of ${openLines.length} scheduled`
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
          The customer is emailed the dates you save here, together with any indent items they
          already have scheduled — one delivery schedule, not one email per system. Clear a date
          to withdraw the commitment.
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
            {openLines.map((l) => {
              const id = idOf(l);
              const value = draft[id] ?? "";
              const isChanged = value !== toYmd(l.scheduledDate);
              return (
                <tr key={id} className={isChanged ? "bg-primary-50/40" : ""}>
                  <td className="px-5 py-3 font-bold text-slate-800">{l.skuCode}</td>
                  <td className="px-5 py-3 text-center font-black text-slate-700">
                    {l.confirmedQty ?? l.requestedQty ?? 0}
                  </td>
                  <td className="px-5 py-3">
                    <DateField
                      min={todayYmd()}
                      value={value}
                      onChange={(v) => setDraft((d) => ({ ...d, [id]: v }))}
                      placeholder="Not scheduled"
                      className="min-w-42 py-1.5"
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

export default BookingScheduleSection;
