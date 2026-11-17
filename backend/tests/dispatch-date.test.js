/**
 * Default dispatch date: 3 days after booking, on every line booked from stock,
 * shown under "Dispatch Date" in the confirmation and delivery schedule emails.
 *
 * The date lives on the line's `scheduledDate` - the field the Sales Desk edits
 * and the schedule email reads - so the portal, the database and the emails
 * cannot disagree about it.
 */
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
const sent = [];
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: {
    sendEmail: async (to, subject, body, options = {}) => {
      sent.push({ to, subject, body, cc: options.cc || [] });
      return true;
    },
  },
});

const { default: Order } = await import('../models/Order.js');
const { default: User } = await import('../models/User.js');
const { default: Location } = await import('../models/Location.js');
const { ProductKoken } = await import('../models/Product.js');
const { createReservation, confirmBooking } = await import('../modules/reservations/reservation.controller.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');
const { defaultDispatchDate, DEFAULT_DISPATCH_DAYS } = await import('../utils/dispatchDate.js');
const { buildDeliveryScheduleMail } = await import('../utils/deliveryScheduleMail.js');
const { fmtDay } = await import('../utils/indentMail.js');

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
const customer = async () => (await User.create({
  email: `cust${++seq}@example.com`, password: 'x', role: 'Customer', user: 'Asha',
  brandAccess: { koken: true, bix: true, imada: true }, moq: 'SKIP',
})).toObject();
const product = (sku, stock) => ProductKoken.create({
  skuCode: sku, availableForSale: stock, totalAvailableQuantity: stock, bookedQuantity: 0,
});
const book = async (who, items) => {
  for (const [p, quantity] of items) {
    await call(createReservation, { user: who, body: { productId: String(p._id), quantity } });
  }
  return call(confirmBooking, { user: who, body: {} });
};

describe('the default dispatch date', () => {
  test('is three calendar days after the booking day', () => {
    assert.equal(DEFAULT_DISPATCH_DAYS, 3);
    // 10:00 IST on 17 Nov 2026.
    assert.equal(defaultDispatchDate(new Date('2026-11-17T04:30:00Z')).toISOString(), '2026-11-20T00:00:00.000Z');
  });

  test('counts from the booking day in India, whatever zone the server is in', () => {
    // 23:30 IST on 17 Nov is still the 17th in India (18:00 UTC).
    assert.equal(defaultDispatchDate(new Date('2026-11-17T18:00:00Z')).toISOString(), '2026-11-20T00:00:00.000Z');
    // 00:30 IST on 18 Nov is 19:00 UTC on the 17th - but the 18th in India.
    assert.equal(defaultDispatchDate(new Date('2026-11-17T19:00:00Z')).toISOString(), '2026-11-21T00:00:00.000Z');
  });

  test('rolls over month ends', () => {
    assert.equal(defaultDispatchDate(new Date('2026-11-29T06:00:00Z')).toISOString(), '2026-12-02T00:00:00.000Z');
  });
});

describe('a booking from available stock', () => {
  test('every booked line carries the dispatch date, and the email shows it under Dispatch Date', async () => {
    const who = await customer();
    const res = await book(who, [[await product('SKU-A', 20), 5], [await product('SKU-B', 20), 3]]);
    assert.equal(res.statusCode, 201, JSON.stringify(res.payload));

    const rows = await Order.find({ orderId: res.payload.data.orderId }).lean();
    assert.equal(rows.length, 2);
    const expected = defaultDispatchDate(rows[0].date).toISOString();
    for (const row of rows) {
      assert.equal(new Date(row.scheduledDate).toISOString(), expected, 'stored on the line');
      assert.equal(row.scheduledBy ?? null, null, 'set by the system, not a person');
    }

    const mail = sent.find((m) => m.to === who.email);
    assert.ok(mail, 'the customer is mailed');
    assert.match(mail.body, /Dispatch Date/);
    assert.ok(mail.body.includes(fmtDay(expected)), `the date is in the email: ${fmtDay(expected)}`);
    assert.doesNotMatch(mail.body, /Available From/i);
  });

  test('a partly indented booking dates the booked part and says the indent comes later', async () => {
    const who = await customer();
    const res = await book(who, [[await product('SKU-C', 2), 5]]);
    assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
    const [row] = await Order.find({ orderId: res.payload.data.orderId }).lean();
    assert.ok(row.scheduledDate, 'the 2 booked units have a dispatch date');
    const mail = sent.find((m) => m.to === who.email);
    assert.match(mail.body, /Dispatch Date/);
    assert.match(mail.body, /Indented units are scheduled once material arrives/);
  });

  test('nothing in stock: no booking line, no dispatch date', async () => {
    const who = await customer();
    const res = await book(who, [[await product('SKU-D', 0), 4]]);
    assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
    assert.equal(await Order.countDocuments({}), 0);
    const mail = sent.find((m) => m.to === who.email);
    assert.ok(mail);
    assert.doesNotMatch(mail.body, /Dispatch Date/);
  });
});

describe('the delivery schedule email', () => {
  const line = (sku, date) => ({ reference: 'BO-1', skuCode: sku, product: null, quantity: 1, scheduledDate: date, note: null });

  test('booking lines are headed Dispatch Date; indent lines keep Available From', () => {
    const mail = buildDeliveryScheduleMail({
      customer: { name: 'Asha' },
      bookingLines: [line('SKU-A', new Date('2026-11-20T00:00:00Z'))],
      indentLines: [{ ...line('SKU-Z', new Date('2026-12-01T00:00:00Z')), reference: 'PI-1' }],
    });
    const [bookingPart, indentPart] = mail.html.split('Indent Items');
    assert.match(bookingPart, /Dispatch Date/);
    assert.doesNotMatch(bookingPart, /Available From/);
    assert.match(indentPart, /Available From/);
    assert.doesNotMatch(indentPart, /Dispatch Date/);
  });
});
