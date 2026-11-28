/**
 * BOOKING DATA BIFURCATION.
 *
 *   Total Bookings  =  Available Inventory Against Bookings  +  Pending Indents
 *
 * The client's worked example: 100 units booked, 70 in stock, 30 to indent.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING
 * ---------------------------------------------------------------------------
 *
 * The three numbers are easy. Keeping them true through the lifecycle is not,
 * and there are exactly two ways the system can make them lie:
 *
 * 1. DOUBLE COUNTING. At the confirmation split the booking row's `pendingQty`
 *    and the reservation behind it hold the SAME units. Any derivation that
 *    reads both reports the shortfall twice, and the result looks entirely
 *    plausible on screen.
 *
 * 2. THE STALE SNAPSHOT. `pendingQty` is frozen at confirmation. Once stock
 *    arrives and auto-books against the indent, the reservation shrinks and
 *    the row does not — so anything built on `pendingQty` keeps reporting
 *    units the customer has already been given.
 *
 * Both of those were live in the Customer Portal, which derived its indent
 * total IN THE BROWSER by summing `pendingQty` across the booking's rows.
 *
 * On top of that, the split has to stop counting units that are no longer
 * outstanding — cancelled, expired-and-released, dispatched — without losing
 * the historical record of them.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import Order from '../models/Order.js';
import Reservation from '../models/Reservation.js';
import {
  bifurcateRows, bifurcateBookings, bifurcateSku, attachBookingBifurcation,
  isOutstandingLine, isDispatchedLine, emptyBifurcation,
} from '../utils/bookingBifurcation.js';
import { shapeBooking } from '../modules/sales/booking.shape.js';

const CUSTOMER = new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Order, Reservation);
});
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * One booking line, as the confirmation writes it: `bookedQty` is what the
 * customer asked for, `confirmedQty` what stock covered, `pendingQty` the
 * remainder that became an indent.
 */
const line = (orderId, skuCode, confirmedQty, pendingQty = 0, extra = {}) => ({
  orderId,
  brand: 'Koken',
  user: CUSTOMER,
  status: 'PO Received',
  company: 'ABC Motors',
  skuCode,
  requestedQty: confirmedQty,
  bookedQty: confirmedQty + pendingQty,
  confirmedQty,
  pendingQty,
  stockState: 'reserved',
  ...extra,
});

/** The live indent behind a shortfall — PI-x for BO-x. */
const indent = (orderId, skuCode, quantity, status = 'Pending') => ({
  reservationId: `RES-${orderId}-${skuCode}`,
  customerId: CUSTOMER,
  productId: new mongoose.Types.ObjectId(),
  skuCode,
  quantity,
  expiryDate: new Date(Date.now() + 7 * 864e5),
  reservedBy: CUSTOMER,
  status,
  indentNumber: orderId.replace(/^[A-Z]+-/, 'PI-'),
});

const splitOf = async (orderId) =>
  (await bifurcateBookings(await Order.find({ orderId }).lean())).get(orderId).totals;

// ── The identity ────────────────────────────────────────────────────────────

describe('the three numbers', () => {
  test("the client's example: 100 booked, 70 in stock, 30 on indent", async () => {
    await Order.create(line('BO-1', 'SKU-A', 70, 30));
    await Reservation.create(indent('BO-1', 'SKU-A', 30));

    const t = await splitOf('BO-1');
    assert.equal(t.totalBookedQty, 100, 'Total Booking Quantity');
    assert.equal(t.allocatedQty, 70, 'Inventory Allocated Against Booking');
    assert.equal(t.pendingIndentQty, 30, 'Pending Indent Quantity');
    assert.equal(t.allocatedQty + t.pendingIndentQty, t.totalBookedQty, 'the identity');
  });

  test('fully available: everything is allocated, nothing is indented', async () => {
    await Order.create(line('BO-1', 'SKU-A', 100, 0));
    const t = await splitOf('BO-1');
    assert.deepEqual(
      [t.totalBookedQty, t.allocatedQty, t.pendingIndentQty], [100, 100, 0],
    );
  });

  test('entirely short: the booking has NO order row, and is still counted', async () => {
    // The confirmation only pushes an order row when confirmedQty > 0, so a
    // line stock could not touch exists solely as a reservation. Deriving the
    // indent from order rows reports zero for exactly this booking.
    await Reservation.create(indent('BO-1', 'SKU-A', 100));

    const { totals, bySku } = bifurcateRows(
      [], new Map([['SKU-A', 100]]),
    );
    assert.deepEqual(
      [totals.totalBookedQty, totals.allocatedQty, totals.pendingIndentQty], [100, 0, 100],
    );
    assert.equal(bySku.length, 1, 'the SKU appears even with no order row');
    assert.equal(bySku[0].skuCode, 'SKU-A');
  });

  test('the shortfall is NOT counted twice', async () => {
    // `pendingQty` on the row and the reservation are the same 30 units.
    await Order.create(line('BO-1', 'SKU-A', 70, 30));
    await Reservation.create(indent('BO-1', 'SKU-A', 30));

    const t = await splitOf('BO-1');
    assert.equal(t.totalBookedQty, 100, 'not 130');
  });

  test('the indent is the LIVE balance, not the frozen snapshot', async () => {
    // 30 short at confirmation; 15 arrived since and were auto-booked, so the
    // reservation is down to 15 while the row still says 30.
    await Order.create(line('BO-1', 'SKU-A', 85, 30));
    await Reservation.create(indent('BO-1', 'SKU-A', 15, 'Partially Confirmed'));

    const t = await splitOf('BO-1');
    assert.equal(t.pendingIndentQty, 15, 'the row still says 30; the customer is waiting for 15');
    assert.equal(t.allocatedQty, 85);
    assert.equal(t.totalBookedQty, 100);
  });

  test('unknown is null, never zero', () => {
    const { totals } = bifurcateRows([line('BO-1', 'SKU-A', 70, 30)], null);
    assert.equal(totals.pendingIndentQty, null);
    assert.equal(totals.totalBookedQty, null);
    assert.equal(totals.allocatedQty, 70, 'what IS known is still reported');
  });

  test('nothing at all is a zeroed split, not a crash', () => {
    const { totals, bySku } = bifurcateRows([], new Map());
    assert.deepEqual(totals, emptyBifurcation());
    assert.deepEqual(bySku, []);
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('through the lifecycle', () => {
  test('a cancelled line leaves the outstanding split and is reported separately', async () => {
    await Order.create([
      line('BO-1', 'SKU-A', 70, 0),
      line('BO-1', 'SKU-B', 40, 0, { status: 'Cancelled', stockState: 'released' }),
    ]);
    const t = await splitOf('BO-1');
    assert.equal(t.allocatedQty, 70, 'the cancelled 40 are not still reserved');
    assert.equal(t.cancelledQty, 40, 'but they are not lost either');
    assert.equal(t.totalBookedQty, 70);
    assert.equal(t.bookedQtyEver, 110, 'the historical ask is preserved whole');
  });

  test('a cancelled booking contributes nothing, and its indent is closed with it', async () => {
    await Order.create(line('BO-1', 'SKU-A', 70, 30, { status: 'Cancelled', stockState: 'released' }));
    // closeBookingIndent() cancels the reservation alongside the booking.
    await Reservation.create(indent('BO-1', 'SKU-A', 30, 'Cancelled'));

    const t = await splitOf('BO-1');
    assert.deepEqual([t.totalBookedQty, t.allocatedQty, t.pendingIndentQty], [0, 0, 0]);
    assert.equal(t.cancelledQty, 70);
  });

  test('a booking that expired without a PO has released its stock', async () => {
    // The 7-day no-PO expiry: releaseStock, then stockState 'released'. The
    // line keeps its status — only the stock state says the units went back.
    await Order.create(line('BO-1', 'SKU-A', 70, 0, {
      stockState: 'released', autoCancelledAt: new Date(),
    }));
    const t = await splitOf('BO-1');
    assert.equal(t.allocatedQty, 0, 'released units are on the shelf, not against this booking');
    assert.equal(t.bookedQtyEver, 70, 'what was asked for is still on the record');
  });

  test('an expired SELECTION LIST holds nothing and contributes nothing', async () => {
    // A selection-list line is a 'Reserved' reservation with NO indent number:
    // it has never been confirmed, so no stock was ever set aside for it and
    // no indent was ever raised. Expiry just closes it.
    await Reservation.create({
      ...indent('BO-1', 'SKU-A', 50), indentNumber: null, status: 'Expired',
    });
    const split = await bifurcateSku('SKU-A');
    assert.deepEqual(
      [split.totalBookedQty, split.allocatedQty, split.pendingIndentQty], [0, 0, 0],
    );
  });

  test('a PO raised consumes the stock, and the units are STILL outstanding', async () => {
    // Consumed means the units left the available pool for good — they are
    // owed to this customer and still waiting to go out of the door. Treating
    // 'consumed' as settled would collapse the booking to nothing at exactly
    // the moment it became a firm commitment.
    await Order.create(line('BO-1', 'SKU-A', 70, 30, {
      stockState: 'consumed', poNumber: 'PO-99', poGeneratedAt: new Date(),
    }));
    await Reservation.create(indent('BO-1', 'SKU-A', 30));

    const t = await splitOf('BO-1');
    assert.equal(t.allocatedQty, 70);
    assert.equal(t.pendingIndentQty, 30);
    assert.equal(t.totalBookedQty, 100);
  });

  test('dispatched units are tracked separately and leave the outstanding split', async () => {
    await Order.create([
      line('BO-1', 'SKU-A', 40, 0, { status: 'Dispatched', stockState: 'consumed' }),
      line('BO-1', 'SKU-B', 30, 0, { stockState: 'consumed' }),
    ]);
    const t = await splitOf('BO-1');
    assert.equal(t.dispatchedQty, 40);
    assert.equal(t.allocatedQty, 30, 'only what has not left is still against the booking');
    assert.equal(t.totalBookedQty, 30);
    assert.equal(t.bookedQtyEver, 70, 'the booking total the customer placed is unchanged');
  });

  test('a delivered line counts as dispatched, not as outstanding', async () => {
    await Order.create(line('BO-1', 'SKU-A', 25, 0, { status: 'Delivered', stockState: 'consumed' }));
    const t = await splitOf('BO-1');
    assert.equal(t.dispatchedQty, 25);
    assert.equal(t.allocatedQty, 0);
  });

  test('indent fulfilment moves units from pending to allocated, total unchanged', async () => {
    // Before: 70 allocated, 30 waiting.
    await Order.create(line('BO-1', 'SKU-A', 70, 30));
    await Reservation.create(indent('BO-1', 'SKU-A', 30));
    const before = await splitOf('BO-1');

    // Stock arrives for 30: indentAvailability bumps confirmedQty and closes
    // the reservation.
    await Order.updateOne({ orderId: 'BO-1' }, {
      $set: { confirmedQty: 100, requestedQty: 100, pendingQty: 0 },
    });
    await Reservation.updateOne({ indentNumber: 'PI-1' }, { $set: { status: 'Confirmed' } });
    const after = await splitOf('BO-1');

    assert.equal(before.totalBookedQty, after.totalBookedQty, 'the customer still wants 100');
    assert.deepEqual([after.allocatedQty, after.pendingIndentQty], [100, 0]);
  });

  test('partial fulfilment splits correctly at every step', async () => {
    await Order.create(line('BO-1', 'SKU-A', 70, 30));
    await Reservation.create(indent('BO-1', 'SKU-A', 30));
    assert.deepEqual(Object.values(await splitOf('BO-1')).slice(0, 3), [100, 70, 30]);

    // 10 of the 30 arrive.
    await Order.updateOne({ orderId: 'BO-1' }, { $set: { confirmedQty: 80 } });
    await Reservation.updateOne({ indentNumber: 'PI-1' }, {
      $set: { quantity: 20, status: 'Partially Confirmed' },
    });
    const t = await splitOf('BO-1');
    assert.deepEqual([t.totalBookedQty, t.allocatedQty, t.pendingIndentQty], [100, 80, 20]);
  });

  test('a quantity increase and a decrease both keep the identity', async () => {
    await Order.create(line('BO-1', 'SKU-A', 70, 30));
    await Reservation.create(indent('BO-1', 'SKU-A', 30));

    for (const [confirmed, pending] of [[90, 30], [50, 10], [70, 0]]) {
      await Order.updateOne({ orderId: 'BO-1' }, { $set: { confirmedQty: confirmed } });
      await Reservation.updateOne({ indentNumber: 'PI-1' }, { $set: { quantity: pending } });
      const t = await splitOf('BO-1');
      assert.equal(
        t.allocatedQty + t.pendingIndentQty, t.totalBookedQty,
        `identity broken at ${confirmed}/${pending}`,
      );
      assert.equal(t.allocatedQty, confirmed);
      assert.equal(t.pendingIndentQty, pending);
    }
  });
});

// ── Booking-wise and SKU-wise agree ─────────────────────────────────────────

describe('booking-wise and SKU-wise', () => {
  test('concurrent bookings for the same SKU sum to the SKU total', async () => {
    await Order.create([
      line('BO-1', 'SKU-A', 70, 30),
      line('BO-2', 'SKU-A', 40, 60),
      line('BO-3', 'SKU-A', 25, 0),
    ]);
    await Reservation.create([
      indent('BO-1', 'SKU-A', 30),
      indent('BO-2', 'SKU-A', 60),
    ]);

    const perBooking = await bifurcateBookings(await Order.find({}).lean());
    const sku = await bifurcateSku('SKU-A');

    const sum = (key) => [...perBooking.values()].reduce((n, b) => n + b.totals[key], 0);
    assert.equal(sku.allocatedQty, sum('allocatedQty'), 'allocated');
    assert.equal(sku.pendingIndentQty, sum('pendingIndentQty'), 'pending indent');
    assert.equal(sku.totalBookedQty, sum('totalBookedQty'), 'total');

    assert.deepEqual(
      [sku.totalBookedQty, sku.allocatedQty, sku.pendingIndentQty], [225, 135, 90],
    );
    assert.equal(sku.bookings.length, 3, 'booking-wise visibility, not just a total');
  });

  test('the SKU view finds a booking that has no order row at all', async () => {
    await Order.create(line('BO-1', 'SKU-A', 70, 0));
    // BO-2 wanted 50 and got nothing: a reservation, and no Order document.
    await Reservation.create(indent('BO-2', 'SKU-A', 50));

    const sku = await bifurcateSku('SKU-A');
    assert.equal(sku.pendingIndentQty, 50);
    assert.equal(sku.totalBookedQty, 120);
    assert.ok(
      sku.bookings.some((b) => b.orderId === 'BO-2' && b.pendingIndentQty === 50),
      'the order-row-less booking is listed, not merely totalled',
    );
  });

  test('the SKU view is brand-scoped', async () => {
    await Order.create([
      line('BO-1', 'SKU-A', 70, 0),
      { ...line('BO-2', 'SKU-A', 40, 0), brand: 'BIX' },
    ]);
    const koken = await bifurcateSku('SKU-A', ['Koken']);
    assert.equal(koken.allocatedQty, 70, 'a BIX booking is not a Koken user\'s business');
    const both = await bifurcateSku('SKU-A', ['Koken', 'BIX']);
    assert.equal(both.allocatedQty, 110);
  });

  test('a SKU nobody has booked is a zeroed split, not an error', async () => {
    const sku = await bifurcateSku('SKU-NONE');
    assert.equal(sku.totalBookedQty, 0);
    assert.deepEqual(sku.bookings, []);
  });

  test('per-SKU lines within one booking each carry their own split', async () => {
    await Order.create([
      line('BO-1', 'SKU-A', 70, 30),
      line('BO-1', 'SKU-B', 10, 0),
    ]);
    await Reservation.create(indent('BO-1', 'SKU-A', 30));

    const { bySku } = (await bifurcateBookings(await Order.find({}).lean())).get('BO-1');
    const a = bySku.find((l) => l.skuCode === 'SKU-A');
    const b = bySku.find((l) => l.skuCode === 'SKU-B');
    assert.deepEqual([a.totalBookedQty, a.allocatedQty, a.pendingIndentQty], [100, 70, 30]);
    assert.deepEqual([b.totalBookedQty, b.allocatedQty, b.pendingIndentQty], [10, 10, 0]);
  });
});

// ── The shapes the screens read ─────────────────────────────────────────────

describe('what reaches the screens', () => {
  test('attachBookingBifurcation stamps every row of a booking', async () => {
    await Order.create([line('BO-1', 'SKU-A', 70, 30), line('BO-1', 'SKU-B', 10, 0)]);
    await Reservation.create(indent('BO-1', 'SKU-A', 30));

    const rows = await Order.find({}).lean();
    await attachBookingBifurcation(rows);

    assert.ok(rows.every((r) => r.bifurcation), 'the client reads it off whichever row it has');
    for (const r of rows) {
      assert.equal(r.bifurcation.totalBookedQty, 110);
      assert.equal(r.bifurcation.allocatedQty, 80);
      assert.equal(r.bifurcation.pendingIndentQty, 30);
    }
  });

  test('it derives from the UNREDACTED rows but stamps the copies', async () => {
    await Order.create(line('BO-1', 'SKU-A', 70, 30));
    await Reservation.create(indent('BO-1', 'SKU-A', 30));

    const source = await Order.find({}).lean();
    // What a customer actually receives: box numbers and prices stripped.
    const visible = source.map(({ boxNo, unitPrice, ...rest }) => rest);
    await attachBookingBifurcation(visible, source);

    assert.equal(visible[0].bifurcation.totalBookedQty, 100);
    assert.ok(!('bifurcation' in source[0]), 'the source rows are not mutated');
  });

  test('the sales desk keeps its old totals AND gains the named split', async () => {
    const rows = [line('BO-1', 'SKU-A', 70, 30)];
    const shaped = shapeBooking(rows, new Map(), { indentBySku: new Map([['SKU-A', 30]]) });

    // Unchanged, for every reader that already depended on them.
    assert.equal(shaped.totals.booked, 70);
    assert.equal(shaped.totals.indent, 30);
    assert.equal(shaped.totals.total, 100);
    // And the bifurcation beside them.
    assert.equal(shaped.totals.totalBookedQty, 100);
    assert.equal(shaped.totals.allocatedQty, 70);
    assert.equal(shaped.totals.pendingIndentQty, 30);
    assert.equal(shaped.totals.bySku.length, 1);
  });

  test('on a part-dispatched booking the two disagree, and the new one is right', () => {
    const rows = [
      line('BO-1', 'SKU-A', 40, 0, { status: 'Dispatched', stockState: 'consumed' }),
      line('BO-1', 'SKU-B', 30, 0),
    ];
    const shaped = shapeBooking(rows, new Map(), { indentBySku: new Map() });
    assert.equal(shaped.totals.booked, 70, 'the legacy figure counts what has already left');
    assert.equal(shaped.totals.allocatedQty, 30, 'the bifurcation counts what is still held');
    assert.equal(shaped.totals.dispatchedQty, 40);
  });
});

// ── The line predicates ─────────────────────────────────────────────────────

describe('which lines count', () => {
  test('outstanding: reserved and consumed yes, released no', () => {
    assert.equal(isOutstandingLine({ status: 'PO Received', stockState: 'reserved' }), true);
    assert.equal(isOutstandingLine({ status: 'PO Received', stockState: 'consumed' }), true);
    assert.equal(isOutstandingLine({ status: 'PO Received', stockState: 'released' }), false);
    assert.equal(isOutstandingLine({ status: 'Cancelled', stockState: 'reserved' }), false);
    assert.equal(isOutstandingLine({ status: 'Dispatched', stockState: 'consumed' }), false);
  });

  test('a legacy row with no stockState reads as still reserved', () => {
    assert.equal(isOutstandingLine({ status: 'Booked' }), true);
  });

  test('dispatched: only a live line that has actually gone', () => {
    assert.equal(isDispatchedLine({ status: 'Dispatched' }), true);
    assert.equal(isDispatchedLine({ status: 'Delivered' }), true);
    assert.equal(isDispatchedLine({ status: 'Cancelled' }), false);
    assert.equal(isDispatchedLine({ status: 'PO Received' }), false);
  });
});
