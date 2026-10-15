/**
 * Cancelling a confirmed booking gives its stock back.
 *
 * Runs the real handlers end to end: the customer adds a SKU to the Selection
 * List, confirms the booking (stock moves available → booked), then cancels it
 * (booked → available). Checked against the product's three counters, which
 * must keep `availableForSale + bookedQuantity === totalAvailableQuantity`.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});

const { default: Order } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: User } = await import('../models/User.js');
const { ProductKoken } = await import('../models/Product.js');
const { createReservation, confirmBooking } = await import('../modules/reservations/reservation.controller.js');
const { cancelBooking, updateOrderPO } = await import('../modules/orders/order.controller.js');

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  let err = null;
  await handler({ body: {}, params: {}, headers: {}, ...req }, res, (e) => { err = e; });
  if (err) throw err;
  return res;
};

const customer = async () => (await User.create({
  email: 'buyer@example.com',
  password: 'x',
  user: 'Buyer',
  company: 'Buyer Co',
  role: 'Customer',
  brandAccess: { koken: true },
  moq: 'SKIP',
})).toObject();

const stockOf = async (id) => {
  const p = await ProductKoken.findById(id).lean();
  return { available: p.availableForSale, booked: p.bookedQuantity, total: p.totalAvailableQuantity };
};

/** Add to the Selection List, then confirm. Returns the booking id. */
const book = async (user, product, quantity) => {
  await call(createReservation, { user, body: { productId: String(product._id), quantity } });
  const res = await call(confirmBooking, { user });
  assert.equal(res.statusCode < 300, true, JSON.stringify(res.payload));
  return (await Order.findOne({}).lean())?.orderId;
};

describe('cancelling a confirmed booking', () => {
  test('all of the booked stock goes back', async () => {
    const user = await customer();
    const p = await ProductKoken.create({ skuCode: 'SKU-1', availableForSale: 10, totalAvailableQuantity: 10, bookedQuantity: 0 });

    const orderId = await book(user, p, 4);
    assert.deepEqual(await stockOf(p._id), { available: 6, booked: 4, total: 10 }, 'confirmed: 4 held');

    const res = await call(cancelBooking, { user, params: { orderId } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await stockOf(p._id), { available: 10, booked: 0, total: 10 }, 'cancelled: all back');

    const row = await Order.findOne({ orderId }).lean();
    assert.equal(row.status, 'Cancelled');
    assert.equal(row.stockState, 'released');
  });

  test('cancelling twice does not give the stock back twice', async () => {
    const user = await customer();
    const p = await ProductKoken.create({ skuCode: 'SKU-2', availableForSale: 10, totalAvailableQuantity: 10, bookedQuantity: 0 });
    const orderId = await book(user, p, 4);

    await call(cancelBooking, { user, params: { orderId } });
    const again = await call(cancelBooking, { user, params: { orderId } });
    assert.equal(again.statusCode, 409);
    assert.deepEqual(await stockOf(p._id), { available: 10, booked: 0, total: 10 });
  });

  test('a part-confirmed booking gives back what it held, and its indent is closed with it', async () => {
    const user = await customer();
    const p = await ProductKoken.create({ skuCode: 'SKU-3', availableForSale: 3, totalAvailableQuantity: 3, bookedQuantity: 0 });

    const orderId = await book(user, p, 5);
    assert.deepEqual(await stockOf(p._id), { available: 0, booked: 3, total: 3 }, '3 confirmed, 2 on indent');

    await call(cancelBooking, { user, params: { orderId } });
    assert.deepEqual(await stockOf(p._id), { available: 3, booked: 0, total: 3 }, 'the 3 are back');

    // The 2 still on indent are closed with the booking, so they are never
    // booked later for a customer who cancelled. They held no stock.
    const indent = await Reservation.findOne({ indentNumber: orderId.replace(/^BO-/, 'PI-') }).lean();
    assert.equal(indent.status, 'Cancelled');
    assert.ok(indent.cancelledAt);
    assert.match(indent.cancellationReason, /cancelled by the customer/);
    assert.deepEqual(await stockOf(p._id), { available: 3, booked: 0, total: 3 }, 'closing it moved no stock');
  });

  test('once the PO is raised the booking cannot be cancelled and the stock stays out', async () => {
    const user = await customer();
    const p = await ProductKoken.create({ skuCode: 'SKU-4', availableForSale: 10, totalAvailableQuantity: 10, bookedQuantity: 0 });
    const orderId = await book(user, p, 4);

    await call(updateOrderPO, { user: { ...user, role: 'Super Admin', permissions: ['*'] }, params: { orderId }, body: { poNumber: 'PO-77' } });
    assert.deepEqual(await stockOf(p._id), { available: 6, booked: 0, total: 6 }, 'PO raised: 4 consumed');

    const res = await call(cancelBooking, { user, params: { orderId } });
    assert.equal(res.statusCode, 423);
    assert.deepEqual(await stockOf(p._id), { available: 6, booked: 0, total: 6 });
  });
});
