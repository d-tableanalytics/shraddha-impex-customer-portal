/**
 * SMOKE TEST — Upcoming Stock module only.
 *
 * Every case is numbered (US-xx) to match the smoke-test report. Runs the real
 * app.js over HTTP — real routes, real permission checks, real services —
 * against a throwaway in-memory replica set. Only auth is stubbed (x-test-user)
 * and outgoing mail is captured instead of sent. The live database is never
 * touched.
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
const sent = [];
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async (to, subject) => { sent.push({ to, subject }); return true; } },
});
mock.module(new URL('../middlewares/auth.js', import.meta.url).href, {
  namedExports: {
    protect: async (req, res, next) => {
      const id = req.headers['x-test-user'];
      const user = id && mongoose.isValidObjectId(id) ? await UserModel.findById(id).lean() : null;
      if (!user) return res.status(401).json({ success: false, message: 'Not authorized to access this route.' });
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
const { default: StockMovement } = await import('../models/StockMovement.js');
const { default: UpcomingShipment } = await import('../models/UpcomingShipment.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { istYmd } = await import('../utils/businessDay.js');

const DAY = 864e5;
let server;
let U;

before(async () => {
  await startTestReplSet();
  server = await startServer(app);
});
after(async () => {
  await server?.close();
  await stopTestMongo();
});

let seq = 0;
const mkUser = async (role, extra = {}) => (await User.create({
  email: `${role.replace(/\s/g, '').toLowerCase()}${++seq}@example.com`, password: 'x'.repeat(12),
  user: `${role} ${seq}`, company: `${role} Co ${seq}`, role, ...extra,
})).toObject();

beforeEach(async () => {
  await clearCollections();
  await seedBrands();
  sent.length = 0;
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  // Manual mode: the real assignment rule holds arriving stock, so nothing in
  // these tests books an indent unless a test says so.
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'manual', effectiveFrom: new Date(0) });
  U = {
    admin: await mkUser('Admin'),
    sales: await mkUser('Sales', { brandAccess: { koken: true } }),
    im: await mkUser('Inventory Manager'),
    mgmt: await mkUser('Management'),
    importTeam: await mkUser('Import Team'),
    wh: await mkUser('Warehouse User'),
    c1: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
    c2: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
    c3: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const http = async (method, url, who, body) => {
  const headers = who ? { 'x-test-user': String(who._id) } : {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${server.url}${url}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const GET = (url, who) => http('GET', url, who);
const POST = (url, who, body) => http('POST', url, who, body);
const BASE = '/api/v1/inventory/upcoming';
const ymd = (days) => istYmd(new Date(Date.now() + days * DAY));
let rid = 0;
const nextId = (p) => `${p}-${Date.now()}-${++rid}`;

const product = (sku) => createProductModel('Koken').create({
  skuCode: sku, availableForSale: 0, totalAvailableQuantity: 0, bookedQuantity: 0,
});
const rows = (list) => list.map((r, i) => ({ row: i + 2, brand: 'Koken', ...r }));
const preview = (list, who = U.importTeam) => POST(`${BASE}/import/preview`, who, { rows: rows(list) });
const upload = (list, who = U.importTeam, importId = nextId('imp')) => POST(`${BASE}/import`, who, {
  importId, fileName: 'smoke.xlsx', rows: rows(list),
});
const list = async (who = U.admin) => {
  const res = await GET(BASE, who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const itemOf = async (sku, who = U.admin) => (await list(who)).items.find((i) => i.skuCode === sku);

/** An open indent for `qty` of `sku`, raised `daysAgo` days ago (nothing in stock). */
const indent = async (who, p, qty, daysAgo) => {
  const res = await POST('/api/v1/reservations/direct-booking', who, { items: [{ productId: String(p._id), quantity: qty }] });
  assert.ok(res.status < 300, `booking failed: ${res.status} ${JSON.stringify(res.body)}`);
  const orderId = res.body.data.orderId || res.body.data.indentId.replace(/^PI-/, 'BO-');
  const number = orderId.replace(/^BO-/, 'PI-');
  await Reservation.updateMany({ indentNumber: number }, { $set: { reservationDate: new Date(Date.now() - daysAgo * DAY) } });
  return Reservation.findOne({ indentNumber: number }).lean();
};

/** Three customers waiting on SKU-S: oldest 10 (c1), then 6 (c2), newest 8 (c3) — 24 in all. */
const threeIndents = async () => {
  const p = await product('SKU-S');
  const oldest = await indent(U.c1, p, 10, 30);
  const middle = await indent(U.c2, p, 6, 20);
  const newest = await indent(U.c3, p, 8, 10);
  return { p, oldest, middle, newest };
};
const fifo = (item) => item.indents.map((i) => [i.indentNumber, i.requiredQty, i.reservedQty, i.shortQty]);

/** Everything outside Upcoming Stock that the module must never change. */
const snapshotOutside = async () => ({
  products: await Product.find({}, 'skuCode totalAvailableQuantity availableForSale bookedQuantity').sort({ skuCode: 1 }).lean(),
  balances: await StockBalance.find({}, 'skuCode onHand reserved').sort({ skuCode: 1 }).lean(),
  movements: await StockMovement.countDocuments(),
  indents: await Reservation.find({}, 'indentNumber status quantity').sort({ indentNumber: 1 }).lean(),
  orders: await Order.find({}, 'orderId status confirmedQty allocations').sort({ orderId: 1 }).lean(),
  notifications: await mongoose.connection.collection('notifications').countDocuments(),
});

// ── 1. File upload and import ───────────────────────────────────────────────

describe('1. File upload and import', () => {
  test('US-01 a valid file previews cleanly and uploads', async () => {
    await product('SKU-A');
    const pv = await preview([{ skuCode: 'SKU-A', qty: 100, eta: ymd(10), ref: 'PO-1', supplier: 'Koken Japan' }]);
    assert.equal(pv.status, 200);
    assert.equal(pv.body.data.lines[0].outcome, 'existing');
    const res = await upload([{ skuCode: 'SKU-A', qty: 100, eta: ymd(10), ref: 'PO-1', supplier: 'Koken Japan' }]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.data.lines, res.body.data.qty], [1, 100]);
    const item = await itemOf('SKU-A');
    assert.deepEqual([item.upcoming, item.shipments[0].ref, item.shipments[0].supplier], [100, 'PO-1', 'Koken Japan']);
  });

  test('US-02 an empty file is refused with a clear message', async () => {
    const res = await POST(`${BASE}/import/preview`, U.importTeam, { rows: [] });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'The file has no data rows.');
    const up = await POST(`${BASE}/import`, U.importTeam, { importId: nextId('x'), fileName: 'e.xlsx', rows: [] });
    assert.equal(up.status, 400);
    assert.equal(await UpcomingShipment.countDocuments(), 0);
  });

  test('US-03 missing required columns (SKU, quantity) are reported per row', async () => {
    await product('SKU-A');
    const pv = await preview([{ qty: 5 }, { skuCode: 'SKU-A' }]);
    const [noSku, noQty] = pv.body.data.lines;
    assert.match(noSku.problems.join(), /SKU code is missing/);
    assert.match(noQty.problems.join(), /Quantity "" is not a whole number above 0/);
  });

  test('US-04 invalid formats and incorrect data are rejected with clear reasons', async () => {
    await product('SKU-A');
    const pv = await preview([
      { skuCode: 'SKU-A', qty: 'abc' },
      { skuCode: 'SKU-A', qty: 0 },
      { skuCode: 'SKU-A', qty: -5 },
      { skuCode: 'SKU-A', qty: 2.5 },
      { skuCode: 'SKU-A', qty: 5, eta: '31/13/2026' },
      { skuCode: 'SKU-A', qty: 5, brand: 'NoSuchBrand' },
      { skuCode: 'NEW-NO-BRAND', qty: 5, brand: '' },
    ]);
    const msgs = pv.body.data.lines.map((l) => [l.outcome, l.problems.join(' | ')]);
    assert.ok(msgs.every(([o]) => o === 'error'), JSON.stringify(msgs));
    assert.match(msgs[0][1], /"abc" is not a whole number above 0/);
    assert.match(msgs[1][1], /"0" is not a whole number above 0/);
    assert.match(msgs[2][1], /"-5" is not a whole number above 0/);
    assert.match(msgs[3][1], /"2.5" is not a whole number above 0/);
    assert.match(msgs[4][1], /"31\/13\/2026" is not a date/);
    assert.match(msgs[5][1], /Brand "NoSuchBrand" does not exist/);
    assert.match(msgs[6][1], /not in Inventory Master — give its brand/);
  });

  test('US-05 a file with only invalid rows cannot be imported; nothing is recorded', async () => {
    await product('SKU-A');
    const res = await upload([{ skuCode: 'SKU-A', qty: 0 }, { skuCode: '', qty: 3 }]);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /No row in the file can be imported/);
    assert.equal(await UpcomingShipment.countDocuments(), 0);
  });

  test('US-06 valid rows import and invalid rows are skipped, as the preview said', async () => {
    await product('SKU-A');
    const res = await upload([{ skuCode: 'SKU-A', qty: 40, ref: 'PO-1' }, { skuCode: 'SKU-A', qty: 'TBC', ref: 'PO-2' }]);
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.data.lines, res.body.data.skipped], [1, 1]);
  });

  test('US-07 duplicate rows are merged and their quantities combined', async () => {
    await product('SKU-A');
    const dup = [
      { skuCode: 'SKU-A', qty: 100, ref: 'PO-1', eta: ymd(20) },
      { skuCode: 'sku-a', qty: 50, ref: 'po-1', eta: ymd(10) },
      { skuCode: 'SKU-A', qty: 25, ref: 'PO-2' },
    ];
    const pv = await preview(dup);
    assert.equal(pv.body.data.lines.length, 2);
    assert.match(pv.body.data.lines[0].notes.join(), /Merged rows 2, 3 \(100 \+ 50 = 150\)/);
    const res = await upload(dup);
    assert.deepEqual([res.body.data.lines, res.body.data.qty, res.body.data.merged], [2, 175, 1]);
    const merged = await UpcomingShipment.findOne({ refKey: 'po-1' }).lean();
    assert.equal(merged.orderedQty, 150);
    assert.equal(istYmd(merged.eta), ymd(10), 'earliest date kept');
  });

  test('US-08 a file over the row limit is refused with a clear message', async () => {
    const big = Array.from({ length: 2001 }, (_, i) => ({ row: i + 2, skuCode: 'SKU-A', qty: 1 }));
    const res = await POST(`${BASE}/import/preview`, U.importTeam, { rows: big });
    assert.equal(res.status, 413);
    assert.match(res.body.message, /import at most 2000 at a time/);
  });

  test('US-09 only SKU and quantity are required; a new SKU with a brand is created with zero stock', async () => {
    await product('SKU-A');
    const res = await upload([{ skuCode: 'SKU-A', qty: 7 }, { skuCode: 'SMOKE-NEW-1', brand: 'Koken', qty: 3 }]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.created, 1);
    const created = await Product.findOne({ skuCode: 'SMOKE-NEW-1' }).lean();
    assert.equal(created.totalAvailableQuantity, 0);
  });
});

// ── 2. Automatic FIFO reservation ───────────────────────────────────────────

describe('2. Automatic FIFO reservation', () => {
  test('US-10 reservations are calculated automatically right after upload', async () => {
    await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    const item = await itemOf('SKU-S'); // the very next read — no other call
    assert.equal(item.reserved, 20);
    assert.ok(item.indents.every((i) => typeof i.reservedQty === 'number'));
  });

  test('US-11 older indents receive stock before newer ones', async () => {
    const { oldest, middle, newest } = await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    const item = await itemOf('SKU-S');
    assert.deepEqual(fifo(item), [
      [oldest.indentNumber, 10, 10, 0],
      [middle.indentNumber, 6, 6, 0],
      [newest.indentNumber, 8, 4, 4],
    ]);
    assert.deepEqual(item.indents.map((i) => i.fifoPosition), [1, 2, 3]);
  });

  test('US-12 manual reservation is removed (endpoints gone)', async () => {
    await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    for (const path of ['/reservations', '/reservations/abc/release', '/holds', '/holds/resume', '/customers']) {
      const res = path === '/customers' ? await GET(`${BASE}${path}`, U.admin) : await POST(`${BASE}${path}`, U.admin, {});
      assert.equal(res.status, 404, path);
    }
  });

  test('US-13 reservations never exceed the upcoming quantity (many random cases)', async () => {
    await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 77, ref: 'PO-SEED' }]); // a value the loop never uses
    const id = String((await UpcomingShipment.findOne({}).lean())._id);
    for (const qty of [1, 5, 9, 10, 15, 16, 23, 24, 25, 100]) {
      assert.equal((await http('PATCH', `${BASE}/shipments/${id}`, U.importTeam, { orderedQty: qty })).status, 200);
      const item = await itemOf('SKU-S');
      const sum = item.indents.reduce((s, i) => s + i.reservedQty, 0);
      assert.equal(sum, item.reserved, `qty ${qty}: per-indent sum = total`);
      assert.ok(item.reserved <= item.upcoming, `qty ${qty}: reserved ${item.reserved} <= upcoming ${item.upcoming}`);
      assert.equal(item.reserved, Math.min(qty, 24), `qty ${qty}`);
      assert.equal(item.remaining, Math.max(0, qty - 24), `qty ${qty}`);
      assert.ok(item.indents.every((i) => i.reservedQty <= i.requiredQty), `qty ${qty}: no indent over-filled`);
    }
  });

  test('US-14 stock is used earliest arrival first, and each indent shows its shipment', async () => {
    await threeIndents();
    await upload([
      { skuCode: 'SKU-S', qty: 12, eta: ymd(30), ref: 'PO-LATE' },
      { skuCode: 'SKU-S', qty: 7, eta: ymd(5), ref: 'PO-SOON' },
    ]);
    const item = await itemOf('SKU-S');
    assert.deepEqual(item.indents.map((i) => i.coveredBy.map((c) => `${c.ref}:${c.qty}`)), [
      ['PO-SOON:7', 'PO-LATE:3'], ['PO-LATE:6'], ['PO-LATE:3'],
    ]);
  });

  test('US-15 indents that are no longer open are left out of the allocation', async () => {
    const { oldest } = await threeIndents();
    await Reservation.updateOne({ _id: oldest._id }, { $set: { status: 'Cancelled' } });
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    const item = await itemOf('SKU-S');
    assert.equal(item.indents.length, 2);
    assert.deepEqual(item.indents.map((i) => i.reservedQty), [6, 8]);
    assert.equal(item.remaining, 6);
  });
});

// ── 3. Reserved and remaining stock ─────────────────────────────────────────

describe('3. Reserved and remaining stock', () => {
  const scenario = async (qty) => {
    await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty, ref: 'PO-9' }]);
    return itemOf('SKU-S');
  };

  test('US-20 upcoming greater than total indent demand', async () => {
    const item = await scenario(40);
    assert.deepEqual([item.demand, item.upcoming, item.reserved, item.remaining], [24, 40, 24, 16]);
    assert.ok(item.indents.every((i) => i.shortQty === 0));
    assert.equal(item.status, 'Available', '16 of 40 free is above the 20% line');
  });

  test('US-20b just above demand: status follows the 20% Low Remaining rule', async () => {
    const item = await scenario(30);
    assert.deepEqual([item.reserved, item.remaining], [24, 6]);
    assert.equal(item.status, 'Low Remaining', '6 of 30 free is exactly 20%');
  });

  test('US-21 upcoming less than total indent demand', async () => {
    const item = await scenario(13);
    assert.deepEqual([item.reserved, item.remaining], [13, 0]);
    assert.deepEqual(item.indents.map((i) => [i.reservedQty, i.shortQty]), [[10, 0], [3, 3], [0, 8]]);
    assert.equal(item.status, 'Fully Reserved');
  });

  test('US-22 upcoming exactly matches total indent demand', async () => {
    const item = await scenario(24);
    assert.deepEqual([item.reserved, item.remaining], [24, 0]);
    assert.ok(item.indents.every((i) => i.reservedQty === i.requiredQty));
  });

  test('US-23 no eligible indents: nothing reserved, all of it remaining', async () => {
    await product('SKU-N');
    await upload([{ skuCode: 'SKU-N', qty: 40, ref: 'PO-1' }]);
    const item = await itemOf('SKU-N');
    assert.deepEqual([item.indents.length, item.reserved, item.remaining, item.status], [0, 0, 40, 'Available']);
  });

  test('US-24 zero or invalid quantities are never recorded and never allocated', async () => {
    await threeIndents();
    const res = await upload([{ skuCode: 'SKU-S', qty: 0, ref: 'PO-0' }, { skuCode: 'SKU-S', qty: 'x', ref: 'PO-X' }]);
    assert.equal(res.status, 400);
    assert.equal(await itemOf('SKU-S'), undefined, 'no upcoming stock, so no allocation');
    const id = String((await upload([{ skuCode: 'SKU-S', qty: 5, ref: 'PO-5' }]).then(() => UpcomingShipment.findOne({}).lean()))._id);
    assert.equal((await http('PATCH', `${BASE}/shipments/${id}`, U.importTeam, { orderedQty: 0 })).status, 400, 'edit to 0 refused');
  });

  test('US-25 summary cards add up across SKUs', async () => {
    await threeIndents();
    await product('SKU-N');
    await upload([{ skuCode: 'SKU-S', qty: 13, ref: 'PO-9' }, { skuCode: 'SKU-N', qty: 40, ref: 'PO-1' }]);
    const { items } = await list();
    const t = items.reduce((a, i) => ({ up: a.up + i.upcoming, res: a.res + i.reserved, rem: a.rem + i.remaining }), { up: 0, res: 0, rem: 0 });
    assert.deepEqual(t, { up: 53, res: 13, rem: 40 });
    assert.ok(items.every((i) => i.upcoming === i.reserved + i.remaining));
  });
});

// ── 4. Internal analysis only ───────────────────────────────────────────────

describe('4. Internal analysis only', () => {
  test('US-30 inventory, indents, bookings and the stock ledger are not modified', async () => {
    await threeIndents();
    const before = await snapshotOutside();
    sent.length = 0;
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    for (let i = 0; i < 3; i += 1) await list();
    const after = await snapshotOutside();
    assert.deepEqual(after, before);
  });

  test('US-31 no email or notification is sent', async () => {
    await threeIndents();
    const notes = await mongoose.connection.collection('notifications').countDocuments();
    sent.length = 0;
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    await list();
    assert.equal(sent.length, 0, 'no email');
    assert.equal(await mongoose.connection.collection('notifications').countDocuments(), notes, 'no notification');
  });

  test('US-32 nothing about the allocation is stored', async () => {
    await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    await list();
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    if (names.includes('upcomingreservations')) {
      assert.equal(await mongoose.connection.collection('upcomingreservations').countDocuments(), 0);
    }
  });

  test('US-33 internal users can see the results; customers and anonymous users cannot', async () => {
    await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    for (const who of ['admin', 'sales', 'im', 'mgmt', 'importTeam', 'wh']) {
      const res = await GET(BASE, U[who]);
      assert.equal(res.status, 200, who);
      assert.equal(res.body.data.items.find((i) => i.skuCode === 'SKU-S').reserved, 20, who);
    }
    assert.equal((await GET(BASE, U.c1)).status, 403, 'customer');
    assert.equal((await GET(BASE, null)).status, 401, 'not signed in');
    // Customer names only for roles that already see them (booking desk / assignment).
    assert.notEqual((await itemOf('SKU-S', U.sales)).indents[0].customer, '—');
    assert.equal((await itemOf('SKU-S', U.wh)).indents[0].customer, '—');
  });

  test('US-34 only master-data roles can upload or change entries', async () => {
    await product('SKU-A');
    const file = [{ skuCode: 'SKU-A', qty: 5, ref: 'PO-1' }];
    for (const who of ['sales', 'wh', 'mgmt']) assert.equal((await upload(file, U[who])).status, 403, who);
    for (const who of ['c1']) assert.equal((await upload(file, U[who])).status, 403, who);
    assert.equal((await upload(file, U.im)).status, 201);
  });
});

// ── 5. Data integrity ───────────────────────────────────────────────────────

describe('5. Data integrity', () => {
  test('US-40 refreshing the page repeatedly gives identical results', async () => {
    await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    const first = await itemOf('SKU-S');
    for (let i = 0; i < 5; i += 1) {
      const again = await itemOf('SKU-S');
      assert.deepEqual(fifo(again), fifo(first));
      assert.deepEqual([again.reserved, again.remaining, again.upcoming], [first.reserved, first.remaining, first.upcoming]);
    }
    const [a, b, c] = await Promise.all([itemOf('SKU-S'), itemOf('SKU-S'), itemOf('SKU-S')]);
    assert.deepEqual([fifo(a), fifo(b)], [fifo(c), fifo(c)], 'parallel refreshes agree');
  });

  test('US-41 re-submitting the same upload records it once', async () => {
    await product('SKU-A');
    const file = [{ skuCode: 'SKU-A', qty: 50, ref: 'PO-1' }];
    const id = nextId('same');
    const [a, b] = await Promise.all([upload(file, U.importTeam, id), upload(file, U.importTeam, id)]);
    assert.ok([a.status, b.status].every((s) => s === 201 || s === 409), `${a.status} ${b.status}`);
    const third = await upload(file, U.importTeam, id);
    assert.equal(third.body.data.replayed, true);
    assert.equal(await UpcomingShipment.countDocuments(), 1);
    assert.equal((await itemOf('SKU-A')).upcoming, 50);
  });

  test('US-42 uploading the same file again (new upload) refuses lines already recorded', async () => {
    await product('SKU-A');
    const file = [{ skuCode: 'SKU-A', qty: 50, ref: 'PO-1' }];
    await upload(file);
    const again = await upload(file);
    assert.equal(again.status, 400);
    const pv = await preview(file);
    assert.match(pv.body.data.lines[0].problems.join(), /Already on upcoming stock under PO-1/);
    assert.equal((await itemOf('SKU-A')).upcoming, 50, 'not doubled');
  });

  test('US-43 a second file with new shipments adds to upcoming and re-runs FIFO', async () => {
    await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 10, ref: 'PO-1' }]);
    assert.equal((await itemOf('SKU-S')).reserved, 10);
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-2' }]);
    const item = await itemOf('SKU-S');
    assert.deepEqual([item.upcoming, item.reserved, item.remaining], [30, 24, 6]);
  });

  test('US-44 existing functions still work: edit, cancel, delete, and FIFO follows each', async () => {
    await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-1' }, { skuCode: 'SKU-S', qty: 10, ref: 'PO-2' }]);
    const line = async (ref) => String((await UpcomingShipment.findOne({ shipmentRef: ref }).lean())._id);
    assert.equal((await itemOf('SKU-S')).reserved, 24);

    assert.equal((await http('PATCH', `${BASE}/shipments/${await line('PO-1')}`, U.importTeam, { orderedQty: 5, eta: ymd(3) })).status, 200);
    assert.deepEqual([(await itemOf('SKU-S')).upcoming, (await itemOf('SKU-S')).reserved], [15, 15]);

    assert.equal((await POST(`${BASE}/shipments/${await line('PO-2')}/cancel`, U.importTeam, {})).status, 200);
    assert.deepEqual([(await itemOf('SKU-S')).upcoming, (await itemOf('SKU-S')).reserved], [5, 5]);

    assert.equal((await http('DELETE', `${BASE}/shipments/${await line('PO-1')}`, U.importTeam)).status, 200);
    assert.equal(await itemOf('SKU-S'), undefined, 'nothing upcoming left: off the list');
  });

  test('US-45 stock received into inventory reduces upcoming; FIFO recalculates; still nothing booked', async () => {
    const { p } = await threeIndents();
    await upload([{ skuCode: 'SKU-S', qty: 20, ref: 'PO-9' }]);
    const res = await POST('/api/v1/inventory/items/SKU-S/adjust', U.admin, { brand: 'Koken', mode: 'delta', quantity: 8 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const item = await itemOf('SKU-S');
    assert.deepEqual([item.actual, item.upcoming, item.reserved], [8, 12, 12]);
    // Manual assignment mode: the real rule holds the 8; the indents are unchanged.
    assert.deepEqual(item.indents.map((i) => i.requiredQty), [10, 6, 8]);
    assert.equal((await Product.findById(p._id).lean()).bookedQuantity, 0);
  });

  test('US-46 brand access: a user sees only their brands', async () => {
    await product('SKU-A');
    await upload([{ skuCode: 'SKU-A', qty: 5, ref: 'PO-1' }]);
    const bixOnly = await mkUser('Sales', { brandAccess: { bix: true } });
    assert.equal((await list(bixOnly)).items.length, 0);
  });
});
