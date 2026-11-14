/**
 * Sales Desk search — GET /sales/bookings?search=
 *
 * The desk's Customer Name column is read live from the customer's user record
 * (the Customer Master name, else the contact person), not stamped on the
 * booking, so searching it means finding the customers first and joining their
 * bookings. These pin that, the partial / any-case matching, that a real name
 * full of regex characters is matched literally, and that the fields the box
 * already searched (booking id, SKU, company, PO number) still do.
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
const { default: Location } = await import('../models/Location.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { ProductKoken } = await import('../models/Product.js');
const { createDirectBooking } = await import('../modules/reservations/reservation.controller.js');
const { getBookings } = await import('../modules/sales/sales.controller.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');

const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', permissions: ['*'] };

before(async () => { await startTestReplSet(); });
after(async () => { await stopTestMongo(); });

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const full = { body: {}, params: {}, query: {}, headers: {}, method: 'POST', originalUrl: '/test', ...req };
  let err = null;
  await handler(full, res, (e) => { err = e; });
  if (err) {
    const log = console.error;
    console.error = () => {};
    try { errorHandler(err, full, res, () => {}); } finally { console.error = log; }
  }
  return res;
};

let seq = 0;
const customer = async (over) => (await User.create({
  email: `c${++seq}@example.com`, password: 'x', role: 'Customer', brandAccess: { koken: true }, moq: 'SKIP', ...over,
})).toObject();

const book = async (user, sku) => {
  const p = await ProductKoken.create({ skuCode: sku, availableForSale: 50, totalAvailableQuantity: 50, bookedQuantity: 0 });
  const res = await call(createDirectBooking, { user, body: { items: [{ productId: String(p._id), quantity: 2 }] } });
  assert.ok(res.statusCode < 300, JSON.stringify(res.payload));
  return res.payload.data.orderId;
};

/** The booking ids the desk lists for `search` (and the meta it reports). */
const search = async (term, status = 'all') => {
  const res = await call(getBookings, { user: ADMIN, method: 'GET', query: { status, search: term } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  return { ids: res.payload.data.map((b) => b.orderId).sort(), meta: res.payload.meta, data: res.payload.data };
};

let sharma; let nikita; let om;

beforeEach(async () => {
  await clearCollections();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'auto', effectiveFrom: new Date(0) });

  // Customer Master name full of regex metacharacters, as real names are.
  const a = await customer({ customerName: 'Sharma Auto Parts (P) Ltd.', user: 'Rakesh Verma', company: 'SAP Group' });
  const b = await customer({ customerName: 'Nikita Traders', user: 'Nikita Rao', company: 'NT Pvt Ltd' });
  // No Customer Master name: the desk's Customer Name column shows the contact.
  const c = await customer({ customerName: null, user: 'Om Prakash', company: 'Om Motors' });
  sharma = await book(a, 'SKU-A1');
  nikita = await book(b, 'SKU-B1');
  om = await book(c, 'SKU-C1');
});

describe('by customer name', () => {
  test('the full Customer Master name finds that customer’s bookings only', async () => {
    assert.deepEqual((await search('Sharma Auto Parts (P) Ltd.')).ids, [sharma]);
  });

  test('partial and case-insensitive', async () => {
    assert.deepEqual((await search('auto parts')).ids, [sharma]);
    assert.deepEqual((await search('NIKITA')).ids, [nikita]);
    assert.deepEqual((await search('niKit')).ids, [nikita]);
  });

  test('the contact person, which the column shows when there is no Customer Master name', async () => {
    assert.deepEqual((await search('om prak')).ids, [om]);
    assert.deepEqual((await search('rakesh')).ids, [sharma]);
  });

  test('the row returned names the customer the desk shows', async () => {
    const { data } = await search('nikita traders');
    assert.equal(data.length, 1);
    assert.equal(data[0].customerProfile.customerName, 'Nikita Traders');
  });

  test('an unmatched name returns nothing, and zero counts', async () => {
    const { ids, meta } = await search('Zebra Crossing Co');
    assert.deepEqual(ids, []);
    assert.deepEqual(meta, { total: 0, pendingPo: 0, generated: 0 });
  });

  test('regex characters are matched literally', async () => {
    // Unescaped, "(" was a regex syntax error and "." matched every booking.
    assert.deepEqual((await search('(P)')).ids, [sharma]);
    assert.deepEqual((await search('.')).ids, [sharma]);
    assert.deepEqual((await search('[')).ids, []);
  });

  test('the scope tabs still apply, with counts for the searched set', async () => {
    await Order.updateMany({ orderId: nikita }, { $set: { poNumber: 'PO-NT-9', poGeneratedAt: new Date() } });
    const all = await search('a'); // Sharma, Nikita, Om Prakash
    assert.equal(all.meta.total, 3);
    assert.equal(all.meta.generated, 1);
    assert.deepEqual((await search('nikita', 'pending')).ids, []);
    assert.deepEqual((await search('nikita', 'generated')).ids, [nikita]);
  });
});

describe('the fields it already searched', () => {
  test('booking id, SKU, stamped company and PO number', async () => {
    await Order.updateMany({ orderId: om }, { $set: { poNumber: 'PO-OM-4471' } });
    assert.deepEqual((await search(nikita)).ids, [nikita]);
    assert.deepEqual((await search('sku-b1')).ids, [nikita]);
    assert.deepEqual((await search('NT Pvt')).ids, [nikita]);
    assert.deepEqual((await search('om-44')).ids, [om]);
  });

  test('no search lists every booking', async () => {
    assert.deepEqual((await search('')).ids, [sharma, nikita, om].sort());
  });
});
