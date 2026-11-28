/**
 * Phase 6 — SKU Activity Log coverage.
 *
 * The question this file answers is not "does the endpoint work" but "can an
 * admin open one SKU and see everything that happened to it". So each test
 * runs a real workflow through the real controllers and then asserts the
 * activity feed can account for it.
 *
 * THE DISTINCTION THAT MATTERS. A booking is two things at once: a commitment
 * to a customer, and a quantity of stock set aside. The ledger records the
 * second; the booking documents record the first. Both appear, and the
 * business event carries `affectsStock: false` so a quantity is never counted
 * twice on one screen.
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
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { getActivity, triggerOf, ACTIVITY_TYPES } = await import('../modules/inventory/activity.service.js');

let server;
let U;
const BRANDS = ['Koken', 'BIX', 'IMADA'];

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
const GET = (u, w) => http('GET', u, w);
const POST = (u, w, b) => http('POST', u, w, b);
const PUT = (u, w, b) => http('PUT', u, w, b);

const product = (sku, units) => createProductModel('Koken').create({
  skuCode: sku, totalAvailableQuantity: units, bookedQuantity: 0, availableForSale: units,
  description: `Test ${sku}`,
});

/** The whole feed for one SKU, unpaged. */
const feed = (skuCode, extra = {}) =>
  getActivity({ skuCode, brands: BRANDS, limit: 200, ...extra });

const typesIn = (records) => new Set(records.map((r) => r.activityType));

const book = async (who, p, qty, body = {}) => {
  const res = await POST('/api/v1/reservations/direct-booking', who,
    { items: [{ productId: String(p._id), quantity: qty }], ...body });
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data.orderId || res.body.data.indentId.replace(/^PI-/, 'BO-');
};

// ════════════════════════════════════════════════════════════════════════════

describe('SKU activity coverage', () => {
  test('AC-01 a full lifecycle is visible on one screen', async () => {
    const p = await product('AC-1', 50);
    const orderId = await book(U.alice, p, 10);
    await PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-AC-1' });

    const { records } = await feed('AC-1');
    const types = typesIn(records);

    // The business events...
    assert.ok(types.has('BOOKING_CREATED'), 'the booking itself is not on the log');
    assert.ok(types.has('PO_RAISED'), 'the PO is not on the log');
    // ...and the stock that moved with them.
    assert.ok(types.has('BOOKING_CONFIRMED'), 'the reservation movement is missing');
    assert.ok(types.has('STOCK_OUT'), 'the issue is missing');
    assert.ok(types.has('BOOKING_RELEASED'), 'the release is missing');
  });

  test('AC-02 a business event never pretends stock moved', async () => {
    const p = await product('AC-2', 50);
    await book(U.alice, p, 6);

    const { records } = await feed('AC-2');
    for (const r of records.filter((x) => x.source === 'booking')) {
      assert.equal(r.affectsStock, false, `${r.activityType} claims to move stock`);
      assert.equal(r.previousStock, null);
      assert.equal(r.updatedStock, null);
      assert.equal(r.balanceKind, null);
    }
    // And the ledger rows still do.
    assert.ok(records.some((r) => r.affectsStock && r.balanceKind === 'booked'));
  });

  test('AC-03 a partial booking shows requested, confirmed and pending', async () => {
    const p = await product('AC-3', 4);
    await book(U.alice, p, 10);

    const { records } = await feed('AC-3');
    const created = records.find((r) => r.activityType === 'BOOKING_CREATED');
    assert.ok(created, 'no booking row');
    assert.equal(created.details.requestedQty, 10);
    assert.equal(created.details.confirmedQty, 4);
    assert.equal(created.details.pendingQty, 6);
    assert.match(created.description, /10 Units requested/);
    assert.ok(records.some((r) => r.activityType === 'INDENT_RAISED'), 'the indent is not shown');
  });

  test('AC-04 the customer and the SI Team member who booked for them are both shown', async () => {
    const p = await product('AC-4', 50);
    const res = await POST('/api/v1/reservations/direct-booking', U.sales, {
      items: [{ productId: String(p._id), quantity: 5 }],
      customerId: String(U.alice._id),
    });
    assert.ok(res.status < 300, JSON.stringify(res.body));

    const { records } = await feed('AC-4');
    const created = records.find((r) => r.activityType === 'BOOKING_CREATED');
    assert.ok(created);
    assert.equal(created.details.customer, U.alice.user, 'the customer is not named');
    assert.ok(created.details.placedBy, 'the SI Team member who placed it is not named');
    assert.equal(created.details.sourceModule, 'Sales Desk (on behalf)');
  });

  test('AC-05 a cancellation is shown as a status change AND as released stock', async () => {
    const p = await product('AC-5', 50);
    const orderId = await book(U.alice, p, 8);
    await POST(`/api/v1/orders/${orderId}/cancel`, U.admin, { reason: 'not needed' });

    const { records } = await feed('AC-5');
    const status = records.find((r) => r.activityType === 'STATUS_CHANGED' && r.status === 'Cancelled');
    assert.ok(status, 'the cancellation is not recorded as a status change');
    assert.equal(status.details.statusTo, 'Cancelled');
    assert.ok(records.some((r) => r.movementType === 'RELEASE'), 'the released stock is missing');
  });

  test('AC-06 a selection-list line that was removed is still visible', async () => {
    const p = await product('AC-6', 50);
    await Reservation.create({
      reservationId: 'RES-AC-6', customerId: U.alice._id, productId: p._id, skuCode: 'AC-6',
      quantity: 12, expiryDate: new Date(Date.now() + 864e5), reservedBy: U.alice._id,
      status: 'Cancelled',
    });

    const { records } = await feed('AC-6');
    const closed = records.find((r) => r.activityType === 'SELECTION_CLOSED');
    assert.ok(closed, 'a removed selection-list line left no trace');
    assert.equal(closed.affectsStock, false);
    assert.match(closed.description, /removed from the selection list/);
  });

  test('AC-07 imports, adjustments and counts are all present', async () => {
    const p = await product('AC-7', 20);
    const loc = await Location.findOne({ isDefault: true }).lean();
    await StockBalance.updateOne(
      { skuCode: 'AC-7' },
      { $set: { skuCode: 'AC-7', brand: 'Koken', location: loc._id, locationCode: loc.code, onHand: 20, reserved: 0 } },
      { upsert: true },
    );
    const res = await POST('/api/v1/inventory/items/AC-7/adjust', U.admin,
      { brand: 'Koken', mode: 'delta', quantity: 5, reasonCode: 'DATA_ENTRY', note: 'count correction' });
    assert.ok(res.status < 400, JSON.stringify(res.body));

    const { records } = await feed('AC-7');
    const adj = records.find((r) => r.activityType === 'ADJUSTMENT');
    assert.ok(adj, 'the adjustment is not on the log');
    assert.equal(adj.affectsStock, true);
    assert.equal(adj.trigger, 'manual');
    assert.ok(adj.details.sourceModule, 'the adjustment does not say where it came from');
    assert.ok(p);
  });

  test('AC-08 remediation activity is labelled, not left unexplained', async () => {
    await product('AC-8', 20);
    const { postBatch } = await import('../modules/inventory/ledger.service.js');
    await postBatch({
      idempotencyKey: 'ac8-backfill', workflowType: 'ledger-backfill',
      referenceType: 'booking', referenceId: 'BO-AC-8',
      effectiveDate: new Date('2026-08-01T10:00:00Z'),
      lines: [{
        movementType: 'RESERVE', skuCode: 'AC-8', brand: 'Koken', quantity: 5,
        effectiveDate: new Date('2026-08-01T10:00:00Z'), reasonCode: 'RECONCILIATION',
      }],
    });

    const { records } = await feed('AC-8');
    const row = records.find((r) => r.id && r.action && /backfill/i.test(r.action));
    assert.ok(row, 'a backfilled movement reads as an unexplained entry');
    assert.equal(row.trigger, 'system', 'a system correction is shown as if a person did it');
  });

  test('AC-09 two customers on one SKU are told apart', async () => {
    const p = await product('AC-9', 60);
    await book(U.alice, p, 10);
    await book(U.bob, p, 7);

    const { records } = await feed('AC-9');
    const created = records.filter((r) => r.activityType === 'BOOKING_CREATED');
    assert.equal(created.length, 2);
    const customers = new Set(created.map((r) => r.details.customer));
    assert.equal(customers.size, 2, 'both bookings are attributed to the same customer');
  });

  test('AC-10 every record carries the common detail shape', async () => {
    const p = await product('AC-10', 40);
    await book(U.alice, p, 5);

    const { records } = await feed('AC-10');
    assert.ok(records.length >= 2);
    for (const r of records) {
      assert.ok(r.details, `${r.activityType} has no details block`);
      assert.ok('customer' in r.details && 'sourceModule' in r.details && 'bookingId' in r.details);
      assert.ok(['manual', 'automatic', 'system'].includes(r.trigger), `bad trigger on ${r.activityType}`);
      assert.ok(r.at, `${r.activityType} has no date`);
    }
  });

  test('AC-11 the feed is ordered newest first across all three sources', async () => {
    const p = await product('AC-11', 60);
    const orderId = await book(U.alice, p, 5);
    await PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-AC-11' });

    const { records } = await feed('AC-11');
    const times = records.map((r) => new Date(r.at).getTime());
    const sorted = [...times].sort((a, b) => b - a);
    assert.deepEqual(times, sorted, 'the merged feed is out of order');
  });

  test('AC-12 one business event is not shown once per source', async () => {
    const p = await product('AC-12', 40);
    const orderId = await book(U.alice, p, 5);

    const { records } = await feed('AC-12');
    const created = records.filter((r) => r.activityType === 'BOOKING_CREATED' && r.referenceNumber === orderId);
    assert.equal(created.length, 1, 'the booking is listed more than once');
    const ids = records.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'the feed contains duplicate rows');
  });

  test('AC-13 filters narrow by type and by reference', async () => {
    const p = await product('AC-13', 60);
    const orderId = await book(U.alice, p, 6);
    await book(U.bob, p, 4);

    const byType = await feed('AC-13', { activityType: 'BOOKING_CREATED' });
    assert.ok(byType.records.length >= 2);
    assert.ok(byType.records.every((r) => r.activityType === 'BOOKING_CREATED'));

    const byRef = await feed('AC-13', { reference: orderId });
    assert.ok(byRef.records.length > 0, 'filtering by booking id found nothing');
    assert.ok(byRef.records.every((r) => r.referenceNumber === orderId
      || r.details?.bookingId === orderId), 'the reference filter leaked other bookings');
  });

  test('AC-14 filtering by customer shows only that customer', async () => {
    const p = await product('AC-14', 60);
    await book(U.alice, p, 6);
    await book(U.bob, p, 4);

    const { records } = await feed('AC-14', { customerId: String(U.alice._id) });
    const created = records.filter((r) => r.activityType === 'BOOKING_CREATED');
    assert.ok(created.length > 0);
    assert.ok(
      created.every((r) => r.details.customer === U.alice.user),
      "another customer's booking appeared under this filter",
    );
  });

  test('AC-15 pagination totals match what is actually returned', async () => {
    const p = await product('AC-15', 200);
    for (let i = 0; i < 4; i += 1) await book(U.alice, p, 3);

    const all = await feed('AC-15');
    const page1 = await getActivity({ skuCode: 'AC-15', brands: BRANDS, page: 1, limit: 3 });
    const page2 = await getActivity({ skuCode: 'AC-15', brands: BRANDS, page: 2, limit: 3 });

    assert.equal(page1.total, all.total, 'the total changes between pages');
    assert.equal(page1.records.length, 3);
    const seen = new Set([...page1.records, ...page2.records].map((r) => r.id));
    assert.equal(seen.size, page1.records.length + page2.records.length, 'pages overlap');
  });

  test('AC-16 the type list offered to the UI includes the new activities', () => {
    const types = new Set(ACTIVITY_TYPES.map((t) => t.type));
    for (const t of ['BOOKING_CREATED', 'PO_RAISED', 'STATUS_CHANGED', 'SELECTION_CLOSED']) {
      assert.ok(types.has(t), `${t} is not offered as a filter`);
    }
  });

  test('AC-17 the trigger says whether a person or a job did it', () => {
    assert.equal(triggerOf('booking-confirm', 'user'), 'manual');
    assert.equal(triggerOf('po-settlement-release', 'user'), 'automatic');
    assert.equal(triggerOf('ledger-backfill', 'user'), 'system');
    assert.equal(triggerOf('stock-adjustment', 'system'), 'automatic');
  });

  test('AC-18 the export endpoint returns a workbook, under the same permission', async () => {
    const p = await product('AC-18', 40);
    await book(U.alice, p, 5);

    const res = await fetch(`${server.url}/api/v1/inventory/items/AC-18/activity/export`, {
      headers: { 'x-test-user': String(U.admin._id) },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /spreadsheetml/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000, 'the workbook is empty');
    // PK.. — a real xlsx is a zip.
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    assert.ok(p);
  });

  test('AC-19 a customer cannot read the admin activity log', async () => {
    await product('AC-19', 10);
    const res = await GET('/api/v1/inventory/items/AC-19/activity', U.alice);
    assert.equal(res.status, 403, 'the activity log is readable without the stock-ledger permission');
  });

  test('AC-20 a booking that failed leaves no stock movement behind', async () => {
    const p = await product('AC-20', 2);
    // More than exists: the line is indented, not confirmed, so nothing moves.
    await book(U.alice, p, 2);
    const before = await feed('AC-20');
    const movements = before.records.filter((r) => r.affectsStock).length;

    const res = await POST('/api/v1/reservations/direct-booking', U.alice,
      { items: [{ productId: String(p._id), quantity: 99 }] });
    assert.ok(res.status < 500);

    const after = await feed('AC-20');
    const now = after.records.filter((r) => r.affectsStock).length;
    assert.equal(now, movements, 'a booking that moved no stock produced a stock movement');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TARGETED COVERAGE — events that only the audit log records durably
// ════════════════════════════════════════════════════════════════════════════

describe('Durable event coverage', () => {
  const auditRow = (skuCode, action, remarks, meta = {}) =>
    mongoose.connection.collection('auditlogs').insertOne({
      action, remarks, meta: { skuCode, ...meta },
      method: 'POST', endpoint: '/test', ipAddress: '127.0.0.1', userAgent: 'test',
      createdAt: new Date(), updatedAt: new Date(),
    });

  test('CV-01 a selection-list quantity change keeps BOTH the old and new figure', async () => {
    await product('CV-1', 50);
    await auditRow('CV-1', 'Reservation Updated',
      'Adjusted quantity of reservation RES-CV-1 to 10',
      { reservationId: 'RES-CV-1', previousQuantity: 40, newQuantity: 10 });

    const { records } = await feed('CV-1');
    const row = records.find((r) => r.activityType === 'AUDIT_EVENT');
    assert.ok(row, 'a quantity change left no activity record');
    assert.equal(row.details.statusFrom, '40', 'the previous quantity was lost');
    assert.equal(row.details.statusTo, '10');
    assert.equal(row.derivedFrom, 'audit-log');
    assert.equal(row.affectsStock, false);
  });

  test('CV-02 the record survives deletion of the document it describes', async () => {
    const p = await product('CV-2', 50);
    const r = await Reservation.create({
      reservationId: 'RES-CV-2', customerId: U.alice._id, productId: p._id, skuCode: 'CV-2',
      quantity: 25, expiryDate: new Date(Date.now() + 864e5), reservedBy: U.alice._id,
      status: 'Reserved',
    });
    await auditRow('CV-2', 'Reservation Cancelled',
      'Cancelled selection line (CV-2 x25) — by the customer.',
      { reservationId: 'RES-CV-2', quantity: 25, previousStatus: 'Reserved', newStatus: 'Cancelled' });

    // The business document is removed entirely.
    await Reservation.deleteOne({ _id: r._id });

    const { records } = await feed('CV-2');
    const row = records.find((r2) => r2.activityType === 'AUDIT_EVENT');
    assert.ok(row, 'the history vanished with the document');
    assert.match(row.description, /Cancelled/);
    assert.equal(row.details.statusTo, 'Cancelled');
  });

  test('CV-03 a pre-PO booking amendment is recorded as its own event', async () => {
    await product('CV-3', 50);
    await auditRow('CV-3', 'Booking Edited (Sales)',
      'Booking BO-CV-3 line CV-3 changed from 12 to 5 before PO.',
      { orderId: 'BO-CV-3', previousQuantity: 12, newQuantity: 5 });

    const { records } = await feed('CV-3');
    const row = records.find((r) => r.activityType === 'AUDIT_EVENT');
    assert.ok(row);
    assert.equal(row.action, 'Booking quantity amended (pre-PO)');
    assert.equal(row.details.bookingId, 'BO-CV-3');
    assert.equal(row.details.sourceModule, 'Sales Desk');
  });

  test('CV-04 the whole Pending Indent lifecycle is visible', async () => {
    await product('CV-4', 80);
    const steps = [
      ['Indent Scheduled', 'Indent PI-CV-4 scheduled'],
      ['Indent Stock Assigned', '10 unit(s) of CV-4 assigned to PI-CV-4'],
      ['Indent Allocated', '5 unit(s) of arriving stock allocated'],
      ['Indent Returned To Booking', 'Indent PI-CV-4 returned to its booking'],
      ['Indent Cancelled', 'Cancelled indent (CV-4 x5)'],
    ];
    for (const [action, remarks] of steps) await auditRow('CV-4', action, remarks, { indentNumber: 'PI-CV-4' });

    const { records } = await feed('CV-4');
    const actions = records.filter((r) => r.activityType === 'AUDIT_EVENT').map((r) => r.action);
    for (const expected of [
      'Indent scheduled', 'Indent stock assigned by hand', 'Indent allocated arriving stock',
      'Indent returned to booking', 'Indent cancelled',
    ]) {
      assert.ok(actions.includes(expected), `missing: ${expected}`);
    }
  });

  test('CV-05 repeated confirm/cancel/reconfirm cycles are separate events', async () => {
    await product('CV-5', 80);
    for (const n of [1, 2, 3]) {
      await auditRow('CV-5', 'Reservation Confirmed',
        `Reservation RES-CV-5-${n}: confirmed 5, pending 0 (requested 5)`,
        { reservationId: `RES-CV-5-${n}` });
    }
    await auditRow('CV-5', 'Booking Cancelled', 'Booking BO-CV-5 cancelled', { orderId: 'BO-CV-5' });

    const { records } = await feed('CV-5');
    const confirms = records.filter((r) => r.action === 'Booking confirmed');
    assert.equal(confirms.length, 3, 'repeated cycles were collapsed into one');
    const ids = new Set(records.map((r) => r.id));
    assert.equal(ids.size, records.length, 'the feed contains duplicates');
  });

  test('CV-06 an oversold exception appears on the SKU it concerns', async () => {
    await product('CV-6', 4);
    await mongoose.connection.collection('oversoldexceptions').insertOne({
      skuCode: 'CV-6', brand: 'Koken', onHand: 4, reserved: 9, shortfall: 5,
      source: 'count', countId: 'CNT-CV-6', status: 'Open',
      affectedBookings: [{ orderId: 'BO-CV-6', confirmedQty: 9 }],
      raisedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });

    const { records } = await feed('CV-6');
    const row = records.find((r) => r.activityType === 'OVERSOLD_EXCEPTION');
    assert.ok(row, 'an oversold exception is invisible on the SKU it concerns');
    assert.equal(row.quantity, 5);
    assert.equal(row.affectsStock, false);
    assert.equal(row.details.bookingId, 'BO-CV-6');
    assert.equal(row.trigger, 'system');
  });

  test('CV-07 SKU attribution does not match a longer code by accident', async () => {
    await product('CV-7', 10);
    await product('CV-70', 10);
    await auditRow('CV-70', 'Reservation Updated', 'Adjusted quantity for CV-70 to 3', {});

    const { records } = await feed('CV-7');
    assert.equal(
      records.some((r) => r.activityType === 'AUDIT_EVENT'), false,
      'CV-7 picked up an entry that belongs to CV-70',
    );
  });

  test('CV-08 rows say whether they come from a mutable document', async () => {
    const p = await product('CV-8', 50);
    await POST(`/api/v1/reservations/direct-booking`, U.alice,
      { items: [{ productId: String(p._id), quantity: 5 }] });

    const { records } = await feed('CV-8');
    const created = records.find((r) => r.activityType === 'BOOKING_CREATED');
    assert.equal(created.derivedFrom, 'current-document',
      'a row read from a live document does not say so');
    const movement = records.find((r) => r.affectsStock);
    assert.equal(movement.derivedFrom, 'ledger');
  });

  test('CV-09 pagination covers every source without dropping rows', async () => {
    const p = await product('CV-9', 200);
    for (let i = 0; i < 3; i += 1) {
      await POST(`/api/v1/reservations/direct-booking`, U.alice,
        { items: [{ productId: String(p._id), quantity: 2 }] });
    }
    for (const n of [1, 2, 3]) await auditRow('CV-9', 'Reservation Updated', `change ${n} for CV-9`, {});

    const all = await feed('CV-9');
    const seen = new Set();
    let fetched = 0;
    for (let page = 1; page <= Math.ceil(all.total / 5); page += 1) {
      const r = await getActivity({ skuCode: 'CV-9', brands: BRANDS, page, limit: 5 });
      for (const rec of r.records) seen.add(rec.id);
      fetched += r.records.length;
    }
    assert.equal(fetched, all.total, 'paging through dropped or repeated rows');
    assert.equal(seen.size, all.total);
  });

  test('CV-10 the export states its limit rather than truncating silently', async () => {
    await product('CV-10', 20);
    const { exportLimit } = await import('../modules/inventory/activity.controller.js');
    assert.equal(typeof exportLimit, 'number');
    assert.ok(exportLimit >= 1000);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // The client's own coverage list (2026-11-28), item by item.
  //
  // Most of it was already exercised above. These pin the ones the list names
  // that nothing asserted directly, so "the Activity Log covers X" is a test
  // result rather than a reading of the code.
  // ══════════════════════════════════════════════════════════════════════════

  test('RQ-01 a selection list that EXPIRED is visible, and moved no stock', async () => {
    const p = await product('RQ-1', 50);
    const added = await POST('/api/v1/reservations', U.alice,
      { productId: String(p._id), quantity: 20 });
    assert.ok(added.status < 300, JSON.stringify(added.body));

    // The 7-day expiry, as the nightly job applies it. It holds no stock —
    // nothing is reserved until confirmation — so the point of the record is
    // that it exists at all, and says so.
    await Reservation.updateOne(
      { reservationId: added.body.data.reservationId },
      { $set: { status: 'Expired', expiredAt: new Date() } },
    );

    const { records } = await feed('RQ-1');
    const closed = records.find((r) => r.activityType === 'SELECTION_CLOSED');
    assert.ok(closed, 'an expired selection-list line must not vanish from the log');
    assert.equal(closed.affectsStock, false, 'it never held stock, so it releases none');
    assert.equal(closed.quantity, 20, 'what was asked for is still reported');

    // And no stock movement was invented alongside it.
    assert.ok(
      !records.some((r) => r.affectsStock),
      'an expiring selection list must post no stock movement',
    );
    const fresh = await Product.findById(p._id).lean();
    assert.equal(fresh.availableForSale, 50);
  });

  test('RQ-02 booking confirmation does not deduct what was never reserved', async () => {
    // The client's worked complaint: "if stock has already been reserved
    // during selection list creation, booking confirmation must not appear to
    // deduct the same quantity again."
    //
    // In this system nothing is reserved at selection-list time, so there is
    // exactly ONE allocation per booking. Asserted rather than assumed: a
    // second RESERVE movement here would be the double deduction.
    const p = await product('RQ-2', 50);
    const added = await POST('/api/v1/reservations', U.alice,
      { productId: String(p._id), quantity: 20 });
    assert.ok(added.status < 300);

    const afterList = await Product.findById(p._id).lean();
    assert.equal(afterList.availableForSale, 50, 'a selection list holds no stock');

    const confirmed = await POST('/api/v1/reservations/confirm', U.alice, {});
    assert.ok(confirmed.status < 300, JSON.stringify(confirmed.body));

    const { records } = await feed('RQ-2');
    const reserves = records.filter((r) => r.activityType === 'BOOKING_CONFIRMED');
    assert.equal(reserves.length, 1, 'the units are set aside once, not twice');
    assert.equal(reserves[0].quantity, 20);

    // The business event beside it says what happened without moving anything.
    const created = records.find((r) => r.activityType === 'BOOKING_CREATED');
    assert.ok(created);
    assert.equal(created.affectsStock, false, 'the commitment is not a second deduction');
  });

  test('RQ-03 a confirmed booking that expired without a PO shows the release and its reason', async () => {
    const p = await product('RQ-3', 50);
    const orderId = await book(U.alice, p, 20);

    // Age the booking past the 7-day PO deadline and run the real settlement.
    const old = new Date(Date.now() - 9 * 864e5);
    await Order.collection.updateMany(
      { orderId }, { $set: { orderTimestamp: old, createdAt: old, date: old } },
    );
    const { runPoSettlement } = await import('../modules/orders/poExpiryJob.js');
    await runPoSettlement();

    const { records } = await feed('RQ-3');
    const release = records.find((r) => r.activityType === 'BOOKING_RELEASED');
    assert.ok(release, 'the stock going back must be on the log');
    // Negative: a release is an allocation movement going the other way. The
    // sign is the ledger's; what stops it reading as stock LEAVING is
    // `direction` and `balanceKind` below, not the number.
    assert.equal(release.quantity, -20);
    assert.equal(release.direction, 'release', 'released, not "stock out" — the goods never left');
    assert.equal(release.balanceKind, 'booked', 'the pair counts allocation, not on-hand');

    // Released once. Releasing again is the defect this guards.
    await runPoSettlement();
    const { records: after } = await feed('RQ-3');
    assert.equal(
      after.filter((r) => r.activityType === 'BOOKING_RELEASED').length, 1,
      'previously released inventory must not be released again',
    );
    const fresh = await Product.findById(p._id).lean();
    assert.equal(fresh.availableForSale, 50, 'and the stock came back exactly once');
  });

  test('RQ-04 a dispatch is recorded as a status change, not as a stock deduction', async () => {
    const p = await product('RQ-4', 50);
    const orderId = await book(U.alice, p, 20);
    await POST(`/api/v1/sales/bookings/${orderId}/po`, U.admin,
      { poNumber: 'PO-RQ4', poDate: new Date().toISOString() });

    const moved = await PUT(`/api/v1/orders/booking/${orderId}/status`, U.admin,
      { status: 'Dispatched' });
    assert.ok(moved.status < 300, JSON.stringify(moved.body));

    const { records } = await feed('RQ-4');
    const status = records.find((r) => r.activityType === 'STATUS_CHANGED');
    assert.ok(status, 'the dispatch must appear');
    assert.equal(status.affectsStock, false,
      'the PO already consumed these units; a dispatch must not deduct them a second time');
  });

  test('RQ-05 every record says who did it and whether a person or the system did', async () => {
    const p = await product('RQ-5', 50);
    await book(U.alice, p, 20);
    const { records } = await feed('RQ-5');
    assert.ok(records.length > 0);
    for (const r of records) {
      // Three values, not two: 'manual' is a person, 'automatic' is a rule
      // firing on a person's action (stock arriving auto-books an indent), and
      // 'system' is a scheduled job. Collapsing the middle one into either
      // would misattribute it.
      assert.ok(
        ['manual', 'automatic', 'system'].includes(r.trigger),
        `no trigger on ${r.activityType}`,
      );
      assert.ok('actor' in r, `no actor field on ${r.activityType}`);
      // Before/after are either BOTH present or BOTH absent, and labelled by
      // what they count. A half-known pair is what produced misleading rows.
      const known = r.previousStock !== null && r.previousStock !== undefined;
      const knownAfter = r.updatedStock !== null && r.updatedStock !== undefined;
      assert.equal(known, knownAfter, `a half-known before/after pair on ${r.activityType}`);
      if (known) assert.ok(r.balanceKind, `a before/after pair with no balanceKind on ${r.activityType}`);
    }
  });

  test('RQ-06 before/after are never fabricated when the record cannot supply them', async () => {
    const p = await product('RQ-6', 50);
    await book(U.alice, p, 60);  // 50 confirmed, 10 to indent

    const { records } = await feed('RQ-6');
    const indent = records.find((r) => r.activityType === 'INDENT_RAISED');
    assert.ok(indent);
    assert.equal(indent.affectsStock, false);
    assert.equal(indent.previousStock, null, 'an indent moves nothing, so it has no before');
    assert.equal(indent.updatedStock, null, 'and no after — invented ones are the complaint');
  });
});
