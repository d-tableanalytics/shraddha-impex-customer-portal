/**
 * The booking journey — one structure, one table, every booking mail.
 *
 * Every booking-related email (confirmation, indent raised, PO raised, and the
 * lifecycle status mails) shows the SAME single table, so the customer can read
 * the whole story of an order in any one of them. One row per SKU:
 *
 *   SKU | Booked | Confirmed | Indent | Change
 *
 * The Change column is reconstructed, not stored: the edit audit trail is
 * replayed forward (buildChangeSummary) to recover each line's booking-stage
 * quantity, so a booking edited five times still reports only what the desk
 * actually decided. When nothing was ever edited the column reads "No change",
 * which is exactly what a customer should see.
 *
 * This module is a LEAF: it imports models only, so both mail utils and the
 * sales controller can build on it without an import cycle.
 */

import AuditLog from '../models/AuditLog.js';
import Order from '../models/Order.js';
import Reservation from '../models/Reservation.js';

/**
 * A customer edit RESETS the baseline the desk's changes are measured from,
 * rather than counting as one — see buildChangeSummary.
 */
export const QTY_EDIT_ACTIONS = {
  desk: 'Booking Edited (Sales)',
  customer: 'Booking Edited (Customer)',
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

  // LIVE indent balance, not the pendingQty frozen on the order row. An indent
  // shrinks as stock arrives against it ('Indent Auto-Booked'), so the snapshot
  // would tell the customer 20 pcs are still outstanding when only 15 are.
  // Scoped to THIS booking's indent — a booking and its indent share a sequence
  // number and differ only in the prefix.
  const openIndents = await Reservation.find({
    indentNumber: String(orderId).replace(/^[A-Z]+-/, 'PI-'),
    status: { $in: ['Pending', 'Partially Confirmed'] },
  }).lean();
  const indentBySku = new Map();
  for (const r of openIndents) {
    indentBySku.set(r.skuCode, (indentBySku.get(r.skuCode) || 0) + (r.quantity || 0));
  }

  const lines = rows.map((r) => {
    const booked = r.confirmedQty || 0;
    const indent = indentBySku.get(r.skuCode) || 0;
    const base = {
      skuCode: r.skuCode,
      msilCode: r.msilCode || null,
      fromSku: null,
      onPo: r.bookedQty || 0,
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
      return { ...base, change: deskAdded ? booked : 0, type: deskAdded ? 'added' : 'unchanged' };
    }

    if (o.addedByDesk) return { ...base, onPo: 0, change: booked, type: 'added' };

    const change = booked - o.qty;
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
 * Everything the table needs, computed once per mail.
 *
 * @param {string} orderId
 * @param {object[]|null} rows  pass the already-loaded booking to skip a query
 * @returns null when the booking has no rows (e.g. a standalone indent).
 */
export const buildBookingJourney = async ({ orderId, rows = null }) => {
  const orderRows = rows && rows.length
    ? rows
    : await Order.find({ orderId }).sort({ createdAt: 1 });
  if (!orderRows.length) return null;

  const summary = await buildChangeSummary(orderRows, orderId);

  // Booking-stage quantity: what the line held once the confirmation-time
  // stock check had run. Recovered as booked − change, which holds for every
  // change type the replay produces (removed: 0 − (−q) = q; added: q − q = 0).
  const stageQty = (l) => Math.max(0, l.booked - l.change);

  const confirmed = summary.lines
    // A desk-added line did not exist at confirmation time (onPo 0), so it has
    // no place in the "as confirmed" table.
    .filter((l) => (l.onPo || 0) > 0)
    .map((l) => ({
      // The code it was BOOKED under — a later re-code must not rewrite history.
      skuCode: l.fromSku || l.skuCode,
      msilCode: l.msilCode,
      booked: l.onPo,
      confirmed: Math.min(stageQty(l), l.onPo),
      indent: Math.max(0, l.onPo - stageQty(l)),
    }));

  const indentLines = summary.lines
    .filter((l) => (l.indent || 0) > 0)
    .map((l) => ({ skuCode: l.skuCode, msilCode: l.msilCode, quantity: l.indent }));

  const final = summary.lines
    .filter((l) => l.type !== 'removed')
    .map((l) => ({
      skuCode: l.skuCode,
      msilCode: l.msilCode,
      qty: l.booked,
      change: l.change,
      type: l.type,
      label: changeLabel(l),
      indent: l.indent,
    }));
  // A removed line still belongs in the final table — as zero, labelled so.
  for (const l of summary.lines) {
    if (l.type === 'removed') {
      final.push({
        skuCode: l.skuCode, msilCode: l.msilCode,
        qty: 0, change: l.change, type: 'removed', label: changeLabel(l), indent: l.indent,
      });
    }
  }

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
    confirmed,
    indentLines,
    final,
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
  confirmed: [],
  indentLines: lines.map((l) => ({
    skuCode: l.skuCode,
    msilCode: l.msilCode || null,
    quantity: Number(l.quantity) || 0,
  })),
  final: [],
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
 */
export const journeyTablesHtml = (journey, { audience = 'customer' } = {}) => {
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

  const body = rows.map((r) => `
    <tr>
      <td style="${CELL}"><strong>${escHtml(r.skuCode)}</strong></td>
      ${msilCell(r.msilCode)}
      <td style="${CELL} text-align: right;">${r.booked} pcs</td>
      <td style="${CELL} text-align: right; font-weight: bold; ${r.confirmed > 0 ? 'color: #1a7f37;' : 'color: #bbb;'}">${r.confirmed} pcs</td>
      <td style="${CELL} text-align: right; ${r.indent > 0 ? 'color: #b54708; font-weight: bold;' : 'color: #bbb;'}">${r.indent} pcs</td>
      <td style="${CELL} ${TONE[r.type] || TONE.unchanged}">${escHtml(r.label)}</td>
    </tr>`).join('');

  const tableHtml = `
    <table style="border-collapse: collapse; margin: 0 0 10px; width: 100%;">
      <thead><tr>
        <th style="${HEAD}">SKU</th>${msilHead}
        <th style="${HEAD} text-align: right;">Booked</th>
        <th style="${HEAD} text-align: right;">Confirmed</th>
        <th style="${HEAD} text-align: right;">Indent</th>
        <th style="${HEAD}">Change</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="${showMsil ? 2 : 1}" style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">${t('booked')} pcs</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; color: #1a7f37;">${t('confirmed')} pcs</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; ${ti > 0 ? 'color: #b54708;' : 'color: #bbb;'}">${ti} pcs</td>
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

  // The indent has its own reference number, and the customer needs it to chase
  // the outstanding units — so it is named whenever any remain.
  const indentNote = ti > 0 && journey.indentId
    ? `<p style="margin: 0 0 8px; font-size: 12px; color: #888;">
         Indent reference <strong style="font-family: monospace; color: #b54708;">${escHtml(journey.indentId)}</strong>
         &mdash; the Indent column is live and shrinks as stock arrives.
       </p>`
    : '';

  return `
    ${sectionHeading('Booking Details',
      journey.bookingDate ? `As booked on ${fmtD(journey.bookingDate)}.` : null)}
    ${poHtml}
    ${tableHtml}
    ${indentNote}`;
};

export default {
  QTY_EDIT_ACTIONS, buildChangeSummary, changeLabel,
  buildBookingJourney, indentOnlyJourney, journeyTablesHtml,
};
