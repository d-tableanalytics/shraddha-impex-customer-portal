/**
 * The booking journey — one structure, three tables, every booking mail.
 *
 * Every booking-related email (confirmation, indent raised, PO raised, and the
 * lifecycle status mails) shows the same three tables so the customer can read
 * the whole story of an order in any one of them:
 *
 *   1. Confirmed Booking Details   what the booking held at confirmation time
 *   2. Indent / PO Details         what is awaiting stock, and the PO once raised
 *   3. Final Booking Details       what the booking holds NOW, with any changes
 *
 * Table 1 is reconstructed, not stored: the edit audit trail is replayed
 * forward (buildChangeSummary) to recover each line's booking-stage quantity,
 * so a booking edited five times still shows what it looked like on day one.
 * Table 3 is the live rows. When nothing was ever edited the two agree — which
 * is exactly what a customer should see.
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
 * Everything the three tables need, computed once per mail.
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
 * could be fulfilled, so no booking exists. The three tables still render,
 * with tables 1 and 3 stating plainly that no units were confirmed.
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
 * The three journey tables, as one HTML fragment.
 *
 * The MSIL column follows the audience rule the rest of the mails use: the
 * customer orders by SKU; support reconciles codes, so only support sees it.
 */
export const journeyTablesHtml = (journey, { audience = 'customer' } = {}) => {
  if (!journey) return '';
  const showMsil = audience === 'support';
  const msilHead = showMsil ? `<th style="${HEAD}">MSIL Code</th>` : '';
  const msilCell = (v) => (showMsil ? `<td style="${CELL}">${escHtml(v || '—')}</td>` : '');
  const table = (heads, body, foot) => `
    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead><tr>${heads}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot>${foot}</tfoot>
    </table>`;

  // ── 1 · Confirmed Booking Details ────────────────────────────────────────
  let confirmedHtml;
  if (journey.confirmed.length) {
    const rows = journey.confirmed.map((l) => `
      <tr>
        <td style="${CELL}"><strong>${escHtml(l.skuCode)}</strong></td>
        ${msilCell(l.msilCode)}
        <td style="${CELL} text-align: right;">${l.booked} pcs</td>
        <td style="${CELL} text-align: right; color: #1a7f37; font-weight: bold;">${l.confirmed} pcs</td>
        <td style="${CELL} text-align: right; ${l.indent > 0 ? 'color: #b54708; font-weight: bold;' : 'color: #bbb;'}">${l.indent} pcs</td>
      </tr>`).join('');
    const t = (k) => journey.confirmed.reduce((n, l) => n + l[k], 0);
    confirmedHtml = table(
      `<th style="${HEAD}">SKU</th>${msilHead}
       <th style="${HEAD} text-align: right;">Booked</th>
       <th style="${HEAD} text-align: right;">Confirmed from Stock</th>
       <th style="${HEAD} text-align: right;">Moved to Indent</th>`,
      rows,
      `<tr>
        <td colspan="${showMsil ? 2 : 1}" style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">${t('booked')} pcs</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; color: #1a7f37;">${t('confirmed')} pcs</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; ${t('indent') > 0 ? 'color: #b54708;' : 'color: #bbb;'}">${t('indent')} pcs</td>
      </tr>`,
    );
  } else {
    confirmedHtml = emptyNote(
      'No units could be confirmed from stock at booking time — the entire request was raised as an indent.',
    );
  }

  // ── 2 · Indent / PO Details ──────────────────────────────────────────────
  const poBox = journey.po
    ? `<table style="border-collapse: collapse; margin: 0 0 10px;">
        <tr><td style="padding: 2px 12px 2px 0; color: #777; font-size: 13px;">PO Number</td>
            <td style="padding: 2px 0; font-weight: bold; font-size: 13px; font-family: monospace;">${escHtml(journey.po.number)}</td></tr>
        <tr><td style="padding: 2px 12px 2px 0; color: #777; font-size: 13px;">PO Raised on</td>
            <td style="padding: 2px 0; font-weight: bold; font-size: 13px;">${fmtD(journey.po.raisedAt)}</td></tr>
        ${journey.po.promiseDate ? `
        <tr><td style="padding: 2px 12px 2px 0; color: #777; font-size: 13px;">Promise Date</td>
            <td style="padding: 2px 0; font-weight: bold; font-size: 13px;">${fmtD(journey.po.promiseDate)}</td></tr>` : ''}
      </table>`
    : `<p style="margin: 4px 0 8px; font-size: 13px; color: #777;">Purchase Order: <strong>not yet raised</strong>.</p>`;

  let indentHtml;
  if (journey.indentLines.length) {
    const rows = journey.indentLines.map((l) => `
      <tr>
        <td style="${CELL}"><strong>${escHtml(l.skuCode)}</strong></td>
        ${msilCell(l.msilCode)}
        <td style="${CELL} text-align: right; color: #b54708; font-weight: bold;">${l.quantity} pcs</td>
      </tr>`).join('');
    const total = journey.indentLines.reduce((n, l) => n + l.quantity, 0);
    indentHtml = table(
      `<th style="${HEAD}">SKU</th>${msilHead}
       <th style="${HEAD} text-align: right;">Qty Awaiting Stock</th>`,
      rows,
      `<tr>
        <td colspan="${showMsil ? 2 : 1}" style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; color: #b54708;">${total} pcs</td>
      </tr>`,
    );
    indentHtml = `<p style="margin: 0 0 6px; font-size: 12px; color: #888;">
        Indent reference: <strong style="font-family: monospace; color: #b54708;">${escHtml(journey.indentId)}</strong>
        — these figures are live and shrink as stock arrives.</p>${indentHtml}`;
  } else {
    indentHtml = emptyNote('No units are awaiting stock on this booking.');
  }

  // ── 3 · Final Booking Details ────────────────────────────────────────────
  let finalHtml;
  if (journey.final.length) {
    const rows = journey.final.map((l) => `
      <tr>
        <td style="${CELL}"><strong>${escHtml(l.skuCode)}</strong></td>
        ${msilCell(l.msilCode)}
        <td style="${CELL} text-align: right; font-weight: bold;">${l.qty} pcs</td>
        <td style="${CELL} ${TONE[l.type] || TONE.unchanged}">${escHtml(l.label)}</td>
        <td style="${CELL} text-align: right; ${l.indent > 0 ? 'color: #b54708; font-weight: bold;' : 'color: #bbb;'}">${l.indent} pcs</td>
      </tr>`).join('');
    const tq = journey.final.reduce((n, l) => n + l.qty, 0);
    const ti = journey.final.reduce((n, l) => n + l.indent, 0);
    const tc = journey.final.reduce((n, l) => n + l.change, 0);
    finalHtml = table(
      `<th style="${HEAD}">SKU</th>${msilHead}
       <th style="${HEAD} text-align: right;">Final Qty</th>
       <th style="${HEAD}">Change</th>
       <th style="${HEAD} text-align: right;">On Indent</th>`,
      rows,
      `<tr>
        <td colspan="${showMsil ? 2 : 1}" style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold;">${tq} pcs</td>
        <td style="${CELL} border-bottom: none; font-weight: bold;">${tc === 0 ? '' : `${tc > 0 ? '+' : '-'}${Math.abs(tc)} pcs`}</td>
        <td style="${CELL} border-bottom: none; text-align: right; font-weight: bold; ${ti > 0 ? 'color: #b54708;' : 'color: #bbb;'}">${ti} pcs</td>
      </tr>`,
    );
  } else {
    finalHtml = emptyNote('No booking exists yet — every unit is awaiting stock on the indent above.');
  }

  return `
    ${sectionHeading('1 · Confirmed Booking Details',
      journey.bookingDate ? `As confirmed on ${fmtD(journey.bookingDate)}.` : null)}
    ${confirmedHtml}
    ${sectionHeading('2 · Indent / PO Details')}
    ${poBox}
    ${indentHtml}
    ${sectionHeading('3 · Final Booking Details',
      journey.po
        ? 'The quantities committed on the purchase order, including any adjustments made while raising it.'
        : 'The booking as it stands today, including any adjustments so far.')}
    ${finalHtml}`;
};

export default {
  QTY_EDIT_ACTIONS, buildChangeSummary, changeLabel,
  buildBookingJourney, indentOnlyJourney, journeyTablesHtml,
};
