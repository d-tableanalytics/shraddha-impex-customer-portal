import mongoose from 'mongoose';
import Order from '../../models/Order.js';
import User from '../../models/User.js';
import AuditLog from '../../models/AuditLog.js';
import { nextSequence } from '../../models/Counter.js';
import { io } from '../../server.js';
import { notifyUser } from '../../utils/notify.js';
import { sendEmail } from '../../utils/mailer.js';
import { COMPANY_CC } from '../../utils/mailRecipients.js';
import {
  assertBookingEditable, lockState, isPlaceholderPo, poDueAt, PO_DEADLINE_DAYS,
} from '../../utils/bookingLock.js';
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

// Collapse the flat Order rows into one booking object for the review screen.
const shapeBooking = (rows) => {
  const first = rows[0];
  const bookingDate = first.date || first.orderTimestamp || first.createdAt;
  const lock = lockState(rows);
  return {
    orderId: first.orderId,
    customer: first.company || null,
    user: first.user,
    brand: first.brand,
    date: bookingDate,
    // Deadline for raising the PO. Sent as an absolute timestamp so the UI can
    // tick a live countdown without refetching; null once the PO exists, since
    // the booking is no longer at risk of auto-cancellation.
    poDueAt: lock.locked ? null : poDueAt(bookingDate),
    poDeadlineDays: PO_DEADLINE_DAYS,
    status: first.status,
    remarks: first.remarks || null,
    emailId: first.emailId || null,
    phoneNumber: first.phoneNumber || null,
    ...lock,
    totalQuantity: rows.reduce((n, r) => n + (r.confirmedQty || 0), 0),
    lineCount: rows.length,
    lines: rows.map((r) => ({
      id: r._id,
      skuCode: r.skuCode,
      msilCode: r.msilCode || null,
      brand: r.brand,
      category: r.category || null,
      bookedQty: r.bookedQty || 0,
      confirmedQty: r.confirmedQty || 0,
      pendingQty: r.pendingQty || 0,
    })),
  };
};

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * What changed between what the customer originally booked and what is being
 * put on the PO.
 *
 *   bookedQty     — the quantity the customer placed (0 for a sales-added line)
 *   confirmedQty  — the quantity going onto the PO, after any sales-desk edits
 *
 * Removed lines no longer exist as rows, so they are recovered from the audit
 * trail. A SKU that was added and later removed is ignored, since the customer
 * never saw it.
 */
const buildChangeSummary = async (rows, orderId) => {
  const lines = rows.map((r) => {
    const from = r.bookedQty || 0;
    const to = r.confirmedQty || 0;
    let type = 'unchanged';
    if (from === 0 && to > 0) type = 'added';
    else if (to > from) type = 'increased';
    else if (to < from) type = 'reduced';
    return { skuCode: r.skuCode, msilCode: r.msilCode || null, from, to, type };
  });

  // Removals, recovered from this booking's edit history.
  const currentSkus = new Set(rows.map((r) => r.skuCode));
  const editLogs = await AuditLog.find({
    action: 'Booking Edited (Sales)',
    'meta.orderId': orderId,
  }).sort({ createdAt: 1 }).lean();

  const removed = new Map();
  for (const log of editLogs) {
    for (const c of log?.meta?.changes || []) {
      if (c.type === 'removed') removed.set(c.skuCode, c.fromQty || 0);
      // Re-added later → no longer a removal.
      if (c.type === 'added') removed.delete(c.skuCode);
    }
  }
  for (const [skuCode, from] of removed) {
    if (currentSkus.has(skuCode)) continue;
    lines.push({ skuCode, msilCode: null, from, to: 0, type: 'removed' });
  }

  return {
    lines,
    changed: lines.some((l) => l.type !== 'unchanged'),
    totalFrom: lines.reduce((n, l) => n + l.from, 0),
    totalTo: lines.reduce((n, l) => n + l.to, 0),
  };
};

/** Plain-language description of one line's change, e.g. "10 pcs → 8 pcs". */
const changeLabel = (l) => {
  if (l.type === 'added') return `newly added — ${l.to} pcs`;
  if (l.type === 'removed') return `removed — was ${l.from} pcs`;
  if (l.type === 'unchanged') return `no change — ${l.to} pcs`;
  return `changed from ${l.from} pcs to ${l.to} pcs`;
};

const buildPoRaisedEmail = ({ customerName, orderId, poNumber, summary }) => {
  const cell = 'padding: 7px 12px; border-bottom: 1px solid #eee; font-size: 13px;';
  const head = 'padding: 7px 12px; background: #f4f6f8; color: #555; text-align: left; font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e3e7eb;';
  const tone = {
    increased: 'color: #1a7f37; font-weight: bold;',
    reduced: 'color: #b54708; font-weight: bold;',
    added: 'color: #1a5b9e; font-weight: bold;',
    removed: 'color: #b42318; font-weight: bold;',
    unchanged: 'color: #888;',
  };

  const rows = summary.lines.map((l) => `
    <tr>
      <td style="${cell}"><strong>${esc(l.skuCode)}</strong></td>
      <td style="${cell}">${esc(l.msilCode || '—')}</td>
      <td style="${cell} text-align: right;">${l.from} pcs</td>
      <td style="${cell} text-align: right;">${l.to} pcs</td>
      <td style="${cell} ${tone[l.type]}">${esc(changeLabel(l))}</td>
    </tr>`).join('');

  return `
    <p>Hi ${esc(customerName)},</p>
    <p>Your booking <strong>${esc(orderId)}</strong> has been processed and
       PO No. <strong>${esc(poNumber)}</strong> has been punched against it.</p>

    <div style="margin: 18px 0; padding: 14px 18px; background: #f0f6ff; border: 1px solid #cfe0f7; border-radius: 4px;">
      <div style="font-size: 11px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">Booking ID</div>
      <div style="font-size: 20px; font-weight: bold; color: #1a5b9e; font-family: monospace;">${esc(orderId)}</div>
      <div style="margin-top: 10px; font-size: 11px; color: #5a7ca8; text-transform: uppercase; letter-spacing: 0.5px;">PO Number</div>
      <div style="font-size: 20px; font-weight: bold; color: #1a5b9e; font-family: monospace;">${esc(poNumber)}</div>
    </div>

    ${summary.changed
      ? `<p><strong>Please note:</strong> some items were adjusted before the PO was raised. The changes are shown below.</p>`
      : `<p>All items were processed exactly as you booked them — no quantities were changed.</p>`}

    <table style="border-collapse: collapse; margin: 0 0 8px; width: 100%;">
      <thead>
        <tr>
          <th style="${head}">SKU</th>
          <th style="${head}">MSIL Code</th>
          <th style="${head} text-align: right;">Booked</th>
          <th style="${head} text-align: right;">On PO</th>
          <th style="${head}">Change</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="${cell} border-bottom: none; text-align: right; font-weight: bold;">Total</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold;">${summary.totalFrom} pcs</td>
          <td style="${cell} border-bottom: none; text-align: right; font-weight: bold;">${summary.totalTo} pcs</td>
          <td style="${cell} border-bottom: none;"></td>
        </tr>
      </tfoot>
    </table>

    <p style="margin: 16px 0; padding: 12px 16px; background: #fff8e6; border-left: 4px solid #f0a500; font-size: 14px;">
      <strong>Please note:</strong> the turnaround time (TAT) for this booking is
      <strong>7 days</strong> from the date of confirmation.
    </p>

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

    const all = [...byBooking.values()].map(shapeBooking);

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
    res.status(200).json({ success: true, data: shapeBooking(rows) });
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
  assertBookingEditable(existing, req.user);

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
      await recordAudit(
        req.user,
        'Booking Edited (Sales)',
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
      data: shapeBooking(updated),
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
    await Order.updateMany(
      { orderId },
      { $set: { poNumber, poGeneratedAt: now, poGeneratedBy: req.user._id } },
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
      `PO ${poNumber} raised for booking ${orderId} by ${req.user.user || req.user.email}. Booking is now locked.`,
      req,
      { meta: { orderId, poNumber, poGeneratedAt: now } },
    );

    // Tell the customer their PO is through — in-app, and by email with a
    // line-by-line account of anything the sales desk changed.
    const summary = await buildChangeSummary(updated, orderId);

    if (updated[0]?.user) {
      notifyUser(updated[0].user, {
        title: 'PO Generated',
        message: summary.changed
          ? `PO ${poNumber} raised for booking ${orderId}. Some quantities were adjusted — see your email.`
          : `PO ${poNumber} has been raised for your booking ${orderId}.`,
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
        const subject = summary.changed
          ? `PO ${poNumber} raised for booking ${orderId} — items adjusted`
          : `PO ${poNumber} raised for booking ${orderId}`;

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
