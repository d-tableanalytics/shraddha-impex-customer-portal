/**
 * Inward allocations: arriving stock goes onto the booking its indent belongs to.
 *
 * A booking of 50 confirms 30; 20 wait on its indent. When 10 arrive they are
 * allocated to the SAME booking as "inward allocation 1" (10 picked and
 * dispatched on their own); 5 more become allocation 2, and the indent is
 * down to 5. No new booking, same PO.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
const sent = [];
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: {
    sendEmail: async (to, subject, html) => { sent.push({ to, subject, html }); return true; },
  },
});

const { default: Order } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { default: User } = await import('../models/User.js');
const { ProductKoken } = await import('../models/Product.js');
const {
  processAvailableIndents, allocationModeFor,
} = await import('../modules/inventory/indentAvailability.service.js');
const { updateAllocationStatus } = await import('../modules/orders/order.controller.js');

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); sent.length = 0; });

let seq = 0;
const customerFor = () => User.create({
  email: `buyer${++seq}@example.com`, password: 'x', role: 'Customer', user: 'Buyer',
});

const openIndent = (customer, product, quantity, indentNumber, daysAgo = 5, over = {}) => Reservation.create({
  reservationId: `RES-${++seq}`,
  customerId: customer._id,
  productId: product._id,
  skuCode: product.skuCode,
  quantity,
  reservationDate: new Date(Date.now() - daysAgo * 864e5),
  expiryDate: new Date(Date.now() + 7 * 864e5),
  status: 'Pending',
  reservedBy: customer._id,
  indentNumber,
  poNumber: '-',
  ...over,
});

const product = (skuCode) => ProductKoken.create({
  skuCode, availableForSale: 0, totalAvailableQuantity: 0, bookedQuantity: 0,
});

/** Stock arrives: `units` more on the shelf, as the inward posting leaves it. */
const arrive = async (p, units) => {
  await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: units, totalAvailableQuantity: units } });
  // The allocator reads availability from the balance; this test's ledger has
  // no location to post to, so set the balance to what is now free.
  await StockBalance.deleteMany({ skuCode: p.skuCode });
  await StockBalance.create({
    skuCode: p.skuCode, brand: 'Koken', location: new mongoose.Types.ObjectId(),
    locationCode: 'MAIN', onHand: units, reserved: 0,
  });
};

const line = (customer, orderId, skuCode, over = {}) => Order.create({
  orderId,
  lineSeq: 0,
  brand: 'Koken',
  user: customer._id,
  status: 'PO Received',
  skuCode,
  requestedQty: 30,
  bookedQty: 50,
  confirmedQty: 30,
  pendingQty: 20,
  poNumber: 'PO-1025',
  poGeneratedAt: new Date(),
  stockState: 'consumed',
  ...over,
});

describe('inward allocation onto the same booking', () => {
  test('10 then 5 arrive against an indent of 20: two allocations, indent down to 5', async () => {
    const customer = await customerFor();
    const p = await product('SKU-1');
    await line(customer, 'BO-2026-001025', 'SKU-1');
    await openIndent(customer, p, 20, 'PI-2026-001025');

    await arrive(p, 10);
    await processAvailableIndents(['SKU-1']);

    let row = await Order.findOne({ orderId: 'BO-2026-001025' }).lean();
    assert.equal(row.confirmedQty, 40);
    assert.equal(row.pendingQty, 10);
    assert.equal(row.bookedQty, 50, 'what the customer ordered never changes');
    assert.deepEqual(row.allocations.map((a) => [a.seq, a.quantity, a.indentNumber, a.status]), [
      [1, 10, 'PI-2026-001025', 'PO Received'],
    ]);
    let indent = await Reservation.findOne({}).lean();
    assert.equal(indent.quantity, 10);
    assert.equal(indent.status, 'Partially Confirmed');

    await arrive(p, 5);
    await processAvailableIndents(['SKU-1']);

    row = await Order.findOne({ orderId: 'BO-2026-001025' }).lean();
    assert.equal(row.confirmedQty, 45);
    assert.equal(row.pendingQty, 5);
    assert.deepEqual(row.allocations.map((a) => [a.seq, a.quantity]), [[1, 10], [2, 5]]);
    indent = await Reservation.findOne({}).lean();
    assert.equal(indent.quantity, 5);

    // Same booking, no duplicate, same PO.
    assert.deepEqual(await Order.distinct('orderId'), ['BO-2026-001025']);
    assert.equal(row.poNumber, 'PO-1025');

    // The booking's PO had consumed its stock, so allocations leave inventory now.
    const after = await ProductKoken.findById(p._id).lean();
    assert.equal(after.availableForSale, 0);
    assert.equal(after.totalAvailableQuantity, 0);

    const mails = sent.filter((m) => m.to === customer.email);
    assert.equal(mails.length, 2, 'one mail per allocation');
    assert.match(mails[0].subject, /BO-2026-001025 — indented stock allocated/);
    assert.doesNotMatch(mails[0].html, /Please raise your PO/);
  });

  test('a part-allocated indent is told once, by the allocation mail', async () => {
    const customer = await customerFor();
    const p = await product('SKU-M');
    await line(customer, 'BO-2026-000400', 'SKU-M');
    await openIndent(customer, p, 20, 'PI-2026-000400');

    await arrive(p, 10);
    await processAvailableIndents(['SKU-M'], {
      event: 'material-inward', reference: 'GRN-1', inwardBySku: new Map([['SKU-M', 10]]),
    });

    const mails = sent.filter((m) => m.to === customer.email);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /indented stock allocated/);
  });

  test('allocating the whole remainder closes the indent', async () => {
    const customer = await customerFor();
    const p = await product('SKU-2');
    await line(customer, 'BO-2026-000500', 'SKU-2');
    await openIndent(customer, p, 20, 'PI-2026-000500');

    await arrive(p, 25);
    await processAvailableIndents(['SKU-2']);

    const row = await Order.findOne({}).lean();
    assert.equal(row.confirmedQty, 50);
    assert.equal(row.pendingQty, 0);
    assert.deepEqual(row.allocations.map((a) => a.quantity), [20]);
    const indent = await Reservation.findOne({}).lean();
    assert.equal(indent.status, 'Confirmed');
    assert.equal(indent.autoBookedOrderId, 'BO-2026-000500');
    const after = await ProductKoken.findById(p._id).lean();
    assert.equal(after.availableForSale, 5, 'only what the indent needed was taken');
  });

  test('oldest indent first; the next one gets what is left', async () => {
    const a = await customerFor();
    const b = await customerFor();
    const p = await product('SKU-3');
    await line(a, 'BO-2026-000601', 'SKU-3');
    await line(b, 'BO-2026-000602', 'SKU-3');
    await openIndent(a, p, 20, 'PI-2026-000601', 10);
    await openIndent(b, p, 30, 'PI-2026-000602', 2);

    await arrive(p, 25);
    await processAvailableIndents(['SKU-3']);

    const rows = await Order.find({}).sort({ orderId: 1 }).lean();
    assert.deepEqual(rows.map((r) => [r.orderId, r.allocations.map((x) => x.quantity)]), [
      ['BO-2026-000601', [20]],
      ['BO-2026-000602', [5]],
    ]);
  });

  test('a SKU that had nothing confirmed gets a line holding only its allocation', async () => {
    const customer = await customerFor();
    await product('SKU-A');
    const b = await product('SKU-B');
    await line(customer, 'BO-2026-000700', 'SKU-A', { stockState: 'reserved', poNumber: '-', poGeneratedAt: null, priceType: null });
    await openIndent(customer, b, 12, 'PI-2026-000700');

    await arrive(b, 4);
    await processAvailableIndents(['SKU-B']);

    const added = await Order.findOne({ skuCode: 'SKU-B' }).lean();
    assert.equal(added.orderId, 'BO-2026-000700');
    assert.equal(added.bookedQty, 12);
    assert.equal(added.confirmedQty, 4, 'initially confirmed 0 + allocation 4');
    assert.equal(added.pendingQty, 8);
    assert.deepEqual(added.allocations.map((a) => a.quantity), [4]);
    assert.equal(added.stockState, 'reserved', 'the booking has no PO yet');
    assert.match(sent.find((m) => m.to === customer.email).html, /Please raise your PO/);
  });

  test('a booking id with no lines at all is filled under that id', async () => {
    const customer = await customerFor();
    const p = await product('SKU-C');
    await openIndent(customer, p, 6, 'PI-2026-000800');

    await arrive(p, 6);
    await processAvailableIndents(['SKU-C']);

    const rows = await Order.find({}).lean();
    assert.deepEqual(rows.map((r) => [r.orderId, r.confirmedQty, r.allocations.length]), [['BO-2026-000800', 6, 1]]);
  });

  test('a cancelled booking still needs the full quantity before a new booking is raised', async () => {
    const customer = await customerFor();
    const p = await product('SKU-D');
    await line(customer, 'BO-2026-000900', 'OTHER', { status: 'Cancelled', stockState: 'released', poNumber: '-', poGeneratedAt: null });
    await openIndent(customer, p, 20, 'PI-2026-000900');

    await arrive(p, 10);
    await processAvailableIndents(['SKU-D']);
    assert.equal(await Order.countDocuments({ status: { $ne: 'Cancelled' } }), 0, 'partial stock is not taken');

    await arrive(p, 20);
    await processAvailableIndents(['SKU-D']);
    const fresh = await Order.findOne({ status: { $ne: 'Cancelled' } }).lean();
    assert.notEqual(fresh.orderId, 'BO-2026-000900');
    assert.equal(fresh.confirmedQty, 20);
    assert.equal(fresh.allocations, undefined);
  });
});

describe('allocationModeFor', () => {
  const indent = { indentNumber: 'PI-2026-000009', skuCode: 'S' };
  test('live booking → allocate; empty → create; cancelled or none → null', () => {
    assert.equal(allocationModeFor(indent, [{ skuCode: 'S', status: 'Dispatched' }]), 'allocate');
    assert.equal(allocationModeFor(indent, []), 'create');
    assert.equal(allocationModeFor(indent, [{ skuCode: 'S', status: 'Cancelled' }]), null);
    assert.equal(allocationModeFor({ indentNumber: null }, []), null);
  });
});

describe('an allocation has its own status', () => {
  const run = async (params, body) => {
    const res = { statusCode: null, payload: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.payload = b; return res; };
    let err = null;
    await updateAllocationStatus({ params, body, user: { _id: new mongoose.Types.ObjectId() } }, res, (e) => { err = e; });
    if (err) throw err;
    return res;
  };

  test('moves one allocation without touching the line or the other allocation', async () => {
    const customer = await customerFor();
    const row = await line(customer, 'BO-2026-001025', 'SKU-1', {
      status: 'Dispatched',
      allocations: [
        { seq: 1, quantity: 10, at: new Date(), status: 'PO Received' },
        { seq: 2, quantity: 5, at: new Date(), status: 'PO Received' },
      ],
    });

    const res = await run({ orderId: 'BO-2026-001025', lineId: String(row._id), seq: '1' }, { status: 'Ready for Dispatch' });
    assert.equal(res.statusCode, 200);

    const after = await Order.findById(row._id).lean();
    assert.equal(after.status, 'Dispatched');
    assert.deepEqual(after.allocations.map((a) => a.status), ['Ready for Dispatch', 'PO Received']);
  });

  test('rejects an unknown status and an unknown allocation', async () => {
    const customer = await customerFor();
    const row = await line(customer, 'BO-2026-001026', 'SKU-1', {
      allocations: [{ seq: 1, quantity: 10, at: new Date() }],
    });
    assert.equal((await run({ orderId: 'BO-2026-001026', lineId: String(row._id), seq: '1' }, { status: 'Lost' })).statusCode, 400);
    assert.equal((await run({ orderId: 'BO-2026-001026', lineId: String(row._id), seq: '9' }, { status: 'Dispatched' })).statusCode, 404);
  });
});
