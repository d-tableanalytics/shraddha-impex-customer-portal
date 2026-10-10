/**
 * allocate-auto-bookings.js
 * -----------------------------------------------------------------------------
 * Turn an auto-booking raised from indents into inward allocations on the
 * bookings those indents belong to.
 *
 *   node scripts/allocate-auto-bookings.js                          # DRY RUN — reports, writes nothing
 *   node scripts/allocate-auto-bookings.js --apply                  # write
 *   node scripts/allocate-auto-bookings.js --booking BO-2026-000111 # one auto-booking only (repeatable)
 *
 * Before inward allocations existed, stock arriving for indents was raised as a
 * NEW booking. BO-2026-000111 (9 Oct) took the indents of 13 bookings — 48
 * units of 183H.35-8 belonged to BO-2026-000009 under PO 2242890. This moves
 * each indent's units onto its own booking as "Inward allocation 1", dated when
 * the stock actually arrived, through the same code the allocator now uses
 * (allocateToBooking). The auto-booking is emptied as its lines move.
 *
 * ONLY TOUCHES AUTO-BOOKINGS NOBODY HAS ACTED ON: every row 'PO Received',
 * stock still reserved, no PO raised. Anything else is reported and left.
 *
 * STOCK: the units are reserved on the auto-booking. Moving to a booking that
 * is still reserved, nothing moves; to one whose PO already consumed its
 * stock, they are released and issued in one step, as the allocator would.
 *
 * NO EMAILS are sent. The customer was told about the auto-booking.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// The service imports notify.js, which imports server.js, and importing that
// STARTS THE SERVER, crons included. Stub it before anything loads it.
register('./lib/stub-server.mjs', import.meta.url);

const { connectDatabase } = await import('../config/database.js');
const { default: Order, LINE_ORDER } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: User } = await import('../models/User.js');
const { default: AuditLog } = await import('../models/AuditLog.js');
const { isPlaceholderPo } = await import('../utils/bookingLock.js');
const { releaseStock, reserveStock, adjustConsumedQty } = await import('../utils/stockLedger.js');
const {
  allocateToBooking, allocationModeFor, parentBookingIdOf,
} = await import('../modules/inventory/indentAvailability.service.js');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.flatMap((arg, i) => (arg === '--booking' && args[i + 1] ? [args[i + 1]] : []));

await connectDatabase();
console.log(apply ? '\nAPPLYING — auto-bookings to inward allocations\n' : '\nDRY RUN — nothing will be written (pass --apply to write)\n');

const autoIds = only.length
  ? only
  : (await Reservation.distinct('autoBookedOrderId', { autoBookedOrderId: { $ne: null } })).sort();

let moved = 0;
let skipped = 0;

for (const autoId of autoIds) {
  const autoRows = await Order.find({ orderId: autoId }).sort(LINE_ORDER);
  const sources = await Reservation.find({ autoBookedOrderId: autoId, status: 'Confirmed' })
    .sort({ reservationDate: 1 }).lean();
  if (!autoRows.length || !sources.length) continue;

  const untouched = autoRows.every((r) => r.status === 'PO Received'
    && (r.stockState ?? 'reserved') === 'reserved'
    && isPlaceholderPo(r.poNumber));
  if (!untouched) {
    console.log(`  ${autoId}  SKIPPED — already acted on (PO raised, status moved or stock settled)`);
    skipped += sources.length;
    continue;
  }

  const byParent = new Map();
  for (const indent of sources) {
    const parentId = parentBookingIdOf(indent);
    if (!parentId || parentId === autoId) continue;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(indent);
  }

  for (const [parentId, indents] of byParent) {
    const parentRows = await Order.find({ orderId: parentId }).sort(LINE_ORDER).lean();
    const mode = allocationModeFor(indents[0], parentRows);
    for (const i of indents) {
      const msg = `  ${autoId} → ${parentId}  ${i.skuCode.padEnd(14)} ${String(i.quantity).padStart(4)}  (${i.indentNumber})`;
      console.log(mode ? msg : `${msg}  SKIPPED — ${parentId} was cancelled`);
    }
    if (!mode) { skipped += indents.length; continue; }
    if (!apply) { moved += indents.length; continue; }

    const customer = await User.findById(indents[0].customerId).lean();
    const ctx = { workflow: 'auto-booking-to-allocation', referenceType: 'booking', referenceId: parentId };
    const made = await allocateToBooking(
      customer,
      parentId,
      indents.map((indent) => ({ indent, take: indent.quantity })),
      parentRows,
      {
        mode,
        // When the stock actually arrived and was booked.
        now: indents[0].autoBookedAt || new Date(),
        // Already closed against the auto-booking; repoint it.
        claim: async (indent) => {
          await Reservation.updateOne({ _id: indent._id }, { $set: { autoBookedOrderId: parentId } });
          return () => Reservation.updateOne({ _id: indent._id }, { $set: { autoBookedOrderId: autoId } });
        },
        // Reserved on the auto-booking already. Onto a consumed line they are
        // released and issued; onto a reserved one nothing moves.
        take: async ({ product, qty, consumed }) => {
          if (!consumed) return true;
          if (!(await releaseStock(product, qty, null, ctx))) return false;
          if ((await adjustConsumedQty(product, 0, qty, null, ctx)).ok) return true;
          await reserveStock(product, qty, null, ctx);
          return false;
        },
        untake: async ({ product, qty, consumed }) => {
          if (!consumed) return;
          await adjustConsumedQty(product, qty, 0, null, ctx);
          await reserveStock(product, qty, null, ctx);
        },
      },
    );
    if (!made) continue;

    // Only once the units are on their booking do they leave the auto-booking.
    for (const a of made.lines) {
      const row = autoRows.find((r) => r.skuCode === a.skuCode && (r.confirmedQty || 0) >= a.quantity);
      if (!row) {
        console.error(`  !! ${autoId}: no line held ${a.quantity} of ${a.skuCode} to remove — check it by hand.`);
        continue;
      }
      row.confirmedQty -= a.quantity;
      row.requestedQty = Math.max(0, (row.requestedQty || 0) - a.quantity);
      row.bookedQty = Math.max(0, (row.bookedQty || 0) - a.quantity);
      if (row.confirmedQty === 0) await Order.deleteOne({ _id: row._id });
      else await row.save();
    }

    moved += made.lines.length;
    await AuditLog.create({
      action: 'Auto-Booking To Allocation',
      method: 'SCRIPT',
      endpoint: 'scripts/allocate-auto-bookings.js',
      ipAddress: '127.0.0.1',
      userAgent: 'ERP MAINTENANCE SCRIPT',
      remarks: `${made.lines.length} line(s) moved from ${autoId} to ${parentId} as inward allocations.`,
      meta: { from: autoId, orderId: parentId, lines: made.lines },
    });
  }

  if (apply) {
    const left = await Order.countDocuments({ orderId: autoId });
    console.log(`  ${autoId}  ${left ? `${left} line(s) remain` : 'now empty — every line went to its own booking'}`);
  }
}

console.log(`\n${moved} indent line(s) ${apply ? 'moved' : 'to move'}, ${skipped} skipped.\n`);
await mongoose.disconnect();
