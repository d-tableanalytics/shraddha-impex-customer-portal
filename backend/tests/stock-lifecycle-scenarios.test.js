/**
 * The expected business outcomes, run as tests.
 *
 * Each `describe` below is one of the scenarios in the remediation brief,
 * asserted on real stock figures after a real workflow — not on a status
 * field. A booking that says "Cancelled" while its units are still held is
 * exactly the failure these exist to catch.
 *
 * THE SEVEN-DAY CLOCK is simulated by backdating the booking rather than
 * waiting, which is how the deadline is actually measured: `daysSince` reads
 * `orderTimestamp`, so a booking written seven days into the past is, to every
 * code path, seven days old.
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
const mails = [];
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async (to, subject) => { mails.push({ to: String(to), subject }); return true; } },
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
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { default: StockMovement } = await import('../models/StockMovement.js');
const { default: OversoldException } = await import('../models/OversoldException.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { runPoSettlement } = await import('../modules/orders/poExpiryJob.js');
const { runReservationExpiryChecks } = await import('../modules/reservations/reservationExpiryJob.js');

let server;
let U;
const DAY = 864e5;

before(async () => { await startTestReplSet(); server = await startServer(app); });
after(async () => { await server?.close(); await stopTestMongo(); });

let seq = 0;
const mkUser = async (role, extra = {}) => (await User.create({
  email: `${role.replace(/\s/g, '').toLowerCase()}${++seq}@example.com`, password: 'x'.repeat(12),
  user: `${role} ${seq}`, company: `${role} Co ${seq}`, role, ...extra,
})).toObject();

beforeEach(async () => {
  await clearCollections();
  mails.length = 0;
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

const product = (sku, units) => createProductModel('Koken').create({
  skuCode: sku, totalAvailableQuantity: units, bookedQuantity: 0, availableForSale: units,
});

/** total / booked / available, the three figures every scenario is stated in. */
const stock = async (sku) => {
  const p = await Product.findOne({ skuCode: sku }).lean();
  return {
    total: p.totalAvailableQuantity ?? 0,
    booked: p.bookedQuantity ?? 0,
    available: p.availableForSale ?? 0,
  };
};

const book = async (who, p, qty, body = {}) => {
  const res = await POST('/api/v1/reservations/direct-booking', who,
    { items: [{ productId: String(p._id), quantity: qty }], ...body });
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data.orderId || res.body.data.indentId.replace(/^PI-/, 'BO-');
};

/** Push a booking back in time so the 7-day deadline has genuinely passed. */
const age = async (orderId, days) => {
  const when = new Date(Date.now() - days * DAY);
  await Order.collection.updateMany({ orderId }, { $set: { orderTimestamp: when, createdAt: when, date: when } });
};

const releasesFor = (orderId, sku) => StockMovement.countDocuments({
  referenceId: orderId, skuCode: sku, movementType: 'RELEASE',
});

// ════════════════════════════════════════════════════════════════════════════

describe('Scenario 3 — confirmed booking expires without a PO', () => {
  test('S3-01 the booking expires and every unit comes back', async () => {
    const p = await product('S3-1', 10);
    const orderId = await book(U.alice, p, 4);
    assert.deepEqual(await stock('S3-1'), { total: 10, booked: 4, available: 6 });

    await age(orderId, 8);
    await runPoSettlement();

    assert.deepEqual(
      await stock('S3-1'), { total: 10, booked: 0, available: 10 },
      'the expired booking did not return its units',
    );
    const line = await Order.findOne({ orderId, skuCode: 'S3-1' }).lean();
    assert.equal(line.status, 'Cancelled');
    assert.equal(line.stockState, 'released');
    assert.equal(await releasesFor(orderId, 'S3-1'), 1, 'no RELEASE movement was recorded');
  });

  test('S3-02 released stock is immediately bookable by someone else', async () => {
    const p = await product('S3-2', 10);
    const orderId = await book(U.alice, p, 10);
    assert.equal((await stock('S3-2')).available, 0);

    await age(orderId, 8);
    await runPoSettlement();

    const second = await book(U.bob, p, 10);
    const line = await Order.findOne({ orderId: second, skuCode: 'S3-2' }).lean();
    assert.equal(line.confirmedQty, 10, 'the freed stock could not be booked again');
    assert.deepEqual(await stock('S3-2'), { total: 10, booked: 10, available: 0 });
  });

  test('S3-03 a multi-line booking records a RELEASE for EVERY line', async () => {
    // The 25 Nov failure: 7 lines expired, 3 movements were written.
    const skus = ['S3-3a', 'S3-3b', 'S3-3c', 'S3-3d', 'S3-3e', 'S3-3f', 'S3-3g'];
    const items = [];
    for (const s of skus) items.push({ productId: String((await product(s, 50))._id), quantity: 5 });
    const res = await POST('/api/v1/reservations/direct-booking', U.alice, { items });
    const orderId = res.body.data.orderId;

    await age(orderId, 8);
    await runPoSettlement();

    for (const s of skus) {
      assert.equal(await releasesFor(orderId, s), 1, `${s} has no RELEASE movement`);
      assert.deepEqual(await stock(s), { total: 50, booked: 0, available: 50 }, `${s} did not come back`);
    }
  });
});

describe('Scenario 4 — a PO is raised inside the deadline', () => {
  test('S4-01 the expiry job leaves a PO-backed booking alone', async () => {
    const p = await product('S4-1', 10);
    const orderId = await book(U.alice, p, 4);
    await PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-S4-1' });
    const afterPo = await stock('S4-1');

    await age(orderId, 9);
    await runPoSettlement();

    assert.deepEqual(await stock('S4-1'), afterPo, 'a PO-backed booking was released by the expiry job');
    const line = await Order.findOne({ orderId, skuCode: 'S4-1' }).lean();
    assert.equal(line.stockState, 'consumed');
    assert.notEqual(line.status, 'Cancelled');
    // The consumption produces its own RELEASE; what must not appear is a
    // second one from the expiry job.
    assert.equal(await releasesFor(orderId, 'S4-1'), 1);
  });

  test('S4-02 the deadline boundary: 6.9 days is safe, 7.1 is not', async () => {
    const early = await product('S4-2a', 10);
    const late = await product('S4-2b', 10);
    const a = await book(U.alice, early, 3);
    const b = await book(U.alice, late, 3);

    await age(a, 6.9);
    await age(b, 7.1);
    await runPoSettlement();

    assert.deepEqual(await stock('S4-2a'), { total: 10, booked: 3, available: 7 },
      'a booking inside the deadline was expired');
    assert.deepEqual(await stock('S4-2b'), { total: 10, booked: 0, available: 10 },
      'a booking past the deadline was not expired');
  });
});

describe('Scenario 5 — two customers on one SKU', () => {
  test("S5-01 one expiry leaves the other customer's units untouched", async () => {
    const p = await product('S5-1', 20);
    const a = await book(U.alice, p, 5);
    const b = await book(U.bob, p, 7);
    assert.deepEqual(await stock('S5-1'), { total: 20, booked: 12, available: 8 });

    const bobBefore = await Order.find({ orderId: b }).lean();

    await age(a, 8);
    await runPoSettlement();

    assert.deepEqual(
      await stock('S5-1'), { total: 20, booked: 7, available: 13 },
      "Alice's expiry released the wrong quantity",
    );
    assert.equal(await releasesFor(a, 'S5-1'), 1);
    assert.equal(await releasesFor(b, 'S5-1'), 0, "Bob's booking was released too");

    const bobAfter = await Order.find({ orderId: b }).lean();
    assert.equal(bobAfter[0].confirmedQty, bobBefore[0].confirmedQty);
    assert.equal(bobAfter[0].stockState, 'reserved');
    assert.equal(bobAfter[0].status, bobBefore[0].status);
  });
});

describe('Scenario 6 — phantom stock is reported, not released', () => {
  test('S6-01 a line claiming more than is held releases only what exists', async () => {
    // The 14305M-19 conditions: the line says 7, the counter holds 4.
    const p = await product('S6-1', 4);
    const orderId = await book(U.alice, p, 4);
    // Corrupt the line the way the real data was corrupted: it claims 7.
    await Order.collection.updateMany({ orderId }, { $set: { confirmedQty: 7, bookedQty: 7 } });
    assert.deepEqual(await stock('S6-1'), { total: 4, booked: 4, available: 0 });

    await age(orderId, 8);
    await runPoSettlement();

    const after = await stock('S6-1');
    assert.equal(after.available, 4, `available is ${after.available}; 7 would be phantom stock`);
    assert.equal(after.booked, 0);
    assert.equal(after.total, 4, 'physical stock changed because a reservation expired');
    assert.ok(after.available <= after.total, 'phantom stock was created');

    const ex = await OversoldException.findOne({ skuCode: 'S6-1' }).lean();
    assert.ok(ex, 'the 3-unit discrepancy was absorbed silently instead of reported');
    assert.equal(ex.shortfall, 3);
  });
});

describe('Duplicate and concurrent settlement', () => {
  test('DS-01 running the expiry job twice releases the stock once', async () => {
    const p = await product('DS-1', 10);
    const orderId = await book(U.alice, p, 4);
    await age(orderId, 8);

    await runPoSettlement();
    const once = await stock('DS-1');
    await runPoSettlement();
    const twice = await stock('DS-1');

    assert.deepEqual(twice, once, 'the second run released the stock again');
    assert.equal(await releasesFor(orderId, 'DS-1'), 1, 'a second RELEASE movement was written');
  });

  test('DS-02 two expiry jobs at the same moment release once', async () => {
    const p = await product('DS-2', 10);
    const orderId = await book(U.alice, p, 4);
    await age(orderId, 8);

    await Promise.all([runPoSettlement(), runPoSettlement()]);

    assert.deepEqual(await stock('DS-2'), { total: 10, booked: 0, available: 10 });
    assert.equal(await releasesFor(orderId, 'DS-2'), 1);
  });

  test('DS-03 a manual cancellation followed by expiry does not double-release', async () => {
    const p = await product('DS-3', 10);
    const orderId = await book(U.alice, p, 4);
    await POST(`/api/v1/orders/${orderId}/cancel`, U.admin, { reason: 'changed mind' });
    const afterCancel = await stock('DS-3');

    await age(orderId, 8);
    await runPoSettlement();

    assert.deepEqual(await stock('DS-3'), afterCancel, 'expiry released an already-cancelled booking');
    assert.equal(await releasesFor(orderId, 'DS-3'), 1);
  });

  test('DS-04 a PO raised concurrently with expiry yields exactly one outcome', async () => {
    const p = await product('DS-4', 10);
    const orderId = await book(U.alice, p, 4);
    await age(orderId, 7.5);

    await Promise.all([
      PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-DS-4' }),
      runPoSettlement(),
    ]);

    const lines = await Order.find({ orderId }).lean();
    assert.equal(lines.length, 1);
    assert.ok(['consumed', 'released'].includes(lines[0].stockState));
    const after = await stock('DS-4');
    // consumed -> total 6, available 6. released -> total 10, available 10.
    const consumed = after.total === 6 && after.available === 6 && after.booked === 0;
    const released = after.total === 10 && after.available === 10 && after.booked === 0;
    assert.ok(consumed || released, `neither outcome cleanly applied: ${JSON.stringify(after)}`);
  });

  test('DS-05 a late PO on released stock does not revive the reservation silently', async () => {
    const p = await product('DS-5', 10);
    const orderId = await book(U.alice, p, 4);
    await age(orderId, 8);
    await runPoSettlement();
    const afterExpiry = await stock('DS-5');

    const res = await PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-DS-5-LATE' });

    assert.ok(res.status >= 400, 'a PO was accepted on an expired booking');
    assert.deepEqual(await stock('DS-5'), afterExpiry, 'a late PO moved stock');
  });
});

describe('Selection List lifecycle', () => {
  test('SL-01 adding to the selection list does NOT reserve stock (current design)', async () => {
    const p = await product('SL-1', 10);
    const before = await stock('SL-1');

    const res = await POST('/api/v1/reservations', U.alice,
      { productId: String(p._id), quantity: 4 });
    assert.ok(res.status < 300, JSON.stringify(res.body));

    assert.deepEqual(
      await stock('SL-1'), before,
      'the selection list now reserves stock — this test records the CURRENT design',
    );
    const r = await Reservation.findOne({ skuCode: 'SL-1' }).lean();
    assert.equal(r.status, 'Reserved');
    assert.ok(r.expiryDate, 'no 7-day expiry was set on the selection line');
  });

  test('SL-02 an expired selection line is removed and holds no stock', async () => {
    const p = await product('SL-2', 10);
    await POST('/api/v1/reservations', U.alice, { productId: String(p._id), quantity: 4 });
    await Reservation.collection.updateMany(
      { skuCode: 'SL-2' },
      { $set: { reservationDate: new Date(Date.now() - 8 * DAY), expiryDate: new Date(Date.now() - DAY) } },
    );
    const before = await stock('SL-2');

    await runReservationExpiryChecks();

    const r = await Reservation.findOne({ skuCode: 'SL-2' }).lean();
    assert.equal(r.status, 'Expired', 'the selection line was not expired by the job');
    assert.ok(r.expiredAt);
    assert.deepEqual(await stock('SL-2'), before, 'expiry moved stock that was never reserved');
  });

  test('SL-03 running the selection-list expiry twice is harmless', async () => {
    const p = await product('SL-3', 10);
    await POST('/api/v1/reservations', U.alice, { productId: String(p._id), quantity: 4 });
    await Reservation.collection.updateMany(
      { skuCode: 'SL-3' },
      { $set: { reservationDate: new Date(Date.now() - 8 * DAY), expiryDate: new Date(Date.now() - DAY) } },
    );

    await runReservationExpiryChecks();
    const once = await stock('SL-3');
    await runReservationExpiryChecks();

    assert.deepEqual(await stock('SL-3'), once);
    assert.equal(await Reservation.countDocuments({ skuCode: 'SL-3', status: 'Expired' }), 1);
  });

  test('SL-04 an expired selection line cannot be confirmed into a booking', async () => {
    const p = await product('SL-4', 10);
    await POST('/api/v1/reservations', U.alice, { productId: String(p._id), quantity: 4 });
    await Reservation.collection.updateMany(
      { skuCode: 'SL-4' },
      { $set: { reservationDate: new Date(Date.now() - 8 * DAY), expiryDate: new Date(Date.now() - DAY) } },
    );
    await runReservationExpiryChecks();

    const res = await POST('/api/v1/reservations/confirm-booking', U.alice, {});
    assert.ok(res.status >= 400, 'an expired selection line was confirmed into a booking');
    assert.deepEqual(await stock('SL-4'), { total: 10, booked: 0, available: 10 });
  });
});

describe('Indent closes with its booking', () => {
  test('IN-01 cancelling a booking closes the indent it created', async () => {
    // Partial fill: 4 from stock, the rest becomes the indent.
    const p = await product('IN-1', 4);
    const orderId = await book(U.alice, p, 10);
    const indentNumber = orderId.replace(/^BO-/, 'PI-');

    const before = await Reservation.findOne({ indentNumber }).lean();
    assert.ok(before, 'no indent was raised for the unfilled remainder');
    assert.equal(before.status, 'Partially Confirmed');

    await POST(`/api/v1/orders/${orderId}/cancel`, U.admin, { reason: 'not needed' });

    const after = await Reservation.findOne({ indentNumber }).lean();
    assert.equal(after.status, 'Cancelled', 'the indent outlived its cancelled booking');
    assert.ok(after.cancelledAt);
    assert.match(after.cancellationReason || '', /cancel/i);
  });

  test('IN-02 the 7-day expiry closes the indent too', async () => {
    const p = await product('IN-2', 4);
    const orderId = await book(U.alice, p, 10);
    const indentNumber = orderId.replace(/^BO-/, 'PI-');

    await age(orderId, 8);
    await runPoSettlement();

    const after = await Reservation.findOne({ indentNumber }).lean();
    assert.equal(after.status, 'Cancelled', 'an expired booking left its indent open');
    assert.match(after.cancellationReason || '', /no PO|expired/i);
  });

  test('IN-03 an indent from a booking that confirmed NOTHING survives', async () => {
    // No stock at all: no order row is created, and the indent IS the whole
    // request. These are the 8 open indents in production — legitimate
    // customer demand waiting on stock, with no booking to be cancelled with.
    const p = await product('IN-3', 0);
    const res = await POST('/api/v1/reservations/direct-booking', U.alice,
      { items: [{ productId: String(p._id), quantity: 12 }] });
    assert.ok(res.status < 300, JSON.stringify(res.body));

    const indent = await Reservation.findOne({ skuCode: 'IN-3' }).lean();
    assert.ok(indent, 'no indent was raised when nothing could be filled');
    assert.equal(indent.status, 'Pending');
    assert.equal(indent.quantity, 12);
    assert.equal(
      await Order.countDocuments({ skuCode: 'IN-3' }), 0,
      'an order row was created for a booking that confirmed nothing',
    );

    // Nothing may close it: there is no cancelled booking behind it.
    await runPoSettlement();
    const still = await Reservation.findOne({ skuCode: 'IN-3' }).lean();
    assert.equal(still.status, 'Pending', 'a legitimate waiting indent was cancelled');
  });

  test('IN-04 a cancelled booking does not close ANOTHER booking\'s indent', async () => {
    const p = await product('IN-4', 4);
    const a = await book(U.alice, p, 10);
    const b = await book(U.bob, p, 6);
    const indentA = a.replace(/^BO-/, 'PI-');
    const indentB = b.replace(/^BO-/, 'PI-');

    await POST(`/api/v1/orders/${a}/cancel`, U.admin, { reason: 'test' });

    assert.equal((await Reservation.findOne({ indentNumber: indentA }).lean()).status, 'Cancelled');
    const bobIndent = await Reservation.findOne({ indentNumber: indentB }).lean();
    assert.notEqual(bobIndent.status, 'Cancelled', "another customer's indent was cancelled");
  });
});
