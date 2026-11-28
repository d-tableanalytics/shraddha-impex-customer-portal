import { Boxes, PackageCheck, Clock, Truck, Ban } from "lucide-react";

/**
 * THE BOOKING QUANTITY BIFURCATION.
 *
 *   Total Bookings  =  Available Inventory Against Bookings  +  Pending Indents
 *
 * One component, rendered identically on the Admin Portal and the Customer
 * Portal, reading the figures the SERVER derived
 * (backend/utils/bookingBifurcation.js). It does no arithmetic of its own —
 * deliberately. The split used to be computed in the browser from each row's
 * frozen `pendingQty`, which misses a SKU that stock could not cover at all
 * and keeps reporting an indent that has since been closed, and that is
 * exactly how the two portals came to disagree about the same booking.
 *
 * ---------------------------------------------------------------------------
 * WHY "ALLOCATED" IS NOT "AVAILABLE"
 * ---------------------------------------------------------------------------
 *
 * The middle figure is stock SET ASIDE FOR THIS CUSTOMER. It is not the
 * unreserved stock anyone can still book (AVL), and the two must never be read
 * as interchangeable — adding them double-counts, swapping them oversells. The
 * caption says so in as many words rather than relying on the column heading.
 *
 * `null` means the server did not supply a figure. It is rendered as an em
 * dash, never as zero: a quantity the desk uses to decide whether a booking
 * matches the customer's PO must not show a confident 0 for "not known".
 */

const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN"));

const Figure = ({ icon: Icon, label, value, hint, tone }) => (
  <div className="flex-1 min-w-[140px] px-3 py-2.5 rounded-lg bg-white border border-slate-200">
    <div className="flex items-center gap-1.5">
      <Icon size={13} className={tone.icon} />
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
        {label}
      </span>
    </div>
    <div className={`mt-0.5 text-lg font-black leading-none ${tone.value}`}>{fmt(value)}</div>
    {hint ? <div className="mt-1 text-[10px] text-slate-400 leading-snug">{hint}</div> : null}
  </div>
);

const TONES = {
  total: { icon: "text-slate-500", value: "text-slate-800" },
  allocated: { icon: "text-emerald-600", value: "text-emerald-700" },
  pending: { icon: "text-amber-600", value: "text-amber-700" },
  gone: { icon: "text-slate-400", value: "text-slate-600" },
};

/**
 * @param {object}  bifurcation  the server's split, or null
 * @param {boolean} [compact]    drop the explanatory hints (list rows, drawers)
 * @param {string}  [title]
 */
export const BookingBifurcation = ({ bifurcation, compact = false, title = "Booking quantities" }) => {
  if (!bifurcation) return null;
  const {
    totalBookedQty, allocatedQty, pendingIndentQty, dispatchedQty, cancelledQty,
  } = bifurcation;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      {!compact && (
        <div className="px-1 pb-2 flex items-baseline justify-between gap-2 flex-wrap">
          <span className="text-xs font-bold text-slate-700">{title}</span>
          {/* The identity, printed. A reader can check the three figures add up
              without doing it in their head, and if they ever stop adding up
              the screen says so rather than hiding it. */}
          <span className="text-[10px] text-slate-400">
            Total = Allocated + Pending indent
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Figure
          icon={Boxes}
          label="Total booking"
          value={totalBookedQty}
          tone={TONES.total}
          hint={compact ? null : "Outstanding quantity the customer is waiting for"}
        />
        <Figure
          icon={PackageCheck}
          label="Allocated from inventory"
          value={allocatedQty}
          tone={TONES.allocated}
          hint={compact ? null : "Stock set aside for this booking — not available to anyone else"}
        />
        <Figure
          icon={Clock}
          label="Pending indent"
          value={pendingIndentQty}
          tone={TONES.pending}
          hint={compact ? null : "Still to be procured — no stock covers it yet"}
        />
        {/* Dispatched and cancelled are shown only when they are non-zero. They
            are NOT part of the split above — the goods have left, or were never
            wanted — but hiding them entirely leaves a customer wondering why
            the total shrank. */}
        {dispatchedQty > 0 && (
          <Figure
            icon={Truck}
            label="Already dispatched"
            value={dispatchedQty}
            tone={TONES.gone}
            hint={compact ? null : "Shipped — no longer held against this booking"}
          />
        )}
        {cancelledQty > 0 && (
          <Figure
            icon={Ban}
            label="Cancelled"
            value={cancelledQty}
            tone={TONES.gone}
            hint={compact ? null : "Released back into available stock"}
          />
        )}
      </div>
    </div>
  );
};

export default BookingBifurcation;
