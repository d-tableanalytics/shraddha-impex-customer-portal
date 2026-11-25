/**
 * The booking journey — one structure, one table, every booking mail.
 *
 * Every booking-related email (confirmation, indent raised, PO raised, and the
 * lifecycle status mails) shows the SAME single table, so the customer can read
 * the whole story of an order in any one of them. One row per SKU:
 *
 *   SKU | Booked | Confirmed | Indent | Dispatch Date | Change
 *
 * The Change column is reconstructed, not stored: the edit audit trail is
 * replayed forward (buildChangeSummary) to recover each line's booking-stage
 * quantity, so a booking edited five times still reports only what the desk
 * actually decided. When nothing was ever edited the column reads "No change",
 * which is exactly what a customer should see.
 *
 * The Dispatch Date column is PER LINE, read from each order row's
 * `scheduledDate` — the field the Sales Desk edits. It is deliberately not a
 * single booking-level date: two SKUs on one booking routinely leave on
 * different days, and printing one date against both is a promise the warehouse
 * never made. A line with no date assigned shows an em dash rather than a
 * default, because "not scheduled yet" and "leaving on the 3rd" are different
 * facts and guessing between them is how a customer waits in for nothing.
 *
 * ---------------------------------------------------------------------------
 * STANDALONE INDENTS — THE LINES THE BOOKING TABLE CANNOT HOLD
 * ---------------------------------------------------------------------------
 *
 * The table above is driven by the booking's ORDER ROWS, and a line stock could
 * not cover AT ALL never becomes one: the confirmation only pushes a row when
 * `confirmedQty > 0`. Such a line exists purely as a reservation under the
 * booking's indent number, so it has no row to hang an Indent quantity off and
 * fell out of every mail — the customer was told about the shortfall on the
 * SKUs they partly got, and heard nothing at all about the SKUs they got none
 * of.
 *
 * They are reported in a SECOND table rather than folded into the first. The
 * booking table's columns are Booked / Confirmed / Change, which are facts
 * about an order row; a standalone indent has none of them, and inventing
 * zeroes for it would change what every existing figure in that table means.
 * See `standaloneIndentLines` on the journey, and the Standalone Indents
 * section in `journeyTablesHtml`.
 *
 * This module is a LEAF: it imports models only, so both mail utils and the
 * sales controller can build on it without an import cycle.
 */

import AuditLog from '../models/AuditLog.js';
import Order, { LINE_ORDER } from '../models/Order.js';
import { Product } from '../models/Product.js';
import Reservation from '../models/Reservation.js';

/**
 * A customer edit RESETS the baseline the desk's changes are measured from,
 * rather than counting as one — see buildChangeSummary.
 */
export const QTY_EDIT_ACTIONS = {
  desk: 'Booking Edited (Sales)',
  customer: 'Booking Edited (Customer)',
};

// -- The live indent balance ------------------------------------------------

/** A booking and its indent share a sequence number: BO-2026-001312 -> PI-2026-001312. */
export const indentIdFor = (orderId) => String(orderId).replace(/^[A-Z]+-/, 'PI-');

/**
 * Open indent quantity per SKU, for one or many bookings.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RESERVATION AND NOT `Order.pendingQty`
 * ---------------------------------------------------------------------------
 *
 * `pendingQty` is the remainder FROZEN onto the order row at confirmation. The
 * reservation is the live balance, and the two diverge the moment stock arrives
 * and auto-books part of the indent ('Indent Auto-Booked'): the snapshot still
 * says 20 pcs are outstanding when only 15 are.
 *
 * They are also the SAME UNITS - `resItem.quantity = pendingQty` at the split -
 * so adding a booking's `pendingQty` to its indent would count the shortfall
 * twice. Only one of them may be used, and the live one is the right one.
 *
 * ---------------------------------------------------------------------------
 * BATCHED ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * Takes an ARRAY so a list of bookings costs one query rather than one per row.
 * The sales list renders every pending booking, and a per-booking lookup there
 * is the classic N+1 that only shows up once the desk has a few hundred.
 *
 * @param {string[]} orderIds
 * @returns {Promise<Map<string, Map<string, number>>>} orderId -> (skuCode -> qty)
 */
export const openIndentsByOrder = async (orderIds = []) => {
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];
  const out = new Map(ids.map((id) => [id, new Map()]));
  if (ids.length === 0) return out;

  // Map the indent number back to the booking it belongs to, so one query
  // serves them all.
  const bookingByIndent = new Map(ids.map((id) => [indentIdFor(id), id]));

  const rows = await Reservation.find({
    indentNumber: { $in: [...bookingByIndent.keys()] },
    // Only what is still outstanding. A Confirmed or Cancelled reservation has
    // either become stock on the booking or gone away, and counting it would
    // report units the customer is no longer waiting for.
    status: { $in: ['Pending', 'Partially Confirmed'] },
  }).select('indentNumber skuCode quantity').lean();

  for (const r of rows) {
    const orderId = bookingByIndent.get(r.indentNumber);
    if (!orderId) continue;
    const bySku = out.get(orderId);
    bySku.set(r.skuCode, (bySku.get(r.skuCode) || 0) + (r.quantity || 0));
  }
  return out;
};

/**
 * How many open indent lines per booking the MSIL supply check is holding for
 * a Convert / Cancel decision (utils/msilSupply.js). One query for the page, so
 * the bookings list can flag them without opening each booking.
 */
export const awaitingDecisionByOrder = async (orderIds = []) => {
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];
  const out = new Map();
  if (ids.length === 0) return out;
  const bookingByIndent = new Map(ids.map((id) => [indentIdFor(id), id]));
  const rows = await Reservation.aggregate([
    {
      $match: {
        indentNumber: { $in: [...bookingByIndent.keys()] },
        status: { $in: ['Pending', 'Partially Confirmed'] },
        'supplyCheck.status': 'Awaiting decision',
      },
    },
    { $group: { _id: '$indentNumber', n: { $sum: 1 } } },
  ]);
  for (const r of rows) out.set(bookingByIndent.get(r._id), r.n);
  return out;
};

/** The single-booking case. */
export const openIndentBySku = async (orderId) =>
  (await openIndentsByOrder([orderId])).get(String(orderId)) ?? new Map();

/**
 * Display names for a set of SKUs, in ONE query across every brand.
 *
 * A product's display name is its `description` — the master has no `name`
 * field, and every screen that shows one reads that column (see
 * inventory/activity.controller.js). Missing is null, never the SKU: the caller
 * decides whether to fall back, and a name that is silently the code again
 * would make an empty master look populated.
 *
 * Uniqueness is per-brand, so the same code can exist twice. Indent lines carry
 * no brand of their own, so the first match wins — which is also what
 * `findProductBySku` does, and the two must not disagree about the name of the
 * line they are both describing.
 */
export const productNamesForSkus = async (skuCodes = []) => {
  const skus = [...new Set(skuCodes.filter(Boolean).map(String))];
  const out = new Map();
  if (!skus.length) return out;

  const rows = await Product.find({ skuCode: { $in: skus } }, 'skuCode description').lean();
  for (const p of rows) {
    if (!out.get(p.skuCode) && p.description) out.set(p.skuCode, p.description);
  }
  return out;
};

/**
 * Which SKUs this booking actually holds an order row for.
 *
 * The question behind "is this indent line standalone": a SKU with a row was
 * partly covered by stock and is already on the booking table; a SKU without
 * one was covered not at all and appears nowhere. Takes the already-loaded rows
 * when a caller has them, so the sales desk's detail response does not pay for
 * a second query it already made.
 */
const bookedSkusFor = async (orderId, rows = null) => {
  const source = rows ?? await Order.find({ orderId }).select('skuCode').lean();
  return new Set(source.map((r) => r.skuCode).filter(Boolean));
};

/**
 * The open indent for ONE booking, as lines.
 *
 * ---------------------------------------------------------------------------
 * WHY LINES AND NOT THE SUM openIndentsByOrder ALREADY GIVES
 * ---------------------------------------------------------------------------
 * The desk cross-checks a booking against the customer's paper PO. The indent
 * is the half of that with nothing to look at: a line stock could not cover AT
 * ALL never became an order row — the confirmation only pushes one when
 * `confirmedQty > 0` — so it exists solely as a reservation and appears nowhere
 * in Booking Items. A summed quantity says how much is outstanding; only the
 * lines say WHICH SKUs, which is what makes the two documents comparable.
 *
 * Same filter as `openIndentsByOrder`, and for the same reason: a Confirmed or
 * Cancelled reservation has either become stock on the booking or gone away,
 * and listing it would show the customer units they are no longer waiting for.
 *
 * Rows are the LIVE balance, never `Order.pendingQty` — see the note on that
 * function. The two diverge the moment stock arrives and auto-books part of the
 * indent, and this section exists precisely to expose that kind of mismatch.
 *
 * DETAIL ONLY. The bookings LIST does not call this: it needs a total per
 * booking, which the batched `openIndentsByOrder` already gives it in one
 * query, and fetching every reservation line for a whole page would be a
 * query per row for something no list column shows.
 *
 * Every line is classified:
 *
 *   standalone: true   no order row on this booking carries the SKU — stock
 *                      covered none of it, so it is invisible everywhere the
 *                      booking's own lines are listed.
 *   standalone: false  the booking holds a partly-confirmed row for the SKU;
 *                      the shortfall already shows in that row's Indent column.
 *
 * The flag is decided on the SERVER and sent, rather than left to each screen
 * to work out by comparing two lists. The sales desk used to derive it from the
 * line table it had on hand, which made the answer move while the desk typed —
 * adding the missing SKU as a draft line made the warning about it disappear
 * before anything had been saved.
 *
 * @param {object[]|null} [options.rows] the booking's order rows, if loaded
 */
export const openIndentLinesFor = async (orderId, { rows = null } = {}) => {
  const indentNumber = indentIdFor(orderId);

  const reservations = await Reservation.find({
    indentNumber,
    status: { $in: ['Pending', 'Partially Confirmed'] },
  })
    .select('reservationId skuCode msilCode quantity status reservationDate expiryDate supplyDate supplyCheck')
    .sort({ skuCode: 1 })
    .lean();

  // Both lookups are skipped entirely for a booking stock covered in full,
  // which is most of them.
  const [booked, names] = reservations.length
    ? await Promise.all([
      bookedSkusFor(orderId, rows),
      productNamesForSkus(reservations.map((r) => r.skuCode)),
    ])
    : [new Set(), new Map()];

  return {
    indentNumber,
    lines: reservations.map((r) => ({
      reservationId: r.reservationId,
      skuCode: r.skuCode,
      msilCode: r.msilCode || null,
      // The material's name, so a line can be recognised without looking the
      // code up. Null when the master has none — the screen falls back to the
      // SKU, which it is already showing.
      productName: names.get(r.skuCode) || null,
      quantity: r.quantity || 0,
      // See the note above: decided here, not on the screen.
      standalone: !booked.has(r.skuCode),
      status: r.status,
      reservedOn: r.reservationDate || null,
      expiresOn: r.expiryDate || null,
      // The MSIL supply check's verdict (utils/msilSupply.js). 'Awaiting
      // decision' is what puts Convert / Cancel on the desk.
      supplyDate: r.supplyDate || null,
      supplyCheck: r.supplyCheck?.status
        ? {
          status: r.supplyCheck.status,
          reason: r.supplyCheck.reason || null,
          arrivedAt: r.supplyCheck.arrivedAt || null,
          decidedAt: r.supplyCheck.decidedAt || null,
        }
        : null,
    })),
  };
};


// ── Change replay (moved verbatim from sales.controller) ───────────────────

export const buildChangeSummary = async (rows, orderId) => {
  const editLogs = await AuditLog.find({
    action: { $in: [QTY_EDIT_ACTIONS.desk, QTY_EDIT_ACTIONS.customer] },
    'meta.orderId': orderId,
  }).sort({ createdAt: 1 }).lean();

  // Replay the edits forward, keyed by the SKU each line carries at that point
  // in time, so a line that was re-coded still resolves to the quantity it was
  // booked with.
  const origin = new Map();  // current skuCode → { qty, addedByDesk, fromSku }
  const removed = new Map(); // skuCode → booking-stage qty

  for (const log of editLogs) {
    // A customer revising their own order moves the baseline: from here on,
    // "what the booking held" is what THEY last asked for, and only the desk's
    // later edits read as adjustments.
    const byCustomer = log.action === QTY_EDIT_ACTIONS.customer;
    for (const c of log?.meta?.changes || []) {
      if (byCustomer) {
        if (c.type === 'removed') { origin.delete(c.skuCode); continue; }
        const sku = c.type === 'sku' ? c.toSku : c.skuCode;
        const prior = origin.get(sku);
        origin.set(sku, {
          qty: c.toQty ?? 0,
          addedByDesk: prior?.addedByDesk ?? false,
          fromSku: prior?.fromSku ?? null,
        });
        continue;
      }
      if (c.type === 'added') {
        origin.set(c.skuCode, { qty: 0, addedByDesk: true, fromSku: null });
        removed.delete(c.skuCode); // re-added → no longer a removal
      } else if (c.type === 'removed') {
        const prior = origin.get(c.skuCode);
        // Only report a line the CUSTOMER booked. One the desk both added and
        // removed never reached them.
        if (!prior?.addedByDesk) removed.set(c.skuCode, prior?.qty ?? c.fromQty ?? 0);
        origin.delete(c.skuCode);
      } else if (c.type === 'sku') {
        // The line survives under a new code — carry its origin across, keeping
        // the code it was booked under so the customer can recognise it.
        const prior = origin.get(c.fromSku)
          ?? { qty: c.fromQty ?? 0, addedByDesk: false, fromSku: c.fromSku };
        origin.delete(c.fromSku);
        origin.set(c.toSku, { ...prior, fromSku: prior.fromSku ?? c.fromSku });
      } else if (!origin.has(c.skuCode)) {
        // First sighting of a line wins: that is its pre-edit, booking-stage state.
        // 'quantity-split' rows land here too — the fromQty they carry is the
        // quantity held before the edit, exactly like a plain 'quantity' row.
        origin.set(c.skuCode, { qty: c.fromQty ?? 0, addedByDesk: false, fromSku: null });
      }
    }
  }

  // The LIVE indent balance - see openIndentsByOrder for why the reservation
  // and not the pendingQty frozen on the order row.
  const indentBySku = await openIndentBySku(orderId);

  const lines = rows.map((r) => {
    const booked = r.confirmedQty || 0;
    const indent = indentBySku.get(r.skuCode) || 0;
    // The line's TOTAL as it stands: confirmed plus what is still open on the
    // indent. Computed, not read from bookedQty — the snapshot goes stale the
    // moment stock auto-books part of the indent, and a Booked column that
    // disagrees with Confirmed + Indent is the first thing a customer notices.
    const total = booked + indent;
    const base = {
      skuCode: r.skuCode,
      msilCode: r.msilCode || null,
      fromSku: null,
      onPo: total,
      booked,
      indent,
    };
    const o = origin.get(r.skuCode);

    if (!o) {
      // Never edited by the desk. The bookedQty check is the marker
      // runUpdateItems stamps on a line it added itself, and covers the case
      // where that line's audit entry did not survive — no customer line is
      // ever written with bookedQty 0.
      const deskAdded = (r.bookedQty || 0) === 0 && booked > 0;
      return { ...base, change: deskAdded ? total : 0, type: deskAdded ? 'added' : 'unchanged' };
    }

    if (o.addedByDesk) return { ...base, change: total, type: 'added' };

    // Change is TOTAL against TOTAL: the desk's quantity means "this many
    // units for the customer", so raising 5 to 15 is +10 whether stock covered
    // it or the indent did. Measuring on the confirmed part alone is what once
    // reported "No change" on an edit that moved 15 units to indent.
    // (The baseline is the first audit entry's fromQty; entries written before
    // the totals rework recorded the confirmed part there, so a booking edited
    // under both schemes can over-report — new edits are exact.)
    const change = total - o.qty;
    // A re-code is a change even when the quantity is untouched, so it is typed
    // in its own right rather than falling through to "no change".
    if (o.fromSku && o.fromSku !== r.skuCode) {
      return { ...base, fromSku: o.fromSku, change, type: 'recoded' };
    }
    return { ...base, change, type: change > 0 ? 'increased' : change < 0 ? 'reduced' : 'unchanged' };
  });

  const currentSkus = new Set(rows.map((r) => r.skuCode));
  for (const [skuCode, qty] of removed) {
    if (currentSkus.has(skuCode)) continue;
    lines.push({
      skuCode, msilCode: null, fromSku: null,
      onPo: qty, booked: 0, change: -qty, indent: indentBySku.get(skuCode) || 0,
      type: 'removed',
    });
  }

  const sum = (key) => lines.reduce((n, l) => n + l[key], 0);
  return {
    lines,
    changed: lines.some((l) => l.type !== 'unchanged'),
    totalOnPo: sum('onPo'),
    totalBooked: sum('booked'),
    totalChange: sum('change'),
    totalIndent: sum('indent'),
  };
};

/** Signed description of what the desk did to one line, for the Change column. */
export const changeLabel = (l) => {
  const signed = `${l.change > 0 ? '+' : '-'}${Math.abs(l.change)} pcs`;
  if (l.type === 'added') return `${signed} — line added`;
  if (l.type === 'removed') return `${signed} — line removed`;
  if (l.type === 'recoded') {
    return l.change === 0
      ? `re-coded from ${l.fromSku}`
      : `re-coded from ${l.fromSku}, ${signed}`;
  }
  return l.change === 0 ? 'No change' : signed;
};

// ── Journey assembly ───────────────────────────────────────────────────────

/**
 * The dispatch date of every line, keyed by SKU.
 *
 * ---------------------------------------------------------------------------
 * A LIST PER SKU, NOT A DATE PER SKU
 * ---------------------------------------------------------------------------
 *
 * One booking can carry the same SKU on more than one row — a desk-added line,
 * or stock that arrived later against the indent and was allocated as its own
 * row — and those rows can be scheduled for different days. Collapsing them to
 * one date would quietly drop a delivery the customer has been promised, so
 * every distinct day is kept and the renderer prints them all.
 *
 * Dates are de-duplicated on their UTC day, which is how a dispatch date is
 * stored whether the default wrote it (utils/dispatchDate.js) or the desk
 * picked it, so two rows scheduled for the same day read as one date.
 *
 * A row with no date contributes NOTHING rather than a null entry: a SKU whose
 * rows are all unscheduled ends up with an empty list, which the renderer shows
 * as an em dash — "not scheduled yet", not "scheduled for nothing".
 *
 * @returns {Map<string, Date[]>}
 */
export const dispatchDatesBySku = (orderRows = []) => {
  const out = new Map();
  for (const r of orderRows) {
    if (!r?.skuCode) continue;
    if (!out.has(r.skuCode)) out.set(r.skuCode, []);
    const when = r.scheduledDate ? new Date(r.scheduledDate) : null;
    if (!when || Number.isNaN(when.getTime())) continue;
    const list = out.get(r.skuCode);
    if (!list.some((d) => d.getTime() === when.getTime())) list.push(when);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
};

/**
 * Everything the table needs, computed once per mail.
 *
 * @param {string} orderId
 * @param {object[]|null} rows  pass the already-loaded booking to skip a query
 * @returns null when the booking has no rows (e.g. a standalone indent).
 */
export const buildBookingJourney = async ({ orderId, rows = null }) => {
  const orderRows = rows && rows.length
    ? rows
    : await Order.find({ orderId }).sort(LINE_ORDER);
  if (!orderRows.length) return null;

  const summary = await buildChangeSummary(orderRows, orderId);

  const indentLines = summary.lines
    .filter((l) => (l.indent || 0) > 0)
    .map((l) => ({ skuCode: l.skuCode, msilCode: l.msilCode, quantity: l.indent }));

  /**
   * THE STANDALONE INDENT — the lines the table above structurally cannot show.
   *
   * Measured against the rows the booking table actually renders, NOT against
   * the order rows. The two differ by one case that matters: a line the desk
   * REMOVED is gone from the order rows but is still pushed onto
   * `summary.lines` from the audit trail, carrying its open indent in the
   * Indent column. Keying off the order rows would list such a line in both
   * tables and double its quantity on the page.
   *
   * So the rule is exactly "an open indent line that no row of the booking
   * table accounts for", which is the only definition under which the two
   * tables partition the indent instead of overlapping on it.
   */
  const accounted = new Set(summary.lines.map((l) => l.skuCode));
  const standaloneIndentLines = (await openIndentLinesFor(orderId, { rows: orderRows }))
    .lines.filter((l) => !accounted.has(l.skuCode));

  const first = orderRows[0];
  const po = String(first.poNumber ?? '').trim();
  const locked = Boolean(first.poGeneratedAt) || (po !== '' && po !== '-');

  return {
    orderId,
    bookingDate: first.orderTimestamp || first.date || first.createdAt,
    indentId: `PI-${String(orderId).replace(/^[A-Z]+-/, '')}`,
    po: locked
      ? {
          number: first.poNumber,
          raisedAt: first.poGeneratedAt || null,
          promiseDate: first.promiseDate || first.supplyByDate || null,
        }
      : null,
    summary,
    indentLines,
    standaloneIndentLines,
    // Per line, for the Dispatch Date column. See dispatchDatesBySku().
    dispatchBySku: dispatchDatesBySku(orderRows),
  };
};

/**
 * The journey shape for a STANDALONE indent — a confirmation where nothing
 * could be fulfilled, so no booking exists. The table still renders, from the
 * indent lines, showing every unit as ordered but none confirmed.
 */
export const indentOnlyJourney = ({ indentId, lines = [] }) => ({
  orderId: null,
  bookingDate: new Date(),
  indentId,
  po: null,
  summary: null,
  indentLines: lines.map((l) => ({
    skuCode: l.skuCode,
    msilCode: l.msilCode || null,
    quantity: Number(l.quantity) || 0,
  })),
  /**
   * EMPTY ON PURPOSE, even though every line here is in the literal sense
   * standalone. The second table exists to carry what the FIRST one cannot,
   * and on this mail the first table is already built from these very lines —
   * listing them again below would print the same indent twice and double its
   * total on the page.
   */
  standaloneIndentLines: [],
  // No booking, so no line has a dispatch date: nothing is in hand to dispatch.
  dispatchBySku: new Map(),
});

// ── Rendering ──────────────────────────────────────────────────────────────

// Local copies of the mail styling constants. This module must stay a leaf —
// importing them from indentMail.js would create the cycle it exists to avoid.
const escHtml = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtD = (d) => {
  const date = d ? new Date(d) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/**
 * A calendar DAY stored as UTC midnight — a dispatch date, however it was set
 * (utils/dispatchDate.js, or picked on the Sales Desk) — printed as that same
 * day wherever the server runs.
 *
 * `fmtD` above reads in the server's zone, which is right for an instant like
 * the booking time and wrong for a stored day: on a server west of UTC it
 * renders the day BEFORE the one the desk picked, so the customer is told to
 * expect goods a day early. Same reasoning, and same fix, as `fmtDay` in
 * indentMail.js.
 */
const fmtDispatchDay = (d) => {
  const date = d ? new Date(d) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-IN', {
    timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
  });
};

/**
 * The Dispatch Date cell for one SKU.
 *
 * Several dates are stacked, not joined onto one line: they are separate
 * promises about separate rows, and a comma between them reads as a range.
 * No date at all is an em dash — see the note at the top of this module on why
 * an unscheduled line must not borrow anybody else's date.
 */
const dispatchCell = (dates = []) => {
  const printed = dates.map(fmtDispatchDay).filter(Boolean);
  if (!printed.length) {
    return `<span style="color: #bbb;" title="Not scheduled yet.">&mdash;</span>`;
  }
  return printed
    .map((d) => `<div style="white-space: nowrap;">${escHtml(d)}</div>`)
    .join('');
};

const CELL = 'padding: 7px 12px; border-bottom: 1px solid #eee; font-size: 13px;';
const HEAD = 'padding: 7px 12px; background: #f4f6f8; color: #555; text-align: left; '
  + 'font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e3e7eb;';

const TONE = {
  increased: 'color: #1a7f37; font-weight: bold;',
  reduced: 'color: #b54708; font-weight: bold;',
  added: 'color: #1a5b9e; font-weight: bold;',
  removed: 'color: #b42318; font-weight: bold;',
  recoded: 'color: #1a5b9e; font-weight: bold;',
  unchanged: 'color: #888;',
};

const sectionHeading = (text, caption) => `
  <h4 style="margin: 22px 0 2px; font-size: 13px; color: #1a5b9e; text-transform: uppercase; letter-spacing: 0.5px;">
    ${escHtml(text)}
  </h4>
  ${caption ? `<p style="margin: 0 0 8px; font-size: 12px; color: #888;">${caption}</p>` : ''}`;

const emptyNote = (text) => `
  <p style="margin: 4px 0 8px; padding: 10px 14px; background: #fafafa; border: 1px dashed #ddd;
            border-radius: 4px; font-size: 13px; color: #777;">${escHtml(text)}</p>`;

/**
 * The booking, as ONE table.
 *
 * This was three tables — as-confirmed, indent, final — which left the customer
 * cross-reading three grids to answer a single question: what did I order, what
 * am I actually getting, and what changed. One row per SKU carries the same
 * facts in five columns:
 *
 *   Booked     what the customer ordered, indent included. Never moves.
 *   Confirmed  what the booking holds against stock right now.
 *   Indent     what is still awaiting stock. Read live, so it shrinks as stock
 *              arrives against it.
 *   Change     what Admin or Sales adjusted AFTER the booking was placed, and
 *              nothing else — a stock shortfall at booking time is not an
 *              adjustment, it is the Indent column.
 *
 * Booked minus Confirmed is therefore the shortfall, and Change is the human
 * decision laid over it. Keeping those two apart is the whole point of the
 * table: conflating them is what once told a customer their 50 had been
 * "changed to 2" when nobody had touched it.
 *
 * The MSIL column follows the audience rule the rest of the mails use: the
 * customer orders by SKU; support reconciles codes, so only support sees it.
 *
 * @param {boolean} [opts.dispatchDates=true] render the Dispatch Date column.
 *   Pass false ONLY on a mail that already carries the booking's delivery
 *   schedule table — the PO mail — so the same dates are not printed twice.
 */
export const journeyTablesHtml = (journey, { audience = 'customer', dispatchDates = true } = {}) => {
  if (!journey) return '';
  const showMsil = audience === 'support';
  const msilHead = showMsil ? `<th style="${HEAD}">MSIL Code</th>` : '';
  const msilCell = (v) => (showMsil ? `<td style="${CELL}">${escHtml(v || '\u2014')}</td>` : '');

  // One row per SKU. Driven by the change replay when a booking exists; a
  // STANDALONE indent has no booking rows at all, so its lines come straight
  // off the indent and read as "ordered, none confirmed, all awaiting stock".
  const rows = journey.summary
    ? journey.summary.lines.map((l) => ({
      skuCode: l.skuCode,
      msilCode: l.msilCode,
      booked: l.onPo,
      confirmed: l.booked,
      indent: l.indent,
      change: l.change,
      type: l.type,
      label: changeLabel(l),
    }))
    : journey.indentLines.map((l) => ({
      skuCode: l.skuCode,
      msilCode: l.msilCode,
      booked: l.quantity,
      confirmed: 0,
      indent: l.quantity,
      change: 0,
      type: 'unchanged',
      label: 'No change',
    }));

  if (!rows.length) return emptyNote('This booking has no line items.');

  const t = (k) => rows.reduce((n, r) => n + r[k], 0);
  const tc = t('change');
  const ti = t('indent');

  /**
   * The Dispatch Date column rides on the BOOKING table only.
   *
   * A journey with no `dispatchBySku` is one built before this column existed,
   * or the indent-only shape, where nothing is in hand to dispatch. Dropping
   * the column entirely in that case keeps those mails exactly as they were
   * rather than giving them a row of em dashes to explain.
   *
   * `dispatchDates: false` is the PO mail, and ONLY the PO mail. That mail
   * already attaches the booking's full delivery schedule — every live line,
   * its quantity and its dispatch date, in the layout the customer files
   * purchase orders in — so the column here would print the same dates a few
   * inches above the table that exists to carry them. The caller passes false
   * only when that schedule table is actually present; when it is empty (every
   * line cancelled) the column stays, because then nothing else on the mail
   * says when anything leaves. See raisePo() in sales.controller.js.
   */
  const dispatchBySku = journey.dispatchBySku instanceof Map ? journey.dispatchBySku : null;
  const showDispatch = Boolean(dispatchDates && dispatchBySku && journey.summary);
  const dispatchHead = showDispatch
    ? `<th style="${HEAD}">Dispatch Date</th>`
    : '';
  const dispatchTd = (skuCode) => (showDispatch
    ? `<td style="${CELL}">${dispatchCell(dispatchBySku.get(skuCode) || [])}</td>`
    : '');

  const body = rows.map((r) => `
    <tr>
      <td style="${CELL}"><strong>${escHtml(r.skuCode)}</strong></td>
      ${msilCell(r.msilCode)}
      <td style="${CELL} text-align: right;">${r.booked} pcs</td>
      <td style="${CELL} text-align: right; font-weight: bold; ${r.confirmed > 0 ? 'color: #1a7f37;' : 'color: #bbb;'}">${r.confirmed} pcs</td>
      <td style="${CELL} text-align: right; ${r.indent > 0 ? 'color: #b54708; font-weight: bold;' : 'color: #bbb;'}">${r.indent} pcs</td>
      ${dispatchTd(r.skuCode)}
      <td style="${CELL} ${TONE[r.type] || TONE.unchanged}">${escHtml(r.label)}</td>
    </tr>`).join('');

  const tableHtml = `
    <table style="border-collapse: collapse; margin: 0 0 10px; width: 100%;">
      <thead><tr>
        <th style="${HEAD}">SKU</th>${msilHead}
        <th style="${HEAD} text-align: right;">Booked</th>
        <th style="${HEAD} text-align: right;">Confirmed</th>
        <th style="${HEAD} text-align: right;">Indent</th>
        ${dispatchHead}
        <th style="${HEAD}">Change</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="${showMsil ? 2 : 1}" style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">${t('booked')} pcs</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; color: #1a7f37;">${t('confirmed')} pcs</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; ${ti > 0 ? 'color: #b54708;' : 'color: #bbb;'}">${ti} pcs</td>
        ${showDispatch ? `<td style="${CELL} border-bottom: none;"></td>` : ''}
        <td style="${CELL} border-bottom: none; font-weight: bold;">${tc === 0 ? '' : `${tc > 0 ? '+' : '-'}${Math.abs(tc)} pcs`}</td>
      </tr></tfoot>
    </table>`;

  // PO facts stay: they are the reference the customer quotes from the moment
  // the PO exists, and with the tables merged this is the only place the status
  // mails carry them. A few labelled values, not a fourth table.
  const poHtml = journey.po
    ? `<p style="margin: 0 0 10px; font-size: 12px; color: #666;">
         Purchase Order <strong style="font-family: monospace; color: #1a5b9e;">${escHtml(journey.po.number)}</strong>
         raised on <strong>${fmtD(journey.po.raisedAt)}</strong>${journey.po.promiseDate
           ? ` &middot; promise date <strong>${fmtD(journey.po.promiseDate)}</strong>` : ''}.
       </p>`
    : '';

  const standalone = Array.isArray(journey.standaloneIndentLines)
    ? journey.standaloneIndentLines
    : [];
  const standaloneQty = standalone.reduce((n, l) => n + (Number(l.quantity) || 0), 0);

  // The indent has its own reference number, and the customer needs it to chase
  // the outstanding units — so it is named whenever any remain, on either table.
  const indentNote = (ti > 0 || standaloneQty > 0) && journey.indentId
    ? `<p style="margin: 0 0 8px; font-size: 12px; color: #888;">
         Indent reference <strong style="font-family: monospace; color: #b54708;">${escHtml(journey.indentId)}</strong>
         &mdash; the Indent column is live and shrinks as stock arrives.
       </p>`
    : '';

  // Once the PO exists the transaction IS a purchase order — the section is
  // headed as one, so the mail does not keep calling it a booking after the
  // conversion mail told the customer the name changed.
  return `
    ${sectionHeading(
      journey.po ? 'Purchase Order Details' : 'Booking Details',
      journey.bookingDate ? `As booked on ${fmtD(journey.bookingDate)}.` : null)}
    ${poHtml}
    ${tableHtml}
    ${indentNote}
    ${standaloneIndentHtml(journey, standalone, { showMsil })}`;
};

/**
 * STANDALONE INDENTS — its own section, under the booking table.
 *
 * These are the SKUs stock could not cover at all. They have no order row, so
 * the table above has nowhere to put them (see the note at the top of this
 * module), and until now the customer's confirmation mail simply did not
 * mention them: they asked for five materials, were told about the three that
 * were partly in stock, and the two that were entirely out went unmentioned.
 *
 * SEPARATE, NOT MERGED. The booking table's Booked / Confirmed / Change columns
 * are facts about an order row; these lines have none, and filling those cells
 * with zeroes would change the meaning of every total above. Keeping the two
 * apart also keeps the existing partial-indent reporting exactly as it was —
 * nothing in the first table moves because this one exists.
 *
 * Rendered only when there is something to say. A booking whose indent is
 * entirely partial, or which has no indent at all, gets the mail it always got.
 */
const standaloneIndentHtml = (journey, lines, { showMsil }) => {
  if (!lines.length) return '';

  const total = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  const msilHead = showMsil ? `<th style="${HEAD}">MSIL Code</th>` : '';

  const body = lines.map((l) => `
    <tr>
      <td style="${CELL}"><strong>${escHtml(l.skuCode)}</strong></td>
      ${showMsil ? `<td style="${CELL}">${escHtml(l.msilCode || '—')}</td>` : ''}
      <td style="${CELL}">${escHtml(l.productName || '—')}</td>
      <td style="${CELL} text-align: right; color: #b54708; font-weight: bold;">${Number(l.quantity) || 0} pcs</td>
      <td style="${CELL}">${escHtml(l.status || '—')}</td>
      <td style="${CELL} font-family: monospace; font-size: 12px;">${escHtml(l.reservationId || '—')}</td>
    </tr>`).join('');

  return `
    ${sectionHeading(
      'Standalone Indents',
      'Materials on this booking that stock could not cover at all. They carry no '
      + 'confirmed quantity, so they do not appear in the table above.')}
    <p style="margin: 0 0 8px; font-size: 12px; color: #666;">
      Raised under indent
      <strong style="font-family: monospace; color: #b54708;">${escHtml(journey.indentId || '—')}</strong>
      ${journey.orderId
        ? `against booking <strong style="font-family: monospace; color: #1a5b9e;">${escHtml(journey.orderId)}</strong>`
        : ''}.
    </p>
    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead><tr>
        <th style="${HEAD}">SKU / Product Code</th>${msilHead}
        <th style="${HEAD}">Product Name</th>
        <th style="${HEAD} text-align: right;">Qty on Indent</th>
        <th style="${HEAD}">Status</th>
        <th style="${HEAD}">Line Ref</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="${showMsil ? 3 : 2}" style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; color: #b54708;">${total} pcs</td>
        <td style="${CELL} border-bottom: none;"></td>
        <td style="${CELL} border-bottom: none;"></td>
      </tr></tfoot>
    </table>
    <p style="margin: 0 0 8px; font-size: 12px; color: #888;">
      These units are not dispatched with the booking above. They are scheduled
      once material is received, and we will email you when that happens.
    </p>`;
};

export default {
  QTY_EDIT_ACTIONS, buildChangeSummary, changeLabel,
  buildBookingJourney, indentOnlyJourney, journeyTablesHtml,
  dispatchDatesBySku, productNamesForSkus,
};
