import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Package, Layers, PackageCheck, FileCheck2, Activity as StatusIcon, PencilLine, Ban, History,
  RefreshCw, MailCheck, MailX, MailWarning, ArrowRight,
} from "lucide-react";
import { Drawer } from "../ui/Drawer";
import { ERPButton } from "../ui/ERPButton";
import { SkeletonLoader } from "../ui/SkeletonLoader";
import { salesApi } from "../../services/sales";
import { useSalesStore } from "../../store/salesStore";
import { queryKeys, STALE } from "../../lib/queryKeys";
import { fmtStatusDateTime } from "../../constants/bookingLifecycle";

/**
 * BOOKING HISTORY — everything that has happened to one booking, in one place.
 *
 * Opened by the Sales Desk's "Action" button (and from the review drawer). The
 * server builds it from the records already kept — the confirmation, the
 * indent, every allocation, the PO, each status change and every later edit —
 * and folds the records one action writes into a single entry, so nothing is
 * listed twice. This screen only lays it out:
 *
 *   1. who the booking is for and where it stands now;
 *   2. the booking → indent → allocation relationship, per SKU;
 *   3. the activity, oldest first, each entry saying where it was raised from.
 */

const fmt = (d) => (d ? fmtStatusDateTime(d) : "—");
const errorOf = (err) => err?.response?.data?.message || err?.message || "Could not load the booking history.";

/** How each kind of entry is drawn, and which filter it belongs to. */
const KINDS = {
  booking: { Icon: Package, dot: "bg-primary-600", group: "booking" },
  po: { Icon: FileCheck2, dot: "bg-indigo-600", group: "booking" },
  indent: { Icon: Layers, dot: "bg-amber-500", group: "indent" },
  allocation: { Icon: PackageCheck, dot: "bg-emerald-600", group: "allocation" },
  status: { Icon: StatusIcon, dot: "bg-sky-600", group: "status" },
  cancel: { Icon: Ban, dot: "bg-red-600", group: "status" },
  update: { Icon: PencilLine, dot: "bg-slate-500", group: "update" },
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "booking", label: "Booking & PO" },
  { key: "indent", label: "Indents" },
  { key: "allocation", label: "Allocations" },
  { key: "status", label: "Status" },
  { key: "update", label: "Updates" },
];

/**
 * Where an entry was raised from: a neutral chip with a coloured dot. Neutral
 * so it reads in both themes — the dark theme remaps the slate palette, not
 * every accent (index.css) — and the label, not the colour, carries the meaning.
 */
const SOURCE_DOTS = {
  "customer-portal": "bg-violet-500",
  "sales-desk": "bg-primary-500",
  "indent-assignment": "bg-amber-500",
  "indent-history": "bg-amber-500",
  bookings: "bg-sky-500",
  system: "bg-slate-400",
  erp: "bg-slate-400",
};

const SourceChip = ({ source }) => {
  const record = source?.key === "record";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
        record ? "border-dashed border-slate-300 bg-white text-slate-500" : "border-slate-200 bg-slate-50 text-slate-700"
      }`}
      title={record ? "Taken from the booking's own records; the screen it came from was not recorded" : undefined}
    >
      {!record && <span className={`h-1.5 w-1.5 rounded-full ${SOURCE_DOTS[source?.key] || SOURCE_DOTS.erp}`} aria-hidden="true" />}
      {source?.label || "—"}
    </span>
  );
};

// Shades the dark theme remaps, or that read on either background.
const STATUS_TONES = {
  Cancelled: "bg-red-50 text-red-700 border-red-200",
  Delivered: "bg-emerald-50 text-emerald-600 border-emerald-500/30",
  Dispatched: "bg-indigo-50 text-indigo-500 border-indigo-500/30",
  "Ready for Dispatch": "bg-primary-50 text-primary-700 border-primary-200",
};
const StatusPill = ({ status, label }) => (
  <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold ${STATUS_TONES[status] || "bg-amber-50 text-amber-700 border-amber-200/70"}`}>
    {label || status}
  </span>
);

/** An indent's state, in the desk's words. */
const INDENT_STATE = {
  Pending: "Waiting for stock",
  "Partially Confirmed": "Waiting for stock",
  Confirmed: "Fulfilled",
  Cancelled: "Cancelled",
  Expired: "Expired",
  Reserved: "Back in the selection list",
};

const NOTIFICATION = {
  sent: { Icon: MailCheck, tone: "text-emerald-600", text: (n) => `Customer emailed${n.recipient ? ` (${n.recipient})` : ""}` },
  failed: { Icon: MailX, tone: "text-red-600", text: (n) => `Email failed — ${n.error || "the mail server could not be reached"}` },
  skipped: { Icon: MailWarning, tone: "text-amber-700", text: (n) => `Not emailed — ${n.reason || "no address on the account"}` },
  pending: { Icon: MailWarning, tone: "text-slate-500", text: () => "Email not yet attempted" },
  not_applicable: { Icon: MailCheck, tone: "text-slate-500", text: (n) => n.reason || "No email for this change" },
};

const Fact = ({ label, children }) => (
  <div className="min-w-0">
    <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</dt>
    <dd className="mt-0.5 truncate text-sm font-semibold text-slate-800">{children}</dd>
  </div>
);
const Dash = ({ title }) => <span className="font-normal text-slate-400" title={title}>—</span>;

const Tile = ({ label, value, hint }) => (
  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5" title={hint}>
    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
    <p className="mt-1 text-lg font-black tabular-nums text-slate-900">{value ?? <Dash />}</p>
  </div>
);

const Actor = ({ actor }) => (actor
  ? <span className="text-slate-500">by <span className="font-semibold text-slate-700">{actor.name}</span>{actor.role ? ` (${actor.role})` : ""}</span>
  : null);

// ── 1. Who and where ─────────────────────────────────────────────────────────

const Summary = ({ booking }) => {
  const t = booking.totals || {};
  return (
    <section aria-label="Booking summary" className="flex flex-col gap-3">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Booking Number"><span className="font-mono">{booking.orderId}</span></Fact>
          <Fact label="Customer Name">{booking.customerName || <Dash title="No customer name on this account" />}</Fact>
          <Fact label="Company Name">{booking.company || <Dash />}</Fact>
          <Fact label="PO Number">
            {booking.poNumber ? <span className="font-mono">{booking.poNumber}</span> : <Dash title="No PO raised yet" />}
          </Fact>
          <Fact label="Indent">
            {booking.indentNumber ? <span className="font-mono">{booking.indentNumber}</span> : <Dash title="Stock covered everything; no indent was raised" />}
          </Fact>
          <Fact label="Current Status"><StatusPill status={booking.status} label={booking.statusLabel} /></Fact>
          <Fact label="Created">{fmt(booking.createdAt)}</Fact>
          <Fact label="Raised from"><SourceChip source={booking.createdFrom} /></Fact>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-3 text-xs">
          <span className="font-bold text-slate-600">Booking confirmation:</span>
          {booking.poRaisedAt ? (
            <span className="text-slate-600">
              PO {booking.poNumber ? <span className="font-mono font-semibold text-slate-800">{booking.poNumber}</span> : ""} raised {fmt(booking.poRaisedAt)}{" "}
              <Actor actor={booking.poRaisedBy} /> — the booking is locked.
            </span>
          ) : booking.poNumber ? (
            <span className="text-slate-600">PO {booking.poNumber} on record; when it was raised was not recorded.</span>
          ) : (
            <span className="text-slate-500">Not confirmed yet — waiting for the PO.</span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Tile label="Requested" value={t.atBooking?.requested} hint="What the customer asked for when booking" />
        <Tile label="Confirmed at booking" value={t.atBooking?.confirmed} hint="Covered from stock at the moment of booking" />
        <Tile label="Allocated from indent" value={t.allocated} hint="Arriving stock put on this booking since, not counting cancelled allocations" />
        <Tile label="Still on indent" value={t.waitingOnIndent} hint="Still waiting for stock" />
        <Tile label="Confirmed now" value={t.confirmedNow} hint="Units on the booking's live lines today" />
      </div>
    </section>
  );
};

// ── 2. Booking → indent → allocations ───────────────────────────────────────

const Relationships = ({ lines, indents }) => {
  const skus = [...new Set([...lines.map((l) => l.skuCode), ...indents.map((i) => i.skuCode)])];
  if (!skus.length) return null;
  return (
    <section aria-label="Booking, indents and allocations">
      <h3 className="mb-2 text-sm font-bold text-slate-800">Booking, indents &amp; allocations</h3>
      <div className="flex flex-col gap-2">
        {skus.map((sku) => {
          const line = lines.find((l) => l.skuCode === sku);
          const skuIndents = indents.filter((i) => i.skuCode === sku);
          return (
            <div key={sku} className="rounded-xl border border-slate-200 bg-white" data-testid={`sku-${sku}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
                <span className="font-mono text-sm font-black text-slate-800">{sku}</span>
                {line ? (
                  <span className="text-xs text-slate-500">
                    Booked <b className="text-slate-700">{line.bookedQty}</b> · confirmed now <b className="text-slate-700">{line.confirmedQty}</b> ·{" "}
                    <StatusPill status={line.status} label={line.statusLabel} />
                  </span>
                ) : (
                  <span className="text-xs text-slate-500">On indent only — nothing confirmed yet</span>
                )}
              </div>
              <div className="flex flex-col gap-2 px-4 py-3 text-xs text-slate-600">
                {line?.atBooking && (
                  <p>
                    <span className="font-bold text-slate-700">At booking:</span> {line.atBooking.requested} requested{" "}
                    <ArrowRight size={11} className="inline" aria-hidden="true" /> {line.atBooking.confirmed} confirmed
                    {line.atBooking.pending > 0 && `, ${line.atBooking.pending} to indent`}
                  </p>
                )}
                {skuIndents.map((i) => (
                  <p key={i.reservationId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Layers size={12} className="text-amber-500" aria-hidden="true" />
                    <span className="font-bold text-slate-700">
                      {i.relation === "became-this-booking" ? "From indent" : "Indent"}{" "}
                      <span className="font-mono">{i.indentNumber || i.reservationId}</span>
                    </span>
                    {i.relation === "became-this-booking" && <span>(became this booking)</span>}
                    {i.raisedQty != null && <span>· raised for {i.raisedQty}</span>}
                    {i.open && <span>· <b className="text-amber-700">{i.waiting}</b> waiting</span>}
                    <span>· {INDENT_STATE[i.status] || i.status}</span>
                    {i.supplyCheck && <span>· MSIL check: {i.supplyCheck}</span>}
                    {i.closedAt && <span>· closed {fmt(i.closedAt)}</span>}
                  </p>
                ))}
                {line?.allocations?.length > 0 && (
                  <div>
                    <p className="mb-1 font-bold text-slate-700">Allocations</p>
                    <ul className="flex flex-col gap-1">
                      {line.allocations.map((a) => (
                        <li
                          key={`${a.seq}-${a.at}`}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-1.5"
                        >
                          <span className="font-mono font-bold text-slate-700">#{a.seq}</span>
                          <span className="font-bold text-emerald-600">{a.quantity} pcs</span>
                          <span>{fmt(a.at)}</span>
                          {a.indentNumber && <span>from <span className="font-mono">{a.indentNumber}</span></span>}
                          <StatusPill status={a.status} label={a.statusLabel} />
                          <SourceChip source={a.source} />
                          <Actor actor={a.actor} />
                          {a.cancellationReason && <span className="text-red-600">— {a.cancellationReason}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!line?.atBooking && !skuIndents.length && !line?.allocations?.length && (
                  <p className="text-slate-400">Confirmed in full; no indent or allocation.</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

// ── 3. The activity ─────────────────────────────────────────────────────────

const Entry = ({ event, last }) => {
  const { Icon, dot } = KINDS[event.kind] || KINDS.update;
  const n = event.notification && NOTIFICATION[event.notification.state];
  return (
    <li className="relative flex gap-3 pb-5" data-testid="history-entry">
      {!last && <span className="absolute left-3.5 top-8 bottom-0 w-px bg-slate-200" aria-hidden="true" />}
      <span className={`relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white ${dot}`}>
        <Icon size={14} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-sm font-bold text-slate-800">{event.title}</p>
          <time className="whitespace-nowrap text-[11px] font-semibold text-slate-500" dateTime={event.at || undefined}>
            {event.at ? fmt(event.at) : "Date not recorded"}
          </time>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="text-slate-400">Raised from</span>
          <SourceChip source={event.source} />
          <Actor actor={event.actor} />
        </div>
        {event.details?.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-slate-600">
            {event.details.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        )}
        {event.items?.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1">
            {event.items.map((it, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-2 rounded-md bg-slate-50 px-2 py-1 text-xs">
                <span className="font-mono font-bold text-slate-700">{it.skuCode}</span>
                {it.quantity != null && <span className="font-semibold text-slate-800">× {it.quantity}</span>}
                {it.note && <span className="text-slate-500">{it.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {n && (
          <p className={`mt-1.5 flex items-center gap-1.5 text-[11px] font-medium ${n.tone}`}>
            <n.Icon size={12} aria-hidden="true" /> {n.text(event.notification)}
          </p>
        )}
      </div>
    </li>
  );
};

const ActivityLog = ({ events }) => {
  const [filter, setFilter] = useState("all");
  const counts = useMemo(() => {
    const c = { all: events.length };
    for (const e of events) {
      const g = (KINDS[e.kind] || KINDS.update).group;
      c[g] = (c[g] || 0) + 1;
    }
    return c;
  }, [events]);
  const shown = filter === "all" ? events : events.filter((e) => (KINDS[e.kind] || KINDS.update).group === filter);

  return (
    <section aria-label="Booking activity">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-800">Activity</h3>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter activity">
          {FILTERS.filter((f) => f.key === "all" || counts[f.key]).map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                filter === f.key
                  ? "border-primary-600 bg-primary-600 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f.label} <span className={filter === f.key ? "text-primary-100" : "text-slate-400"}>{counts[f.key] || 0}</span>
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <ol className="rounded-xl border border-slate-200 bg-white px-4 pt-4">
          {shown.map((e, i) => <Entry key={e.id} event={e} last={i === shown.length - 1} />)}
        </ol>
      ) : (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
          Nothing recorded for this booking yet.
        </p>
      )}
    </section>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

export const BookingHistoryDrawer = () => {
  const historyFor = useSalesStore((s) => s.historyFor);
  const closeHistory = useSalesStore((s) => s.closeHistory);
  const select = useSalesStore((s) => s.select);
  const orderId = historyFor?.orderId;

  const query = useQuery({
    queryKey: queryKeys.bookingHistory.detail(orderId),
    queryFn: () => salesApi.getHistory(orderId),
    enabled: Boolean(orderId),
    staleTime: STALE.bookingHistory,
  });
  const data = query.data;

  const openBooking = () => {
    const row = historyFor;
    closeHistory();
    select(row);
  };

  return (
    <Drawer
      isOpen={Boolean(orderId)}
      onClose={closeHistory}
      maxWidth="max-w-4xl"
      title={
        <span className="flex items-center gap-2">
          <History size={16} className="text-primary-600" aria-hidden="true" />
          Booking History{orderId ? <span className="font-mono text-slate-500">· {orderId}</span> : null}
        </span>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            The booking, its indent and its stock allocations, from the records kept at each step.
          </p>
          <div className="flex items-center gap-2">
            {query.isFetching && data && (
              <span className="flex items-center gap-1 text-[11px] text-slate-400">
                <RefreshCw size={11} className="animate-spin" aria-hidden="true" /> Refreshing…
              </span>
            )}
            <ERPButton variant="outline" size="sm" onClick={openBooking}>
              Open booking
            </ERPButton>
          </div>
        </div>

        {query.isError && !data ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
            {errorOf(query.error)}
            <ERPButton variant="outline" size="sm" onClick={() => query.refetch()}>Try again</ERPButton>
          </div>
        ) : !data ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading booking history">
            <SkeletonLoader variant="text" className="h-24 w-full" />
            <SkeletonLoader variant="text" className="h-16 w-full" />
            {[0, 1, 2].map((i) => <SkeletonLoader key={i} variant="text" className="h-10 w-full" />)}
          </div>
        ) : (
          <>
            <Summary booking={data.booking} />
            <Relationships lines={data.lines || []} indents={data.indents || []} />
            <ActivityLog events={data.events || []} />
          </>
        )}
      </div>
    </Drawer>
  );
};

export default BookingHistoryDrawer;
