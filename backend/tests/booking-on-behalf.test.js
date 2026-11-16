/**
 * Bookings placed by a Sales Person or Admin ON A CUSTOMER'S BEHALF.
 *
 * The booking flow was written for one person: the signed-in customer. The
 * desk may now name a customer (`customerId`) and the booking is then THAT
 * customer's — their Order rows, their Booking History, their mail — while the
 * staff member is stamped on it as its creator (the "SI Team") and copied on
 * every mail about it. These pin that split, and that nothing changes for a
 * customer booking for themselves.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
const sent = [];
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: {
    sendEmail: async (to, subject, body, options = {}) => {
      sent.push({ to, subject, body, cc: (options.cc || []).map((a) => String(a).toLowerCase()) });
      return true;
    },
  },
});

const { default: Order } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: User } = await import('../models/User.js');
const { default: Location } = await import('../models/Location.js');
const { ProductKoken } = await import('../models/Product.js');
const {
  createReservation, getReservations, confirmBooking, createDirectBooking, updateReservationQuantity,
} = await import('../modules/reservations/reservation.controller.js');
const { getOrders, updateBookingStatus } = await import('../modules/orders/order.controller.js');
const { getBookings, getBookingHistory } = await import('../modules/sales/sales.controller.js');
const { searchCustomers } = await import('../modules/users/user.controller.js');
const { runReservationExpiryChecks } = await import('../modules/reservations/reservationExpiryJob.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');

before(async () => { await startTestReplSet(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => {
  await clearCollections();
  sent.length = 0;
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
});

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const full = { body: {}, params: {}, query: {}, headers: {}, method: 'POST', originalUrl: '/api/v1/reservations/confirm', ...req };
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
const account = async (over = {}) => (await User.create({
  email: `acct${++seq}@example.com`,
  password: 'x',
  role: 'Customer',
  brandAccess: { koken: true, bix: true, imada: true },
  moq: 'SKIP',
  ...over,
})).toObject();

const customerAbc = () => account({
  email: 'abc@example.com', user: 'Asha', customerName: 'Customer ABC', company: 'ABC Industries',
});
const salesA = () => account({
  email: 'salesa@shraddhaimpex.net', user: 'Sales Person A', company: 'Shraddha Impex', role: 'Sales',
  brandAccess: { koken: true, bix: true, imada: true },
});
const admin = () => account({
  email: 'admin@shraddhaimpex.net', user: 'Admin One', role: 'Super Admin',
});

const product = (sku, stock = 50) => ProductKoken.create({
  skuCode: sku, availableForSale: stock, totalAvailableQuantity: stock, bookedQuantity: 0,
});

const mailTo = (address) => sent.filter((m) => m.to === address);

describe('the desk books for a customer', () => {
  test('the line goes into a list the staff member builds for the customer, not the customer\'s own', async () => {
    const abc = await customerAbc();
    const sales = await salesA();
    const p = await product('SKU-1');

    const added = await call(createReservation, { user: sales, body: { productId: String(p._id), quantity: 5, customerId: String(abc._id) } });
    assert.equal(added.statusCode, 201, JSON.stringify(added.payload));
    assert.equal(String(added.payload.data.customerId), String(abc._id));
    assert.equal(String(added.payload.data.reservedBy), String(sales._id));

    // The customer's own Selection List does not show what the desk is still building.
    const own = await call(getReservations, { user: abc, method: 'GET' });
    assert.deepEqual(own.payload.data, []);
    // The staff member's own list (no customer) is untouched too.
    const staffOwn = await call(getReservations, { user: sales, method: 'GET' });
    assert.deepEqual(staffOwn.payload.data, []);
    // The list for that customer is where it is.
    const forAbc = await call(getReservations, { user: sales, method: 'GET', query: { customerId: String(abc._id) } });
    assert.equal(forAbc.payload.data.length, 1);
    assert.equal(forAbc.payload.data[0].skuCode, 'SKU-1');
  });

  test('confirming makes the booking the customer\'s, stamped with who placed it', async () => {
    const abc = await customerAbc();
    const sales = await salesA();
    const p = await product('SKU-1');
    await call(createReservation, { user: sales, body: { productId: String(p._id), quantity: 5, customerId: String(abc._id) } });

    const res = await call(confirmBooking, { user: sales, body: { customerId: String(abc._id) } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
    assert.equal(res.payload.data.customer.id, String(abc._id));
    assert.equal(res.payload.data.createdBy.name, 'Sales Person A');

    const rows = await Order.find({ orderId: res.payload.data.orderId }).lean();
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].user), String(abc._id), 'the booking belongs to the customer');
    assert.equal(rows[0].company, 'ABC Industries');
    assert.equal(rows[0].emailId, 'abc@example.com');
    assert.equal(String(rows[0].createdBy), String(sales._id));
    assert.equal(rows[0].createdByName, 'Sales Person A');
    assert.equal(rows[0].createdByEmail, 'salesa@shraddhaimpex.net');
    assert.equal(rows[0].createdByRole, 'Sales');

    // The reservation was consumed from the desk's list for the customer.
    const left = await Reservation.find({ customerId: abc._id, status: 'Reserved' });
    assert.equal(left.length, 0);

    // ...and it appears in the CUSTOMER's own Booking History.
    const history = await call(getOrders, { user: abc, method: 'GET' });
    assert.equal(history.payload.data.length, 1);
    assert.equal(history.payload.data[0].orderId, res.payload.data.orderId);
    assert.equal(history.payload.data[0].createdByName, 'Sales Person A');
  });

  test('a customer\'s own booking is unchanged: no creator stamp, no extra Cc', async () => {
    const abc = await customerAbc();
    const p = await product('SKU-1');
    await call(createReservation, { user: abc, body: { productId: String(p._id), quantity: 5 } });
    const res = await call(confirmBooking, { user: abc, body: {} });
    assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
    assert.equal(res.payload.data.createdBy, null);
    const [row] = await Order.find({ orderId: res.payload.data.orderId }).lean();
    assert.equal(row.createdBy, null);
    assert.equal(row.createdByName, null);
    const [mail] = mailTo('abc@example.com');
    assert.ok(mail, 'the customer is mailed');
    assert.ok(mail.cc.includes('kinjal@shraddhaimpex.net'));
    assert.ok(!mail.cc.some((a) => a.endsWith('@shraddhaimpex.net') && a !== 'kinjal@shraddhaimpex.net' && a !== 'contact@shraddhaimpex.net'));
  });

  test('the confirmation mail goes TO the customer, copying Kinjal and the staff member', async () => {
    const abc = await customerAbc();
    const sales = await salesA();
    const p = await product('SKU-1');
    await call(createReservation, { user: sales, body: { productId: String(p._id), quantity: 5, customerId: String(abc._id) } });
    await call(confirmBooking, { user: sales, body: { customerId: String(abc._id) } });

    const [mail] = mailTo('abc@example.com');
    assert.ok(mail, 'the customer, not the salesperson, is the recipient');
    assert.equal(mailTo('salesa@shraddhaimpex.net').length, 0, 'the salesperson is never the To: address');
    assert.ok(mail.cc.includes('kinjal@shraddhaimpex.net'), `Kinjal copied: ${mail.cc}`);
    assert.ok(mail.cc.includes('salesa@shraddhaimpex.net'), `creator copied: ${mail.cc}`);
    assert.match(mail.body, /placed on your behalf by.*Sales Person A/s);
  });

  test('an admin can do the same, and is named as the SI Team', async () => {
    const abc = await customerAbc();
    const boss = await admin();
    const p = await product('SKU-1');
    const res = await call(createDirectBooking, {
      user: boss, originalUrl: '/api/v1/reservations/direct-booking',
      body: { customerId: String(abc._id), items: [{ productId: String(p._id), quantity: 3 }] },
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
    const [row] = await Order.find({ orderId: res.payload.data.orderId }).lean();
    assert.equal(String(row.user), String(abc._id));
    assert.equal(row.createdByName, 'Admin One');
    assert.equal(row.createdByRole, 'Super Admin');
    assert.ok(mailTo('abc@example.com')[0].cc.includes('admin@shraddhaimpex.net'));
  });

  test('later lifecycle mail copies the creator too (status change)', async () => {
    const abc = await customerAbc();
    const sales = await salesA();
    const p = await product('SKU-1');
    const booked = await call(createDirectBooking, {
      user: sales, body: { customerId: String(abc._id), items: [{ productId: String(p._id), quantity: 3 }] },
    });
    sent.length = 0;
    const moved = await call(updateBookingStatus, {
      user: await admin(), method: 'PUT',
      params: { orderId: booked.payload.data.orderId }, body: { status: 'Ready for Dispatch' },
    });
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.payload));
    const [mail] = mailTo('abc@example.com');
    assert.ok(mail, 'the status mail goes to the customer');
    assert.ok(mail.cc.includes('kinjal@shraddhaimpex.net'));
    assert.ok(mail.cc.includes('salesa@shraddhaimpex.net'), `creator copied on status mail: ${mail.cc}`);
  });

  test('the customer\'s rules apply, not the staff member\'s (MOQ)', async () => {
    const abc = await customerAbc();
    await User.updateOne({ _id: abc._id }, { $set: { moq: null, customerCategory: 'Customer' } });
    const sales = await salesA();
    const p = await ProductKoken.create({ skuCode: 'SKU-M', availableForSale: 50, totalAvailableQuantity: 50, bookedQuantity: 0, moq: 10 });
    const bad = await call(createReservation, { user: sales, body: { productId: String(p._id), quantity: 5, customerId: String(abc._id) } });
    assert.ok(bad.statusCode >= 400, 'a quantity below the customer\'s multiple is refused for the desk too');
    const ok = await call(createReservation, { user: sales, body: { productId: String(p._id), quantity: 10, customerId: String(abc._id) } });
    assert.equal(ok.statusCode, 201, JSON.stringify(ok.payload));
    // And a desk edit of that line keeps the customer's rule.
    const edit = await call(updateReservationQuantity, { user: sales, method: 'PUT', params: { id: String(ok.payload.data._id) }, body: { quantity: 15 } });
    assert.ok(edit.statusCode >= 400);
  });
});

describe('who may book for whom', () => {
  test('a customer cannot book for another customer', async () => {
    const abc = await customerAbc();
    const other = await account({ email: 'other@example.com' });
    const p = await product('SKU-1');
    const res = await call(createReservation, { user: other, body: { productId: String(p._id), quantity: 5, customerId: String(abc._id) } });
    assert.equal(res.statusCode, 403);
    assert.equal(await Reservation.countDocuments(), 0);
  });

  test('the target must be a live Customer account', async () => {
    const sales = await salesA();
    const staff = await admin();
    const p = await product('SKU-1');
    const notCustomer = await call(createReservation, { user: sales, body: { productId: String(p._id), quantity: 5, customerId: String(staff._id) } });
    assert.equal(notCustomer.statusCode, 400);
    const unknown = await call(createReservation, { user: sales, body: { productId: String(p._id), quantity: 5, customerId: String(new mongoose.Types.ObjectId()) } });
    assert.equal(unknown.statusCode, 404);
    const suspended = await account({ email: 'inactive@example.com', status: 'Inactive' });
    const off = await call(createReservation, { user: sales, body: { productId: String(p._id), quantity: 5, customerId: String(suspended._id) } });
    assert.equal(off.statusCode, 409);
  });
});

describe('what the desk and the history show', () => {
  test('Sales Desk carries the SI Team and is searchable by it; Booking History names it', async () => {
    const abc = await customerAbc();
    const sales = await salesA();
    const p = await product('SKU-1');
    const mine = await call(createDirectBooking, {
      user: sales, body: { customerId: String(abc._id), items: [{ productId: String(p._id), quantity: 3 }] },
    });
    const own = await call(createDirectBooking, { user: abc, body: { items: [{ productId: String(p._id), quantity: 2 }] } });
    const boss = await admin();

    const all = await call(getBookings, { user: boss, method: 'GET', query: { status: 'all' } });
    const byId = new Map(all.payload.data.map((b) => [b.orderId, b]));
    assert.equal(byId.get(mine.payload.data.orderId).createdBy.name, 'Sales Person A');
    assert.equal(byId.get(mine.payload.data.orderId).customerProfile.company, 'ABC Industries');
    assert.equal(byId.get(own.payload.data.orderId).createdBy, null);

    const found = await call(getBookings, { user: boss, method: 'GET', query: { status: 'all', search: 'person a' } });
    assert.deepEqual(found.payload.data.map((b) => b.orderId), [mine.payload.data.orderId]);

    const history = await call(getBookingHistory, { user: boss, method: 'GET', params: { orderId: mine.payload.data.orderId } });
    assert.equal(history.statusCode, 200, JSON.stringify(history.payload));
    assert.equal(history.payload.data.booking.siTeam.name, 'Sales Person A');
    assert.equal(history.payload.data.booking.customerName, 'Customer ABC');
    assert.equal(history.payload.data.booking.company, 'ABC Industries');
    assert.equal(history.payload.data.booking.createdFrom.key, 'create-booking');
  });

  test('the customer picker lists live customer accounts only, by name or company', async () => {
    await customerAbc();
    await account({ email: 'xyz@example.com', customerName: 'XYZ Tools', company: 'XYZ Pvt Ltd' });
    await account({ email: 'gone@example.com', customerName: 'Gone Ltd', status: 'Inactive' });
    const sales = await salesA();

    const all = await call(searchCustomers, { user: sales, method: 'GET', query: {} });
    assert.deepEqual(all.payload.data.map((c) => c.customerName).sort(), ['Customer ABC', 'XYZ Tools']);
    assert.ok(all.payload.data.every((c) => c.password === undefined && c.role === undefined));

    const byCompany = await call(searchCustomers, { user: sales, method: 'GET', query: { search: 'abc indus' } });
    assert.deepEqual(byCompany.payload.data.map((c) => c.customerName), ['Customer ABC']);
    const byName = await call(searchCustomers, { user: sales, method: 'GET', query: { search: 'xyz' } });
    assert.deepEqual(byName.payload.data.map((c) => c.company), ['XYZ Pvt Ltd']);
  });
});

describe('selection-list reminders for a desk-built list', () => {
  test('go to the staff member who is building it, naming the customer', async () => {
    const abc = await customerAbc();
    const sales = await salesA();
    const p = await product('SKU-1');
    const res = await call(createReservation, { user: sales, body: { productId: String(p._id), quantity: 5, customerId: String(abc._id) } });
    // Eight days old: expired.
    await Reservation.updateOne({ _id: res.payload.data._id }, {
      $set: {
        reservationDate: new Date(Date.now() - 8 * 24 * 3600 * 1000),
        expiryDate: new Date(Date.now() - 24 * 3600 * 1000),
      },
    });
    sent.length = 0;
    await runReservationExpiryChecks();
    assert.equal(mailTo('abc@example.com').length, 0, 'the customer never saw these lines');
    const [mail] = mailTo('salesa@shraddhaimpex.net');
    assert.ok(mail, 'the desk is told');
    assert.match(mail.body, /on behalf of.*Customer ABC/s);
  });
});
