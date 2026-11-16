/**
 * Move a booking that a Sales Person or Admin placed under THEIR OWN account
 * onto the customer it was really for.
 *
 * Before Create Booking had a Select Customer field, the desk booked on a
 * customer's behalf by booking as themselves: those Order rows carry the staff
 * account as `user`, so the Sales Desk shows the salesperson in Customer Name
 * and nothing in SI Team, and the customer never sees the booking in their own
 * Booking History.
 *
 * THE DATA CANNOT SAY WHICH CUSTOMER EACH ONE WAS FOR. Somebody who knows has
 * to, so this runs in two steps:
 *
 *   1. node scripts/reassign-booking-customer.js --list
 *      Prints every booking owned by a non-customer account, and writes a CSV
 *      template (orderId,customerEmail) beside this script with the second
 *      column empty. Fill in the customer's login email for each booking you
 *      want moved; leave a row blank (or delete it) to leave that booking alone.
 *
 *   2. node scripts/reassign-booking-customer.js --map <file.csv>
 *      DRY RUN: says exactly what each row would change, writes nothing.
 *      node scripts/reassign-booking-customer.js --map <file.csv> --apply
 *      Does it.
 *
 * What a reassignment changes, per booking:
 *   - every Order row:   user -> the customer; the customer identity snapshot
 *                        (company, emailId, phone, addresses, shop, GST) is
 *                        re-stamped from the customer's record where the row
 *                        still carries the staff member's; createdBy* is
 *                        stamped with the staff account (the SI Team), only if
 *                        not already set.
 *   - its indents:       Reservation rows for this booking's indent id (and any
 *                        that auto-booked into it) move to the customer; their
 *                        reservedBy stays the staff member, which is what makes
 *                        a later auto-booking from them carry the SI Team too.
 *   - status events:     BookingStatusEvent.user -> the customer.
 * The audit trail is NOT rewritten: the staff member did press the button.
 *
 * Refuses a row when the booking does not exist, is already owned by a
 * customer account, or the email is not a live Customer account. One bad row
 * does not stop the others; every outcome is printed.
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import Order from '../models/Order.js';
import User from '../models/User.js';
import Reservation from '../models/Reservation.js';
import BookingStatusEvent from '../models/BookingStatusEvent.js';

const isCustomerAccount = (u) => (u?.role || 'Customer') === 'Customer';
const staffName = (u) => u?.user || u?.customerName || u?.company || u?.email || null;

/** Bookings whose owner is a staff account: one line per booking. */
export const listMisownedBookings = async () => {
  const staff = await User.find({ role: { $ne: 'Customer' } }, 'user email role company').lean();
  if (!staff.length) return [];
  const byId = new Map(staff.map((s) => [String(s._id), s]));
  const rows = await Order.aggregate([
    { $match: { user: { $in: staff.map((s) => s._id) } } },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: '$orderId',
        user: { $first: '$user' },
        date: { $first: '$date' },
        company: { $first: '$company' },
        poNumber: { $first: '$poNumber' },
        createdByName: { $first: '$createdByName' },
        lines: { $sum: 1 },
      },
    },
    { $sort: { date: 1 } },
  ]);
  return rows.map((r) => ({
    orderId: r._id,
    date: r.date,
    lines: r.lines,
    poNumber: r.poNumber && r.poNumber !== '-' ? r.poNumber : null,
    stampedCompany: r.company || null,
    placedBy: byId.get(String(r.user)) || null,
    alreadyStamped: Boolean(r.createdByName),
  }));
};

/**
 * Reassign one booking. Returns { orderId, ok, message, changes } and writes
 * only when `apply` is true.
 */
export const reassignBooking = async ({ orderId, customerEmail, apply = false }) => {
  const id = String(orderId || '').trim();
  const email = String(customerEmail || '').trim().toLowerCase();
  const refuse = (message) => ({ orderId: id, ok: false, message });
  if (!id) return refuse('No booking id.');
  if (!email) return refuse('No customer email given — row skipped.');

  const rows = await Order.find({ orderId: id }).lean();
  if (!rows.length) return refuse('Booking not found.');

  const owner = await User.findById(rows[0].user).lean();
  if (owner && isCustomerAccount(owner)) {
    return refuse(`Already owned by customer account ${owner.email}; nothing to do.`);
  }

  const customer = await User.findOne({ email }).lean();
  if (!customer) return refuse(`No account with email ${email}.`);
  if (!isCustomerAccount(customer)) return refuse(`${email} is a ${customer.role} account, not a customer.`);
  if (customer.status && customer.status !== 'Active') return refuse(`${email} is ${customer.status}.`);

  // The staff member is the SI Team. `owner` is null when the staff account has
  // since been deleted; the row's own stamp, if any, is then all we have.
  const creator = owner
    ? {
      createdBy: owner._id,
      createdByName: staffName(owner),
      createdByEmail: owner.email || null,
      createdByRole: owner.role || null,
    }
    : null;

  const indentNumber = `PI-${id.replace(/^[A-Z]+-/, '')}`;
  const indentFilter = {
    customerId: rows[0].user,
    $or: [{ indentNumber }, { autoBookedOrderId: id }],
  };
  const indents = await Reservation.countDocuments(indentFilter);
  const events = await BookingStatusEvent.countDocuments({ orderId: id, user: rows[0].user });

  const changes = {
    lines: rows.length,
    indents,
    statusEvents: events,
    from: owner ? `${staffName(owner)} <${owner.email}> (${owner.role})` : `deleted account ${rows[0].user}`,
    to: `${customer.customerName || customer.user || customer.company || customer.email} <${customer.email}>`,
    siTeam: rows[0].createdByName || creator?.createdByName || null,
  };

  if (apply) {
    for (const row of rows) {
      const set = {
        user: customer._id,
        // Re-stamp the identity snapshot only where the row still carries the
        // staff member's own details (or none). A value that differs from both
        // was typed on purpose (a PO address, say) and is kept.
        ...(row.company === (owner?.company ?? null) || !row.company || row.company === 'Shraddha Impex'
          ? { company: customer.company || 'Shraddha Impex' } : {}),
        ...(row.emailId === (owner?.email ?? null) || !row.emailId ? { emailId: customer.email || null } : {}),
        ...(row.phoneNumber === (owner?.phone ?? null) || !row.phoneNumber ? { phoneNumber: customer.phone || null } : {}),
        ...(!row.shippingAddress ? { shippingAddress: customer.shippingAddress || null } : {}),
        ...(!row.billingAddress ? { billingAddress: customer.billingAddress || null } : {}),
        ...(!row.shopNumber ? { shopNumber: customer.shopNumber || null } : {}),
        ...(!row.gstCode ? { gstCode: customer.gstNumber || null } : {}),
        ...(!row.location ? { location: customer.location || null } : {}),
        ...(row.role === (owner?.role ?? null) || !row.role ? { role: customer.role || 'Customer' } : {}),
        ...(!row.createdBy && creator ? creator : {}),
      };
      await Order.updateOne({ _id: row._id }, { $set: set });
    }
    await Reservation.updateMany(indentFilter, { $set: { customerId: customer._id } });
    await BookingStatusEvent.updateMany({ orderId: id, user: rows[0].user }, { $set: { user: customer._id } });
  }

  return {
    orderId: id,
    ok: true,
    message: `${apply ? 'Moved' : 'Would move'} ${changes.lines} line(s), ${changes.indents} indent line(s), `
      + `${changes.statusEvents} status event(s) from ${changes.from} to ${changes.to}; SI Team: ${changes.siTeam || '—'}.`,
    changes,
  };
};

const parseMap = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const data = JSON.parse(text);
    return (Array.isArray(data) ? data : Object.entries(data).map(([orderId, customerEmail]) => ({ orderId, customerEmail })));
  }
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^orderId\s*,/i.test(line))
    .map((line) => {
      const [orderId, customerEmail = ''] = line.split(',').map((s) => s.trim());
      return { orderId, customerEmail };
    });
};

const main = async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const mapAt = args.indexOf('--map');
  const mapFile = mapAt >= 0 ? args[mapAt + 1] : null;
  const list = args.includes('--list') || !mapFile;

  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);

  if (list) {
    const bookings = await listMisownedBookings();
    if (!bookings.length) {
      console.log('No booking is owned by a staff account. Nothing to reassign.');
    } else {
      console.log(`${bookings.length} booking(s) are owned by a staff account:\n`);
      for (const b of bookings) {
        console.log(
          `${b.orderId}  ${b.date ? new Date(b.date).toISOString().slice(0, 10) : '—'}  `
          + `${b.lines} line(s)  PO ${b.poNumber || '—'}  stamped company "${b.stampedCompany || '—'}"  `
          + `placed by ${b.placedBy ? `${staffName(b.placedBy)} <${b.placedBy.email}> (${b.placedBy.role})` : 'a deleted account'}`
          + (b.alreadyStamped ? '  [SI Team already stamped]' : ''),
        );
      }
      const out = path.resolve(__dirname, 'reassign-booking-customer.csv');
      fs.writeFileSync(out, ['orderId,customerEmail', ...bookings.map((b) => `${b.orderId},`)].join('\n') + '\n');
      console.log(`\nTemplate written to ${out}\nFill in each customer's login email, then run:\n`
        + `  node scripts/reassign-booking-customer.js --map ${path.relative(process.cwd(), out)}        (dry run)\n`
        + `  node scripts/reassign-booking-customer.js --map ${path.relative(process.cwd(), out)} --apply`);
    }
  } else {
    const rowsIn = parseMap(path.resolve(mapFile));
    console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${rowsIn.length} row(s) in ${mapFile}\n`);
    let moved = 0;
    let skipped = 0;
    for (const row of rowsIn) {
      const result = await reassignBooking({ ...row, apply });
      console.log(`${result.ok ? 'OK  ' : 'SKIP'} ${result.orderId}: ${result.message}`);
      if (result.ok) moved += 1; else skipped += 1;
    }
    console.log(`\n${apply ? 'Moved' : 'Would move'} ${moved} booking(s); ${skipped} skipped.`
      + (apply ? '' : '\nRe-run with --apply to write these changes.'));
  }

  await mongoose.disconnect();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
