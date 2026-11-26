/**
 * Inventory integrity — Phase 1.
 *
 * One test per defect found in the 14305M-19 investigation (26 Nov 2026), each
 * written so it FAILS if the defect comes back, plus the regression cover that
 * proves a healthy booking behaves exactly as it did before.
 *
 * THE FOUR INVARIANTS every test asserts through `consistent()`:
 *     totalAvailableQuantity >= 0
 *     bookedQuantity         >= 0
 *     availableForSale       >= 0
 *     availableForSale + bookedQuantity === totalAvailableQuantity
 *
 * Same harness as release-defects.test.js: the real app over HTTP, real
 * permissions, an in-memory replica set.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';
import { isIsolated, hostsOf } from './helpers/isolation.js';
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
const { default: Location } = await import('../models/Location.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { default: StockMovement } = await import('../models/StockMovement.js');
const { default: OversoldException } = await import('../models/OversoldException.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { releaseStock, consumeStock, reserveStock } = await import('../utils/stockLedger.js');
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
    customer: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
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

/**
 * A product in whatever state the test needs — including a DELIBERATELY broken
 * one, which is the whole point: these defects only show on rows whose booked
 * count disagrees with reality.
 */
const product = (sku, { total, booked = 0, afs = total - booked }, brand = 'Koken') =>
  createProductModel(brand).create({
    skuCode: sku, totalAvailableQuantity: total, bookedQuantity: booked, availableForSale: afs,
  });

const fresh = (sku) => Product.findOne({ skuCode: sku }).lean();

/** The invariant, asserted as one call so no test can forget half of it. */
const consistent = async (sku) => {
  const p = await fresh(sku);
  assert.ok(p, `product ${sku} missing`);
  assert.ok((p.totalAvailableQuantity ?? 0) >= 0, `total negative: ${p.totalAvailableQuantity}`);
  assert.ok((p.bookedQuantity ?? 0) >= 0, `booked negative: ${p.bookedQuantity}`);
  assert.ok((p.availableForSale ?? 0) >= 0, `afs negative: ${p.availableForSale}`);
  assert.equal(
    (p.availableForSale ?? 0) + (p.bookedQuantity ?? 0), p.totalAvailableQuantity ?? 0,
    `invariant broken on ${sku}: afs ${p.availableForSale} + booked ${p.bookedQuantity} != total ${p.totalAvailableQuantity}`,
  );
  return p;
};

const balance = (sku, { onHand, reserved = 0 }, brand = 'Koken') => StockBalance.create({
  skuCode: sku, brand, location: new mongoose.Types.ObjectId(), locationCode: 'MAIN', onHand, reserved,
});

// ════════════════════════════════════════════════════════════════════════════
// TEST ISOLATION — the fence itself
// ════════════════════════════════════════════════════════════════════════════

describe('Test isolation', () => {
  test('INT-00 the suite is connected to a loopback database, never production', () => {
    assert.ok(
      isIsolated(`mongodb://${mongoose.connection.host}`),
      `tests are connected to ${mongoose.connection.host}`,
    );
  });

  test('INT-01 a production connection string is refused by the fence', () => {
    const prod = 'mongodb+srv://user:pw@cluster0.example.mongodb.net/erp_portal?appName=Cluster0';
    assert.equal(isIsolated(prod), false);
    assert.deepEqual(hostsOf(prod), ['cluster0.example.mongodb.net']);
    assert.throws(() => mongoose.connect(prod), /Refusing to connect/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEFECT 3 — releaseStock minted phantom stock
// ════════════════════════════════════════════════════════════════════════════

describe('releaseStock', () => {
  test('REL-01 a healthy release is unchanged: both counters move by the same amount', async () => {
    const p = await product('REL-1', { total: 20, booked: 8 });
    assert.equal(await releaseStock(p, 5, null, { workflow: 'booking-cancel' }), true);
    const after = await consistent('REL-1');
    assert.equal(after.bookedQuantity, 3);
    assert.equal(after.availableForSale, 17);
    assert.equal(after.totalAvailableQuantity, 20);
    const mv = await StockMovement.find({ skuCode: 'REL-1', movementType: 'RELEASE' }).lean();
    assert.equal(mv.length, 1);
    assert.equal(mv[0].quantity, -5);
    assert.equal(await OversoldException.countDocuments({ skuCode: 'REL-1' }), 0);
  });

  test('REL-02 releasing more than is booked credits only what was held — no phantom stock', async () => {
    // The 25 Nov 2026 event: BO-2026-000213 released 7 against a booked count
    // of 4, and availableForSale was credited the full 7.
    const p = await product('REL-2', { total: 4, booked: 4, afs: 0 });
    assert.equal(
      await releaseStock(p, 7, null, { workflow: 'po-settlement-release', referenceId: 'BO-TEST-213' }),
      true,
    );
    const after = await consistent('REL-2');
    assert.equal(after.bookedQuantity, 0);
    assert.equal(after.availableForSale, 4, 'credited more than was held — phantom stock is back');
    assert.ok(after.availableForSale <= after.totalAvailableQuantity, 'afs exceeds physical stock');
  });

  test('REL-03 the unaccounted remainder is reported, not swallowed', async () => {
    const p = await product('REL-3', { total: 4, booked: 4, afs: 0 });
    await releaseStock(p, 7, null, { workflow: 'po-settlement-release', referenceId: 'BO-TEST-213' });
    const ex = await OversoldException.findOne({ skuCode: 'REL-3' }).lean();
    assert.ok(ex, 'no exception raised for the 3 unaccounted units');
    assert.equal(ex.shortfall, 3);
    assert.equal(ex.source, 'release');
    assert.equal(ex.status, 'Open');
  });

  test('REL-04 releasing against a zero booked count moves nothing', async () => {
    const p = await product('REL-4', { total: 10, booked: 0, afs: 10 });
    assert.equal(await releaseStock(p, 5, null, {}), true);
    const after = await consistent('REL-4');
    assert.equal(after.availableForSale, 10, 'invented 5 units out of nothing');
    assert.equal(await OversoldException.countDocuments({ skuCode: 'REL-4' }), 1);
  });

  test('REL-05 concurrent releases of the same units cannot drive booked negative', async () => {
    const p = await product('REL-5', { total: 10, booked: 4, afs: 6 });
    const q = await Product.findById(p._id);
    await Promise.all([
      releaseStock(p, 4, null, {}),
      releaseStock(q, 4, null, {}),
    ]);
    const after = await consistent('REL-5');
    assert.equal(after.bookedQuantity, 0);
    assert.ok(after.availableForSale <= 10, `double release credited ${after.availableForSale}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEFECT 4 — consumeStock under-decremented physical stock
// ════════════════════════════════════════════════════════════════════════════

describe('consumeStock', () => {
  test('CON-01 a healthy PO consumption is unchanged', async () => {
    const p = await product('CON-1', { total: 10, booked: 10, afs: 0 });
    assert.equal(await consumeStock(p, 4, null, { workflow: 'po-raise' }), true);
    const after = await consistent('CON-1');
    assert.equal(after.totalAvailableQuantity, 6);
    assert.equal(after.bookedQuantity, 6);
    assert.equal(after.availableForSale, 0);
    const types = (await StockMovement.find({ skuCode: 'CON-1' }).lean()).map((m) => m.movementType).sort();
    assert.deepEqual(types, ['ISSUE', 'RELEASE']);
  });

  test('CON-02 shipping more than is booked still removes every unit from physical stock', async () => {
    // booked understated by a dropped ledger posting; 7 units genuinely ship.
    const p = await product('CON-2', { total: 10, booked: 4, afs: 6 });
    assert.equal(await consumeStock(p, 7, null, { workflow: 'po-raise' }), true);
    const after = await consistent('CON-2');
    assert.equal(after.totalAvailableQuantity, 3, 'physical stock overstated — goods left but total did not fall');
    assert.equal(after.bookedQuantity, 0);
    assert.equal(after.availableForSale, 3);
  });

  test('CON-03 consumption never drives any figure negative', async () => {
    const p = await product('CON-3', { total: 2, booked: 0, afs: 2 });
    assert.equal(await consumeStock(p, 9, null, {}), true);
    const after = await consistent('CON-3');
    assert.equal(after.totalAvailableQuantity, 0);
    const ex = await OversoldException.findOne({ skuCode: 'CON-3' }).lean();
    assert.ok(ex, 'the 7 units that could not be accounted for were not reported');
    assert.equal(ex.shortfall, 7);
    assert.equal(ex.source, 'consume');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEFECT 2 — syncLegacyStock voided live reservations
// ════════════════════════════════════════════════════════════════════════════

describe('syncLegacyStock', () => {
  test('SYN-01 an incomplete ledger projection cannot void a live reservation', async () => {
    // The 21 Nov 2026 event exactly: the product holds 7 units for a live
    // booking, the ledger never recorded the RESERVE, an adjustment runs.
    await product('SYN-1', { total: 11, booked: 7, afs: 4 });
    await balance('SYN-1', { onHand: 11, reserved: 0 });

    await syncLegacyStock(['SYN-1']);

    const after = await consistent('SYN-1');
    assert.equal(after.bookedQuantity, 7, 'a live reservation was voided by the projection');
    assert.equal(after.availableForSale, 4);
    assert.equal(after.totalAvailableQuantity, 11);
  });

  test('SYN-02 inward stock still reaches the customer portal', async () => {
    // The behaviour syncLegacyStock exists for must survive the fix.
    await product('SYN-2', { total: 5, booked: 2, afs: 3 });
    await balance('SYN-2', { onHand: 40, reserved: 2 });
    await syncLegacyStock(['SYN-2']);
    const after = await consistent('SYN-2');
    assert.equal(after.totalAvailableQuantity, 40, 'inward stock did not reach the legacy fields');
    assert.equal(after.availableForSale, 38);
    assert.equal(after.bookedQuantity, 2);
  });

  test('SYN-03 a genuine oversell shows zero available and is reported, never auto-corrected', async () => {
    await product('SYN-3', { total: 10, booked: 10, afs: 0 });
    await balance('SYN-3', { onHand: 4, reserved: 0 });
    await syncLegacyStock(['SYN-3']);
    const after = await fresh('SYN-3');
    assert.equal(after.availableForSale, 0, 'oversold SKU must show zero, never a negative or a phantom');
    assert.equal(after.bookedQuantity, 10, 'a customer commitment was reduced automatically');
    const ex = await OversoldException.findOne({ skuCode: 'SYN-3' }).lean();
    assert.ok(ex, 'the oversell was not reported');
    assert.equal(ex.source, 'sync');
    assert.equal(ex.shortfall, 6);
  });

  test('SYN-04 a SKU the ledger has no position for keeps its commitments', async () => {
    await product('SYN-4', { total: 6, booked: 6, afs: 0 });
    await syncLegacyStock(['SYN-4']);
    const after = await fresh('SYN-4');
    assert.equal(after.totalAvailableQuantity, 0);
    assert.equal(after.bookedQuantity, 6, 'commitments were zeroed along with the physical stock');
    assert.equal(after.availableForSale, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEFECT 6 — POST /api/orders moved stock with no ledger row and a lost update
// ════════════════════════════════════════════════════════════════════════════

describe('POST /api/orders', () => {
  test('API-01 the response contract is unchanged', async () => {
    await product('API-1', { total: 10 });
    const res = await POST('/api/orders', U.customer, { brand: 'Koken', skuCode: 'API-1', requestedQty: 3 });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.skuCode, 'API-1');
    assert.equal(res.body.data.requestedQty, 3);
    assert.equal(res.body.data.status, 'Booked');
    assert.ok(String(res.body.data.orderId).startsWith('SHR-'));
  });

  test('API-02 the booking now reaches the stock ledger', async () => {
    await product('API-2', { total: 10 });
    const res = await POST('/api/orders', U.customer, { brand: 'Koken', skuCode: 'API-2', requestedQty: 3 });
    await consistent('API-2');
    const mv = await StockMovement.find({ skuCode: 'API-2' }).lean();
    assert.equal(mv.length, 1, 'the legacy order route still moves stock invisibly');
    assert.equal(mv[0].movementType, 'RESERVE');
    assert.equal(mv[0].quantity, 3);
    assert.equal(mv[0].referenceId, res.body.data.orderId);
  });

  test('API-03 insufficient stock is refused with the same message as before', async () => {
    await product('API-3', { total: 2 });
    const res = await POST('/api/orders', U.customer, { brand: 'Koken', skuCode: 'API-3', requestedQty: 5 });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Insufficient stock\. Available: 2/);
    const after = await consistent('API-3');
    assert.equal(after.availableForSale, 2);
  });

  test('API-04 concurrent bookings for the same SKU cannot oversell', async () => {
    await product('API-4', { total: 5 });
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      POST('/api/orders', U.customer, { brand: 'Koken', skuCode: 'API-4', requestedQty: 2 })));
    const ok = results.filter((r) => r.status === 201).length;
    const after = await consistent('API-4');
    assert.equal(after.bookedQuantity, ok * 2);
    assert.ok(after.availableForSale >= 0, 'oversold through a lost update');
    assert.equal(after.bookedQuantity + after.availableForSale, 5);
    assert.equal(await Order.countDocuments({ skuCode: 'API-4' }), ok);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PO GENERATION — stock leaves inventory exactly once
// ════════════════════════════════════════════════════════════════════════════

describe('PO generation', () => {
  const book = async (p, qty) => {
    const res = await POST('/api/v1/reservations/direct-booking', U.customer,
      { items: [{ productId: String(p._id), quantity: qty }] });
    assert.ok(res.status < 300, JSON.stringify(res.body));
    return res.body.data.orderId || res.body.data.indentId.replace(/^PI-/, 'BO-');
  };

  test('PO-01 raising the same PO twice consumes stock once', async () => {
    const p = await product('PO-1', { total: 10 });
    const orderId = await book(p, 4);
    await consistent('PO-1');

    const first = await PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-TEST-1' });
    assert.ok(first.status < 300, JSON.stringify(first.body));
    const afterFirst = await consistent('PO-1');

    await PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-TEST-1' });
    const afterSecond = await consistent('PO-1');

    assert.equal(
      afterSecond.totalAvailableQuantity, afterFirst.totalAvailableQuantity,
      'the second PO request consumed stock again',
    );
    assert.equal(afterSecond.bookedQuantity, afterFirst.bookedQuantity);
    const issues = await StockMovement.countDocuments({ skuCode: 'PO-1', movementType: 'ISSUE' });
    assert.equal(issues, 1, `stock issued ${issues} times for one PO`);
  });

  test('PO-02 a repeated cancellation does not move stock twice', async () => {
    const p = await product('PO-2', { total: 10 });
    const orderId = await book(p, 4);
    await PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-TEST-2' });
    const afterPo = await consistent('PO-2');

    await POST(`/api/v1/orders/${orderId}/cancel`, U.admin, { reason: 'test' });
    const afterCancel = await consistent('PO-2');

    // A post-PO cancellation legitimately returns the units (decided
    // 2026-10-19) — but it must do so once.
    assert.ok(afterCancel.totalAvailableQuantity >= afterPo.totalAvailableQuantity);
    assert.ok(afterCancel.availableForSale <= afterCancel.totalAvailableQuantity, 'phantom stock after cancellation');

    await POST(`/api/v1/orders/${orderId}/cancel`, U.admin, { reason: 'test again' });
    const afterSecond = await consistent('PO-2');
    assert.equal(
      afterSecond.totalAvailableQuantity, afterCancel.totalAvailableQuantity,
      'a repeated cancellation moved stock a second time',
    );
    assert.equal(afterSecond.availableForSale, afterCancel.availableForSale);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// END-TO-END — the 14305M-19 sequence, which must now end consistent
// ════════════════════════════════════════════════════════════════════════════

describe('The 14305M-19 sequence', () => {
  test('E2E-01 reserve, under-recorded ledger, adjustment, PO, expiry — invariant holds throughout', async () => {
    const p = await product('E2E-1', { total: 15 });

    // 18 Aug: 4 reserved and consumed by a PO whose ledger posting was dropped.
    assert.equal(await reserveStock(p, 4, null, {}), true);
    await consistent('E2E-1');
    assert.equal(await consumeStock(p, 4, null, {}), true);
    await consistent('E2E-1');

    // A ledger that under-reports: it only ever saw the RESERVE.
    await balance('E2E-1', { onHand: 11, reserved: 4 });

    // 18 Nov: 7 units reserved for a booking the ledger never records.
    const live = await Product.findById(p._id);
    assert.equal(await reserveStock(live, 7, null, {}), true);
    const held = await consistent('E2E-1');
    assert.equal(held.bookedQuantity, 7);

    // 21 Nov: an adjustment syncs the legacy fields from that stale projection.
    await syncLegacyStock(['E2E-1']);
    const afterSync = await consistent('E2E-1');
    assert.equal(afterSync.bookedQuantity, 7, 'the live hold was voided — the 21 Nov defect');

    // 25 Nov: the booking expires and releases its 7 units.
    const expiring = await Product.findById(p._id);
    assert.equal(await releaseStock(expiring, 7, null, {}), true);
    const end = await consistent('E2E-1');
    assert.ok(
      end.availableForSale <= end.totalAvailableQuantity,
      `phantom stock: afs ${end.availableForSale} > total ${end.totalAvailableQuantity}`,
    );
    assert.equal(end.bookedQuantity, 0);
  });
});
