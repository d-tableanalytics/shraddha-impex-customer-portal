/**
 * scripts/reassign-booking-customer.js — moving a booking the desk placed under
 * its own account onto the customer it was for.
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';

const { default: Order } = await import('../models/Order.js');
const { default: User } = await import('../models/User.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: BookingStatusEvent } = await import('../models/BookingStatusEvent.js');
const { listMisownedBookings, reassignBooking } = await import('../scripts/reassign-booking-customer.js');

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

const line = (over) => ({
  orderId: 'BO-2026-000500', brand: 'koken', status: 'PO Received', skuCode: 'SKU-1',
  requestedQty: 2, bookedQty: 2, confirmedQty: 2, poNumber: '-', date: new Date('2026-10-01'), ...over,
});

const setup = async () => {
  const sales = await User.create({ email: 'salesa@shraddhaimpex.net', password: 'x', role: 'Sales', user: 'Sales Person A', company: 'Shraddha Impex' });
  const abc = await User.create({
    email: 'abc@example.com', password: 'x', role: 'Customer', user: 'Asha', customerName: 'Customer ABC',
    company: 'ABC Industries', phone: '9999', gstNumber: 'GST1', shippingAddress: 'Plot 1',
  });
  await Order.insertMany([
    line({ user: sales._id, company: 'Shraddha Impex', emailId: 'salesa@shraddhaimpex.net', role: 'Sales', lineSeq: 0 }),
    line({ user: sales._id, company: 'Shraddha Impex', emailId: 'salesa@shraddhaimpex.net', role: 'Sales', lineSeq: 1, skuCode: 'SKU-2' }),
  ]);
  await Reservation.create({
    reservationId: 'RES-1', customerId: sales._id, reservedBy: sales._id, productId: sales._id, skuCode: 'SKU-2',
    quantity: 3, expiryDate: new Date(), status: 'Pending', indentNumber: 'PI-2026-000500',
  });
  await BookingStatusEvent.create({
    orderId: 'BO-2026-000500', user: sales._id, status: 'PO Received', changedAt: new Date(), dedupeKey: 'BO-2026-000500|PO Received|0',
  });
  return { sales, abc };
};

describe('reassign-booking-customer', () => {
  test('lists bookings owned by staff accounts', async () => {
    const { sales } = await setup();
    const found = await listMisownedBookings();
    assert.equal(found.length, 1);
    assert.equal(found[0].orderId, 'BO-2026-000500');
    assert.equal(found[0].lines, 2);
    assert.equal(String(found[0].placedBy._id), String(sales._id));
  });

  test('a dry run changes nothing', async () => {
    const { sales } = await setup();
    const r = await reassignBooking({ orderId: 'BO-2026-000500', customerEmail: 'ABC@example.com' });
    assert.ok(r.ok, r.message);
    assert.equal(r.changes.lines, 2);
    assert.equal(r.changes.indents, 1);
    assert.equal((await Order.findOne({ orderId: 'BO-2026-000500' })).user.toString(), String(sales._id));
  });

  test('--apply moves the lines, indent and events to the customer and stamps the SI Team', async () => {
    const { sales, abc } = await setup();
    const r = await reassignBooking({ orderId: 'BO-2026-000500', customerEmail: 'abc@example.com', apply: true });
    assert.ok(r.ok, r.message);

    const rows = await Order.find({ orderId: 'BO-2026-000500' }).lean();
    for (const row of rows) {
      assert.equal(String(row.user), String(abc._id));
      assert.equal(row.company, 'ABC Industries');
      assert.equal(row.emailId, 'abc@example.com');
      assert.equal(row.gstCode, 'GST1');
      assert.equal(row.shippingAddress, 'Plot 1');
      assert.equal(row.role, 'Customer');
      assert.equal(String(row.createdBy), String(sales._id));
      assert.equal(row.createdByName, 'Sales Person A');
      assert.equal(row.createdByEmail, 'salesa@shraddhaimpex.net');
    }
    const indent = await Reservation.findOne({ reservationId: 'RES-1' }).lean();
    assert.equal(String(indent.customerId), String(abc._id));
    assert.equal(String(indent.reservedBy), String(sales._id), 'the desk still raised it');
    const ev = await BookingStatusEvent.findOne({ orderId: 'BO-2026-000500' }).lean();
    assert.equal(String(ev.user), String(abc._id));

    // Running it again finds nothing to do.
    const again = await reassignBooking({ orderId: 'BO-2026-000500', customerEmail: 'abc@example.com', apply: true });
    assert.equal(again.ok, false);
    assert.match(again.message, /Already owned by customer/);
    assert.equal((await listMisownedBookings()).length, 0);
  });

  test('refuses an unknown booking, a staff email, or a blank email', async () => {
    const { sales } = await setup();
    assert.equal((await reassignBooking({ orderId: 'BO-0', customerEmail: 'abc@example.com' })).ok, false);
    assert.equal((await reassignBooking({ orderId: 'BO-2026-000500', customerEmail: sales.email })).ok, false);
    assert.equal((await reassignBooking({ orderId: 'BO-2026-000500', customerEmail: '' })).ok, false);
    assert.equal((await reassignBooking({ orderId: 'BO-2026-000500', customerEmail: 'nobody@example.com' })).ok, false);
  });
});
