/**
 * SKU reordering and Admin detail editing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE GUARDING
 * ---------------------------------------------------------------------------
 *
 * Both features are "harmless" edits that sit one typo away from being
 * dangerous ones. A reorder endpoint that accepts an arbitrary body can drop a
 * line; a "let the Admin edit the details" endpoint that trusts `req.body` can
 * rewrite a confirmed quantity without moving the stock that backs it, and the
 * audit trail will faithfully record it as a legitimate correction.
 *
 * So the tests below are mostly about what the endpoints REFUSE, and about the
 * things that must remain identical after a save.
 *
 * The permission tests mount the real `authorize` middleware over the real
 * service. Only authentication is stubbed - the guard being tested is the
 * genuine article, and so is the code behind it.
 *
 * The service is imported rather than the controller because `sales.controller`
 * imports `io` from `server.js`, which mounts `order.routes.js`, which imports
 * back from `sales.controller` - a cycle that throws on import. See the header
 * of bookingEdit.service.js.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import { buildTestApp, startServer, stubProtect } from './helpers/http.js';
import Order, { LINE_ORDER } from '../models/Order.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import { authorize, PERMISSIONS } from '../middlewares/rbac.js';
import { reorderLines, updateDetails } from '../modules/sales/bookingEdit.service.js';
import { EDITABLE_KEYS, PROTECTED_FIELDS, coerceField } from '../utils/bookingFields.js';

const ORDER_ID = 'BO-2026-000042';
const CUSTOMER = new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Order, User, AuditLog);
});
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

/**
 * A four-line booking, in the order the customer submitted it.
 *
 * `lineSeq` is set because intake sets it; the reorder is then a change from a
 * known starting sequence rather than from the null that historical rows carry.
 */
async function makeBooking({ poNumber = '-', poGeneratedAt = null } = {}) {
  const base = {
    orderId: ORDER_ID,
    brand: 'Koken',
    user: CUSTOMER,
    status: 'PO Received',
    company: 'ABC Motors',
    shopNumber: '102',
    vendorCode: 'VEN-001',
    gstCode: '27AAPFU0939F1ZV',
    phoneNumber: '9876543210',
    location: 'Pune',
    poNumber,
    poGeneratedAt,
  };
  const skus = ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D'];
  await Order.insertMany(
    skus.map((skuCode, i) => ({
      ...base, skuCode, lineSeq: i, requestedQty: 10 + i, confirmedQty: 10 + i, bookedQty: 10 + i,
    })),
  );
  return Order.find({ orderId: ORDER_ID }).sort(LINE_ORDER);
}

/** The canonical read every screen uses. */
const readOrder = async () =>
  (await Order.find({ orderId: ORDER_ID }).sort(LINE_ORDER)).map((r) => r.skuCode);

const SALES = { _id: new mongoose.Types.ObjectId(), role: 'Sales', status: 'Active', user: 'Priya' };
const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Admin', status: 'Active', user: 'Anil' };
const CUSTOMER_USER = { _id: CUSTOMER, role: 'Customer', status: 'Active', user: 'Buyer' };

/**
 * Mounts the two routes with the SAME guards sales.routes.js applies.
 *
 * The handlers are the controller's own two-line bodies - call the service,
 * map a `.status` error onto a response - so what is exercised here is the real
 * guard in front of the real rules.
 */
async function serve(actor) {
  const send = (fn) => async (req, res) => {
    try {
      await fn(req);
      return res.status(200).json({ success: true });
    } catch (error) {
      return res
        .status(error.status ?? 500)
        .json({ success: false, message: error.message, field: error.field });
    }
  };

  const app = buildTestApp({
    mount: (a) => {
      const r = express.Router();
      r.use(stubProtect(actor));
      r.put(
        '/bookings/:orderId/line-order',
        authorize(PERMISSIONS.EDIT_BOOKING_PRE_PO),
        send((req) => reorderLines({
          orderId: req.params.orderId, lineIds: req.body?.lineIds, actor: req.user, req,
        })),
      );
      r.patch(
        '/bookings/:orderId/details',
        authorize(PERMISSIONS.OVERRIDE_PO_LOCK),
        send((req) => updateDetails({
          orderId: req.params.orderId, patch: req.body, actor: req.user, req,
        })),
      );
      a.use('/api/sales', r);
    },
  });
  return startServer(app);
}

const call = async (server, method, path, body) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

// ---------------------------------------------------------------------------
// Requirement 2 - reordering
// ---------------------------------------------------------------------------

describe('reordering SKUs to match the customer PO', () => {
  test('saves the new sequence and it survives a reload', async () => {
    const rows = await makeBooking();
    const byId = Object.fromEntries(rows.map((r) => [r.skuCode, String(r._id)]));
    const server = await serve(SALES);

    // The requirement's own example: A,B,C,D -> C,A,D,B
    const { status } = await call(server, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, {
      lineIds: [byId['SKU-C'], byId['SKU-A'], byId['SKU-D'], byId['SKU-B']],
    });
    await server.close();

    assert.equal(status, 200);
    // Read back through LINE_ORDER - the sort every screen actually uses, not
    // the array the endpoint happened to return.
    assert.deepEqual(await readOrder(), ['SKU-C', 'SKU-A', 'SKU-D', 'SKU-B']);
  });

  test('persists to lineSeq, the field every existing read already sorts on', async () => {
    const rows = await makeBooking();
    const byId = Object.fromEntries(rows.map((r) => [r.skuCode, String(r._id)]));
    const server = await serve(SALES);

    await call(server, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, {
      lineIds: [byId['SKU-C'], byId['SKU-A'], byId['SKU-D'], byId['SKU-B']],
    });
    await server.close();

    const stored = await Order.find({ orderId: ORDER_ID }).select('skuCode lineSeq').lean();
    const seq = Object.fromEntries(stored.map((r) => [r.skuCode, r.lineSeq]));
    // Dense and zero-based, so the stored value states the intended order
    // plainly rather than carrying intake's sparse gaps.
    assert.deepEqual(seq, { 'SKU-C': 0, 'SKU-A': 1, 'SKU-D': 2, 'SKU-B': 3 });
  });

  test('changes NOTHING except the sequence', async () => {
    const rows = await makeBooking();
    const byId = Object.fromEntries(rows.map((r) => [r.skuCode, String(r._id)]));
    const snapshot = (list) => list
      .map((r) => `${r.skuCode}|${r.requestedQty}|${r.confirmedQty}|${r.bookedQty}|${r.status}|${r.brand}|${r.user}`)
      .sort();
    const before = snapshot(rows);

    const server = await serve(SALES);
    await call(server, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, {
      lineIds: [byId['SKU-D'], byId['SKU-C'], byId['SKU-B'], byId['SKU-A']],
    });
    await server.close();

    // Compared set-wise: the sequence is allowed to move, every other field on
    // every line is not.
    assert.deepEqual(snapshot(await Order.find({ orderId: ORDER_ID })), before);
  });

  test('refuses a set that drops a line', async () => {
    const rows = await makeBooking();
    const ids = rows.map((r) => String(r._id));
    const server = await serve(SALES);

    const { status, body } = await call(server, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, {
      lineIds: ids.slice(0, 3),
    });
    await server.close();

    // Otherwise a reorder is a silent delete: the fourth line keeps its old
    // lineSeq and quietly reappears in a position nobody chose.
    assert.equal(status, 400);
    assert.match(body.message, /do not match this booking/i);
    assert.deepEqual(await readOrder(), ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D']);
  });

  test('refuses a line belonging to another booking', async () => {
    const rows = await makeBooking();
    const ids = rows.map((r) => String(r._id));
    const foreign = await Order.create({
      orderId: 'BO-2026-000099', brand: 'Koken', user: CUSTOMER,
      status: 'PO Received', skuCode: 'SKU-ELSEWHERE', requestedQty: 1, confirmedQty: 1,
    });

    const server = await serve(SALES);
    const { status } = await call(server, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, {
      lineIds: [...ids.slice(0, 3), String(foreign._id)],
    });
    await server.close();

    assert.equal(status, 400);
    // The other booking must be untouched - a cross-booking write here would
    // reorder a stranger's lines.
    const other = await Order.findById(foreign._id).lean();
    assert.equal(other.lineSeq, null);
  });

  test('refuses a duplicated line', async () => {
    const rows = await makeBooking();
    const ids = rows.map((r) => String(r._id));
    const server = await serve(SALES);

    const { status, body } = await call(server, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, {
      lineIds: [ids[0], ids[0], ids[1], ids[2]],
    });
    await server.close();

    assert.equal(status, 400);
    assert.match(body.message, /more than once/i);
  });

  test('records the previous order in the audit trail', async () => {
    const rows = await makeBooking();
    const byId = Object.fromEntries(rows.map((r) => [r.skuCode, String(r._id)]));
    const server = await serve(SALES);

    await call(server, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, {
      lineIds: [byId['SKU-C'], byId['SKU-A'], byId['SKU-D'], byId['SKU-B']],
    });
    await server.close();

    const entry = await AuditLog.findOne({ action: 'Booking Lines Reordered' }).lean();
    assert.ok(entry, 'a reorder is an edit and must be recorded');
    // The customer's original submission order is only recoverable from here,
    // which is why it has to be captured.
    assert.deepEqual(entry.meta.from, ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D']);
    assert.deepEqual(entry.meta.to, ['SKU-C', 'SKU-A', 'SKU-D', 'SKU-B']);
    assert.equal(String(entry.user), String(SALES._id));
  });

  test('saving an unchanged order writes no audit noise', async () => {
    const rows = await makeBooking();
    const ids = rows.map((r) => String(r._id));
    const server = await serve(SALES);

    await call(server, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, { lineIds: ids });
    await server.close();

    assert.equal(await AuditLog.countDocuments({ action: 'Booking Lines Reordered' }), 0);
  });

  test('a Customer cannot reorder', async () => {
    const rows = await makeBooking();
    const ids = rows.map((r) => String(r._id));
    const server = await serve(CUSTOMER_USER);

    const { status } = await call(server, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, {
      lineIds: [...ids].reverse(),
    });
    await server.close();

    assert.equal(status, 403);
    assert.deepEqual(await readOrder(), ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D']);
  });

  test('Sales cannot reorder once the PO is raised, but Admin can', async () => {
    const rows = await makeBooking({ poNumber: 'PO-2026-000001', poGeneratedAt: new Date() });
    const ids = rows.map((r) => String(r._id)).reverse();

    const asSales = await serve(SALES);
    const sales = await call(asSales, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, { lineIds: ids });
    await asSales.close();
    // 423 Locked, the same answer every other amendment gives.
    assert.equal(sales.status, 423);

    const asAdmin = await serve(ADMIN);
    const admin = await call(asAdmin, 'PUT', `/api/sales/bookings/${ORDER_ID}/line-order`, { lineIds: ids });
    await asAdmin.close();
    assert.equal(admin.status, 200);
    assert.deepEqual(await readOrder(), ['SKU-D', 'SKU-C', 'SKU-B', 'SKU-A']);
  });
});

// ---------------------------------------------------------------------------
// Requirement 3 + 4 - Admin editing
// ---------------------------------------------------------------------------

describe('Admin editing submitted details', () => {
  const path = `/api/sales/bookings/${ORDER_ID}/details`;

  test('corrects a shop number after Sales submitted it', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    const { status } = await call(server, 'PATCH', path, { shopNumber: '105' });
    await server.close();

    assert.equal(status, 200);
    const rows = await Order.find({ orderId: ORDER_ID }).select('shopNumber').lean();
    assert.equal(rows[0].shopNumber, '105');
  });

  test('writes the change to EVERY line of the booking', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    await call(server, 'PATCH', path, { shopNumber: '105', vendorCode: 'VEN-999' });
    await server.close();

    const rows = await Order.find({ orderId: ORDER_ID }).select('shopNumber vendorCode').lean();
    assert.equal(rows.length, 4);
    // A per-row denormalised field updated on only the first row leaves a
    // booking whose shop number depends on which line you happen to read.
    assert.ok(rows.every((r) => r.shopNumber === '105' && r.vendorCode === 'VEN-999'));
  });

  test('works AFTER the PO is raised - the entire point of the requirement', async () => {
    await makeBooking({ poNumber: 'PO-2026-000001', poGeneratedAt: new Date() });
    const server = await serve(ADMIN);

    const { status } = await call(server, 'PATCH', path, { shopNumber: '105' });
    await server.close();

    assert.equal(status, 200);
    const row = await Order.findOne({ orderId: ORDER_ID }).select('shopNumber').lean();
    assert.equal(row.shopNumber, '105');
  });

  test('maps customerName onto the company column the readers use', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    await call(server, 'PATCH', path, { customerName: 'ABC Motors Pvt Ltd' });
    await server.close();

    const row = await Order.findOne({ orderId: ORDER_ID }).select('company').lean();
    assert.equal(row.company, 'ABC Motors Pvt Ltd');
  });

  test('a promise date also writes supplyByDate, as raisePo does', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    await call(server, 'PATCH', path, { promiseDate: '2026-10-01T00:00:00.000Z' });
    await server.close();

    const row = await Order.findOne({ orderId: ORDER_ID }).select('promiseDate supplyByDate').lean();
    // Readers take `promiseDate || supplyByDate` as one booking-level fact;
    // moving only one of them makes the picklist disagree with the PO.
    assert.equal(row.promiseDate.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(row.supplyByDate.toISOString(), '2026-10-01T00:00:00.000Z');
  });

  // ── Requirement 4: protected fields ──────────────────────────────────────

  test('refuses a quantity, by name, rather than ignoring it', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    const { status, body } = await call(server, 'PATCH', path, { confirmedQty: 999 });
    await server.close();

    assert.equal(status, 400);
    assert.match(body.message, /confirmedQty/);
    // The dangerous outcome is not the refusal, it is a 200 that silently
    // dropped the field and left the Admin believing stock had moved.
    const row = await Order.findOne({ orderId: ORDER_ID }).select('confirmedQty').lean();
    assert.equal(row.confirmedQty, 10);
  });

  test('refuses status, SKU and ownership', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    for (const payload of [{ status: 'Dispatched' }, { skuCode: 'SKU-Z' }, { user: String(ADMIN._id) }]) {
      const { status, body } = await call(server, 'PATCH', path, payload);
      assert.equal(status, 400, `${Object.keys(payload)[0]} must be refused`);
      assert.match(body.message, new RegExp(Object.keys(payload)[0]));
    }
    await server.close();

    const row = await Order.findOne({ orderId: ORDER_ID }).lean();
    assert.equal(row.status, 'PO Received');
    assert.equal(String(row.user), String(CUSTOMER));
  });

  test('refuses the PO provenance fields that make the lock meaningful', async () => {
    await makeBooking({ poNumber: 'PO-2026-000001', poGeneratedAt: new Date() });
    const server = await serve(ADMIN);

    const { status } = await call(server, 'PATCH', path, { poGeneratedBy: String(ADMIN._id) });
    await server.close();

    // Forging this would falsify who is accountable for raising the PO.
    assert.equal(status, 400);
  });

  test('every protected field is absent from the editable list', () => {
    // Belt and braces against a future edit that adds a key to EDITABLE_FIELDS
    // without noticing it was deliberately excluded.
    for (const key of Object.keys(PROTECTED_FIELDS)) {
      assert.ok(!EDITABLE_KEYS.includes(key), `${key} must not be editable`);
    }
  });

  // ── Requirement 6: validation ────────────────────────────────────────────

  test('rejects a malformed GST number', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    const { status, body } = await call(server, 'PATCH', path, { gstCode: 'NOT-A-GST' });
    await server.close();

    assert.equal(status, 400);
    assert.equal(body.field, 'gstCode');
    const row = await Order.findOne({ orderId: ORDER_ID }).select('gstCode').lean();
    assert.equal(row.gstCode, '27AAPFU0939F1ZV', 'the old value survives a rejected edit');
  });

  test('accepts a valid GST number and stores it upper-cased', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    const { status } = await call(server, 'PATCH', path, { gstCode: '29aapfu0939f1zv' });
    await server.close();

    assert.equal(status, 200);
    const row = await Order.findOne({ orderId: ORDER_ID }).select('gstCode').lean();
    assert.equal(row.gstCode, '29AAPFU0939F1ZV');
  });

  test('refuses a PO number already used by another booking', async () => {
    await makeBooking();
    await Order.create({
      orderId: 'BO-2026-000099', brand: 'Koken', user: CUSTOMER, status: 'PO Received',
      skuCode: 'SKU-OTHER', requestedQty: 1, confirmedQty: 1, poNumber: 'PO-2026-000777',
    });

    const server = await serve(ADMIN);
    const { status, body } = await call(server, 'PATCH', path, { poNumber: 'PO-2026-000777' });
    await server.close();

    // The same rule raisePo enforces: two bookings sharing a PO number make the
    // customer's payment ambiguous.
    assert.equal(status, 409);
    assert.match(body.message, /BO-2026-000099/);
  });

  test('refuses to clear the PO number, which would silently unlock the booking', async () => {
    await makeBooking({ poNumber: 'PO-2026-000001', poGeneratedAt: new Date() });
    const server = await serve(ADMIN);

    const { status, body } = await call(server, 'PATCH', path, { poNumber: '' });
    await server.close();

    assert.equal(status, 400);
    assert.match(body.message, /cannot be cleared/i);
  });

  test('an optional field CAN be cleared', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    const { status } = await call(server, 'PATCH', path, { location: '' });
    await server.close();

    assert.equal(status, 200);
    const row = await Order.findOne({ orderId: ORDER_ID }).select('location').lean();
    // null, not '' - every reader tests truthiness and falls back to the
    // customer master, which an empty string would defeat.
    assert.equal(row.location, null);
  });

  // ── Requirement 5: audit ─────────────────────────────────────────────────

  test('records who changed which field, from what, to what', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    await call(server, 'PATCH', path, { shopNumber: '105', vendorCode: 'VEN-002' });
    await server.close();

    const entry = await AuditLog.findOne({ action: 'Booking Details Edited' }).lean();
    assert.ok(entry);
    assert.equal(String(entry.user), String(ADMIN._id));
    assert.ok(entry.createdAt);

    const shop = entry.meta.changes.find((c) => c.field === 'shopNumber');
    assert.deepEqual(
      { field: shop.field, from: shop.from, to: shop.to },
      { field: 'shopNumber', from: '102', to: '105' },
    );
    assert.equal(entry.meta.changes.length, 2);
  });

  test('a save that changes nothing records nothing', async () => {
    await makeBooking();
    const server = await serve(ADMIN);

    const { status } = await call(server, 'PATCH', path, { shopNumber: '102' });
    await server.close();

    assert.equal(status, 200);
    assert.equal(await AuditLog.countDocuments({ action: 'Booking Details Edited' }), 0);
  });

  // ── Requirement 4 + 7: permissions ───────────────────────────────────────

  test('Sales cannot edit submitted details', async () => {
    await makeBooking();
    const server = await serve(SALES);

    const { status } = await call(server, 'PATCH', path, { shopNumber: '105' });
    await server.close();

    // Separation of duties: raising the PO locks the booking against the role
    // that raised it.
    assert.equal(status, 403);
    const row = await Order.findOne({ orderId: ORDER_ID }).select('shopNumber').lean();
    assert.equal(row.shopNumber, '102');
  });

  test('a Customer cannot edit submitted details', async () => {
    await makeBooking();
    const server = await serve(CUSTOMER_USER);

    const { status } = await call(server, 'PATCH', path, { shopNumber: '105' });
    await server.close();

    assert.equal(status, 403);
  });

  test('a missing booking is 404, not a silent success', async () => {
    const server = await serve(ADMIN);
    const { status } = await call(server, 'PATCH', '/api/sales/bookings/BO-NOPE/details', {
      shopNumber: '105',
    });
    await server.close();

    assert.equal(status, 404);
  });
});

// ---------------------------------------------------------------------------

describe('field coercion', () => {
  test('trims, and turns blank into null rather than an empty string', () => {
    assert.equal(coerceField('shopNumber', '  105  '), '105');
    assert.equal(coerceField('shopNumber', '   '), null);
    assert.equal(coerceField('shopNumber', null), null);
  });

  test('refuses an over-long value instead of letting Mongo truncate silently', () => {
    assert.throws(() => coerceField('shopNumber', 'x'.repeat(61)), /cannot be longer/);
  });

  test('refuses an unparseable date', () => {
    assert.throws(() => coerceField('poDate', 'not-a-date'), /not a valid date/);
  });

  test('refuses a field that is not on the editable list', () => {
    assert.throws(() => coerceField('confirmedQty', 5), /not an editable field/);
  });
});
