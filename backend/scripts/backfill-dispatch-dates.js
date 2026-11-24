/**
 * backfill-dispatch-dates.js
 * -----------------------------------------------------------------------------
 * Give every live booking line that has no DISPATCH DATE the one it should have.
 *
 *   node scripts/backfill-dispatch-dates.js           # DRY RUN — reports, writes nothing
 *   node scripts/backfill-dispatch-dates.js --apply   # write the backfill
 *
 * WHY THIS EXISTS
 *
 * `Order.scheduledDate` IS the dispatch date (see utils/dispatchDate.js). It is
 * stamped at confirmation and re-derived when the PO is raised — but both of
 * those are recent, so every booking taken before they existed carries null.
 *
 * A null is not a harmless gap. The delivery-schedule document a customer files
 * their purchase order against prints `scheduledDate` in its "DISPATCH DATE"
 * column, and a null prints as an EMPTY CELL — a blank column on a document that
 * otherwise reconciles line for line reads as an omission, which is exactly the
 * complaint this answers.
 *
 * WHICH DATE EACH LINE GETS, AND WHY IT IS NOT ALL ONE DATE
 *
 * The rule the live code applies — THE BOOKING CONFIRMATION DAY, PLUS THREE —
 * asked of the best record each line carries of that day:
 *
 *     orderTimestamp → createdAt → poDate → poGeneratedAt
 *
 * `orderTimestamp` is the confirmation instant, written by the confirm handler,
 * and is what both PO routes now derive from; `createdAt` is the same moment as
 * recorded by Mongoose. The two PO dates are a last resort for a row old enough
 * to be missing both, where the PO day is the only evidence left of when the
 * booking existed.
 *
 * A line is never dated from TODAY: that would tell a customer that a booking
 * placed in September ships three days from whenever an administrator happened
 * to run this script. It follows that an old booking gets a dispatch date in the
 * PAST — which is the acknowledged cost of counting from the booking day, and is
 * corrected per booking from the Delivery schedule panel, not here.
 *
 * WHAT IT WILL NOT TOUCH
 *
 *   - A line that already has a date. Whether a human picked it or the system
 *     derived it, it is the date the customer has already been told.
 *   - A cancelled line. It is not on any schedule, so it has no dispatch date to
 *     be missing.
 *   - A dispatched or delivered line. Its "DISPATCH DATE" is the real timestamp
 *     of the event, not a plan — stamping a future date on goods that have
 *     already left would be inventing a fact. Any such line whose timestamp is
 *     ALSO missing is reported rather than written, because that is a hole in
 *     the status history and not something a dispatch-date backfill can mend.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { connectDatabase } = await import('../config/database.js');
const { default: Order, LINE_ORDER } = await import('../models/Order.js');
const { defaultDispatchDate } = await import('../utils/dispatchDate.js');
// The one list of "which lines may be GIVEN a date", imported rather than
// retyped: a status added there and not here would leave a class of line that
// the document schedules but the backfill never reaches.
const { OPEN_BOOKING_STATUSES } = await import('../utils/deliverySchedule.js');

const apply = process.argv.slice(2).includes('--apply');

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

await connectDatabase();

console.log('Dispatch-date backfill');
console.log('======================');
console.log(apply ? 'MODE: apply\n' : 'MODE: dry run (pass --apply to write)\n');

const undated = await Order.find(
  { scheduledDate: null, status: { $ne: 'Cancelled' } },
  'orderId poNumber skuCode status scheduledDate statusTimestamp poDate poGeneratedAt orderTimestamp createdAt',
)
  .sort(LINE_ORDER)
  .lean();

const writes = [];
const shipped = [];
const sources = { poDate: 0, poGeneratedAt: 0, orderTimestamp: 0, createdAt: 0 };

for (const line of undated) {
  // A line that has already gone out is dated by the event, not by a plan.
  if (!OPEN_BOOKING_STATUSES.includes(line.status)) {
    shipped.push(line);
    continue;
  }

  const [field, basis] = [
    ['orderTimestamp', line.orderTimestamp],
    ['createdAt', line.createdAt],
    ['poDate', line.poDate],
    ['poGeneratedAt', line.poGeneratedAt],
  ].find(([, value]) => Boolean(value)) || [null, null];

  if (!basis) {
    // Unreachable in practice — `createdAt` is written by Mongoose on every
    // document — and reported rather than assumed away.
    console.log(`  !! ${line.orderId} / ${line.skuCode}: no date to count from. Skipped.`);
    continue;
  }

  sources[field] += 1;
  writes.push({
    updateOne: {
      filter: { _id: line._id },
      // `scheduledBy` stays null: null means the SYSTEM derived this date, which
      // is what a backfill is, and it is also what tells the live PO path it may
      // re-derive the date later rather than treating it as a human's choice.
      update: { $set: { scheduledDate: defaultDispatchDate(basis), scheduledBy: null } },
    },
  });
}

console.log(`  undated live lines read ........ ${undated.length}`);
console.log(`  dispatched/delivered (skipped) . ${shipped.length}`);
console.log(`  to stamp ....................... ${writes.length}`);
if (writes.length) {
  console.log('    counted from booking date .... ' + sources.orderTimestamp);
  console.log('    counted from record created .. ' + sources.createdAt);
  console.log('    counted from PO date ......... ' + sources.poDate);
  console.log('    counted from PO raised at .... ' + sources.poGeneratedAt);
}

const undatedShipped = shipped.filter((l) => !l.statusTimestamp);
if (undatedShipped.length) {
  console.log(`\n  !! ${undatedShipped.length} dispatched/delivered line(s) carry no status timestamp,`);
  console.log('     so their DISPATCH DATE stays blank. That is a gap in the status');
  console.log('     history — fix those lines there, not here:');
  for (const l of undatedShipped.slice(0, 20)) {
    console.log(`     ${l.orderId} / ${l.skuCode} (${l.status})`);
  }
}

if (!writes.length) {
  console.log('\nNothing to backfill.');
} else if (!apply) {
  console.log('\nFirst few, as they would be written:');
  for (const line of undated.filter((l) => OPEN_BOOKING_STATUSES.includes(l.status)).slice(0, 10)) {
    const basis = line.orderTimestamp || line.createdAt || line.poDate || line.poGeneratedAt;
    console.log(
      `  ${line.orderId} / ${line.skuCode} (${line.status}): `
      + `${fmt(basis)} + 3 → ${fmt(defaultDispatchDate(basis))}`,
    );
  }
  console.log(`\n${writes.length} line(s) would be stamped. Re-run with --apply to write.`);
} else {
  const result = await Order.bulkWrite(writes);
  console.log(`\n${result.modifiedCount} line(s) stamped.`);

  // Re-read, because the point of the exercise is that no live line is left
  // without a dispatch date — and a write that reported success while leaving
  // some behind is the failure mode worth catching.
  const left = await Order.countDocuments({
    scheduledDate: null,
    status: { $in: OPEN_BOOKING_STATUSES },
  });
  console.log(
    left
      ? `  !! ${left} live line(s) still have no dispatch date.`
      : '  Every live booking line now carries a dispatch date.',
  );
}

await mongoose.disconnect();
