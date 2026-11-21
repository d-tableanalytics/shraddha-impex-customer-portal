/**
 * Amending a booking after its PO has been raised.
 *
 * TWO THINGS ARE UNDER TEST, AND THE SECOND IS THE IMPORTANT ONE.
 *
 * 1. WHO may do it. Sales holds `amend_booking_post_po`, which reopens the
 *    booking's ITEMS and nothing else; Admin holds `override_po_lock`, which
 *    reopens everything; a Customer holds neither. And nobody at all may amend
 *    a booking whose goods have left — dispatched, delivered or cancelled.
 *
 * 2. WHAT IT DOES TO INVENTORY. Once the PO is raised a line's units have been
 *    CONSUMED: they are gone from `availableForSale` and from
 *    `totalAvailableQuantity` alike. Every assertion below therefore checks all
 *    three counters, because the invariant
 *
 *        availableForSale + bookedQuantity === totalAvailableQuantity
 *
 *    is what "the same stock is never reserved or deducted twice" actually
 *    means, and a test that checked only `availableForSale` would pass while
 *    the grand total drifted.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});

const { default: Order } = await import('../models/Order.js');
const { default: User } = await import('../models/User.js');
const { default: AuditLog } = await import('../models/AuditLog.js');
const { ProductKoken } = await import('../models/Product.js');
const { createReservation, confirmBooking } = await import('../modules/reservations/reservation.controller.js');
const { updateBookingItems, raisePo } = await import('../modules/sales/sales.controller.js');
const { updateBookingStatus, cancelBooking } = await import('../modules/orders/order.controller.js');
const { AMENDABLE_STATUSES, amendmentBlockedBecause, canAmendLockedItems } = await import('../utils/bookingLock.js');

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', email: 'admin@example.com', permissions: ['*'] };
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
  role: 'Customer', brandAccess: { koken: true },
  // MOQ is tested in customer-moq.test.js; it is out of the way here so the
  // quantities below can be whatever the inventory arithmetic needs.
  moqMode: 'NOT_APPLICABLE',
})).toObject();

const product = (stock) => ProductKoken.create({
  skuCode: `SKU-${Math.random().toString(36).slice(2, 8)}`,
  moq: 1, availableForSale: stock, totalAvailableQuantity: stock, bookedQuantity: 0,
});

const stockOf = async (id) => {
  const p = await ProductKoken.findById(id).lean();
  return { available: p.availableForSale, booked: p.bookedQuantity, total: p.totalAvailableQuantity };
};

/** The invariant every assertion here depends on. */
const assertConsistent = async (id, label) => {
  const s = await stockOf(id);
  assert.equal(s.available + s.booked, s.total, `${label}: available + booked === total`);
};

/** Cart → confirm → PO. Returns { orderId, lines }. */
const bookAndRaisePo = async (user, items) => {
  for (const [p, qty] of items) {
    await call(createReservation, { user, body: { productId: String(p._id), quantity: qty } });
  }
  const confirmed = await call(confirmBooking, { user });
  assert.equal(confirmed.statusCode < 300, true, JSON.stringify(confirmed.payload));
  const orderId = (await Order.findOne({}).lean()).orderId;

  const po = await call(raisePo, { user: SALES, params: { orderId }, body: {} });
  assert.equal(po.statusCode < 300, true, JSON.stringify(po.payload));
  return { orderId, lines: await Order.find({ orderId }).sort({ lineSeq: 1 }).lean() };
};

const asLines = (rows) => rows.map((r) => ({
  id: String(r._id), skuCode: r.skuCode, quantity: (r.confirmedQty || 0) + (r.pendingQty || 0),
}));

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

describe('who may amend a committed booking', () => {
  test('Sales can, through amend_booking_post_po and not through the lock override', async () => {
    assert.equal(canAmendLockedItems(SALES), true);
    assert.equal(canAmendLockedItems(ADMIN), true);
    assert.equal(canAmendLockedItems({ role: 'Customer' }), false);
    assert.equal(canAmendLockedItems({ role: 'Warehouse User' }), false);
  });

  test('a customer is refused on their own committed booking, and no stock moves', async () => {
    const user = await customer();
    const p = await product(100);
    const { orderId, lines } = await bookAndRaisePo(user, [[p, 10]]);
    const before = await stockOf(p._id);

    const res = await call(updateBookingItems, {
      user, params: { orderId },
      body: { lines: [{ id: String(lines[0]._id), skuCode: p.skuCode, quantity: 20 }] },
    });
    assert.equal(res.statusCode, 423, 'Locked, not a bare 403');
    assert.deepEqual(await stockOf(p._id), before);
  });

  test('Sales still cannot raise a second PO over the first', async () => {
    const user = await customer();
    const p = await product(100);
    const { orderId } = await bookAndRaisePo(user, [[p, 10]]);

    const res = await call(raisePo, { user: SALES, params: { orderId }, body: { poNumber: 'PO-OVERWRITE' } });
    assert.equal(res.statusCode, 423, 'the narrow key does not reopen the PO itself');
    assert.equal((await Order.findOne({ orderId }).lean()).poNumber !== 'PO-OVERWRITE', true);
  });
});

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------

describe('order status bounds the amendment', () => {
  test('the amendable set is the stages before dispatch', () => {
    assert.deepEqual(AMENDABLE_STATUSES, ['PO Received', 'Booked', 'Ready for Dispatch']);
    assert.equal(amendmentBlockedBecause([{ status: 'PO Received' }]), null);
    assert.equal(amendmentBlockedBecause([{ status: 'Ready for Dispatch' }]), null);
    assert.match(amendmentBlockedBecause([{ status: 'Dispatched' }]), /dispatched/);
    assert.match(amendmentBlockedBecause([{ status: 'Delivered' }]), /delivered/);
    assert.match(amendmentBlockedBecause([{ status: 'Cancelled' }]), /cancelled/);
  });

  test('one open line keeps the booking amendable even with a cancelled line beside it', () => {
    assert.equal(
      amendmentBlockedBecause([{ status: 'Cancelled' }, { status: 'PO Received' }]),
      null,
    );
  });

  test('a dispatched booking is closed to Sales AND to the wildcard', async () => {
    const user = await customer();
    const p = await product(100);
    const { orderId, lines } = await bookAndRaisePo(user, [[p, 10]]);
    await call(updateBookingStatus, { user: ADMIN, params: { orderId }, body: { status: 'Dispatched' } });
    const before = await stockOf(p._id);

    for (const actor of [SALES, ADMIN]) {
      const res = await call(updateBookingItems, {
        user: actor, params: { orderId },
        body: { lines: [{ id: String(lines[0]._id), skuCode: p.skuCode, quantity: 20 }] },
      });
      assert.equal(res.statusCode, 409, `${actor.role} is refused`);
      assert.match(res.payload.message, /no longer be changed/);
    }
    assert.deepEqual(await stockOf(p._id), before, 'nothing moved');
  });

  test('a cancelled booking is closed, and its released stock is not released again', async () => {
    const user = await customer();
    const p = await product(100);
    const { orderId, lines } = await bookAndRaisePo(user, [[p, 10]]);
    await call(cancelBooking, { user: ADMIN, params: { orderId } });
    const afterCancel = await stockOf(p._id);
    assert.deepEqual(afterCancel, { available: 100, booked: 0, total: 100 }, 'all 10 came back');

    const res = await call(updateBookingItems, {
      user: ADMIN, params: { orderId },
      body: { lines: [{ id: String(lines[0]._id), skuCode: p.skuCode, quantity: 5 }] },
    });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(await stockOf(p._id), afterCancel, 'no second release');
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe('inventory after a post-PO amendment', () => {
  test('raising a quantity takes ONLY the additional units', async () => {
    const user = await customer();
    const p = await product(100);
    const { orderId, lines } = await bookAndRaisePo(user, [[p, 10]]);
    assert.deepEqual(await stockOf(p._id), { available: 90, booked: 0, total: 90 }, 'PO consumed 10');

    const res = await call(updateBookingItems, {
      user: SALES, params: { orderId },
      body: { lines: [{ id: String(lines[0]._id), skuCode: p.skuCode, quantity: 25 }] },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));

    // 15 more units consumed, not 25.
    assert.deepEqual(await stockOf(p._id), { available: 75, booked: 0, total: 75 });
    await assertConsistent(p._id, 'after increase');
    assert.equal((await Order.findById(lines[0]._id).lean()).confirmedQty, 25);
  });

  test('lowering a quantity gives back ONLY the excess', async () => {
    const user = await customer();
    const p = await product(100);
    const { orderId, lines } = await bookAndRaisePo(user, [[p, 25]]);
    assert.deepEqual(await stockOf(p._id), { available: 75, booked: 0, total: 75 });

    await call(updateBookingItems, {
      user: SALES, params: { orderId },
      body: { lines: [{ id: String(lines[0]._id), skuCode: p.skuCode, quantity: 10 }] },
    });

    assert.deepEqual(await stockOf(p._id), { available: 90, booked: 0, total: 90 }, '15 returned');
    await assertConsistent(p._id, 'after decrease');
    assert.equal((await Order.findById(lines[0]._id).lean()).confirmedQty, 10);
  });

  test('adding a product consumes its quantity and leaves the other lines alone', async () => {
    const user = await customer();
    const a = await product(100);
    const b = await product(50);
    const { orderId, lines } = await bookAndRaisePo(user, [[a, 10]]);

    const res = await call(updateBookingItems, {
      user: SALES, params: { orderId },
      body: { lines: [...asLines(lines), { skuCode: b.skuCode, quantity: 8 }] },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));

    assert.deepEqual(await stockOf(a._id), { available: 90, booked: 0, total: 90 }, 'untouched');
    assert.deepEqual(await stockOf(b._id), { available: 42, booked: 0, total: 42 }, 'consumed, not reserved');
    await assertConsistent(b._id, 'added line');

    const added = await Order.findOne({ orderId, skuCode: b.skuCode }).lean();
    assert.equal(added.confirmedQty, 8);
    assert.equal(added.stockState, 'consumed', 'matches the rest of a committed booking');
    assert.equal(added.bookedQty, 0, 'the customer never booked it — the desk added it');
    assert.equal(added.poNumber, lines[0].poNumber, 'it is on the same PO');
    assert.equal(added.poGeneratedAt?.getTime(), lines[0].poGeneratedAt?.getTime());
    assert.equal(added.status, lines[0].status);
  });

  test('cancelling a booking with a desk-added line returns its units ONCE', async () => {
    /*
     * THE REASON THE LINE ABOVE MUST SAY 'consumed'.
     *
     * The units were consumed when the line was added. If the row claimed to
     * be merely 'reserved', settlement would take the release branch and move
     * booked → available for units that were never booked — inventing stock
     * and breaking `available + booked === total`. This is that failure,
     * written as the outcome rather than as the field.
     */
    const user = await customer();
    const a = await product(100);
    const b = await product(50);
    const { orderId, lines } = await bookAndRaisePo(user, [[a, 10]]);

    await call(updateBookingItems, {
      user: SALES, params: { orderId },
      body: { lines: [...asLines(lines), { skuCode: b.skuCode, quantity: 8 }] },
    });
    assert.deepEqual(await stockOf(b._id), { available: 42, booked: 0, total: 42 });

    await call(cancelBooking, { user: ADMIN, params: { orderId } });

    assert.deepEqual(
      await stockOf(b._id),
      { available: 50, booked: 0, total: 50 },
      'the 8 came back, and no more than the 8',
    );
    await assertConsistent(b._id, 'after cancelling a booking with an added line');
    assert.deepEqual(await stockOf(a._id), { available: 100, booked: 0, total: 100 });
  });

  test('removing a line releases exactly its quantity, once', async () => {
    const user = await customer();
    const a = await product(100);
    const b = await product(50);
    const { orderId, lines } = await bookAndRaisePo(user, [[a, 10], [b, 8]]);
    assert.deepEqual(await stockOf(b._id), { available: 42, booked: 0, total: 42 });

    const keep = lines.filter((l) => l.skuCode === a.skuCode);
    await call(updateBookingItems, {
      user: SALES, params: { orderId }, body: { lines: asLines(keep) },
    });

    assert.deepEqual(await stockOf(b._id), { available: 50, booked: 0, total: 50 }, 'all 8 back');
    assert.deepEqual(await stockOf(a._id), { available: 90, booked: 0, total: 90 }, 'untouched');
    await assertConsistent(b._id, 'after removal');
    assert.equal(await Order.countDocuments({ orderId }), 1);
  });

  test('an increase beyond available stock is refused and nothing moves', async () => {
    const user = await customer();
    const p = await product(20);
    const { orderId, lines } = await bookAndRaisePo(user, [[p, 10]]);
    assert.deepEqual(await stockOf(p._id), { available: 10, booked: 0, total: 10 });

    const res = await call(updateBookingItems, {
      user: SALES, params: { orderId },
      body: { lines: [{ id: String(lines[0]._id), skuCode: p.skuCode, quantity: 100 }] },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.message, /Not enough stock/);

    assert.deepEqual(await stockOf(p._id), { available: 10, booked: 0, total: 10 }, 'unchanged');
    assert.equal((await Order.findById(lines[0]._id).lean()).confirmedQty, 10, 'the line is unchanged too');
  });

  test('a failed line in a multi-line save leaves the whole save undone', async () => {
    // Without a replica set there is no transaction, so this documents what the
    // code does on a standalone server: the refusal comes BEFORE the failing
    // line's own stock move, and the line is not written. The replica-set path
    // (runInTransaction) rolls the earlier lines back as well.
    const user = await customer();
    const a = await product(100);
    const b = await product(5);
    const { orderId, lines } = await bookAndRaisePo(user, [[a, 10]]);

    const res = await call(updateBookingItems, {
      user: SALES, params: { orderId },
      body: { lines: [...asLines(lines), { skuCode: b.skuCode, quantity: 99 }] },
    });
    assert.equal(res.statusCode, 409);

    assert.deepEqual(await stockOf(b._id), { available: 5, booked: 0, total: 5 }, 'nothing taken');
    await assertConsistent(b._id, 'after a refused add');
    assert.equal(await Order.countDocuments({ orderId, skuCode: b.skuCode }), 0, 'no orphan line');
  });

  test('a run of amendments leaves the counters exactly where the arithmetic says', async () => {
    const user = await customer();
    const p = await product(200);
    const { orderId, lines } = await bookAndRaisePo(user, [[p, 10]]);
    const id = String(lines[0]._id);

    for (const qty of [40, 15, 60, 5, 33]) {
      const res = await call(updateBookingItems, {
        user: SALES, params: { orderId },
        body: { lines: [{ id, skuCode: p.skuCode, quantity: qty }] },
      });
      assert.equal(res.statusCode, 200, `set to ${qty}: ${JSON.stringify(res.payload)}`);
      // 200 units on hand, `qty` of them consumed by this booking.
      assert.deepEqual(
        await stockOf(p._id),
        { available: 200 - qty, booked: 0, total: 200 - qty },
        `after setting ${qty}`,
      );
      await assertConsistent(p._id, `after setting ${qty}`);
    }
    assert.equal((await Order.findById(id).lean()).confirmedQty, 33);
  });
});

// ---------------------------------------------------------------------------
// Traceability
// ---------------------------------------------------------------------------

describe('every amendment is recorded', () => {
  test('the audit row names the actor and what moved', async () => {
    const user = await customer();
    const p = await product(100);
    const b = await product(50);
    const { orderId, lines } = await bookAndRaisePo(user, [[p, 10]]);

    await call(updateBookingItems, {
      user: SALES, params: { orderId },
      body: {
        lines: [
          { id: String(lines[0]._id), skuCode: p.skuCode, quantity: 25 },
          { skuCode: b.skuCode, quantity: 8 },
        ],
      },
    });

    const entry = await AuditLog.findOne({ 'meta.orderId': orderId }).sort({ createdAt: -1 }).lean();
    assert.ok(entry, 'an audit row exists');
    assert.equal(String(entry.user ?? entry.userId ?? entry.actor), String(SALES._id));
    const types = entry.meta.changes.map((c) => c.type).sort();
    assert.deepEqual(types, ['added', 'quantity']);
    const qty = entry.meta.changes.find((c) => c.type === 'quantity');
    assert.equal(qty.fromQty, 10);
    assert.equal(qty.toQty, 25);
  });
});
