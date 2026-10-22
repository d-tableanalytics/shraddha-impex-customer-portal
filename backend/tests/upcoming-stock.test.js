/**
 * Upcoming Stock — ordered but not yet received, linked to the real inventory.
 *
 * Driven through the real app.js over HTTP (auth.js stubbed via x-test-user),
 * against a transactional replica set, with the real role permissions. Stock
 * arrives the way it does in production — through Update Stock — so these
 * tests exercise the whole chain: ledger → balance → processAvailableIndents →
 * upcoming sync → reserved indents assigned before the FIFO pass.
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
// Every email the app tries to send, so a test can prove Upcoming Stock sent none.
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
const { default: AuditLog } = await import('../models/AuditLog.js');
const { default: UpcomingShipment } = await import('../models/UpcomingShipment.js');
const { default: UpcomingArrival } = await import('../models/UpcomingArrival.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { istYmd } = await import('../utils/businessDay.js');
const { postBatch } = await import('../modules/inventory/ledger.service.js');
const { syncUpcoming } = await import('../modules/inventory/upcomingStock.service.js');

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
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'auto', effectiveFrom: new Date(0) });
  U = {
    admin: await mkUser('Admin'),
    sales: await mkUser('Sales', { brandAccess: { koken: true } }),
    bixSales: await mkUser('Sales', { brandAccess: { bix: true } }),
    im: await mkUser('Inventory Manager'),
    importTeam: await mkUser('Import Team'),
    wh: await mkUser('Warehouse User'),
    customerA: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
    customerB: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
  };
});

// ── HTTP ────────────────────────────────────────────────────────────────────

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
const PATCH = (url, who, body) => http('PATCH', url, who, body);

const BASE = '/api/v1/inventory/upcoming';
const ymd = (days) => istYmd(new Date(Date.now() + days * DAY));
let rid = 0;
const nextId = (p) => `${p}-${Date.now()}-${++rid}`;

// ── Fixtures ────────────────────────────────────────────────────────────────

const product = (sku, units = 0) => createProductModel('Koken').create({
  skuCode: sku, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0,
});

/** Stock moves through the real Update Stock route — the ledger and everything after it. */
const adjust = async (sku, delta) => {
  const res = await POST(`/api/v1/inventory/items/${encodeURIComponent(sku)}/adjust`, U.admin, {
    brand: 'Koken', mode: 'delta', quantity: delta,
  });
  assert.equal(res.status, 201, `adjust failed: ${JSON.stringify(res.body)}`);
  return res.body;
};

const importRows = async (rows, who = U.importTeam, importId = nextId('imp')) => {
  const res = await POST(`${BASE}/import`, who, {
    importId, fileName: 'october.xlsx', rows: rows.map((r, i) => ({ row: i + 2, brand: 'Koken', ...r })),
  });
  return { ...res, importId };
};

const list = async (who = U.admin) => {
  const res = await GET(BASE, who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const itemOf = async (sku, who = U.admin) => (await list(who)).items.find((i) => i.skuCode === sku);


/** Book through the real route, as the customer. Nothing in stock → an indent. */
const book = async (who, p, qty) => {
  const res = await POST('/api/v1/reservations/direct-booking', who, { items: [{ productId: String(p._id), quantity: qty }] });
  assert.ok(res.status < 300, `booking failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.orderId || res.body.data.indentId.replace(/^PI-/, 'BO-');
};
const indentOf = (orderId) => Reservation.findOne({ indentNumber: orderId.replace(/^BO-/, 'PI-') }).lean();
/** An open indent for `qty` of `sku` (whatever is in stock is booked; the rest waits). Its id. */
const indentFor = async (sku, qty, who = U.customerA) => {
  const p = await Product.findOne({ skuCode: sku }).lean();
  return String((await indentOf(await book(who, p, qty)))._id);
};

// ── Import ──────────────────────────────────────────────────────────────────

describe('import', () => {
  test('preview validates every row and writes nothing', async () => {
    await product('SKU-A');
    const res = await POST(`${BASE}/import/preview`, U.importTeam, {
      rows: [
        { row: 2, skuCode: 'SKU-A', brand: 'Koken', qty: 100, eta: ymd(10), ref: 'PO-1' },
        { row: 3, skuCode: 'sku-a', brand: '', qty: '40', eta: ymd(12), ref: 'PO-2' },
        { row: 4, skuCode: 'NEW-1', brand: 'Koken', product: 'Brand new socket', qty: 30, eta: ymd(12), ref: 'PO-2' },
        { row: 5, skuCode: 'NEW-2', brand: '', qty: 30, eta: ymd(12), ref: 'PO-2' },
        { row: 6, skuCode: 'SKU-A', brand: 'Koken', qty: 'TBC', eta: ymd(12), ref: 'PO-3' },
        { row: 7, skuCode: 'SKU-A', brand: 'Koken', qty: 5, eta: '', ref: 'PO-4' },
        { row: 8, skuCode: 'SKU-A', brand: 'Koken', qty: 5, eta: ymd(3), ref: '' },
        { row: 9, skuCode: 'SKU-A', brand: 'Nope', qty: 5, eta: ymd(3), ref: 'PO-5' },
        { row: 10, skuCode: 'SKU-A', brand: 'Koken', qty: 9, eta: ymd(4), ref: 'po-1' },
        { row: 11, skuCode: 'SKU-A', qty: 7 },
        { row: 12, skuCode: 'SKU-A', qty: 7, eta: 'next week' },
        { row: 13, skuCode: 'SKU-A', qty: 3, ref: '' },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byRow = new Map(res.body.data.lines.map((l) => [l.row, l]));
    assert.equal(byRow.get(2).outcome, 'existing');
    assert.equal(byRow.get(3).outcome, 'existing', 'brand inferred, code matched case-insensitively');
    assert.equal(byRow.get(3).skuCode, 'SKU-A');
    assert.equal(byRow.get(4).outcome, 'new');
    assert.match(byRow.get(5).problems.join(), /not in Inventory Master — give its brand/);
    assert.match(byRow.get(6).problems.join(), /not a whole number/);
    // Only SKU and quantity are required: no date, no reference, no brand, no supplier is fine.
    assert.equal(byRow.get(7).outcome, 'existing');
    assert.equal(byRow.get(7).eta, null);
    assert.equal(byRow.get(8).outcome, 'existing');
    assert.equal(byRow.get(8).ref, null);
    // Rows 8, 11 and 13 are all SKU-A with no reference: one shipment, merged.
    assert.deepEqual(byRow.get(8).mergedRows, [8, 11, 13]);
    assert.equal(byRow.get(8).qty, 15, '5 + 7 + 3');
    assert.equal(byRow.get(11), undefined, 'folded into row 8');
    assert.match(byRow.get(12).problems.join(), /"next week" is not a date/, 'a date that is given must be readable');
    assert.match(byRow.get(9).problems.join(), /does not exist/);
    // Row 10 repeats row 2's SKU and reference (case differs): merged into row 2.
    assert.equal(byRow.get(10), undefined);
    assert.deepEqual(byRow.get(2).mergedRows, [2, 10]);
    assert.equal(byRow.get(2).qty, 109);
    assert.equal(istYmd(byRow.get(2).eta), ymd(4), 'the earlier of the two dates');
    assert.match(byRow.get(2).notes.join(), /Merged rows 2, 10 \(100 \+ 9 = 109\).*dates differed/);
    assert.equal(await UpcomingShipment.countDocuments(), 0);
  });

  test('commit records valid lines, creates new SKUs, skips errors, and is replay-safe', async () => {
    await product('SKU-A');
    const rows = [
      { skuCode: 'SKU-A', qty: 100, eta: ymd(10), ref: 'PO-1', supplier: 'Koken Japan' },
      { skuCode: 'NEW-1', product: 'Brand new socket', qty: 30, eta: ymd(12), ref: 'PO-2' },
      { skuCode: 'SKU-A', qty: 'TBC', eta: ymd(12), ref: 'PO-3' },
    ];
    const first = await importRows(rows);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(
      { lines: first.body.data.lines, qty: first.body.data.qty, created: first.body.data.created, skipped: first.body.data.skipped },
      { lines: 2, qty: 130, created: 1, skipped: 1 },
    );
    const created = await Product.findOne({ skuCode: 'NEW-1', brand: 'Koken' }).lean();
    assert.equal(created.description, 'Brand new socket');
    assert.equal(created.totalAvailableQuantity, 0, 'a shipment file never adds stock');

    // The same submission again (double click / retry): nothing new.
    const again = await importRows(rows, U.importTeam, first.importId);
    assert.equal(again.body.data.replayed, true);
    assert.equal(await UpcomingShipment.countDocuments(), 2);

    // The same PO line in a new file is refused: it would double what is coming.
    const dup = await importRows([{ skuCode: 'SKU-A', qty: 100, eta: ymd(10), ref: 'po-1' }]);
    assert.equal(dup.status, 400);
    assert.ok(await AuditLog.findOne({ action: 'Upcoming Stock Imported' }));
  });

  test('only master-data roles may import', async () => {
    await product('SKU-A');
    const rows = [{ skuCode: 'SKU-A', qty: 10, eta: ymd(5), ref: 'PO-1' }];
    assert.equal((await importRows(rows, U.sales)).status, 403);
    assert.equal((await importRows(rows, U.wh)).status, 403);
    assert.equal((await importRows(rows, U.im)).status, 201);
  });
});

// ── The list ────────────────────────────────────────────────────────────────

describe('list', () => {
  test('actual stock is read live from inventory; figures and status are derived', async () => {
    await product('SKU-A');
    await adjust('SKU-A', 5); // on hand before anything was ordered
    await importRows([{ skuCode: 'SKU-A', qty: 100, eta: ymd(10), ref: 'PO-1' }]);

    const item = await itemOf('SKU-A');
    assert.equal(item.actual, 5);
    assert.equal(item.upcoming, 100, 'stock that arrived before the line was recorded is not counted against it');
    assert.equal(item.remaining, 100);
    assert.equal(item.projected, 105);
    assert.equal(item.status, 'Available');
    assert.equal(item.shipments[0].ref, 'PO-1');
  });

  test('an ETA in the past is Delayed; brand access scopes the list', async () => {
    await product('SKU-A');
    await importRows([{ skuCode: 'SKU-A', qty: 10, eta: ymd(-2), ref: 'PO-1' }]);
    assert.equal((await itemOf('SKU-A')).status, 'Delayed');

    assert.equal((await list(U.bixSales)).items.length, 0, 'a Koken SKU is not shown to a BIX-only user');
    assert.equal((await GET(BASE, U.customerA)).status, 403, 'customers have no inventory access');
    assert.equal((await GET(BASE, U.wh)).status, 200, 'anyone with view_inventory may read it');
  });
});

// ── Arrivals ────────────────────────────────────────────────────────────────

describe('arrivals', () => {
  test('stock increases fill shipments earliest ETA first; decreases never put upcoming back', async () => {
    await product('SKU-A');
    await importRows([
      { skuCode: 'SKU-A', qty: 100, eta: ymd(10), ref: 'PO-LATE' },
      { skuCode: 'SKU-A', qty: 50, eta: ymd(3), ref: 'PO-SOON' },
    ]);

    await adjust('SKU-A', 60);
    let item = await itemOf('SKU-A');
    assert.equal(item.actual, 60);
    assert.equal(item.upcoming, 90);
    assert.deepEqual(item.shipments.map((s) => [s.ref, s.qty, s.receivedQty]), [['PO-LATE', 90, 10]]);
    assert.equal((await UpcomingShipment.findOne({ shipmentRef: 'PO-SOON' }).lean()).status, 'Received');

    await adjust('SKU-A', -20);
    item = await itemOf('SKU-A');
    assert.equal(item.actual, 40);
    assert.equal(item.upcoming, 90, 'a decrease is not an un-arrival (decided 2026-10-21)');

    await adjust('SKU-A', 200); // more than is outstanding: the rest is just stock
    assert.equal(await itemOf('SKU-A'), undefined, 'fully received with nothing reserved: off the list');
    const late = await UpcomingShipment.findOne({ shipmentRef: 'PO-LATE' }).lean();
    assert.equal(late.receivedQty, 100);
    const last = await UpcomingArrival.findOne({ quantity: 200 }).lean();
    assert.equal(last.appliedQty, 90);
  });

  test('every arrival is counted once, however many passes see it', async () => {
    await product('SKU-A');
    await importRows([{ skuCode: 'SKU-A', qty: 100, eta: ymd(10), ref: 'PO-1' }]);
    await adjust('SKU-A', 30);
    await Promise.all([syncUpcoming({ skuCodes: ['SKU-A'] }), syncUpcoming({ skuCodes: ['SKU-A'] }), list()]);
    await syncUpcoming();
    assert.equal((await UpcomingShipment.findOne({}).lean()).receivedQty, 30);
    assert.equal(await UpcomingArrival.countDocuments(), 1);
  });

  test('stock returned from a booking is not an arrival; a goods receipt is', async () => {
    await product('SKU-A');
    await importRows([{ skuCode: 'SKU-A', qty: 100, eta: ymd(10), ref: 'PO-1' }]);
    const post = (referenceType, movementType, quantity) => postBatch({
      idempotencyKey: nextId('k'), workflowType: 'test', referenceType, referenceId: 'X',
      lines: [{ movementType, skuCode: 'SKU-A', brand: 'Koken', quantity }],
    });
    await post('booking', 'ADJUSTMENT', 25);
    await syncUpcoming({ skuCodes: ['SKU-A'] });
    assert.equal((await UpcomingShipment.findOne({}).lean()).receivedQty, 0);
    await post('receipt', 'RECEIPT', 25);
    await syncUpcoming({ skuCodes: ['SKU-A'] });
    assert.equal((await UpcomingShipment.findOne({}).lean()).receivedQty, 25);
  });
});

// ── Reservations ────────────────────────────────────────────────────────────

describe('FIFO allocation to indents (analysis only)', () => {
  /** A (oldest) waits for 10, B for 6, C (newest) for 8 — 24 in all, nothing in stock. */
  const waiting = async () => {
    const p = await product('SKU-B');
    const A = await book(U.customerA, p, 10);
    await Reservation.updateMany({ indentNumber: A.replace(/^BO-/, 'PI-') }, { $set: { reservationDate: new Date(Date.now() - 10 * DAY) } });
    const B = await book(U.customerB, p, 6);
    await Reservation.updateMany({ indentNumber: B.replace(/^BO-/, 'PI-') }, { $set: { reservationDate: new Date(Date.now() - 5 * DAY) } });
    const C = await book(U.customerA, p, 8);
    return { p, A, B, C, indentA: await indentOf(A), indentB: await indentOf(B), indentC: await indentOf(C) };
  };
  const view = (item) => item.indents.map((i) => [i.fifoPosition, i.requiredQty, i.reservedQty, i.shortQty]);

  test('upload: upcoming is shared out oldest indent first, and Remaining is what is left', async () => {
    const { indentA } = await waiting();
    await importRows([{ skuCode: 'SKU-B', qty: 20, eta: ymd(7), ref: 'PO-9' }]);
    const item = await itemOf('SKU-B');
    assert.deepEqual(view(item), [[1, 10, 10, 0], [2, 6, 6, 0], [3, 8, 4, 4]], 'A and B covered, C gets the last 4');
    assert.deepEqual([item.demand, item.upcoming, item.reserved, item.remaining], [24, 20, 20, 0]);
    assert.equal(item.status, 'Fully Reserved');
    assert.equal(item.indents[0].lineId, String(indentA._id));
    assert.equal(item.indents[0].customer, U.customerA.company);
    assert.equal((await itemOf('SKU-B', U.wh)).indents[0].customer, '—', 'no customer names without booking access');
  });

  test('more upcoming than demand leaves the rest as Remaining', async () => {
    await waiting();
    await importRows([{ skuCode: 'SKU-B', qty: 30, ref: 'PO-9' }]);
    const item = await itemOf('SKU-B');
    assert.deepEqual(view(item).map((r) => r[3]), [0, 0, 0], 'every indent covered');
    assert.deepEqual([item.reserved, item.remaining], [24, 6]);
  });

  test('each indent says which shipment would cover it, earliest arrival first', async () => {
    await waiting();
    await importRows([
      { skuCode: 'SKU-B', qty: 12, eta: ymd(30), ref: 'PO-LATE' },
      { skuCode: 'SKU-B', qty: 7, eta: ymd(5), ref: 'PO-SOON' },
    ]);
    const item = await itemOf('SKU-B');
    const cover = item.indents.map((i) => i.coveredBy.map((c) => [c.ref, c.qty]));
    assert.deepEqual(cover, [
      [['PO-SOON', 7], ['PO-LATE', 3]], // A: 10 — all of the early shipment, then 3 from the late one
      [['PO-LATE', 6]], // B: 6
      [['PO-LATE', 3]], // C: the last 3 of 8
    ]);
    assert.equal(istYmd(item.indents[0].coveredBy[0].eta), ymd(5));
  });

  test('nothing is reserved for real: no booking, indent or stock changes, nothing is sent', async () => {
    const { p, indentA, indentB, indentC } = await waiting();
    // Booking the indents notified people; only what happens after this counts.
    const notifications = () => mongoose.connection.collection('notifications').countDocuments({});
    const before = await notifications();
    sent.length = 0;
    await importRows([{ skuCode: 'SKU-B', qty: 20, ref: 'PO-9' }]);
    await list();
    for (const indent of [indentA, indentB, indentC]) {
      const now = await Reservation.findById(indent._id).lean();
      assert.deepEqual([now.status, now.quantity], [indent.status, indent.quantity], 'indent unchanged');
    }
    const x = await Product.findById(p._id).lean();
    assert.equal(x.bookedQuantity, 0, 'no stock reserved against a booking');
    assert.equal(sent.length, 0, 'no email');
    assert.equal(await notifications(), before, 'no notification');
    assert.equal(await mongoose.connection.collection('upcomingreservations').countDocuments({}), 0, 'nothing stored');
  });

  test('the allocation follows the indents as they change', async () => {
    const { indentA } = await waiting();
    await importRows([{ skuCode: 'SKU-B', qty: 20, ref: 'PO-9' }]);
    // A is booked from elsewhere: it no longer waits, so B and C move up the queue.
    await Reservation.updateOne({ _id: indentA._id }, { $set: { status: 'Confirmed' } });
    const item = await itemOf('SKU-B');
    assert.deepEqual(view(item), [[1, 6, 6, 0], [2, 8, 8, 0]]);
    assert.deepEqual([item.reserved, item.remaining], [14, 6]);
  });

  test('when stock arrives it follows the normal FIFO rule; Upcoming Stock only recounts', async () => {
    const { A, B } = await waiting();
    await importRows([{ skuCode: 'SKU-B', qty: 20, ref: 'PO-9' }]);
    await adjust('SKU-B', 6); // auto mode: the real FIFO pass gives the 6 to A, the oldest
    assert.equal((await indentOf(A)).quantity, 4);
    assert.equal((await indentOf(B)).quantity, 6);
    const item = await itemOf('SKU-B');
    assert.equal(item.upcoming, 14, '6 of the 20 arrived');
    assert.deepEqual(view(item), [[1, 4, 4, 0], [2, 6, 6, 0], [3, 8, 4, 4]], 'recalculated on the new figures');
  });

  test('the reservation endpoints are gone', async () => {
    await waiting();
    await importRows([{ skuCode: 'SKU-B', qty: 20, ref: 'PO-9' }]);
    for (const path of ['/reservations', '/reservations/x/release', '/holds', '/holds/resume']) {
      assert.equal((await POST(`${BASE}${path}`, U.admin, {})).status, 404, path);
    }
  });
});

describe('shipment lines', () => {
  beforeEach(async () => {
    await product('SKU-A');
    await importRows([
      { skuCode: 'SKU-A', qty: 100, eta: ymd(10), ref: 'PO-1' },
      { skuCode: 'SKU-A', qty: 50, eta: ymd(20), ref: 'PO-2' },
    ]);
  });
  const lineId = async (ref) => String((await UpcomingShipment.findOne({ shipmentRef: ref }).lean())._id);

  test('cancel stops expecting what is left of a line', async () => {
    const ok = await POST(`${BASE}/shipments/${await lineId('PO-2')}/cancel`, U.importTeam, { note: 'Supplier cancelled' });
    assert.equal(ok.status, 200);
    assert.equal((await itemOf('SKU-A')).upcoming, 100);
    // A cancelled line frees its reference for a corrected re-import.
    assert.equal((await importRows([{ skuCode: 'SKU-A', qty: 40, eta: ymd(25), ref: 'PO-2' }])).status, 201);
  });

  test('delete removes the entry from upcoming stock and leaves the inventory alone', async () => {
    await adjust('SKU-A', 30); // 30 arrive: PO-1 (earliest) is now partly received
    const { default: StockMovement } = await import('../models/StockMovement.js');
    const movementsBefore = await StockMovement.countDocuments();
    const before = await itemOf('SKU-A');
    assert.deepEqual([before.actual, before.upcoming], [30, 120]);

    const id = await lineId('PO-2');
    assert.equal((await http('DELETE', `${BASE}/shipments/${id}`, U.sales)).status, 403, 'needs master-data permission');
    const res = await http('DELETE', `${BASE}/shipments/${id}`, U.importTeam, { note: 'Entered twice by mistake' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.deletedQty, 50);

    const after = await itemOf('SKU-A');
    assert.equal(after.actual, 30, 'actual stock unchanged');
    assert.equal(after.upcoming, 70);
    assert.deepEqual(after.shipments.map((s) => s.ref), ['PO-1']);
    assert.equal(await StockMovement.countDocuments(), movementsBefore, 'nothing posted to the ledger');

    const doc = await UpcomingShipment.findById(id).lean();
    assert.equal(doc.status, 'Deleted', 'kept for the audit trail');
    assert.equal(doc.deleteReason, 'Entered twice by mistake');
    assert.ok(await AuditLog.findOne({ action: 'Upcoming Shipment Deleted' }));

    assert.equal((await http('DELETE', `${BASE}/shipments/${id}`, U.importTeam)).status, 409, 'already deleted');
    // Its reference is free again for a corrected upload.
    assert.equal((await importRows([{ skuCode: 'SKU-A', qty: 45, eta: ymd(22), ref: 'PO-2' }])).status, 201);
  });

  test('a partly received entry can be deleted; what arrived stays arrived', async () => {
    await adjust('SKU-A', 30);
    const id = await lineId('PO-1');
    assert.equal((await http('DELETE', `${BASE}/shipments/${id}`, U.importTeam)).status, 200);
    const item = await itemOf('SKU-A');
    assert.deepEqual([item.actual, item.upcoming], [30, 50]);
    assert.equal((await UpcomingShipment.findById(id).lean()).receivedQty, 30);
    await adjust('SKU-A', 10); // later stock goes to the remaining entry only
    assert.equal((await itemOf('SKU-A')).upcoming, 40);
  });

  test('the row Delete removes every entry of the SKU, inventory untouched', async () => {
    await adjust('SKU-A', 30);
    const body = { brand: 'Koken', skuCode: 'SKU-A' };

    assert.equal((await POST(`${BASE}/items/delete`, U.sales, body)).status, 403);
    const res = await POST(`${BASE}/items/delete`, U.importTeam, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.data.entries, res.body.data.deletedQty], [2, 120]);
    assert.equal(await itemOf('SKU-A'), undefined, 'the SKU leaves the list');
    assert.equal(await UpcomingShipment.countDocuments({ status: 'Deleted' }), 2);
    const p = await Product.findOne({ skuCode: 'SKU-A' }).lean();
    assert.equal(p.totalAvailableQuantity, 30, 'actual stock unchanged');
    assert.equal((await POST(`${BASE}/items/delete`, U.importTeam, body)).status, 409, 'nothing left');
  });

  test('a delayed shipment gets a new date', async () => {
    const id = await lineId('PO-1');
    assert.equal((await PATCH(`${BASE}/shipments/${id}`, U.importTeam, { eta: 'not a date' })).status, 400);
    assert.equal((await PATCH(`${BASE}/shipments/${id}`, U.sales, { eta: ymd(30) })).status, 403);
    const res = await PATCH(`${BASE}/shipments/${id}`, U.importTeam, { eta: ymd(30) });
    assert.equal(res.status, 200);
    const item = await itemOf('SKU-A');
    assert.equal(istYmd(item.nextEta), ymd(20), 'PO-2 is now the next arrival');
    const line = await UpcomingShipment.findById(id).lean();
    assert.equal(line.etaChanges.length, 1);
  });
});

// ── Optional columns, and editing after import ─────────────────────────────

describe('only SKU and quantity are required', () => {
  test('an entry with just SKU and quantity is recorded, shown, and never Delayed', async () => {
    await product('SKU-A');
    const res = await POST(`${BASE}/import`, U.importTeam, {
      importId: nextId('imp'), fileName: 'minimal.xlsx',
      rows: [{ row: 2, skuCode: 'SKU-A', qty: 40 }, { row: 3, skuCode: 'SKU-A', qty: 10 }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.lines, 1, 'two rows for the same SKU with no reference are merged');
    assert.equal(res.body.data.merged, 1);

    const item = await itemOf('SKU-A');
    assert.equal(item.upcoming, 50);
    assert.equal(item.nextEta, null);
    assert.equal(item.status, 'Available');
    assert.deepEqual(item.shipments.map((s) => [s.ref, s.eta, s.qty]), [[null, null, 50]]);
  });

  test('stock fills dated entries first, then the ones with no date', async () => {
    await product('SKU-A');
    await importRows([{ skuCode: 'SKU-A', qty: 20 }]); // no date, imported first
    await importRows([{ skuCode: 'SKU-A', qty: 30, eta: ymd(40), ref: 'PO-LATE' }]);
    await adjust('SKU-A', 35);
    const lines = await UpcomingShipment.find({}).sort({ createdAt: 1 }).lean();
    assert.deepEqual(lines.map((l) => l.receivedQty), [5, 30], 'the dated entry is filled first');
  });
});

describe('duplicate rows in one file are merged', () => {
  test('same SKU + reference: one entry, quantities added; different references stay apart', async () => {
    await product('SKU-A');
    await product('SKU-B');
    const res = await importRows([
      { skuCode: 'SKU-A', qty: 100, ref: 'PO-1', eta: ymd(20) },
      { skuCode: 'SKU-B', qty: 5, ref: 'PO-1' },
      { skuCode: 'sku-a', qty: 50, ref: 'po-1', eta: ymd(10), supplier: 'Koken Japan' },
      { skuCode: 'SKU-A', qty: 25, ref: 'PO-2' },
      { skuCode: 'SKU-A', qty: 'TBC', ref: 'PO-1' },
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(
      { lines: res.body.data.lines, qty: res.body.data.qty, merged: res.body.data.merged, skipped: res.body.data.skipped },
      { lines: 3, qty: 180, merged: 1, skipped: 1 },
      'the TBC row is an error and is skipped, not merged',
    );
    const po1 = await UpcomingShipment.findOne({ skuCode: 'SKU-A', refKey: 'po-1' }).lean();
    assert.equal(po1.orderedQty, 150);
    assert.equal(istYmd(po1.eta), ymd(10), 'earliest date');
    assert.equal(po1.supplier, 'Koken Japan', 'a blank filled from the later row');
    assert.equal((await UpcomingShipment.findOne({ skuCode: 'SKU-A', refKey: 'po-2' }).lean()).orderedQty, 25);
    assert.equal((await itemOf('SKU-A')).upcoming, 175);
  });

  test('a merged row that matches an entry already recorded is still refused', async () => {
    await product('SKU-A');
    await importRows([{ skuCode: 'SKU-A', qty: 10, ref: 'PO-1' }]);
    const res = await POST(`${BASE}/import/preview`, U.importTeam, {
      rows: [{ row: 2, skuCode: 'SKU-A', qty: 1, ref: 'PO-1' }, { row: 3, skuCode: 'SKU-A', qty: 2, ref: 'PO-1' }],
    });
    const [line] = res.body.data.lines;
    assert.equal(line.outcome, 'error');
    assert.match(line.problems.join(), /Already on upcoming stock/);
  });
});

describe('editing an entry after import', () => {
  let id;
  beforeEach(async () => {
    await product('SKU-A');
    await importRows([{ skuCode: 'SKU-A', qty: 100 }]);
    id = String((await UpcomingShipment.findOne({}).lean())._id);
  });
  const edit = (body, who = U.importTeam) => PATCH(`${BASE}/shipments/${id}`, who, body);

  test('fills in the optional columns, and the product description in Inventory Master', async () => {
    const res = await edit({ eta: ymd(12), ref: 'PO-77', supplier: 'Koken Japan', product: 'Socket 10mm', orderedQty: 120 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const line = await UpcomingShipment.findById(id).lean();
    assert.deepEqual([line.shipmentRef, line.refKey, line.supplier, line.orderedQty], ['PO-77', 'po-77', 'Koken Japan', 120]);
    assert.equal(istYmd(line.eta), ymd(12));
    assert.equal(line.etaChanges.length, 1);
    assert.equal((await Product.findOne({ skuCode: 'SKU-A' }).lean()).description, 'Socket 10mm');
    const item = await itemOf('SKU-A');
    assert.deepEqual([item.upcoming, item.product, item.shipments[0].ref], [120, 'Socket 10mm', 'PO-77']);
    assert.ok(await AuditLog.findOne({ action: 'Upcoming Shipment Edited' }));

    // A blank optional field clears it.
    assert.equal((await edit({ eta: '', ref: '', supplier: '' })).status, 200);
    const cleared = await UpcomingShipment.findById(id).lean();
    assert.deepEqual([cleared.eta, cleared.shipmentRef, cleared.supplier], [null, null, null]);
  });

  test('refuses bad values, and a quantity below what has arrived', async () => {
    assert.equal((await edit({ orderedQty: 0 })).status, 400);
    assert.equal((await edit({ orderedQty: 'ten' })).status, 400);
    assert.equal((await edit({ eta: 'soon' })).status, 400);
    assert.equal((await edit({})).status, 409, 'nothing to change');
    assert.equal((await edit({ supplier: 'X' }, U.sales)).status, 403);

    await importRows([{ skuCode: 'SKU-A', qty: 10, ref: 'PO-1' }]);
    assert.match((await edit({ ref: 'po-1' })).body.message, /already has an upcoming entry under PO-1/);

    // Neither entry has a date, so the older one (this one) receives all 30.
    await adjust('SKU-A', 30);
    assert.equal((await UpcomingShipment.findById(id).lean()).receivedQty, 30);
    const below = await edit({ orderedQty: 29 });
    assert.equal(below.status, 409);
    assert.match(below.body.message, /30 have already arrived/);

    // Open indents never block an edit: the FIFO allocation is just recalculated.
    await indentFor('SKU-A', 200);
    assert.equal((await edit({ orderedQty: 60 })).status, 200);
  });
});
