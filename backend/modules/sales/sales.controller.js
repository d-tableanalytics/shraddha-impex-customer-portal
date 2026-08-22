import mongoose from 'mongoose';
import Order from '../../models/Order.js';
import User from '../../models/User.js';
import Reservation from '../../models/Reservation.js';
import AuditLog from '../../models/AuditLog.js';
import { nextSequence } from '../../models/Counter.js';
import { io } from '../../server.js';
import { notifyUser } from '../../utils/notify.js';
import { sendEmail } from '../../utils/mailer.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';
import { assertBookingEditable, isPlaceholderPo } from '../../utils/bookingLock.js';
import { hasPermission, PERMISSIONS } from '../../middlewares/rbac.js';
import { boxKey, currentBoxNumbers, shapeBooking } from './booking.shape.js';
import {
  findProductBySku, reserveStock, releaseStock, consumeStock,
  adjustReservedQty, adjustConsumedQty,
} from '../../utils/stockLedger.js';
import { recordAudit } from '../../utils/auditLog.js';
import { isTransactionUnsupported } from '../../utils/mongoSession.js';

/**
 * Sales desk: review confirmed bookings, amend them while the PO is pending,
 * then raise the PO — which locks the booking.
 *
 * Sales Users see every customer and every brand (an explicit product decision),
 * so no brand filter is applied here. Route-level `authorize()` keeps everyone
 * else out; each handler re-checks the lock so a stale UI cannot bypass it.
 */

// A booking is a set of Order rows sharing one orderId.
const loadBooking = async (orderId, session = null) => {
  const opts = session ? { session } : {};
  return Order.find({ orderId }, null, opts).sort({ createdAt: 1 });
};

// Audit writing lives in utils/auditLog.js — see recordAudit().

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The quantity breakdown the customer is shown when a PO is raised.
 *
 * Five figures per SKU, because three different things move a quantity and
 * blurring them is what made this mail wrong before:
 *
 *   onPo   — what the CUSTOMER asked for, indent included (`bookedQty`)
 *   booked — what the booking holds now, after any desk edit (`confirmedQty`)
 *   change — what SALES/ADMIN did, and nothing else
 *   indent — what is STILL open on the indent, read live
 *
 * `change` is measured against the BOOKING-STAGE quantity — what the booking
 * held once stock was checked — not against `bookedQty`. Booking 50 against 2
 * in stock writes bookedQty 50, confirmedQty 2, pendingQty 48 and moves the 48
 * to an indent. Diffing bookedQty against confirmedQty therefore reported
 * "changed from 50 pcs to 2 pcs" on a booking nobody had touched. The automatic
 * split is not an adjustment; it now shows up in the Indent column, where it
 * belongs, and leaves `change` at zero.
 *
 * The audit trail is what proves a desk edit happened. Every edit is written as
 * 'Booking Edited (Sales)' with fromQty/toQty recorded against confirmedQty
 * (see runUpdateItems), so replaying those entries recovers each line's
 * booking-stage quantity exactly. A line with no entry was never edited.
 *
 * Removed lines no longer exist as rows and come from the same trail. A SKU the
 * desk both added and later removed is ignored — the customer never saw it.
 */
/**
 * The two audit actions a quantity change is written under.
 *
 * They are kept apart because they mean opposite things to the customer. A
 * DESK edit is an adjustment made to the customer's order by us, and belongs
 * in the Change column of the PO mail. A CUSTOMER edit is the customer
 * revising their own request — it is not something we did to them, and
 * reporting it back as "our team adjusted your quantity" would be nonsense.
 * A customer edit therefore RESETS the baseline the desk's changes are
 * measured from, rather than counting as one.
 */
export const QTY_EDIT_ACTIONS = {
  desk: 'Booking Edited (Sales)',
  customer: 'Booking Edited (Customer)',
};

const buildChangeSummary = async (rows, orderId) => {
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
    indentNumber: String(orderId).replace(/^BO-/, 'PI-'),
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
const changeLabel = (l) => {
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

const buildPoRaisedEmail = ({ customerName, orderId, poNumber, summary }) => {
  const cell = 'padding: 7px 12px; border-bottom: 1px solid #eee; font-size: 13px;';
  const head = 'padding: 7px 12px; background: #f4f6f8; color: #555; text-align: left; font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e3e7eb;';
  const tone = {
    increased: 'color: #1a7f37; font-weight: bold;',
    reduced: 'color: #b54708; font-weight: bold;',
    added: 'color: #1a5b9e; font-weight: bold;',
    removed: 'color: #b42318; font-weight: bold;',
    recoded: 'color: #1a5b9e; font-weight: bold;',
    unchanged: 'color: #888;',
  };

  const rows = summary.lines.map((l) => `
    <tr>
      <td style="${cell}"><strong>${esc(l.skuCode)}</strong></td>
      <td style="${cell} text-align: right;">${l.onPo} pcs</td>
      <td style="${cell} text-align: right;">${l.booked} pcs</td>
      <td style="${cell} ${tone[l.type]}">${esc(changeLabel(l))}</td>
      <td style="${cell} text-align: right; ${l.indent > 0 ? 'color: #b54708; font-weight: bold;' : 'color: #888;'}">${l.indent} pcs</td>
    </tr>`).join('');

  // THE CONVERSION EMAIL. Deliberately carries NO booking TAT line: this mail
  // exists only because a PO has been raised, and the 7-day booking turnaround
  // stops applying at that point. Quoting it against a purchase order tells the
  // customer a deadline that is not theirs.
  //
  // From here on the transaction is a Purchase Order, so
  // this mail leads with the PO number — that is the reference the customer will
  // quote from now on. The booking id stays, demoted to a back-reference, purely
  // so they can reconcile which booking became this PO; it is the one mail that
  // legitimately spans both names.
  return `
    <p>Hi ${esc(customerName)},</p>
    <p>Your booking has been processed and converted into a Purchase Order.
       <strong>PO No. ${esc(poNumber)}</strong> has been raised against it, and
       all further updates will refer to this purchase order.</p>

    <div style="margin: 18px 0; padding: 14px 18px; background: #f0f6ff; border: 1px solid #cfe0f7; border-radius: 4px;">
      <div style="font-size: 11px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">Purchase Order No.</div>
      <div style="font-size: 22px; font-weight: bold; color: #1a5b9e; font-family: monospace;">${esc(poNumber)}</div>
      <div style="margin-top: 10px; font-size: 11px; color: #5a7ca8; letter-spacing: 0.3px;">
        Raised against booking reference <strong style="font-family: monospace;">${esc(orderId)}</strong>
      </div>
    </div>

    ${summary.changed
      ? `<p><strong>Please note:</strong> our team adjusted some quantities before this purchase order was raised. The adjustments are shown in the Change column below.</p>`
      : `<p>No quantities were adjusted by our team${summary.totalIndent > 0 ? ' — the Indent column shows what is still awaiting stock' : ''}.</p>`}

    <table style="border-collapse: collapse; margin: 0 0 20px; width: 100%;">
      <thead>
        <tr>
          <th style="${head}">SKU</th>
          <th style="${head} text-align: right;">On PO</th>
          <th style="${head} text-align: right;">Booked</th>
          <th style="${head}">Change</th>
          <th style="${head} text-align: right;">Indent</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold;">${summary.totalOnPo} pcs</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold;">${summary.totalBooked} pcs</td>
          <td style="${cell} border-bottom: none; font-weight: bold;">${
            summary.totalChange === 0 ? '' : `${summary.totalChange > 0 ? '+' : '-'}${Math.abs(summary.totalChange)} pcs`
          }</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold;">${summary.totalIndent} pcs</td>
        </tr>
      </tfoot>
    </table>

    <p>Thank you for your business.</p>
  `;
};

/**
 * GET /api/v1/sales/bookings?status=pending|generated|all
 * Bookings grouped by orderId. Defaults to those still awaiting a PO.
 */
export const getBookings = async (req, res, next) => {
  try {
    const scope = String(req.query.status || 'all').toLowerCase();
    const search = String(req.query.search || '').trim();

    const query = {};
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
        { skuCode: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { poNumber: { $regex: search, $options: 'i' } },
      ];
    }

    const rows = await Order.find(query).sort({ createdAt: -1 });

    const byBooking = new Map();
    for (const r of rows) {
      if (!byBooking.has(r.orderId)) byBooking.set(r.orderId, []);
      byBooking.get(r.orderId).push(r);
    }

    // One lookup for every row on the screen, not one per booking.
    const boxNumbers = await currentBoxNumbers(rows);
    const all = [...byBooking.values()].map((b) => shapeBooking(b, boxNumbers));

    // Counts come from the UNFILTERED set (search still applies) so the tabs
    // keep showing the same totals whichever one is selected — otherwise
    // "PO Generated" would read 0 while the Pending tab was open.
    const meta = {
      total: all.length,
      pendingPo: all.filter((b) => !b.locked).length,
      generated: all.filter((b) => b.locked).length,
    };

    let bookings = all;
    if (scope === 'pending') bookings = all.filter((b) => !b.locked);
    else if (scope === 'generated') bookings = all.filter((b) => b.locked);

    // Newest first; grouping above loses the sort order of the flat rows.
    bookings.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.status(200).json({ success: true, data: bookings, meta });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/sales/bookings/:orderId — full detail for the review screen. */
export const getBookingDetail = async (req, res, next) => {
  try {
    const rows = await loadBooking(req.params.orderId);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }
    res.status(200).json({
      success: true,
      data: shapeBooking(rows, await currentBoxNumbers(rows)),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/sales/bookings/:orderId/items
 * Body: { lines: [{ id?, skuCode, quantity }] }
 *
 * Replaces the booking's line set. Every difference against the stored rows is
 * applied to inventory in the same transaction:
 *   quantity up   → reserve the delta   (rejected if stock is short)
 *   quantity down → release the excess
 *   SKU changed   → release the old SKU in full, reserve on the new one
 *   line added    → reserve the quantity
 *   line removed  → release the quantity
 *
 * Rejected outright once the PO is generated, unless the caller can override.
 */
const runUpdateItems = async (req, session) => {
  const { orderId } = req.params;
  // Staff work the whole queue; everyone else may only touch their own booking,
  // and only its quantities. See assertMayAmend() below.
  const isStaff = hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS);
  const incoming = Array.isArray(req.body?.lines) ? req.body.lines : null;
  if (!incoming) throw Object.assign(new Error('lines must be an array.'), { status: 400 });
  if (incoming.length === 0) {
    throw Object.assign(new Error('A booking must keep at least one line.'), { status: 400 });
  }

  for (const l of incoming) {
    const qty = Number(l.quantity);
    if (!l.skuCode || !Number.isInteger(qty) || qty <= 0) {
      throw Object.assign(
        new Error('Each line needs a skuCode and a whole quantity greater than zero.'),
        { status: 400 },
      );
    }
  }

  // Reject duplicate SKUs — two lines for one SKU makes the stock delta ambiguous.
  const skus = incoming.map((l) => String(l.skuCode).trim());
  if (new Set(skus).size !== skus.length) {
    throw Object.assign(new Error('The same SKU appears more than once. Combine the quantities into one line.'), { status: 400 });
  }

  const existing = await loadBooking(orderId, session);

  // OWNERSHIP FIRST, before the lock. 404 rather than 403, matching
  // getOrderById and the timeline. Order matters: checking the lock first would
  // answer 423 for a real booking and 404 for one that does not exist, and the
  // difference between those two replies is enough to enumerate booking ids
  // from an account that owns none of them.
  if (!isStaff && (existing.length === 0
    || !existing.every((r) => String(r.user) === String(req.user._id)))) {
    throw Object.assign(new Error('Booking not found.'), { status: 404 });
  }

  assertBookingEditable(existing, req.user);

  if (!isStaff) {
    // A customer may revise QUANTITIES on their own booking and nothing else.
    // The desk composes a booking — adds lines, drops them, swaps a SKU for
    // another; letting the same request body do all that on the customer's
    // side would turn "edit my quantity" into "rewrite my order", so each
    // incoming line has to name a row that already exists and carry the SKU it
    // already has, and no row may be left out.
    const byId = new Map(existing.map((r) => [String(r._id), r]));
    if (incoming.length !== existing.length) {
      throw Object.assign(
        new Error('Send every line of the booking. Lines cannot be added or removed here.'),
        { status: 400 },
      );
    }
    for (const l of incoming) {
      const row = l.id ? byId.get(String(l.id)) : null;
      if (!row) {
        throw Object.assign(
          new Error('Lines cannot be added here — only the quantity of an existing line may be changed.'),
          { status: 400 },
        );
      }
      if (String(l.skuCode).trim() !== row.skuCode) {
        throw Object.assign(
          new Error('The SKU of a line cannot be changed here — only its quantity.'),
          { status: 400 },
        );
      }
    }
  }

  // A line whose PO was raised has already left inventory ('consumed'); one
  // still awaiting a PO is merely held ('reserved'). The two need different
  // ledger operations, so dispatch on the row's state rather than assuming.
  const isConsumed = (row) => (row?.stockState ?? 'reserved') === 'consumed';
  const ledgerCtx = {
    workflow: 'sales-desk-edit',
    referenceType: 'booking',
    referenceId: orderId,
    actor: req.user,
    req,
  };
  const giveBack = (product, row, qty) =>
    isConsumed(row)
      ? adjustConsumedQty(product, qty, 0, session, ledgerCtx).then((r) => r.ok)
      : releaseStock(product, qty, session, ledgerCtx);
  const takeFor = (product, row, qty) =>
    isConsumed(row)
      ? adjustConsumedQty(product, 0, qty, session, ledgerCtx).then((r) => r.ok)
      : reserveStock(product, qty, session, ledgerCtx);

  const template = existing[0];
  const byId = new Map(existing.map((r) => [String(r._id), r]));
  const changes = [];

  // Rows the caller kept, by id. Anything not referenced is a removal.
  const keptIds = new Set(
    incoming.map((l) => (l.id ? String(l.id) : null)).filter(Boolean),
  );

  // ── removals ────────────────────────────────────────────────────────────
  for (const row of existing) {
    if (keptIds.has(String(row._id))) continue;
    const product = await findProductBySku(row.skuCode, session);
    if (product) await giveBack(product, row, row.confirmedQty || 0);
    changes.push({ type: 'removed', skuCode: row.skuCode, fromQty: row.confirmedQty, toQty: 0 });
    await Order.deleteOne({ _id: row._id }, session ? { session } : {});
  }

  // ── updates and additions ───────────────────────────────────────────────
  for (const line of incoming) {
    const qty = Number(line.quantity);
    const skuCode = String(line.skuCode).trim();
    const row = line.id ? byId.get(String(line.id)) : null;

    const product = await findProductBySku(skuCode, session);
    if (!product) {
      throw Object.assign(new Error(`SKU ${skuCode} not found.`), { status: 400 });
    }

    if (!row) {
      // New line. On a locked (already-consumed) booking under admin override
      // the units must leave inventory outright, matching the rest of that
      // booking — `template` carries its settled state.
      if (!(await takeFor(product, template, qty))) {
        throw Object.assign(
          new Error(`Not enough stock for ${skuCode}. Available: ${Math.max(0, product.availableForSale)}, requested: ${qty}.`),
          { status: 409 },
        );
      }
      await Order.create([{
        orderId: template.orderId,
        brand: product.constructor.modelName.toLowerCase().includes('bix') ? 'BIX'
          : product.constructor.modelName.toLowerCase().includes('imada') ? 'IMADA' : 'Koken',
        user: template.user,
        status: template.status,
        orderTimestamp: template.orderTimestamp,
        company: template.company,
        role: template.role,
        date: template.date,
        skuCode,
        category: Array.isArray(product.category) ? product.category.join(', ') : (product.category || null),
        requestedQty: qty,
        // The customer never booked this line — the sales desk added it. Keeping
        // bookedQty at 0 is what makes "originally booked vs final" meaningful
        // in the PO email.
        bookedQty: 0,
        confirmedQty: qty,
        pendingQty: 0,
        poNumber: template.poNumber,
        msilCode: product.msilCode || null,
        boxNo: product.boxNo || null,
        emailId: template.emailId,
        phoneNumber: template.phoneNumber,
        remarks: `Line added at the sales desk by ${req.user.user || req.user.email}.`,
      }], session ? { session } : {});
      changes.push({ type: 'added', skuCode, fromQty: 0, toQty: qty });
      continue;
    }

    const oldSku = row.skuCode;
    const oldQty = row.confirmedQty || 0;

    if (oldSku === skuCode) {
      if (oldQty === qty) continue; // untouched
      const { ok } = isConsumed(row)
        ? await adjustConsumedQty(product, oldQty, qty, session, ledgerCtx)
        : await adjustReservedQty(product, oldQty, qty, session, ledgerCtx);
      if (!ok) {
        throw Object.assign(
          new Error(`Not enough stock for ${skuCode}. Available: ${Math.max(0, product.availableForSale)}, additional needed: ${qty - oldQty}.`),
          { status: 409 },
        );
      }
      changes.push({ type: 'quantity', skuCode, fromQty: oldQty, toQty: qty });
    } else {
      // SKU swap: take the new one FIRST, so a failure leaves the original
      // holding intact rather than giving back stock we then cannot re-take.
      if (!(await takeFor(product, row, qty))) {
        throw Object.assign(
          new Error(`Not enough stock for ${skuCode}. Available: ${Math.max(0, product.availableForSale)}, requested: ${qty}.`),
          { status: 409 },
        );
      }
      const oldProduct = await findProductBySku(oldSku, session);
      if (oldProduct) await giveBack(oldProduct, row, oldQty);
      changes.push({ type: 'sku', skuCode, fromSku: oldSku, toSku: skuCode, fromQty: oldQty, toQty: qty });
    }

    row.skuCode = skuCode;
    row.msilCode = product.msilCode || null;
    row.boxNo = product.boxNo || null;
    row.category = Array.isArray(product.category) ? product.category.join(', ') : (product.category || null);
    row.confirmedQty = qty;
    row.requestedQty = qty; // kept equal to confirmedQty, as runConfirmBooking does
    await row.save(session ? { session } : {});
  }

  const updated = await loadBooking(orderId, session);
  return { updated, changes };
};

export const updateBookingItems = async (req, res, next) => {
  const session = await mongoose.startSession();
  let result;
  try {
    try {
      session.startTransaction();
      result = await runUpdateItems(req, session);
      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      // Standalone MongoDB has no transactions; nothing was committed, so a
      // re-run without a session is safe. Mirrors confirmBooking's fallback.
      if (isTransactionUnsupported(txErr)) {
        console.warn('[updateBookingItems] Transactions unsupported — running without one.');
        result = await runUpdateItems(req, null);
      } else {
        throw txErr;
      }
    } finally {
      session.endSession();
    }

    const { updated, changes } = result;

    if (changes.length) {
      // Desk edits and customer edits are recorded under different actions —
      // see QTY_EDIT_ACTIONS. Both feed the quantity history; only the desk's
      // reach the Change column of the PO mail.
      const byCustomer = !hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS);
      await recordAudit(
        req.user,
        byCustomer ? QTY_EDIT_ACTIONS.customer : QTY_EDIT_ACTIONS.desk,
        `Booking ${req.params.orderId}: ` +
        changes.map((c) =>
          c.type === 'sku' ? `${c.fromSku} → ${c.toSku} (qty ${c.fromQty} → ${c.toQty})`
            : c.type === 'quantity' ? `${c.skuCode} qty ${c.fromQty} → ${c.toQty}`
              : c.type === 'added' ? `added ${c.skuCode} x${c.toQty}`
                : `removed ${c.skuCode} x${c.fromQty}`,
        ).join('; '),
        req,
        { meta: { orderId: req.params.orderId, changes } },
      );

      io.emit('booking-updated', { orderId: req.params.orderId });
    }

    res.status(200).json({
      success: true,
      data: shapeBooking(updated, await currentBoxNumbers(updated)),
      changes,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * POST /api/v1/sales/bookings/:orderId/po
 * Body: { poNumber? }  — omitted means auto-generate PO-YYYY-######.
 *
 * Stamps every row of the booking and locks it.
 */
export const raisePo = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const rows = await loadBooking(orderId);
    // Re-uses the edit guard: an already-raised PO cannot be overwritten by a
    // second raise unless the caller can override the lock.
    assertBookingEditable(rows, req.user);

    let poNumber = String(req.body?.poNumber || '').trim();
    if (isPlaceholderPo(poNumber)) {
      const year = new Date().getFullYear();
      const seq = await nextSequence(`po-${year}`);
      poNumber = `PO-${year}-${String(seq).padStart(6, '0')}`;
    } else {
      // A manually entered PO must be unique across other bookings.
      const clash = await Order.findOne({ poNumber, orderId: { $ne: orderId } });
      if (clash) {
        return res.status(409).json({
          success: false,
          message: `PO Number ${poNumber} is already used by booking ${clash.orderId}.`,
        });
      }
    }

    const now = new Date();

    // Re-stamp the box numbers from the product master before the PO is
    // committed. Each row carries the box number that was mapped when the line
    // was BOOKED, which can be weeks old; if an admin has since re-boxed the
    // SKU, the PO must quote where the goods are now or the warehouse picks the
    // wrong shelf. This is the point at which the snapshot stops being stale
    // data and becomes the record of what was ordered, so it is the point at
    // which it has to be right.
    const boxNumbers = await currentBoxNumbers(rows);
    const reBoxed = [];
    for (const row of rows) {
      const current = boxNumbers.get(boxKey(row.skuCode, row.brand));
      // `undefined` means the product could not be resolved at all — leave the
      // existing snapshot alone rather than blanking it.
      if (current === undefined || current === (row.boxNo || null)) continue;
      reBoxed.push({ skuCode: row.skuCode, from: row.boxNo || null, to: current });
      await Order.updateOne({ _id: row._id }, { $set: { boxNo: current } });
    }

    const {
      customerName,
      shippingAddress,
      billingAddress,
      shopNumber,
      gstCode,
      vendorCode,
      poDate,
      paymentTerm,
      promiseDate,
    } = req.body || {};

    const setFields = {
      poNumber,
      poGeneratedAt: now,
      poGeneratedBy: req.user._id,
    };
    if (customerName) setFields.company = customerName;
    if (shippingAddress) setFields.shippingAddress = shippingAddress;
    if (billingAddress) setFields.billingAddress = billingAddress;
    if (shopNumber) setFields.shopNumber = shopNumber;
    if (gstCode) setFields.gstCode = gstCode;
    if (vendorCode) setFields.vendorCode = vendorCode;
    if (poDate) setFields.poDate = new Date(poDate);
    if (paymentTerm) setFields.paymentTerm = paymentTerm;
    if (promiseDate) {
      setFields.promiseDate = new Date(promiseDate);
      setFields.supplyByDate = new Date(promiseDate);
    }

    await Order.updateMany(
      { orderId },
      { $set: setFields },
    );

    // Raising the PO commits the goods: the reserved units leave inventory for
    // good (total and booked both drop). Done here so stock is correct the
    // instant the PO exists, rather than waiting for the nightly job.
    // stockState guards against double-deducting on a retry.
    for (const row of rows) {
      if ((row.stockState ?? 'reserved') !== 'reserved') continue;
      const product = await findProductBySku(row.skuCode);
      if (product) {
        await consumeStock(product, row.confirmedQty || 0, null, {
          workflow: 'po-raise',
          referenceType: 'booking',
          referenceId: orderId,
          actor: req.user,
          req,
        });
      }
      await Order.updateOne(
        { _id: row._id },
        { $set: { stockState: 'consumed', stockSettledAt: now } },
      );
    }

    const updated = await loadBooking(orderId);

    await recordAudit(
      req.user,
      'PO Generated',
      `PO ${poNumber} raised for booking ${orderId} by ${req.user.user || req.user.email}. `
      + `Booking is now locked.`
      + (reBoxed.length
        ? ` ${reBoxed.length} line(s) picked up a box number changed since booking.`
        : ''),
      req,
      { meta: { orderId, poNumber, poGeneratedAt: now, reBoxed } },
    );

    // Tell the customer their PO is through — in-app, and by email with a
    // line-by-line account of anything the sales desk changed.
    const summary = await buildChangeSummary(updated, orderId);

    if (updated[0]?.user) {
      notifyUser(updated[0].user, {
        title: 'Purchase Order Raised',
        message: summary.changed
          ? `Purchase Order ${poNumber} has been raised. Some quantities were adjusted — see your email.`
          : `Purchase Order ${poNumber} has been raised and is now being processed.`,
        type: 'order',
      });

      const customer = await User.findById(updated[0].user).lean();
      const to = customer?.email || updated[0].emailId;
      if (to && customer?.preferences?.emailNotifications !== false) {
        const body = buildPoRaisedEmail({
          customerName: customer?.user || customer?.company || updated[0].company || 'Customer',
          orderId,
          poNumber,
          summary,
        });
        // Subject names the PURCHASE ORDER, not the booking: this is the mail
        // that tells the customer the reference has changed, and every mail
        // after it uses the PO number.
        const subject = summary.changed
          ? `Your Purchase Order #${poNumber} has been raised — items adjusted`
          : `Your Purchase Order #${poNumber} has been raised`;

        // Fire-and-forget: the PO is already committed, so a mail failure must
        // not fail the request.
        sendEmail(to, subject, body, {
          cc: [...(customer?.bookingCcEmails || []), ...COMPANY_CC],
        }).catch((e) => console.error('[raisePo] email error', e));
      }
    }

    io.emit('po-generated', { orderId, poNumber });

    res.status(200).json({ success: true, data: shapeBooking(updated) });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export default { getBookings, getBookingDetail, updateBookingItems, raisePo };
