/**
 * BOOKING HISTORY — one booking's whole journey, read from the records the
 * system already keeps. Nothing here is written, and nothing is inferred from
 * where the booking stands today.
 *
 * WHERE EACH PART COMES FROM
 *
 *   Booking created   the per-line 'Reservation Confirmed' audit entries the
 *                     confirmation writes (requested / confirmed / pending, per
 *                     line, at that moment); 'Indent Auto-Booked' for a booking
 *                     raised from an indent; 'Booking Created' for the older
 *                     order endpoint. The booking lines' own timestamp only
 *                     when none of those exists, and then said so.
 *   Indent raised     the same confirmation entries (their `pending`); an
 *                     indent line a desk edit created is part of that edit.
 *   Allocations       'Indent Allocated', written whenever arriving stock is
 *                     put on the booking. It keeps the quantity allocated even
 *                     after part of it is moved away, which the allocation
 *                     record on the line does not (a move shrinks or removes
 *                     it). Records with no such entry are shown from the line.
 *   Booking confirmed the PO raise: poGeneratedAt / poGeneratedBy on the lines
 *                     and the 'PO Generated' entry beside it.
 *   Status changes    BookingStatusEvent, with whether the customer was emailed.
 *   Further updates   every other audit entry that names this booking.
 *
 * ONE ENTRY PER THING THAT HAPPENED. Several of those actions write more than
 * one record — a hand assignment writes 'Indent Stock Assigned' AND 'Indent
 * Allocated', a status change writes the status event AND 'Booking Status
 * Updated', a cancellation writes 'Booking Cancelled' AND a 'Cancelled' status
 * event. Each such group is folded into one entry (the extra records supply who
 * did it and from where), and every audit entry consumed that way is marked so
 * it is never listed a second time.
 *
 * WHERE AN ENTRY WAS RAISED FROM is read off the audit entry itself: the API
 * path it was written for and who wrote it. The booking's own customer acting
 * is the Customer Portal; no user at all is the system.
 */

import AuditLog from '../../models/AuditLog.js';
import BookingStatusEvent from '../../models/BookingStatusEvent.js';
import Order, { LINE_ORDER } from '../../models/Order.js';
import Reservation from '../../models/Reservation.js';
import User from '../../models/User.js';
import { bookingStatusOf, stageLabel } from '../../utils/bookingLifecycle.js';
import { isPlaceholderPo, isPoGenerated } from '../../utils/bookingLock.js';
import { indentIdFor, QTY_EDIT_ACTIONS } from '../../utils/bookingJourney.js';

const MINUTE = 60 * 1000;
const OPEN_INDENT = ['Pending', 'Partially Confirmed'];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const time = (d) => (d ? new Date(d).getTime() : NaN);
const near = (a, b, windowMs) => Math.abs(time(a) - time(b)) <= windowMs;
const earliest = (dates) => dates
  .filter((d) => d && Number.isFinite(time(d)))
  .reduce((min, d) => (!min || time(d) < time(min) ? d : min), null);
const sum = (list, pick) => list.reduce((n, x) => n + (Number(pick(x)) || 0), 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Dates inside an entry's text read in India time, as every booking mail does.
const IST = { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' };
const istDate = (d) => new Date(d).toLocaleDateString('en-IN', IST);
const istDateTime = (d) => new Date(d).toLocaleString('en-IN', { ...IST, hour: '2-digit', minute: '2-digit' });

// ── Where an entry was raised from ──────────────────────────────────────────

export const SOURCES = Object.freeze({
  customer: { key: 'customer-portal', label: 'Customer Portal' },
  salesDesk: { key: 'sales-desk', label: 'Sales Desk' },
  indentAssignment: { key: 'indent-assignment', label: 'Indent Stock Assignment' },
  indentHistory: { key: 'indent-history', label: 'Indent History' },
  // The /orders booking endpoints (status, cancel, allocation status, PO) are
  // called by both of these screens, and the record does not say which.
  bookings: { key: 'bookings', label: 'Sales Desk / Booking History' },
  system: { key: 'system', label: 'Automatic (system)' },
  staff: { key: 'erp', label: 'ERP' },
  record: { key: 'record', label: 'Booking record' },
});

const sourceOf = (audit, customerId) => {
  if (!audit) return SOURCES.record;
  if (!audit.user || audit.method === 'SYSTEM_JOB') return SOURCES.system;
  const endpoint = String(audit.endpoint || '');
  if (endpoint.includes('/inventory/indent-assignment')) return SOURCES.indentAssignment;
  if (endpoint.includes('/sales/')) return SOURCES.salesDesk;
  if (customerId && String(audit.user) === String(customerId)) return SOURCES.customer;
  if (endpoint.includes('/reservations')) return SOURCES.indentHistory;
  if (endpoint.includes('/orders')) return SOURCES.bookings;
  return SOURCES.staff;
};

// ── Audit entries this module knows ─────────────────────────────────────────

const MANUAL_ASSIGN = ['Indent Stock Assigned', 'Indent Stock Reassigned (In)'];
const CANCEL_ACTIONS = ['Booking Cancelled', 'Booking Auto-Cancelled (No PO)'];
const MSIL_INDENT_ACTIONS = ['MSIL Indent Held', 'MSIL Indent Converted', 'MSIL Indent Cancelled'];

/**
 * How the remaining entries are listed. `kind` groups them for the screen's
 * filter. Anything not named here but carrying this booking's id is still
 * listed, under its own action name, so a new kind of change is never silently
 * missing from the history.
 */
const UPDATE_KINDS = {
  [QTY_EDIT_ACTIONS.desk]: { kind: 'update', title: 'Booking edited' },
  [QTY_EDIT_ACTIONS.customer]: { kind: 'update', title: 'Customer revised the booking' },
  'Booking Details Edited': { kind: 'update', title: 'Booking details edited' },
  'Booking Lines Reordered': { kind: 'update', title: 'Line order changed' },
  'Booking Priced': { kind: 'update', title: 'Pricing updated', pricing: true },
  'MSIL Supply Date Set': { kind: 'update', title: 'MSIL supply date set' },
  'Booking Scheduled': { kind: 'update', title: 'Delivery schedule set' },
  'Booking Status Email Resent': { kind: 'status', title: 'Status email resent' },
  'Booking Status Updated': { kind: 'status', title: 'Status changed' },
  'Allocation Status Updated': { kind: 'allocation', title: 'Allocation status updated' },
  'Inward Allocation Cancelled': { kind: 'allocation', title: 'Allocation cancelled' },
  'Indent Stock Assigned': { kind: 'allocation', title: 'Stock assigned to the indent' },
  'Indent Stock Reassigned (In)': { kind: 'allocation', title: 'Stock moved in from another booking' },
  'Booking Stock Consumed': { kind: 'allocation', title: 'Stock deducted from inventory' },
  'MSIL Indent Held': { kind: 'indent', title: 'Indent line held for a decision' },
  'MSIL Indent Converted': { kind: 'indent', title: 'Held indent line converted' },
  'MSIL Indent Cancelled': { kind: 'indent', title: 'Held indent line cancelled' },
  'Indent Cancelled': { kind: 'indent', title: 'Indent line cancelled' },
  'Indent Restored': { kind: 'indent', title: 'Indent moved back to the selection list' },
  'PO Generated': { kind: 'po', title: 'PO details recorded', pricing: true },
};

/** Never listed on their own: attribution only, or another booking's record. */
const NEVER_LISTED = new Set([
  'Indent Stock Auto-Assigned', 'Reservation Confirmed', 'Indent Auto-Booked', 'Indent Allocated',
  // Only ever the creation entry; a second match is another moment's text.
  'Booking Created',
]);

// "Priced at the Trader rate — 3 of 4 line(s) rated." — tier names are pricing.
const PRICING_SENTENCE = /\s*Priced at the [^.]*? rate — \d+ of \d+ line\(s\) rated\./g;

/** An audit remark without the "Booking BO-…:" prefix the entry already shows. */
const remarkOf = (audit, orderId, { includePricing }) => {
  let text = String(audit?.remarks || '').trim();
  text = text.replace(new RegExp(`^Booking ${escapeRegex(orderId)}:\\s*`), '');
  if (!includePricing) text = text.replace(PRICING_SENTENCE, '').trim();
  return text || null;
};

/** 'Reservation RES-1: confirmed 2, pending 8 (requested 10)' */
const CONFIRMATION = /^Reservation (\S+): confirmed (\d+), pending (\d+) \(requested (\d+)\)/;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole history of one booking.
 *
 * @param {string} orderId
 * @param {object} [opts]
 * @param {boolean} [opts.includePricing] Rate tiers in the entries — only for
 *        a caller who may see pricing.
 * @returns {Promise<object|null>} null when no such booking exists.
 */
export const getBookingHistory = async (orderId, { includePricing = false } = {}) => {
  const rows = await Order.find({ orderId }).sort(LINE_ORDER).lean();
  if (!rows.length) return null;

  const customerId = rows[0].user;
  const indentNumber = indentIdFor(orderId);
  // The confirmation stamps the booking lines and the reservations it fully
  // confirmed with the same instant, which is what links those reservations
  // (they carry no indent number) back to this booking.
  const stamps = [...new Set(rows.map((r) => time(r.orderTimestamp)).filter(Number.isFinite))];

  const [customer, reservations, statusEvents] = await Promise.all([
    User.findById(customerId, 'user name email company customerName').lean(),
    Reservation.find({
      customerId,
      $or: [
        { indentNumber },
        { autoBookedOrderId: orderId },
        ...(stamps.length ? [{ confirmedAt: { $in: stamps.map((t) => new Date(t)) } }] : []),
      ],
    }).sort({ createdAt: 1, _id: 1 }).lean(),
    BookingStatusEvent.find({ orderId }).sort({ changedAt: 1, _id: 1 }).lean(),
  ]);

  // Reservations that became this booking from ANOTHER booking's indent.
  const becameThis = reservations.filter((r) => r.autoBookedOrderId === orderId && r.indentNumber !== indentNumber);
  // Its own: the indent raised with it, and the lines it confirmed in full.
  const own = reservations.filter((r) => !becameThis.includes(r));
  const ownIndents = own.filter((r) => r.indentNumber === indentNumber);
  const rids = reservations.map((r) => r.reservationId).filter(Boolean);
  const ownRids = new Set(own.map((r) => r.reservationId));

  const placedAt = earliest(rows.map((r) => r.orderTimestamp || r.date || r.createdAt)) || rows[0].createdAt;
  const poTimes = rows.map((r) => r.poGeneratedAt).filter(Boolean);
  const allocTimes = rows.flatMap((r) => (r.allocations || []).map((a) => a.at)).filter(Boolean);
  const skus = [...new Set([...rows.map((r) => r.skuCode), ...reservations.map((r) => r.skuCode)])];
  const around = (dates, before, after) => ({
    $gte: new Date(Math.min(...dates.map(time)) - before),
    $lte: new Date(Math.max(...dates.map(time)) + after),
  });
  const named = new RegExp(`\\b${escapeRegex(orderId)}\\b`);

  // Every branch is answerable from an index: meta.orderId (partial), the
  // action index, or the createdAt+action index for the two writers that name
  // the booking only in their remarks.
  const or = [
    { 'meta.orderId': orderId },
    { action: 'Indent Stock Reassigned', 'meta.from.orderId': orderId },
    { action: 'Indent Stock Reassigned', 'meta.to.orderId': orderId },
    { action: 'Booking Created', meta: null, createdAt: around([placedAt], 10 * MINUTE, 10 * MINUTE), remarks: named },
  ];
  if (poTimes.length) {
    or.push({ action: 'PO Generated', meta: null, createdAt: around(poTimes, 10 * MINUTE, 10 * MINUTE), remarks: named });
  }
  if (rids.length) {
    or.push(
      { action: { $in: MSIL_INDENT_ACTIONS }, 'meta.reservationId': { $in: rids } },
      {
        action: 'Reservation Confirmed',
        user: customerId,
        remarks: { $in: rids.map((id) => new RegExp(`^Reservation ${escapeRegex(id)}:`)) },
      },
      {
        action: { $in: ['Indent Cancelled', 'Indent Restored'] },
        remarks: {
          $in: [
            new RegExp(`indent ${escapeRegex(indentNumber)} \\(`),
            ...rids.map((id) => new RegExp(`\\b${escapeRegex(id)}\\b`)),
          ],
        },
      },
    );
  }
  if (allocTimes.length) {
    or.push({
      action: 'Indent Stock Auto-Assigned',
      'meta.skuCodes': { $in: skus },
      createdAt: around(allocTimes, MINUTE, 30 * MINUTE),
    });
  }
  const audits = await AuditLog.find({ $or: or }).sort({ createdAt: 1, _id: 1 }).lean();

  // Who did what: every actor named by any record, in one query.
  const userIds = new Set([
    ...audits.map((a) => a.user),
    ...statusEvents.map((e) => e.changedBy),
    ...rows.map((r) => r.poGeneratedBy),
    ...rows.flatMap((r) => (r.allocations || []).flatMap((a) => [a.statusBy, a.cancelledBy])),
  ].filter(Boolean).map(String));
  const users = new Map(
    (userIds.size ? await User.find({ _id: { $in: [...userIds] } }, 'user name email role').lean() : [])
      .map((u) => [String(u._id), u]),
  );
  const actorOf = (id) => {
    if (!id) return null;
    const u = users.get(String(id));
    if (!u) return { name: 'A removed user', role: null };
    return { name: u.user || u.name || u.email || 'User', role: u.role || null };
  };

  const used = new Set();
  const idOf = (a) => String(a._id);
  const take = (a) => { if (a) used.add(idOf(a)); return a; };
  const events = [];
  const push = (e) => events.push({
    details: [],
    items: [],
    refs: {},
    actor: null,
    notification: null,
    ...e,
    details: (e.details || []).filter(Boolean),
  });
  const from = (audit) => ({ source: sourceOf(audit, customerId), actor: actorOf(audit?.user) });

  // ── The lines as the confirmation recorded them ──────────────────────────
  const resById = new Map(reservations.map((r) => [r.reservationId, r]));
  const confirmations = audits
    .filter((a) => a.action === 'Reservation Confirmed')
    .map((a) => {
      const m = CONFIRMATION.exec(a.remarks || '');
      const r = m && resById.get(m[1]);
      if (!r || !ownRids.has(m[1])) return null;
      return {
        audit: a, reservationId: m[1], skuCode: r.skuCode,
        confirmed: Number(m[2]), pending: Number(m[3]), requested: Number(m[4]),
      };
    })
    .filter(Boolean);
  const atBookingBySku = new Map();
  for (const c of confirmations) {
    const prev = atBookingBySku.get(c.skuCode) || { requested: 0, confirmed: 0, pending: 0 };
    atBookingBySku.set(c.skuCode, {
      requested: prev.requested + c.requested,
      confirmed: prev.confirmed + c.confirmed,
      pending: prev.pending + c.pending,
    });
  }

  // ── 1. Booking created (and the indent raised with it) ───────────────────
  let created = null;
  const autoBooked = audits.find((a) => a.action === 'Indent Auto-Booked' && a.meta?.orderId === orderId);
  if (autoBooked) {
    take(autoBooked);
    // A whole-only indent booked by hand logs its own entry beside this one.
    const manual = take(audits.find((a) => MANUAL_ASSIGN.includes(a.action)
      && a.meta?.orderId === orderId && near(a.createdAt, autoBooked.createdAt, 2 * MINUTE)));
    const lines = autoBooked.meta?.lines || [];
    created = {
      id: `audit:${idOf(autoBooked)}`,
      at: autoBooked.createdAt,
      kind: 'booking',
      title: 'Booking created from indent',
      details: [
        manual
          ? 'Indent stock was assigned to it by hand, which raised this booking.'
          : 'Stock became available for a waiting indent, which raised this booking for it.',
        `${plural(sum(lines, (l) => l.qty), 'unit')} across ${plural(lines.length, 'SKU')}.`,
      ],
      items: lines.map((l) => ({ skuCode: l.skuCode, quantity: l.qty, note: l.indent ? `from indent ${l.indent}` : null })),
      refs: { indentNumbers: [...new Set(lines.map((l) => l.indent).filter(Boolean))] },
      ...from(manual || autoBooked),
      record: 'Audit log',
    };
    push(created);
  } else if (confirmations.length) {
    confirmations.forEach((c) => take(c.audit));
    const first = confirmations[0].audit;
    const requested = sum(confirmations, (c) => c.requested);
    const confirmed = sum(confirmations, (c) => c.confirmed);
    const pending = sum(confirmations, (c) => c.pending);
    created = {
      id: `audit:${idOf(first)}`,
      at: first.createdAt,
      kind: 'booking',
      title: 'Booking created',
      details: [
        `${plural(requested, 'unit')} requested across ${plural(confirmations.length, 'SKU')}: `
          + `${confirmed} confirmed from stock${pending ? `, ${pending} sent to indent ${indentNumber}` : ''}.`,
      ],
      items: confirmations.map((c) => ({
        skuCode: c.skuCode,
        quantity: c.requested,
        note: `${c.confirmed} confirmed${c.pending ? ` · ${c.pending} to indent` : ''}`,
      })),
      ...from(first),
      record: 'Audit log',
    };
    push(created);
    const short = confirmations.filter((c) => c.pending > 0);
    if (short.length) {
      push({
        id: `indent:${indentNumber}:raised`,
        at: first.createdAt,
        kind: 'indent',
        title: `Indent ${indentNumber} raised`,
        details: ['Raised with the booking for what stock could not cover.'],
        items: short.map((c) => ({ skuCode: c.skuCode, quantity: c.pending, note: 'waiting for stock' })),
        refs: { indentNumbers: [indentNumber] },
        ...from(first),
        record: 'Audit log',
      });
    }
  } else {
    const legacy = take(audits.find((a) => a.action === 'Booking Created'));
    created = {
      id: legacy ? `audit:${idOf(legacy)}` : `booking:${orderId}:created`,
      at: legacy?.createdAt || placedAt,
      kind: 'booking',
      title: 'Booking created',
      details: legacy
        ? [remarkOf(legacy, orderId, { includePricing })]
        : [
          `${plural(rows.length, 'line')} on the booking.`,
          'The time is the booking lines\' own; who placed it was not recorded.',
        ],
      items: rows.map((r) => ({ skuCode: r.skuCode, quantity: r.bookedQty || r.confirmedQty || 0, note: null })),
      ...(legacy ? from(legacy) : { source: SOURCES.record, actor: null }),
      record: legacy ? 'Audit log' : 'Booking lines',
    };
    push(created);
  }

  // Indent lines with no confirmation entry and no edit that explains them
  // (raised before those entries existed): shown from the indent record.
  const confirmedRids = new Set(confirmations.map((c) => c.reservationId));
  const editedIndentSkus = new Set(audits
    .filter((a) => [QTY_EDIT_ACTIONS.desk, QTY_EDIT_ACTIONS.customer].includes(a.action))
    .flatMap((a) => (a.meta?.changes || []).filter((c) => c.indentQty > 0).map((c) => c.skuCode)));
  for (const r of ownIndents) {
    if (confirmedRids.has(r.reservationId) || editedIndentSkus.has(r.skuCode)) continue;
    push({
      id: `indent:${r.reservationId}:raised`,
      at: r.reservationDate || r.createdAt,
      kind: 'indent',
      title: `Indent ${indentNumber} raised`,
      details: ['From the indent record; who raised it was not recorded.'],
      items: [{ skuCode: r.skuCode, quantity: null, note: 'waiting for stock' }],
      refs: { indentNumbers: [indentNumber] },
      source: SOURCES.record,
      record: 'Indent record',
    });
  }

  // ── 2. Allocations ───────────────────────────────────────────────────────
  const allocationKey = (skuCode, seq, at) => `${skuCode}#${seq}#${time(at)}`;
  const allocationSource = new Map(); // allocation record -> { source, actor }
  const recordFor = (skuCode, seq, loggedAt) => {
    for (const row of rows) {
      if (row.skuCode !== skuCode) continue;
      const hit = (row.allocations || []).find((x) => x.seq === seq
        && time(x.at) <= time(loggedAt) + 5000 && near(x.at, loggedAt, 5 * MINUTE));
      if (hit) return hit;
    }
    return null;
  };

  for (const a of audits.filter((x) => x.action === 'Indent Allocated' && x.meta?.orderId === orderId)) {
    take(a);
    const items = a.meta?.allocations || [];
    const manual = take(audits.find((m) => !used.has(idOf(m)) && MANUAL_ASSIGN.includes(m.action)
      && m.meta?.orderId === orderId && near(m.createdAt, a.createdAt, 2 * MINUTE)
      && items.some((i) => i.skuCode === m.meta?.skuCode && i.quantity === m.meta?.quantity)));
    let title = 'Stock allocated from indent';
    const details = [];
    let by;
    if (manual) {
      by = from(manual);
      if (manual.action === 'Indent Stock Reassigned (In)') {
        title = 'Stock moved in from another booking';
        const move = take(audits.find((m) => !used.has(idOf(m)) && m.action === 'Indent Stock Reassigned'
          && m.meta?.to?.orderId === orderId && m.meta?.skuCode === manual.meta?.skuCode
          && near(m.createdAt, manual.createdAt, 2 * MINUTE)));
        if (move) {
          details.push(`Moved here from ${move.meta.from.orderId}`
            + `${move.meta.from.indent ? ` (indent ${move.meta.from.indent})` : ''}.`);
        }
      } else {
        details.push('Assigned by hand.');
      }
      const msil = take(audits.find((m) => !used.has(idOf(m)) && m.action === 'MSIL Indent Converted'
        && m.meta?.orderId === orderId && near(m.createdAt, a.createdAt, 2 * MINUTE)));
      if (msil) details.push('Converted on the Sales Desk after the MSIL supply check held the line.');
    } else {
      // A FIFO run started from Indent Stock Assignment covers many bookings
      // in one entry; it only says who started it, and is never listed itself.
      const run = audits.find((m) => m.action === 'Indent Stock Auto-Assigned'
        && (m.meta?.skuCodes || []).some((s) => items.some((i) => i.skuCode === s))
        && time(m.createdAt) >= time(a.createdAt) - 5000
        && time(m.createdAt) - time(a.createdAt) <= 30 * MINUTE);
      if (run) {
        by = from(run);
        details.push('Auto-assign (FIFO) run from Indent Stock Assignment.');
      } else {
        by = { source: SOURCES.system, actor: null };
        details.push('Stock arrived and went to the oldest waiting indent first (FIFO).');
      }
    }
    for (const i of items) {
      const rec = recordFor(i.skuCode, i.seq, a.createdAt);
      if (rec) allocationSource.set(allocationKey(i.skuCode, rec.seq, rec.at), by);
    }
    push({
      id: `audit:${idOf(a)}`,
      at: a.createdAt,
      kind: 'allocation',
      title,
      details,
      items: items.map((i) => ({
        skuCode: i.skuCode,
        quantity: i.quantity,
        note: [
          `allocation #${i.seq}`,
          i.indentNumber ? `from indent ${i.indentNumber}` : null,
          Number.isFinite(i.remaining) ? `${i.remaining} still waiting` : null,
        ].filter(Boolean).join(' · '),
      })),
      refs: { indentNumbers: [...new Set(items.map((i) => i.indentNumber).filter(Boolean))] },
      ...by,
      record: 'Audit log',
    });
  }
  // Allocation records no audit entry accounts for.
  for (const row of rows) {
    for (const x of row.allocations || []) {
      const key = allocationKey(row.skuCode, x.seq, x.at);
      if (allocationSource.has(key)) continue;
      allocationSource.set(key, { source: SOURCES.record, actor: null });
      push({
        id: `allocation:${key}`,
        at: x.at,
        kind: 'allocation',
        title: 'Stock allocated from indent',
        details: ['From the allocation record on the booking line; who made it was not recorded.'],
        items: [{
          skuCode: row.skuCode,
          quantity: x.quantity,
          note: [`allocation #${x.seq}`, x.indentNumber ? `from indent ${x.indentNumber}` : null].filter(Boolean).join(' · '),
        }],
        refs: { indentNumbers: x.indentNumber ? [x.indentNumber] : [] },
        source: SOURCES.record,
        record: 'Booking line',
      });
    }
  }

  // ── 3. Booking confirmed: the PO ─────────────────────────────────────────
  const poAt = earliest(poTimes);
  const realPo = rows.map((r) => r.poNumber).find((p) => !isPlaceholderPo(p)) || null;
  const poAudits = audits.filter((a) => a.action === 'PO Generated');
  const poAudit = take(poAt
    ? poAudits
      .filter((a) => near(a.createdAt, poAt, 10 * MINUTE))
      .sort((x, y) => Math.abs(time(x.createdAt) - time(poAt)) - Math.abs(time(y.createdAt) - time(poAt)))[0]
    : poAudits[0]);
  let confirmation = null;
  if (poAt || poAudit) {
    const meta = poAudit?.meta || {};
    const poNumber = meta.poNumber || realPo;
    const details = [];
    if (poNumber) details.push(`PO number ${poNumber}.`);
    details.push('The booking is locked: its lines can no longer be edited.');
    if (includePricing && meta.priceType) details.push(`Priced at the ${meta.priceType} rate.`);
    if (meta.deliveryScheduleDate) details.push(`Delivery scheduled from ${istDate(meta.deliveryScheduleDate)}.`);
    if (Array.isArray(meta.reBoxed) && meta.reBoxed.length) {
      details.push(`${plural(meta.reBoxed.length, 'line')} picked up a box number changed since booking.`);
    }
    if (poAudit && !poAudit.meta) {
      // The older writer kept its detail only in the text.
      const text = remarkOf(poAudit, orderId, { includePricing });
      if (text) details.push(text);
    }
    const by = poAudit ? from(poAudit) : { source: SOURCES.record, actor: actorOf(rows.find((r) => r.poGeneratedBy)?.poGeneratedBy) };
    confirmation = {
      id: poAudit ? `audit:${idOf(poAudit)}` : `booking:${orderId}:po`,
      at: poAt || poAudit.createdAt,
      kind: 'po',
      title: 'Booking confirmed — PO raised',
      details,
      refs: { poNumber },
      ...by,
      // Who raised it is on the lines too; it is the better record when the
      // audit entry has no user.
      actor: by.actor || actorOf(rows.find((r) => r.poGeneratedBy)?.poGeneratedBy),
      record: poAudit ? 'Audit log' : 'Booking lines',
    };
    push(confirmation);
  }

  // ── 4. Status changes and cancellation ───────────────────────────────────
  const cancelAudits = audits.filter((a) => CANCEL_ACTIONS.includes(a.action));
  const cancelStatus = new Map(); // cancel audit -> its 'Cancelled' status event
  const notificationOf = (n) => (n?.state ? {
    state: n.state,
    recipient: n.recipient || null,
    sentAt: n.sentAt || null,
    attempts: n.attempts || 0,
    error: n.error || null,
    reason: n.reason || null,
  } : null);

  for (const e of statusEvents) {
    if (e.status === 'Cancelled') {
      const c = cancelAudits.find((x) => !cancelStatus.has(idOf(x)) && near(x.createdAt, e.changedAt, 10 * MINUTE));
      if (c) { cancelStatus.set(idOf(c), e); continue; }
    }
    const match = take(audits.find((a) => !used.has(idOf(a)) && a.action === 'Booking Status Updated'
      && a.meta?.status === e.status && near(a.createdAt, e.changedAt, 2 * MINUTE)));
    let by;
    if (match) by = from(match);
    else if (!e.changedBy) by = { source: SOURCES.system, actor: null };
    else {
      by = {
        source: String(e.changedBy) === String(customerId) ? SOURCES.customer : SOURCES.bookings,
        actor: actorOf(e.changedBy),
      };
    }
    push({
      id: `status:${e._id}`,
      at: e.changedAt,
      kind: e.status === 'Cancelled' ? 'cancel' : 'status',
      title: e.status === 'Cancelled' ? 'Booking cancelled' : `Status: ${stageLabel(e.status)}`,
      details: [
        e.previousStatus ? `Moved from ${stageLabel(e.previousStatus)}.` : null,
        e.remarks || null,
      ],
      ...by,
      actor: by.actor || (e.changedByName && e.changedByName !== 'System'
        ? { name: e.changedByName, role: e.changedByRole || null }
        : null),
      notification: notificationOf(e.notification),
      record: 'Status history',
    });
  }

  for (const c of cancelAudits) {
    take(c);
    const m = c.meta || {};
    const status = cancelStatus.get(idOf(c));
    const auto = c.action === 'Booking Auto-Cancelled (No PO)';
    push({
      id: `audit:${idOf(c)}`,
      at: c.createdAt,
      kind: 'cancel',
      title: auto ? 'Booking cancelled automatically — no PO in time' : 'Booking cancelled',
      details: [
        m.reason ? `Reason: ${m.reason}.` : null,
        Number.isFinite(m.units) ? `${plural(m.units, 'unit')} released back to stock.` : remarkOf(c, orderId, { includePricing }),
        ...(m.indents || []).map((i) => `Allocation #${i.allocation} of ${i.skuCode} (${i.quantity}) released`
          + `${i.indentNumber ? ` from indent ${i.indentNumber}` : ''}.`),
        ...(m.indentsClosed || []).map((i) => `Indent${i.indentNumber ? ` ${i.indentNumber}` : ''} closed for `
          + `${i.skuCode} (${i.quantity} waiting).`),
      ],
      ...from(c),
      notification: notificationOf(status?.notification),
      record: 'Audit log',
    });
  }

  // ── 5. Everything else that names this booking or its indent ─────────────
  for (const a of audits) {
    if (used.has(idOf(a)) || NEVER_LISTED.has(a.action)) continue;
    // 'Booking Created' / 'PO Generated' text-matched for another moment.
    const known = UPDATE_KINDS[a.action];
    if (known?.pricing && a.action === 'Booking Priced' && !includePricing) continue;
    const m = a.meta || {};
    let title = known?.title || a.action;
    const details = [];
    const items = [];

    if (a.action === 'Indent Stock Reassigned') {
      const out = m.from?.orderId === orderId;
      title = out ? 'Stock moved to another booking' : 'Stock moved in from another booking';
      details.push(out
        ? `${plural(m.quantity, 'unit')} of ${m.skuCode} moved from allocation #${m.from?.seq ?? '?'} to `
          + `indent ${m.to?.indent || '?'} on ${m.to?.orderId || '?'}. The indent they came from waits for them again.`
        : `${plural(m.quantity, 'unit')} of ${m.skuCode} moved here from ${m.from?.orderId || '?'}.`);
    } else if (a.action === 'Inward Allocation Cancelled') {
      details.push(`Allocation #${m.seq} — ${plural(m.quantity, 'unit')} of ${m.skuCode} returned to stock`
        + `${m.indentNumber ? ` and to indent ${m.indentNumber}` : ''}.`);
      if (m.indentRestored === false) details.push('The indent was not reopened.');
      if (m.reason) details.push(`Reason: ${m.reason}.`);
    } else if (a.action === 'Allocation Status Updated') {
      details.push(`The allocation made ${m.at ? istDateTime(m.at) : 'earlier'} moved to ${stageLabel(m.status)}.`);
    } else if (a.action === 'Booking Details Edited' && Array.isArray(m.changes)) {
      for (const c of m.changes) details.push(`${c.label}: "${c.from ?? '—'}" → "${c.to ?? '—'}"`);
    } else {
      const text = remarkOf(a, orderId, { includePricing });
      if (text) details.push(...(a.action.startsWith('Booking Edited') ? text.split('; ') : [text]));
    }

    push({
      id: `audit:${idOf(a)}`,
      at: a.createdAt,
      kind: known?.kind || 'update',
      title,
      details,
      items,
      ...from(a),
      record: 'Audit log',
    });
    take(a);
  }

  // Oldest first; things that happened in the same instant in lifecycle order.
  const ORDER = ['booking', 'indent', 'allocation', 'po', 'status', 'update', 'cancel'];
  const seen = new Set();
  const timeline = events
    .filter((e) => (seen.has(e.id) ? false : seen.add(e.id)))
    .map((e, i) => ({ e, i }))
    .sort((x, y) => (time(x.e.at) || 0) - (time(y.e.at) || 0)
      || ORDER.indexOf(x.e.kind) - ORDER.indexOf(y.e.kind)
      || x.i - y.i)
    .map(({ e }) => e);

  // ── The booking, its indents and their allocations, as they stand ────────
  const lines = rows.map((r) => ({
    id: String(r._id),
    skuCode: r.skuCode,
    status: r.status,
    statusLabel: stageLabel(r.status),
    bookedQty: r.bookedQty || 0,
    confirmedQty: r.confirmedQty || 0,
    atBooking: atBookingBySku.get(r.skuCode) || null,
    allocations: (r.allocations || []).map((x) => {
      const by = allocationSource.get(allocationKey(r.skuCode, x.seq, x.at)) || { source: SOURCES.record, actor: null };
      return {
        seq: x.seq,
        quantity: x.quantity,
        indentNumber: x.indentNumber || null,
        at: x.at,
        status: x.status || 'PO Received',
        statusLabel: x.status === 'Cancelled' ? 'Cancelled' : stageLabel(x.status || 'PO Received'),
        statusAt: x.statusAt || null,
        cancelledAt: x.cancelledAt || null,
        cancellationReason: x.cancellationReason || null,
        source: by.source,
        actor: by.actor,
      };
    }),
  }));

  const indentOf = (r, relation) => {
    const raised = confirmations.find((c) => c.reservationId === r.reservationId) || null;
    return {
      reservationId: r.reservationId,
      indentNumber: r.indentNumber || null,
      skuCode: r.skuCode,
      relation,
      status: r.status,
      open: OPEN_INDENT.includes(r.status),
      waiting: OPEN_INDENT.includes(r.status) ? r.quantity || 0 : 0,
      raisedQty: raised ? raised.pending : null,
      raisedAt: raised ? raised.audit.createdAt : (r.reservationDate || r.createdAt || null),
      closedAt: r.cancelledAt || (['Cancelled', 'Expired'].includes(r.status) ? r.expiredAt || null : null),
      closeReason: r.cancellationReason || null,
      autoBookedOrderId: r.autoBookedOrderId || null,
      supplyCheck: r.supplyCheck?.status || null,
    };
  };
  const indents = [
    ...ownIndents.map((r) => indentOf(r, 'raised-with-booking')),
    ...becameThis.map((r) => indentOf(r, 'became-this-booking')),
  ];

  const live = rows.filter((r) => r.status !== 'Cancelled');
  const status = bookingStatusOf(rows);
  const atBooking = confirmations.length
    ? {
      requested: sum(confirmations, (c) => c.requested),
      confirmed: sum(confirmations, (c) => c.confirmed),
      pending: sum(confirmations, (c) => c.pending),
    }
    : null;

  return {
    booking: {
      orderId,
      indentNumber: ownIndents.length || atBooking?.pending ? indentNumber : null,
      customerName: customer?.customerName || customer?.user || null,
      company: customer?.company || rows[0].company || null,
      poNumber: realPo,
      poRaisedAt: confirmation?.at || null,
      poRaisedBy: confirmation?.actor || null,
      locked: rows.some(isPoGenerated),
      status,
      statusLabel: stageLabel(status),
      createdAt: created?.at || placedAt,
      createdFrom: created?.source || SOURCES.record,
      createdBy: created?.actor || null,
      totals: {
        atBooking,
        allocated: sum(rows.flatMap((r) => (r.allocations || []).filter((x) => x.status !== 'Cancelled')), (x) => x.quantity),
        waitingOnIndent: sum(ownIndents.filter((r) => OPEN_INDENT.includes(r.status)), (r) => r.quantity),
        confirmedNow: sum(live, (r) => r.confirmedQty),
        lines: live.length,
      },
    },
    lines,
    indents,
    events: timeline,
  };
};

export default { getBookingHistory, SOURCES };
