/**
 * Concurrent amendments to a committed booking.
 *
 * WHY THIS NEEDS A REPLICA SET.
 *
 * `updateBookingItems` runs inside `runInTransaction`, which on a standalone
 * server silently takes its "no transaction" fallback. Every other test in this
 * area therefore exercises the UNPROTECTED path, which is fine for arithmetic
 * and useless for this question: the requirement is that two simultaneous
 * edits cannot both take the same stock, and that is precisely what the
 * transaction and the guarded `$inc` exist to prevent. A single-node replica
 * set is the path production takes on Atlas.
 *
 * WHAT "CORRECT" MEANS HERE.
 *
 * Not "both succeed" and not "one fails". Either outcome is acceptable — a
 * write conflict is retried, and a genuine shortfall is refused — but in BOTH
 * cases inventory must agree with the booking afterwards:
 *
 *     availableForSale + bookedQuantity === totalAvailableQuantity
 *     units consumed by the booking === what its lines say they hold
 *
 * These tests assert the reconciliation, not the race's winner.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});

const { default: Order } = await import('../models/Order.js');
const { default: User } = await import('../models/User.js');
const { ProductKoken } = await import('../models/Product.js');
const { createReservation, confirmBooking } = await import('../modules/reservations/reservation.controller.js');
const { updateBookingItems, raisePo } = await import('../modules/sales/sales.controller.js');

before(async () => { await startTestReplSet(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

const SALES = { _id: new mongoose.Types.ObjectId(), role: 'Sales', email: 'desk@example.com' };

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  let err = null;
  await handler({ body: {}, params: {}, query: {}, headers: {}, ...req }, res, (e) => { err = e; });
  if (err) throw err;
  return res;
};

const customer = async () => (await User.create({
  email: 'buyer@example.com', password: 'x', user: 'Buyer', company: 'Buyer Co',
  role: 'Customer', brandAccess: { koken: true }, moqMode: 'NOT_APPLICABLE',
})).toObject();

const product = (stock) => ProductKoken.create({
  skuCode: `SKU-${Math.random().toString(36).slice(2, 8)}`,
  moq: 1, availableForSale: stock, totalAvailableQuantity: stock, bookedQuantity: 0,
});

const stockOf = async (id) => {
  const p = await ProductKoken.findById(id).lean();
  return { available: p.availableForSale, booked: p.bookedQuantity, total: p.totalAvailableQuantity };
};

const bookAndRaisePo = async (user, p, qty) => {
  await call(createReservation, { user, body: { productId: String(p._id), quantity: qty } });
  await call(confirmBooking, { user });
  const orderId = (await Order.findOne({}).lean()).orderId;
  await call(raisePo, { user: SALES, params: { orderId }, body: {} });
  return { orderId, line: await Order.findOne({ orderId }).lean() };
};

/**
 * The booking and the stock, reconciled.
 *
 * `onHand` is what the SKU started with. A committed booking's units have left
 * inventory, so the totals must have dropped by exactly what the booking's
 * lines now claim to hold — no more, and no less.
 */
const assertReconciled = async (orderId, p, onHand, label) => {
  const rows = await Order.find({ orderId, skuCode: p.skuCode }).lean();
  const held = rows.reduce((n, r) => n + (r.confirmedQty || 0), 0);
  const stock = await stockOf(p._id);

  assert.equal(stock.available + stock.booked, stock.total, `${label}: the invariant holds`);
  assert.equal(stock.total, onHand - held, `${label}: ${held} consumed from ${onHand}`);
  assert.equal(stock.available, onHand - held, `${label}: availability agrees`);
};

/** Resolve to a plain result whichever way the handler answered. */
const attempt = (fn) => fn().then(
  (res) => ({ ok: res.statusCode < 300, status: res.statusCode, message: res.payload?.message ?? null }),
  (err) => ({ ok: false, status: err.status ?? 500, message: err.message }),
);

describe('two amendments at once', () => {
  test('both raise the same line: the booking and inventory still agree', async () => {
    const user = await customer();
    const p = await product(200);
    const { orderId, line } = await bookAndRaisePo(user, p, 10);
    const id = String(line._id);

    const results = await Promise.all([
      attempt(() => call(updateBookingItems, {
        user: SALES, params: { orderId }, body: { lines: [{ id, skuCode: p.skuCode, quantity: 40 }] },
      })),
      attempt(() => call(updateBookingItems, {
        user: SALES, params: { orderId }, body: { lines: [{ id, skuCode: p.skuCode, quantity: 70 }] },
      })),
    ]);

    assert.ok(results.some((r) => r.ok), `at least one must land: ${JSON.stringify(results)}`);
    // Whatever landed last is what the line holds, and inventory must match it
    // — never the sum of the two, which is the double-deduction being guarded.
    const final = await Order.findById(id).lean();
    assert.ok([10, 40, 70].includes(final.confirmedQty), `unexpected quantity ${final.confirmedQty}`);
    await assertReconciled(orderId, p, 200, 'after two concurrent increases');
  });

  test('one raises while the other lowers: no units are invented or lost', async () => {
    const user = await customer();
    const p = await product(200);
    const { orderId, line } = await bookAndRaisePo(user, p, 50);
    const id = String(line._id);

    await Promise.all([
      attempt(() => call(updateBookingItems, {
        user: SALES, params: { orderId }, body: { lines: [{ id, skuCode: p.skuCode, quantity: 80 }] },
      })),
      attempt(() => call(updateBookingItems, {
        user: SALES, params: { orderId }, body: { lines: [{ id, skuCode: p.skuCode, quantity: 20 }] },
      })),
    ]);

    await assertReconciled(orderId, p, 200, 'after a concurrent increase and decrease');
  });

  test('two bookings compete for the last units: the SKU is never oversold', async () => {
    const user = await customer();
    // 30 on hand. Each booking holds 10, then both try to take the remaining 10
    // on top — only one can have it.
    const p = await product(30);

    const first = await bookAndRaisePo(user, p, 10);
    await call(createReservation, { user, body: { productId: String(p._id), quantity: 10 } });
    await call(confirmBooking, { user });
    const secondId = (await Order.find({}).sort({ _id: -1 }).limit(1).lean())[0].orderId;
    await call(raisePo, { user: SALES, params: { orderId: secondId }, body: {} });
    const secondLine = await Order.findOne({ orderId: secondId }).lean();

    assert.deepEqual(await stockOf(p._id), { available: 10, booked: 0, total: 10 }, '20 consumed, 10 left');

    const results = await Promise.all([
      attempt(() => call(updateBookingItems, {
        user: SALES, params: { orderId: first.orderId },
        body: { lines: [{ id: String(first.line._id), skuCode: p.skuCode, quantity: 20 }] },
      })),
      attempt(() => call(updateBookingItems, {
        user: SALES, params: { orderId: secondId },
        body: { lines: [{ id: String(secondLine._id), skuCode: p.skuCode, quantity: 20 }] },
      })),
    ]);

    const landed = results.filter((r) => r.ok);
    assert.equal(landed.length, 1, `exactly one may take the last 10: ${JSON.stringify(results)}`);
    assert.match(results.find((r) => !r.ok).message, /Not enough stock/);

    const stock = await stockOf(p._id);
    assert.equal(stock.available + stock.booked, stock.total, 'the invariant holds');
    assert.equal(stock.available, 0, 'the last units went to exactly one booking');

    const held = (await Order.find({ skuCode: p.skuCode }).lean())
      .reduce((n, r) => n + (r.confirmedQty || 0), 0);
    assert.equal(held, 30, 'the two bookings together hold what left inventory');
  });

  test('an amendment racing a cancellation leaves one consistent outcome', async () => {
    const { cancelBooking } = await import('../modules/orders/order.controller.js');
    const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', email: 'a@x.com', permissions: ['*'] };

    const user = await customer();
    const p = await product(100);
    const { orderId, line } = await bookAndRaisePo(user, p, 20);

    await Promise.all([
      attempt(() => call(updateBookingItems, {
        user: SALES, params: { orderId },
        body: { lines: [{ id: String(line._id), skuCode: p.skuCode, quantity: 40 }] },
      })),
      attempt(() => call(cancelBooking, { user: ADMIN, params: { orderId } })),
    ]);

    const rows = await Order.find({ orderId }).lean();
    const stock = await stockOf(p._id);
    assert.equal(stock.available + stock.booked, stock.total, 'the invariant holds');

    if (rows.every((r) => r.status === 'Cancelled')) {
      // The cancellation won: every unit is back, however big the line had
      // become in the meantime.
      assert.deepEqual(stock, { available: 100, booked: 0, total: 100 }, 'cancelled: all units returned');
    } else {
      const held = rows.reduce((n, r) => n + (r.confirmedQty || 0), 0);
      assert.equal(stock.total, 100 - held, 'live: inventory matches what the lines hold');
    }
  });
});
