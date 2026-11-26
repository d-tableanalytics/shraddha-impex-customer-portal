/**
 * Inventory integrity — one customer's settlement must not consume another's.
 *
 * WHAT THIS FILE IS ABOUT
 * ----------------------
 * `bookedQuantity` is ONE number per SKU, summed across every booking. There is
 * no per-booking allocation in the legacy schema. So when that aggregate is
 * understated — which a dropped ledger posting plus syncLegacyStock made
 * routine — settling one booking can take back more than its own share and
 * leave another customer's units unreserved. Their order is untouched, so the
 * commitment still exists on paper; but nothing is holding their stock any
 * more, and the portal will sell it to somebody else.
 *
 * Every test below sets up a DELIBERATELY corrupted aggregate with two
 * customers holding the same SKU, and asserts two things:
 *
 *   1. the other customer's units are still reserved afterwards, and
 *   2. the other customer's ORDER was not cancelled, reduced, reassigned or
 *      rewritten in any way — asserted field by field, not by count.
 *
 * The corruption is injected through the raw collection, never through a
 * workflow: the point is to reproduce the state production is already in, not
 * to test the bug that produced it.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';
import { startServer } from './helpers/http.js';

let UserModel = null;
mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});
mock.module(new URL('../middlewares/auth.js', import.meta.url).href, {
  namedExports: {
    protect: async (req, res, next) => {
      const id = req.headers['x-test-user'];
      const user = id && mongoose.isValidObjectId(id) ? await UserModel.findById(id).lean() : null;
      if (!user) return res.status(401).json({ success: false });
      req.user = { ...user, id: String(user._id) };
      return next();
    },
  },
});

const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
UserModel = User;
const { default: Order } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: Location } = await import('../models/Location.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { default: OversoldException } = await import('../models/OversoldException.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { releaseStock, consumeStock } = await import('../utils/stockLedger.js');
const { syncLegacyStock } = await import('../modules/inventory/balance.service.js');

let server;
let U;

before(async () => { await startTestReplSet(); server = await startServer(app); });
after(async () => { await server?.close(); await stopTestMongo(); });

let seq = 0;
const mkUser = async (role, extra = {}) => (await User.create({
  email: `${role.replace(/\s/g, '').toLowerCase()}${++seq}@example.com`, password: 'x'.repeat(12),
  user: `${role} ${seq}`, company: `${role} Co ${seq}`, role, ...extra,
})).toObject();

beforeEach(async () => {
  await clearCollections();
  await seedBrands();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'auto', effectiveFrom: new Date(0) });
  U = {
    admin: await mkUser('Admin'),
    sales: await mkUser('Sales'),
    alice: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
    bob: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
  };
});

const http = async (method, url, who, body) => {
  const headers = who ? { 'x-test-user': String(who._id) } : {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${server.url}${url}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json };
};
const POST = (u, w, b) => http('POST', u, w, b);
const PUT = (u, w, b) => http('PUT', u, w, b);

const product = (sku, { total, booked = 0, afs = total - booked }) =>
  createProductModel('Koken').create({
    skuCode: sku, totalAvailableQuantity: total, bookedQuantity: booked, availableForSale: afs,
  });

const fresh = (sku) => Product.findOne({ skuCode: sku }).lean();

const consistent = async (sku) => {
  const p = await fresh(sku);
  assert.ok((p.totalAvailableQuantity ?? 0) >= 0, `total negative: ${p.totalAvailableQuantity}`);
  assert.ok((p.bookedQuantity ?? 0) >= 0, `booked negative: ${p.bookedQuantity}`);
  assert.ok((p.availableForSale ?? 0) >= 0, `afs negative: ${p.availableForSale}`);
  assert.ok(
    (p.availableForSale ?? 0) <= (p.totalAvailableQuantity ?? 0),
    `phantom stock: afs ${p.availableForSale} > total ${p.totalAvailableQuantity}`,
  );
  return p;
};

const book = async (who, p, qty) => {
  const res = await POST('/api/v1/reservations/direct-booking', who,
    { items: [{ productId: String(p._id), quantity: qty }] });
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data.orderId || res.body.data.indentId.replace(/^PI-/, 'BO-');
};

/**
 * Reproduce the production state: the ledger never saw one booking's RESERVE,
 * so a later sync reset `bookedQuantity` to a figure that is too low. Written
 * through the raw collection because no workflow should be able to do this.
 */
const understate = (sku, booked) => Product.collection.updateOne(
  { skuCode: sku },
  [{
    $set: {
      bookedQuantity: booked,
      availableForSale: { $max: [0, { $subtract: ['$totalAvailableQuantity', booked] }] },
    },
  }],
);

/** The exact, field-level state of every line of a booking. */
const snapshot = async (orderId) => (await Order.find({ orderId }).sort({ skuCode: 1 }).lean())
  .map((o) => ({
    orderId: o.orderId, skuCode: o.skuCode, user: String(o.user), status: o.status,
    requestedQty: o.requestedQty, bookedQty: o.bookedQty, confirmedQty: o.confirmedQty,
    pendingQty: o.pendingQty, poNumber: o.poNumber, stockState: o.stockState,
    cancelledAt: o.cancelledAt ? o.cancelledAt.toISOString() : null,
    company: o.company, emailId: o.emailId,
  }));

/** Asserts a booking was not cancelled, reduced, reassigned or rewritten. */
const untouched = async (orderId, before, label) => {
  assert.deepEqual(await snapshot(orderId), before, `${label}: booking ${orderId} was modified`);
};

// ════════════════════════════════════════════════════════════════════════════

describe('Two customers, one SKU', () => {
  test('MC-01 cancelling one booking leaves the other customer\'s units reserved', async () => {
    const p = await product('MC-1', { total: 30 });
    const a = await book(U.alice, p, 10);
    const b = await book(U.bob, p, 5);
    const bobBefore = await snapshot(b);
    assert.equal((await fresh('MC-1')).bookedQuantity, 15);

    const res = await POST(`/api/v1/orders/${a}/cancel`, U.admin, { reason: 'test' });
    assert.ok(res.status < 300, JSON.stringify(res.body));

    const after = await consistent('MC-1');
    assert.equal(after.bookedQuantity, 5, "Bob's units are no longer reserved");
    assert.equal(after.availableForSale, 25);
    await untouched(b, bobBefore, 'MC-01');
  });

  test('MC-02 a CORRUPTED aggregate cannot be drained past the other booking\'s share', async () => {
    // Alice 10 + Bob 5 = 15, but the counter says 7 — Bob's RESERVE was dropped
    // and a sync rewrote the figure. Cancelling Alice used to take all 7.
    const p = await product('MC-2', { total: 30 });
    const a = await book(U.alice, p, 10);
    const b = await book(U.bob, p, 5);
    const bobBefore = await snapshot(b);
    await understate('MC-2', 7);

    await POST(`/api/v1/orders/${a}/cancel`, U.admin, { reason: 'test' });

    const after = await consistent('MC-2');
    assert.ok(
      after.bookedQuantity >= 5,
      `Bob holds 5 units but only ${after.bookedQuantity} remain reserved — his stock is now sellable`,
    );
    await untouched(b, bobBefore, 'MC-02');
    const ex = await OversoldException.findOne({ skuCode: 'MC-2' }).lean();
    assert.ok(ex, 'the shortfall was not reported');
    assert.ok(
      ex.affectedBookings.some((x) => x.orderId === b),
      "the exception does not name Bob's booking as affected",
    );
  });

  test('MC-03 expiry of a corrupted reservation protects the other booking', async () => {
    const p = await product('MC-3', { total: 30 });
    const a = await book(U.alice, p, 12);
    const b = await book(U.bob, p, 6);
    const bobBefore = await snapshot(b);
    await understate('MC-3', 8);

    // Age Alice's booking past the 7-day PO deadline and run the expiry job.
    const when = new Date(Date.now() - 9 * 864e5);
    await Order.collection.updateMany({ orderId: a }, { $set: { orderTimestamp: when, createdAt: when } });
    const { runPoExpiry } = await import('../modules/orders/poExpiryJob.js');
    if (typeof runPoExpiry === 'function') await runPoExpiry();
    else await releaseStock(await Product.findById(p._id), 12, null, { referenceId: a });

    const after = await consistent('MC-3');
    assert.ok(after.bookedQuantity >= 6, `Bob's 6 units lost: only ${after.bookedQuantity} reserved`);
    await untouched(b, bobBefore, 'MC-03');
  });

  test('MC-04 PO generation against an understated counter still ships the right quantity', async () => {
    const p = await product('MC-4', { total: 30 });
    const a = await book(U.alice, p, 10);
    const b = await book(U.bob, p, 5);
    const bobBefore = await snapshot(b);
    await understate('MC-4', 7);
    const beforePo = await fresh('MC-4');

    const res = await PUT(`/api/v1/orders/${a}/po`, U.sales, { poNumber: 'PO-MC-4' });
    assert.ok(res.status < 300, JSON.stringify(res.body));

    const after = await consistent('MC-4');
    // 10 units genuinely left the building.
    assert.equal(
      after.totalAvailableQuantity, beforePo.totalAvailableQuantity - 10,
      'physical stock did not fall by what actually shipped',
    );
    assert.ok(after.bookedQuantity >= 5, `Bob's units were consumed by Alice's PO`);
    await untouched(b, bobBefore, 'MC-04');
  });

  test('MC-05 simultaneous PO and cancellation settle the line exactly once', async () => {
    const p = await product('MC-5', { total: 30 });
    const a = await book(U.alice, p, 10);
    const b = await book(U.bob, p, 5);
    const bobBefore = await snapshot(b);
    const beforeBoth = await fresh('MC-5');

    await Promise.all([
      PUT(`/api/v1/orders/${a}/po`, U.sales, { poNumber: 'PO-MC-5' }),
      POST(`/api/v1/orders/${a}/cancel`, U.admin, { reason: 'race' }),
    ]);

    const after = await consistent('MC-5');
    const lines = await Order.find({ orderId: a }).lean();
    // Whichever won, the line settled once and ended in exactly one state.
    assert.equal(lines.length, 1);
    assert.ok(['consumed', 'released'].includes(lines[0].stockState), `stockState ${lines[0].stockState}`);
    // Alice's 10 units moved once: either out of inventory, or back to available.
    const movedOnce = after.totalAvailableQuantity === beforeBoth.totalAvailableQuantity - 10
      || after.totalAvailableQuantity === beforeBoth.totalAvailableQuantity;
    assert.ok(movedOnce, `stock moved more than once: ${beforeBoth.totalAvailableQuantity} -> ${after.totalAvailableQuantity}`);
    assert.ok(after.bookedQuantity >= 5, "Bob's units were released by Alice's race");
    await untouched(b, bobBefore, 'MC-05');
  });

  test('MC-06 a new booking cannot quietly consume pre-existing phantom stock', async () => {
    // A row already carrying 5 phantom units, exactly as production has today.
    await product('MC-6', { total: 4, booked: 0, afs: 4 });
    await Product.collection.updateOne({ skuCode: 'MC-6' }, { $set: { availableForSale: 9 } });
    const p = await Product.findOne({ skuCode: 'MC-6' });

    const orderId = await book(U.alice, p, 9);
    const afterBooking = await fresh('MC-6');
    assert.equal(afterBooking.bookedQuantity, 9);

    // Raising the PO must not pretend 9 units shipped from a shelf holding 4.
    // Physical stock stops at zero; the 5 uncovered units are reported.
    await PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-MC-6' });
    const after = await consistent('MC-6');
    assert.equal(after.totalAvailableQuantity, 0, 'physical stock went negative or did not fall');
    // TWO exceptions now, raised at the two moments the oversell is visible:
    // when the booking is granted against phantom availability, and again when
    // the PO tries to ship units that are not there. Both matter — the first
    // is the early warning, the second is the proof that goods could not be
    // issued — so each is asserted by source rather than by taking whichever
    // findOne happens to return.
    const atBooking = await OversoldException.findOne({ skuCode: 'MC-6', source: 'sync' }).lean();
    assert.ok(atBooking, 'the booking oversold against phantom stock and nothing recorded it');
    assert.equal(atBooking.shortfall, 5);

    const atShipping = await OversoldException.findOne({ skuCode: 'MC-6', source: 'consume' }).lean();
    assert.ok(atShipping, 'shipping more than exists was not detected');
    assert.equal(atShipping.shortfall, 5);
  });

  test('MC-07 a negative booked counter is never treated as a credit', async () => {
    await product('MC-7', { total: 10, booked: 0, afs: 10 });
    await Product.collection.updateOne({ skuCode: 'MC-7' }, { $set: { bookedQuantity: -18, availableForSale: 10 } });
    const p = await Product.findOne({ skuCode: 'MC-7' });

    assert.equal(await releaseStock(p, 5, null, {}), true);
    const afterRelease = await fresh('MC-7');
    assert.equal(afterRelease.availableForSale, 10, 'a negative booked count was read as a credit');

    const q = await Product.findOne({ skuCode: 'MC-7' });
    assert.equal(await consumeStock(q, 3, null, {}), true);
    const after = await fresh('MC-7');
    assert.ok(after.totalAvailableQuantity >= 0);
    assert.equal(after.totalAvailableQuantity, 7, 'goods shipped but physical stock did not fall');
  });

  test('MC-08 a stock adjustment during two live bookings preserves both holds', async () => {
    const p = await product('MC-8', { total: 30 });
    const a = await book(U.alice, p, 10);
    const b = await book(U.bob, p, 5);
    const aliceBefore = await snapshot(a);
    const bobBefore = await snapshot(b);

    // A ledger that knows nothing about either booking — the 21 Nov state.
    // Built at the DEFAULT location, which is the one the adjustment resolves.
    // The bookings' own dual-write already created the balance row; force it
    // into the state the ledger was actually in — knowing nothing is reserved.
    const loc = await Location.findOne({ isDefault: true }).lean();
    await StockBalance.updateOne(
      { skuCode: 'MC-8' },
      { $set: { skuCode: 'MC-8', brand: 'Koken', location: loc._id, locationCode: loc.code, onHand: 30, reserved: 0 } },
      { upsert: true },
    );
    const res = await POST('/api/v1/inventory/items/MC-8/adjust', U.admin,
      { brand: 'Koken', mode: 'delta', quantity: 4, reasonCode: 'DATA_ENTRY', note: 'test' });
    assert.ok(res.status < 400, JSON.stringify(res.body));

    const after = await consistent('MC-8');
    assert.equal(after.bookedQuantity, 15, 'the adjustment voided live reservations');
    assert.equal(after.totalAvailableQuantity, 34, 'inward stock did not reach the legacy fields');
    assert.equal(after.availableForSale, 19);
    await untouched(a, aliceBefore, 'MC-08');
    await untouched(b, bobBefore, 'MC-08');
  });

  test('MC-09 syncLegacyStock during live bookings never reduces a commitment', async () => {
    const p = await product('MC-9', { total: 30 });
    const a = await book(U.alice, p, 10);
    const b = await book(U.bob, p, 5);
    const aliceBefore = await snapshot(a);
    const bobBefore = await snapshot(b);

    await StockBalance.create({
      skuCode: 'MC-9', brand: 'Koken', location: new mongoose.Types.ObjectId(),
      locationCode: 'MAIN', onHand: 30, reserved: 0,
    });
    await syncLegacyStock(['MC-9']);

    const after = await consistent('MC-9');
    assert.equal(after.bookedQuantity, 15);
    assert.equal(after.availableForSale, 15);
    await untouched(a, aliceBefore, 'MC-09');
    await untouched(b, bobBefore, 'MC-09');
  });

  test('MC-10 no reservation or indent is altered by any settlement above', async () => {
    const p = await product('MC-10', { total: 20 });
    const a = await book(U.alice, p, 8);
    await book(U.bob, p, 4);
    const reservationsBefore = (await Reservation.find({ skuCode: 'MC-10' }).sort({ _id: 1 }).lean())
      .map((r) => ({ id: r.reservationId, status: r.status, qty: r.quantity, customer: String(r.customerId) }));

    await understate('MC-10', 5);
    await POST(`/api/v1/orders/${a}/cancel`, U.admin, { reason: 'test' });

    const reservationsAfter = (await Reservation.find({ skuCode: 'MC-10' }).sort({ _id: 1 }).lean())
      .map((r) => ({ id: r.reservationId, status: r.status, qty: r.quantity, customer: String(r.customerId) }));

    // Alice's own indent may legitimately close with her booking; Bob's must not.
    const bobBefore = reservationsBefore.filter((r) => r.customer === String(U.bob._id));
    const bobAfter = reservationsAfter.filter((r) => r.customer === String(U.bob._id));
    assert.deepEqual(bobAfter, bobBefore, "Bob's reservation was altered by Alice's cancellation");
  });
});
