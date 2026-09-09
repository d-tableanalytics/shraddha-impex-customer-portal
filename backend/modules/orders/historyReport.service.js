import Order from '../../models/Order.js';
import Reservation from '../../models/Reservation.js';
import User from '../../models/User.js';
import { isMsilCustomer } from '../../utils/moq.js';

/**
 * The weekly Booking & Indent History report: what goes in it.
 *
 * ONE PERIOD, TWO SETS OF ROWS, no rendering. This module answers "what
 * happened between these two instants" and nothing else — the renderers take
 * what it returns and cannot query, so the spreadsheet and the PDF cannot
 * disagree about the week.
 *
 * THE ROWS ARE THE ONES THE SCREENS EXPORT. Booking History and Indent History
 * each export one row per SKU line with the customer block repeated on it
 * (frontend/src/utils/historyExportColumns.js); this produces the same columns
 * in the same order from the same underlying records. A recipient comparing the
 * weekly mail against a manual export should find the same sheet.
 *
 * THE WINDOW IS ON `createdAt`, AND THAT IS THE DUPLICATION GUARANTEE.
 * A record is created once, so it falls inside exactly one weekly window and
 * appears in exactly one report — no row is ever sent twice and none is missed
 * between consecutive weeks. Windowing on `updatedAt` would have been the other
 * reading of "created/updated", and it re-reports a booking every week somebody
 * touches it: the same booking in four consecutive reports is precisely the
 * duplication this is asked to avoid.
 */

/** The indent statuses Indent History shows. Matches INDENT_STATUSES on the client. */
export const INDENT_STATUSES = ['Pending', 'Partially Confirmed'];

/** '-' and blanks are how "no PO" is stored. Neither is a PO number. */
export const realPoNumber = (value) => {
  const s = String(value ?? '').trim();
  return s === '' || s === '-' ? null : s;
};

/** MSIL or Customer — the two words User Management uses for a customer's type. */
export const customerTypeOf = (user) => (isMsilCustomer(user) ? 'MSIL' : 'Customer');

/**
 * A zone's offset from UTC at a given instant, in milliseconds.
 *
 * Formatting the instant in the target zone and differencing it against the
 * instant itself is the only way to get this in plain JS without a date
 * library, and unlike a hard-coded +05:30 it stays correct for a deployment
 * that moves and for any zone with daylight saving.
 */
const tzOffsetMs = (when, timezone) => {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(when).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    // Some ICU builds render midnight as hour 24 of the previous day.
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  );
  return asUtc - Math.floor(when.getTime() / 1000) * 1000;
};

/**
 * The reporting period ending at `now`: the previous `days` days.
 *
 * Cut at MIDNIGHT IN THE REPORT'S TIMEZONE, not at the moment the job happens to
 * fire. A window ending at 08:30 would put Monday-morning bookings in the report
 * that says it covers up to Sunday, and moving the cron by five minutes would
 * silently move which records land in which week. Whole days also make two
 * consecutive runs meet exactly: [Mon 00:00, Mon 00:00) then [Mon, Mon) — no
 * overlap to duplicate a record, no gap to lose one.
 *
 * `label` is what the run is claimed under, so every attempt at the same period
 * — a restart, a manual re-run, an overlapping deploy — derives the same key and
 * the second is refused by the unique index on ReportRun.
 */
export const periodFor = (now = new Date(), timezone = 'Asia/Kolkata', days = 7) => {
  const dateOnly = (d) => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);

  // Today's date in the report's zone, whatever the server's clock reads...
  const [y, m, d] = dateOnly(now).split('-').map(Number);
  // ...expressed as the instant that local midnight actually happened at.
  const to = new Date(Date.UTC(y, m - 1, d) - tzOffsetMs(now, timezone));
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);

  const fromLabel = dateOnly(from);
  // The window is half-open, so the last day IN it is the day before `to`.
  const toLabel = dateOnly(new Date(to.getTime() - 1));

  return {
    from,
    to,
    days,
    timezone,
    fromLabel,
    toLabel,
    /** `2026-09-01_2026-09-07` — stable per period, and it is the claim key. */
    label: `${fromLabel}_${toLabel}`,
    /** For a subject line: `01 Sep 2026 – 07 Sep 2026`. */
    get title() {
      const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
        timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
      });
      return `${fmt(this.fromLabel)} – ${fmt(this.toLabel)}`;
    },
  };
};

/**
 * The customer master details, for every customer id in one query.
 *
 * Read live from the user record, exactly as attachCustomerDetails() does for
 * the screens — a shop number filled in after a booking was placed still appears
 * on that booking's row.
 */
const customerIndex = async (ids) => {
  const unique = [...new Set(ids.map((id) => String(id || '')).filter(Boolean))];
  if (!unique.length) return new Map();
  const users = await User.find(
    { _id: { $in: unique } },
    'user company customerName phone location shopNumber customerCategory',
  ).lean();
  return new Map(users.map((u) => [String(u._id), u]));
};

/** The four customer columns, from a user record. Blank stays blank; N/A is the renderer's word. */
const customerBlock = (user, fallback = {}) => ({
  customerName: user?.customerName || user?.company || user?.user || fallback.company || null,
  shopNumber: fallback.shopNumber || user?.shopNumber || null,
  location: fallback.location || user?.location || null,
  customerType: customerTypeOf(user),
});

/**
 * Bookings created in the window, one row per line item.
 *
 * An Order document IS a line, so no grouping is needed to get line rows — the
 * booking-level fields simply repeat, which is what the on-screen export
 * produces too and what makes each row stand on its own when the sheet is
 * sorted or filtered.
 */
export const gatherBookingRows = async ({ from, to }) => {
  const orders = await Order.find(
    { createdAt: { $gte: from, $lt: to } },
    'orderId user company poNumber status date createdAt location shopNumber skuCode msilCode '
    + 'brand bookedQty confirmedQty pendingQty requestedQty',
  ).sort({ createdAt: 1, orderId: 1 }).lean();

  const byId = await customerIndex(orders.map((o) => o.user));

  return orders.map((o) => ({
    ...customerBlock(byId.get(String(o.user)), {
      company: o.company,
      shopNumber: o.shopNumber,
      location: o.location,
    }),
    bookingId: o.orderId,
    bookingDate: o.date || o.createdAt || null,
    poNumber: realPoNumber(o.poNumber),
    status: o.status || null,
    skuCode: o.skuCode || null,
    msilCode: o.msilCode || null,
    brand: o.brand || null,
    bookedQty: o.bookedQty ?? o.requestedQty ?? 0,
    confirmedQty: o.confirmedQty ?? 0,
    indentQty: o.pendingQty ?? 0,
  }));
};

/**
 * Indents raised in the window, one row per line.
 *
 * Restricted to the statuses Indent History shows, so the sheet and the screen
 * agree on what an indent is. The BOOKING DATE and a missing PO number are
 * looked up from the orders collection — a reservation carries neither, and the
 * report asks for both. One aggregation for the whole period, not one query per
 * indent.
 */
export const gatherIndentRows = async ({ from, to }) => {
  const reservations = await Reservation.find(
    { status: { $in: INDENT_STATUSES }, createdAt: { $gte: from, $lt: to } },
    'reservationId customerId indentNumber poNumber skuCode msilCode quantity status '
    + 'createdAt updatedAt scheduledDate',
  ).sort({ createdAt: 1 }).lean();

  const byId = await customerIndex(reservations.map((r) => r.customerId));

  // An indent id and its booking id share a sequence number and differ only in
  // the prefix. Asked of the orders collection rather than assumed — a
  // standalone indent has a number but no booking behind it.
  const candidates = [...new Set(
    reservations.map((r) => r.indentNumber).filter(Boolean).map((id) => id.replace(/^PI-/, 'BO-')),
  )];
  const bookings = candidates.length
    ? await Order.aggregate([
      { $match: { orderId: { $in: candidates } } },
      {
        $group: {
          _id: '$orderId',
          date: { $first: '$date' },
          createdAt: { $first: '$createdAt' },
          poNumber: { $first: '$poNumber' },
        },
      },
    ])
    : [];
  const bookingById = new Map(bookings.map((b) => [b._id, b]));

  return reservations.map((r) => {
    const derived = r.indentNumber ? r.indentNumber.replace(/^PI-/, 'BO-') : null;
    const booking = derived ? bookingById.get(derived) : null;
    return {
      ...customerBlock(byId.get(String(r.customerId))),
      indentNumber: r.indentNumber || null,
      bookingId: booking ? derived : null,
      bookingDate: booking ? (booking.date || booking.createdAt || null) : null,
      poNumber: realPoNumber(r.poNumber) || realPoNumber(booking?.poNumber),
      status: r.status || null,
      indentDate: r.createdAt || r.updatedAt || null,
      skuCode: r.skuCode || null,
      msilCode: r.msilCode || null,
      indentQty: r.quantity ?? 0,
      scheduledDate: r.scheduledDate || null,
    };
  });
};

/**
 * Everything the report shows, plus the counts the email leads with.
 *
 * `customers` counts DISTINCT customers rather than rows: "42 bookings" and "42
 * bookings from 3 customers" are different weeks, and the second is the one a
 * support desk reads the report to find out about.
 */
export const gatherHistoryReport = async ({
  now = new Date(),
  timezone = 'Asia/Kolkata',
  days = 7,
} = {}) => {
  const period = periodFor(now, timezone, days);

  const [bookings, indents] = await Promise.all([
    gatherBookingRows(period),
    gatherIndentRows(period),
  ]);

  const distinct = (rows, key) => new Set(rows.map((r) => r[key]).filter(Boolean)).size;

  return {
    period,
    timezone,
    generatedAt: now,
    bookings,
    indents,
    summary: {
      bookings: distinct(bookings, 'bookingId'),
      bookingLines: bookings.length,
      bookingQty: bookings.reduce((n, r) => n + (Number(r.bookedQty) || 0), 0),
      bookingsWithPo: new Set(bookings.filter((r) => r.poNumber).map((r) => r.bookingId)).size,
      indents: distinct(indents, 'indentNumber') + indents.filter((r) => !r.indentNumber).length,
      indentLines: indents.length,
      indentQty: indents.reduce((n, r) => n + (Number(r.indentQty) || 0), 0),
      customers: new Set(
        [...bookings, ...indents].map((r) => r.customerName).filter(Boolean),
      ).size,
    },
  };
};

export default {
  periodFor,
  gatherBookingRows,
  gatherIndentRows,
  gatherHistoryReport,
  realPoNumber,
  customerTypeOf,
  INDENT_STATUSES,
};
