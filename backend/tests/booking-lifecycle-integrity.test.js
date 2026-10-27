/**
 * Booking lifecycle integrity: confirmation, cancellation, 7-day expiry and PO
 * raising, against a REAL TRANSACTIONAL database (a replica set).
 *
 * Every stock-moving workflow runs in a MongoDB transaction, but the default
 * test server has none, so until now every test exercised only the fallback.
 * These run the real path: commit, abort, retry.
 *
 * The invariant checked throughout, per product:
 *     availableForSale + bookedQuantity === totalAvailableQuantity
 * and no unit is released, reserved or consumed twice.
 *
 * Root cause these pin (reproduced before the fix): a bulk booking ran every
 * row in one transaction AND posted each row to the stock ledger in a separate
 * transaction while it was open. A long sheet outlived MongoDB's 60-second
 * transaction limit and failed with "Transaction with { txnNumber: N } has been
 * aborted." — and the ledger postings survived the rollback. Concurrent
 * bookings of one SKU failed outright with WriteConflict, never retried.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
const sent = [];
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async (to, subject) => { sent.push({ to, subject }); return true; } },
});

const { default: Order } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: User } = await import('../models/User.js');
const { default: Location } = await import('../models/Location.js');
const { default: StockBatch } = await import('../models/StockBatch.js');
const { default: AuditLog } = await import('../models/AuditLog.js');
const { ProductKoken, ProductBIX, ProductIMADA } = await import('../models/Product.js');
const { createReservation, confirmBooking, createDirectBooking } = await import('../modules/reservations/reservation.controller.js');
const { cancelBooking, updateOrderPO } = await import('../modules/orders/order.controller.js');
const { runPoSettlement } = await import('../modules/orders/poExpiryJob.js');
const { runReservationExpiryChecks } = await import('../modules/reservations/reservationExpiryJob.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');

before(async () => { await startTestReplSet(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => {
  await clearCollections();
  sent.length = 0;
  // The ledger needs a stock location to post to.
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
});

/** Call a handler; errors go through the real error handler, as in the app. */
const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const full = { body: {}, params: {}, headers: {}, method: 'POST', originalUrl: '/test', ...req };
  let err = null;
  await handler(full, res, (e) => { err = e; });
  if (err) errorHandler(err, full, res, () => {});
  return res;
};

let seq = 0;
const customer = async (over = {}) => (await User.create({
  email: `buyer${++seq}@example.com`,
  password: 'x',
  user: `Buyer ${seq}`,
  company: 'Buyer Co',
  role: 'Customer',
  brandAccess: { koken: true, bix: true, imada: true },
  moq: 'SKIP',
  ...over,
})).toObject();
const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', permissions: ['*'], email: 'desk@example.com' };

const product = (Model, skuCode, units) => Model.create({
  skuCode, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0,
});
const stock = async (p) => {
  const x = await p.constructor.findById(p._id).lean();
  assert.equal(x.availableForSale + x.bookedQuantity, x.totalAvailableQuantity, `invariant broken on ${x.skuCode}`);
  return { available: x.availableForSale, booked: x.bookedQuantity, total: x.totalAvailableQuantity };
};

/** A direct (bulk-upload style) booking. Returns the response. */
const bulk = (user, lines) => call(createDirectBooking, {
  user, body: { items: lines.map(([p, quantity]) => ({ productId: String(p._id), quantity })) },
});
const bookingIdOf = (res) => res.payload?.data?.orderId;

/** Move a booking's date back, as if it was placed `days` ago. */
const age = (orderId, days) => Order.updateMany(
  { orderId },
  { $set: { date: new Date(Date.now() - days * 864e5) } },
);

// ─────────────────────────────────────────────────────────────────────────────

describe('confirmation', () => {
  test('1. a confirmed booking holds its stock, and the ledger is posted after the commit', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-1', 10);
    await call(createReservation, { user, body: { productId: String(p._id), quantity: 4 } });

    const res = await call(confirmBooking, { user });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(await stock(p), { available: 6, booked: 4, total: 10 });
    assert.equal(await Order.countDocuments(), 1);
    assert.equal(await StockBatch.countDocuments({ referenceId: bookingIdOf(res) }), 1);
    assert.equal(await AuditLog.countDocuments({ action: 'Reservation Confirmed' }), 1);
  });

  test('9. a failure mid-transaction rolls everything back — stock, reservations, ledger, audit', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-9', 10);
    await call(createReservation, { user, body: { productId: String(p._id), quantity: 4 } });

    // Fail the LAST write, after stock has been deducted and reservations moved.
    const real = Order.insertMany;
    Order.insertMany = async () => { throw new Error('disk on fire'); };
    try {
      const res = await call(confirmBooking, { user });
      assert.equal(res.statusCode, 500);
      assert.equal(res.payload.success, false);
    } finally {
      Order.insertMany = real;
    }

    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 }, 'stock rolled back');
    assert.equal(await Order.countDocuments(), 0);
    const r = await Reservation.findOne({}).lean();
    assert.equal(r.status, 'Reserved', 'still in the selection list');
    assert.equal(await StockBatch.countDocuments(), 0, 'no ledger entry for a booking that never happened');
    assert.equal(await AuditLog.countDocuments({ action: 'Reservation Confirmed' }), 0);
  });

  test('10. a bulk booking with one invalid row books nothing', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-10', 10);
    const res = await call(createDirectBooking, {
      user,
      body: { items: [{ productId: String(p._id), quantity: 2 }, { productId: String(new mongoose.Types.ObjectId()), quantity: 1 }] },
    });
    assert.notEqual(res.statusCode, 201);
    assert.equal(res.payload.success, false);
    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
    assert.equal(await Order.countDocuments(), 0);
    assert.equal(await Reservation.countDocuments(), 0);
    assert.equal(await StockBatch.countDocuments(), 0);
  });

  test('11. concurrent bookings of the same SKU all succeed, and stock adds up', async () => {
    const user = await customer();
    const a = await product(ProductKoken, 'K-11A', 100);
    const b = await product(ProductKoken, 'K-11B', 100);
    // Opposite line order on alternate requests: the worst case for conflicts.
    const runs = await Promise.all([0, 1, 2, 3, 4].map((i) => bulk(user, i % 2 ? [[a, 1], [b, 1]] : [[b, 1], [a, 1]])));
    assert.deepEqual(runs.map((r) => r.statusCode), [201, 201, 201, 201, 201]);
    assert.deepEqual(await stock(a), { available: 95, booked: 5, total: 100 });
    assert.deepEqual(await stock(b), { available: 95, booked: 5, total: 100 });
    assert.equal(new Set(runs.map(bookingIdOf)).size, 5, 'five distinct bookings');
  });

  test('a transaction failure is reported plainly, without database internals', async () => {
    const res = { statusCode: 200, payload: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.payload = b; return res; };
    const err = Object.assign(new Error('Transaction with { txnNumber: 1 } has been aborted.'), {
      name: 'MongoServerError', code: 251, codeName: 'NoSuchTransaction',
    });
    errorHandler(err, {}, res, () => {});
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.message, /nothing was saved/i);
    assert.doesNotMatch(res.payload.message, /txnNumber/);
  });
});

describe('cancellation', () => {
  test('2. cancelling releases every reserved unit and records when and why', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-2', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));

    const res = await call(cancelBooking, { user: ADMIN, params: { orderId: id }, body: { reason: 'Ordered twice' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
    const row = await Order.findOne({ orderId: id }).lean();
    assert.equal(row.status, 'Cancelled');
    assert.equal(row.stockState, 'released');
    assert.ok(row.cancelledAt);
    assert.equal(row.cancellationReason, 'Ordered twice');
  });

  test('3. cancelling twice — even at the same instant — releases once', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-3', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));

    const [a, b] = await Promise.all([
      call(cancelBooking, { user: ADMIN, params: { orderId: id } }),
      call(cancelBooking, { user: ADMIN, params: { orderId: id } }),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
    assert.equal((await call(cancelBooking, { user: ADMIN, params: { orderId: id } })).statusCode, 409);
  });

  test('a part-confirmed booking releases only what it held', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-4', 3);
    const id = bookingIdOf(await bulk(user, [[p, 5]])); // 3 booked, 2 on indent
    assert.deepEqual(await stock(p), { available: 0, booked: 3, total: 3 });
    await call(cancelBooking, { user: ADMIN, params: { orderId: id } });
    assert.deepEqual(await stock(p), { available: 3, booked: 0, total: 3 });
  });

  test('12. stock comes back correctly for all three brands', async () => {
    const user = await customer();
    const k = await product(ProductKoken, 'SAME-SKU', 10);
    const x = await product(ProductBIX, 'BIX-1', 10);
    const i = await product(ProductIMADA, 'IMA-1', 10);
    const id = bookingIdOf(await bulk(user, [[k, 2], [x, 3], [i, 4]]));
    assert.deepEqual(await stock(x), { available: 7, booked: 3, total: 10 });

    await call(cancelBooking, { user: ADMIN, params: { orderId: id } });
    for (const p of [k, x, i]) assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
  });

  test('a booking whose PO was raised can be cancelled: its units go back into inventory', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-5', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));
    await call(updateOrderPO, { user: ADMIN, params: { orderId: id }, body: { poNumber: 'PO-1' } });
    assert.deepEqual(await stock(p), { available: 6, booked: 0, total: 6 }, 'consumed');

    assert.equal((await call(cancelBooking, { user: ADMIN, params: { orderId: id } })).statusCode, 200);
    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 }, 'all 4 back on the shelf');
    const row = await Order.findOne({ orderId: id }).lean();
    assert.equal(row.status, 'Cancelled');
    assert.equal(row.stockState, 'released');
  });

  test('a delivered booking can be cancelled too, and only once', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-5D', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));
    await call(updateOrderPO, { user: ADMIN, params: { orderId: id }, body: { poNumber: 'PO-D' } });
    await Order.updateMany({ orderId: id }, { $set: { status: 'Delivered' } });

    const [a, b] = await Promise.all([
      call(cancelBooking, { user: ADMIN, params: { orderId: id } }),
      call(cancelBooking, { user: ADMIN, params: { orderId: id } }),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
  });
});

describe('7-day PO expiry', () => {
  test('4. after 7 days without a PO the booking is cancelled and its stock released', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-6', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));
    await age(id, 7.1);

    const out = await runPoSettlement();
    assert.equal(out.cancelled.length, 1);
    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
    const row = await Order.findOne({ orderId: id }).lean();
    assert.equal(row.status, 'Cancelled');
    assert.ok(row.autoCancelledAt && row.cancelledAt);
    assert.match(row.cancellationReason, /No PO raised within 7 days/);
    assert.ok(await AuditLog.findOne({ action: 'Booking Auto-Cancelled (No PO)' }));
  });

  test('elapsed time, not calendar days: 6.9 days is not yet due', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-7', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));
    await age(id, 6.9);
    const out = await runPoSettlement();
    assert.equal(out.cancelled.length, 0);
    assert.deepEqual(await stock(p), { available: 6, booked: 4, total: 10 });
  });

  test('5. a booking with a PO is never expired', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-8', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));
    await call(updateOrderPO, { user: ADMIN, params: { orderId: id }, body: { poNumber: 'PO-8' } });
    await age(id, 30);

    const out = await runPoSettlement();
    assert.equal(out.cancelled.length, 0);
    assert.equal((await Order.findOne({ orderId: id }).lean()).status, 'PO Received');
    assert.deepEqual(await stock(p), { available: 6, booked: 0, total: 6 });
  });

  test('6. cancelled and delivered bookings are left alone', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-12', 10);
    const cancelled = bookingIdOf(await bulk(user, [[p, 2]]));
    await call(cancelBooking, { user: ADMIN, params: { orderId: cancelled } });
    const delivered = bookingIdOf(await bulk(user, [[p, 3]]));
    await call(updateOrderPO, { user: ADMIN, params: { orderId: delivered }, body: { poNumber: 'PO-12' } });
    await Order.updateMany({ orderId: delivered }, { $set: { status: 'Delivered' } });
    await age(cancelled, 30);
    await age(delivered, 30);
    const before = await stock(p);

    const out = await runPoSettlement();
    assert.equal(out.cancelled.length, 0);
    assert.deepEqual(await stock(p), before);
    assert.equal((await Order.findOne({ orderId: delivered }).lean()).status, 'Delivered');
  });

  test('7. staff cancelling as the job expires the booking: released once', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-13', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));
    await age(id, 8);

    await Promise.all([runPoSettlement(), call(cancelBooking, { user: ADMIN, params: { orderId: id } })]);
    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
    assert.equal((await Order.findOne({ orderId: id }).lean()).status, 'Cancelled');
  });

  test('8. a PO raised as the job expires the booking: one wins, stock is right either way', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-14', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));
    await age(id, 8);

    const [, po] = await Promise.all([
      runPoSettlement(),
      call(updateOrderPO, { user: ADMIN, params: { orderId: id }, body: { poNumber: 'PO-14' } }),
    ]);
    const row = await Order.findOne({ orderId: id }).lean();
    if (po.statusCode === 200) {
      // The PO won: consumed, not cancelled.
      assert.notEqual(row.status, 'Cancelled');
      assert.equal(row.stockState, 'consumed');
      assert.deepEqual(await stock(p), { available: 6, booked: 0, total: 6 });
    } else {
      // The expiry won: released, and the PO was refused.
      assert.equal(po.statusCode, 409);
      assert.equal(row.status, 'Cancelled');
      assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
    }
  });

  test('13a. two runs of the job at once release once', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-15', 10);
    const id = bookingIdOf(await bulk(user, [[p, 4]]));
    await age(id, 8);

    await Promise.all([runPoSettlement(), runPoSettlement()]);
    await runPoSettlement();
    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
    assert.equal(await AuditLog.countDocuments({ action: 'Booking Auto-Cancelled (No PO)' }), 1);
  });
});

describe('selection-list reminders', () => {
  test('13b. the day-5 and last-day reminders are each sent once, however often the job runs', async () => {
    const user = await customer();
    const p = await product(ProductKoken, 'K-16', 10);
    await call(createReservation, { user, body: { productId: String(p._id), quantity: 1 } });
    await Reservation.updateMany({}, { $set: { reservationDate: new Date(Date.now() - 5.2 * 864e5) } });

    await Promise.all([runReservationExpiryChecks(), runReservationExpiryChecks()]);
    await runReservationExpiryChecks();
    assert.equal(sent.filter((m) => /Awaiting Confirmation/.test(m.subject)).length, 1, 'day 5, once');

    await Reservation.updateMany({}, { $set: { reservationDate: new Date(Date.now() - 6.2 * 864e5) } });
    await Promise.all([runReservationExpiryChecks(), runReservationExpiryChecks()]);
    assert.equal(sent.filter((m) => /Final Reminder/.test(m.subject)).length, 1, 'last day, once');

    // No stock is held by an unconfirmed selection-list item.
    assert.deepEqual(await stock(p), { available: 10, booked: 0, total: 10 });
  });
});

const { default: StockBalance } = await import('../models/StockBalance.js');
const { processAvailableIndents } = await import('../modules/inventory/indentAvailability.service.js');

describe('stock reserved against an indent', () => {
  /** What the allocator reads: free stock per SKU, as the balance projection holds it. */
  const freeIs = async (p, units) => {
    await StockBalance.deleteMany({ skuCode: p.skuCode });
    await StockBalance.create({
      skuCode: p.skuCode, brand: 'Koken', location: new mongoose.Types.ObjectId(),
      locationCode: 'MAIN', onHand: units, reserved: 0,
    });
  };
  const arrive = async (p, units) => {
    await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: units, totalAvailableQuantity: units } });
    await freeIs(p, units);
    await processAvailableIndents([p.skuCode]);
  };

  test('cancelling a booking releases its inward allocation too, records it, and the next indent can have the stock', async () => {
    const a = await customer();
    const b = await customer();
    const p = await product(ProductKoken, 'K-IND', 3);

    const idA = bookingIdOf(await bulk(a, [[p, 5]])); // 3 booked, PI-A waits for 2
    await Reservation.updateMany({ customerId: a._id }, { $set: { reservationDate: new Date(Date.now() - 5 * 864e5) } });
    await bulk(b, [[p, 4]]); // nothing in stock: PI-B waits for 4

    await arrive(p, 2); // oldest first: PI-A gets the 2, as inward allocation 1
    let row = await Order.findOne({ orderId: idA }).lean();
    assert.equal(row.confirmedQty, 5);
    assert.deepEqual(row.allocations.map((x) => [x.quantity, x.status]), [[2, 'PO Received']]);
    assert.deepEqual(await stock(p), { available: 0, booked: 5, total: 5 });

    const res = await call(cancelBooking, { user: ADMIN, params: { orderId: idA }, body: { reason: 'No longer needed' } });
    assert.equal(res.statusCode, 200);

    // All 5 released — the 3 booked at the start and the 2 allocated from the
    // indent — and the cancellation hands them straight to the existing FIFO
    // allocator: PI-B, next in line, takes its 4, leaving 1 free.
    assert.deepEqual(await stock(p), { available: 1, booked: 4, total: 5 });
    const bRows = await Order.find({ user: b._id }).lean();
    assert.equal(bRows.reduce((n, r) => n + r.confirmedQty, 0), 4, 'PI-B got its 4 from the released stock');
    row = await Order.findOne({ orderId: idA }).lean();
    assert.equal(row.status, 'Cancelled');
    assert.equal(row.allocations[0].status, 'Cancelled', 'the allocation record says it was released');
    assert.ok(row.allocations[0].statusAt);

    const audit = await AuditLog.findOne({ action: 'Booking Cancelled' }).lean();
    assert.equal(audit.meta.reason, 'No longer needed');
    assert.ok(audit.meta.releasedAt);
    assert.deepEqual(audit.meta.indents, [
      { skuCode: 'K-IND', indentNumber: idA.replace(/^BO-/, 'PI-'), allocation: 1, quantity: 2 },
    ]);

  });

  test('a PO expiry releases an indent allocation the same way, once', async () => {
    const a = await customer();
    const p = await product(ProductKoken, 'K-IND2', 1);
    const id = bookingIdOf(await bulk(a, [[p, 4]])); // 1 booked, 3 on indent
    await arrive(p, 3);
    assert.deepEqual((await Order.findOne({ orderId: id }).lean()).allocations.map((x) => x.quantity), [3]);
    await freeIs(p, 0);
    await age(id, 8);

    await Promise.all([runPoSettlement(), runPoSettlement()]);
    assert.deepEqual(await stock(p), { available: 4, booked: 0, total: 4 });
    const row = await Order.findOne({ orderId: id }).lean();
    assert.equal(row.allocations[0].status, 'Cancelled');
    const audit = await AuditLog.findOne({ action: 'Booking Auto-Cancelled (No PO)' }).lean();
    assert.match(audit.meta.reason, /No PO raised within 7 days/);
    assert.equal(audit.meta.indents[0].quantity, 3);
    assert.equal(await AuditLog.countDocuments({ action: 'Booking Auto-Cancelled (No PO)' }), 1);
  });
});

describe("a cancelled or expired booking's open indent", () => {
  test('closes with the booking when the PO deadline passes', async () => {
    const a = await customer();
    const p = await product(ProductKoken, 'K-EXP-IND', 1);
    const id = bookingIdOf(await bulk(a, [[p, 4]])); // 1 booked, 3 on indent
    await age(id, 8);

    await runPoSettlement();

    const indent = await Reservation.findOne({ indentNumber: id.replace(/^BO-/, 'PI-') }).lean();
    assert.equal(indent.status, 'Cancelled');
    assert.match(indent.cancellationReason, /expired: no PO raised within 7 days/);
    const audit = await AuditLog.findOne({ action: 'Booking Auto-Cancelled (No PO)' }).lean();
    assert.deepEqual(audit.meta.indentsClosed, [{ skuCode: 'K-EXP-IND', indentNumber: indent.indentNumber, quantity: 3 }]);
    assert.deepEqual(await stock(p), { available: 1, booked: 0, total: 1 }, 'only the booked unit moved');
  });

  test('is never assigned stock afterwards', async () => {
    const a = await customer();
    const p = await product(ProductKoken, 'K-CAN-IND', 1);
    const id = bookingIdOf(await bulk(a, [[p, 4]]));
    await call(cancelBooking, { user: ADMIN, params: { orderId: id } });

    await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: 10, totalAvailableQuantity: 10 } });
    await StockBalance.deleteMany({ skuCode: p.skuCode });
    await StockBalance.create({ skuCode: p.skuCode, brand: 'Koken', location: new mongoose.Types.ObjectId(), locationCode: 'MAIN', onHand: 11, reserved: 0 });
    await processAvailableIndents([p.skuCode]);

    assert.equal(await Order.countDocuments({ user: a._id, status: { $ne: 'Cancelled' } }), 0, 'no new booking for a customer who cancelled');
  });
});

describe("a cancelled booking never keeps an open indent", () => {
  const indentOf = (id) => Reservation.find({ indentNumber: id.replace(/^BO-/, 'PI-') }).lean();

  test('cancelling after the PO is raised cancels the indent too', async () => {
    const a = await customer();
    const p = await product(ProductKoken, 'K-IND-PO', 2);
    const id = bookingIdOf(await bulk(a, [[p, 5]])); // 2 booked, 3 on indent
    await call(updateOrderPO, { user: ADMIN, params: { orderId: id }, body: { poNumber: 'PO-X' } });

    const res = await call(cancelBooking, { user: ADMIN, params: { orderId: id } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((await indentOf(id)).map((r) => r.status), ['Cancelled']);
  });

  test('the status route cannot cancel — only "Cancel booking" can', async () => {
    const { applyBookingStatus } = await import('../modules/orders/bookingStatus.service.js');
    const a = await customer();
    const p = await product(ProductKoken, 'K-IND-ST', 2);
    const id = bookingIdOf(await bulk(a, [[p, 5]]));

    const out = await applyBookingStatus({ orderId: id, status: 'Cancelled', actor: ADMIN });
    assert.equal(out.ok, false);
    assert.match(out.message, /Cancel booking/);
    assert.equal((await Order.findOne({ orderId: id }).lean()).status, 'PO Received', 'nothing changed');
    assert.deepEqual((await indentOf(id)).map((r) => r.status), ['Partially Confirmed'], 'the indent is still open');
  });

  test('an older cancelled booking with its indent still open gets it cancelled', async () => {
    const a = await customer();
    const p = await product(ProductKoken, 'K-IND-OLD', 2);
    const id = bookingIdOf(await bulk(a, [[p, 5]]));
    // As it was before the rule: booking cancelled, indent left open.
    await Order.updateMany({ orderId: id }, { $set: { status: 'Cancelled', stockState: 'released' } });

    const res = await call(cancelBooking, { user: ADMIN, params: { orderId: id } });
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.message, /indent .* has now been cancelled too/);
    assert.deepEqual((await indentOf(id)).map((r) => r.status), ['Cancelled']);
  });
});
