/**
 * Edit Details → Select Customer: moving a booking to a different customer.
 *
 * Choosing a customer in Edit Details is an OWNERSHIP change, not a text edit:
 * the desk's Customer Name column and the customer's Booking History both read
 * the booking's `user`. So these tests check the whole move (rows, indent
 * lines, status timeline), the details that follow the customer, the details
 * that stay with the order, the SI Team, and every refusal leaving the booking
 * exactly as it was.
 *
 * Runs on a single-node replica set so the move goes through a real
 * transaction, the path production takes on Atlas.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';
import Order, { LINE_ORDER } from '../models/Order.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import Reservation from '../models/Reservation.js';
import BookingStatusEvent from '../models/BookingStatusEvent.js';
import { updateDetails } from '../modules/sales/bookingEdit.service.js';
import { snapshotFromCustomer } from '../utils/bookingFields.js';

const ORDER_ID = 'BO-2026-000077';
const INDENT_NUMBER = 'PI-2026-000077';

before(async () => { await startTestReplSet(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

let seq = 0;
const makeUser = (fields) => User.create({
  email: `u${++seq}@example.com`,
  password: 'x'.repeat(12),
  status: 'Active',
  ...fields,
});

const customerFields = (over = {}) => ({
  role: 'Customer',
  customerCategory: 'Customer',
  brandAccess: { koken: true },
  ...over,
});

/** A two-line booking owned by `owner`, with an open indent line and a status event. */
async function makeBooking(owner, extra = {}) {
  const base = {
    orderId: ORDER_ID,
    brand: 'Koken',
    user: owner._id,
    status: 'PO Received',
    company: 'Old Co',
    emailId: 'old@example.com',
    phoneNumber: '111',
    location: 'Pune',
    shopNumber: 'S-1',
    gstCode: '27AAPFU0939F1ZV',
    shippingAddress: 'Old ship',
    billingAddress: 'Old bill',
    poNumber: 'PO-77',
    vendorCode: 'VEN-9',
    paymentTerm: '30 days',
    ...extra,
  };
  await Order.insertMany(['SKU-A', 'SKU-B'].map((skuCode, i) => ({
    ...base, skuCode, lineSeq: i, requestedQty: 5, confirmedQty: 5, bookedQty: 5,
  })));
  await Reservation.create({
    reservationId: 'R-1',
    customerId: owner._id,
    reservedBy: extra.createdBy || owner._id,
    productId: new mongoose.Types.ObjectId(),
    skuCode: 'SKU-C',
    quantity: 3,
    expiryDate: new Date(Date.now() + 86400000),
    status: 'Pending',
    indentNumber: INDENT_NUMBER,
  });
  await BookingStatusEvent.create({
    orderId: ORDER_ID, user: owner._id, status: 'PO Received', dedupeKey: `${ORDER_ID}:po`,
  });
}

const rowsOf = () => Order.find({ orderId: ORDER_ID }).sort(LINE_ORDER).lean();

const ACTOR = { _id: new mongoose.Types.ObjectId(), role: 'Admin', user: 'Anil', email: 'anil@example.com' };

describe('Edit Details: changing the booking customer', () => {
  test('moves every row, the indent lines and the status timeline to the new customer', async () => {
    const oldOwner = await makeUser(customerFields({ customerName: 'Old Customer' }));
    const next = await makeUser(customerFields({
      customerName: 'New Customer', company: 'New Co', phone: '999', location: 'Mumbai',
      shopNumber: 'S-9', gstNumber: '27AABCU9603R1ZM', shippingAddress: 'New ship', billingAddress: 'New bill',
    }));
    await makeBooking(oldOwner);

    const { changes } = await updateDetails({ orderId: ORDER_ID, patch: { customerId: String(next._id) }, actor: ACTOR });

    const rows = await rowsOf();
    assert.ok(rows.every((r) => String(r.user) === String(next._id)), 'every row belongs to the new customer');
    assert.equal(await Reservation.countDocuments({ indentNumber: INDENT_NUMBER, customerId: next._id }), 1);
    assert.equal(await BookingStatusEvent.countDocuments({ orderId: ORDER_ID, user: next._id }), 1);
    assert.equal(changes[0].field, 'customer');
    assert.equal(changes[0].from, 'Old Customer');
    assert.equal(changes[0].to, 'New Customer');
  });

  test("re-stamps the customer's details and keeps the order's own", async () => {
    const oldOwner = await makeUser(customerFields());
    const next = await makeUser(customerFields({
      customerName: 'New Customer', company: 'New Co', phone: '999', location: 'Mumbai',
      shopNumber: 'S-9', gstNumber: '27AABCU9603R1ZM', shippingAddress: 'New ship', billingAddress: 'New bill',
    }));
    await makeBooking(oldOwner);

    await updateDetails({ orderId: ORDER_ID, patch: { customerId: String(next._id) }, actor: ACTOR });

    for (const row of await rowsOf()) {
      assert.equal(row.company, 'New Co');
      assert.equal(row.emailId, next.email);
      assert.equal(row.phoneNumber, '999');
      assert.equal(row.location, 'Mumbai');
      assert.equal(row.shopNumber, 'S-9');
      assert.equal(row.gstCode, '27AABCU9603R1ZM');
      assert.equal(row.shippingAddress, 'New ship');
      assert.equal(row.billingAddress, 'New bill');
      // The order's own terms do not follow the customer.
      assert.equal(row.poNumber, 'PO-77');
      assert.equal(row.vendorCode, 'VEN-9');
      assert.equal(row.paymentTerm, '30 days');
      assert.equal(row.confirmedQty, 5);
    }
  });

  test("a detail the new customer lacks is cleared, not left as the old customer's", async () => {
    const oldOwner = await makeUser(customerFields());
    const next = await makeUser(customerFields({ customerName: 'Bare' }));
    await makeBooking(oldOwner);

    await updateDetails({ orderId: ORDER_ID, patch: { customerId: String(next._id) }, actor: ACTOR });

    const [row] = await rowsOf();
    assert.equal(row.gstCode, null);
    assert.equal(row.shopNumber, null);
    assert.equal(row.company, 'Bare', 'company falls back to the customer name');
  });

  test('a value the form sent wins over the new customer record', async () => {
    const oldOwner = await makeUser(customerFields());
    const next = await makeUser(customerFields({ customerName: 'New', shippingAddress: 'Profile address' }));
    await makeBooking(oldOwner);

    await updateDetails({
      orderId: ORDER_ID,
      patch: { customerId: String(next._id), shippingAddress: 'Site 4, as on the PO' },
      actor: ACTOR,
    });

    const [row] = await rowsOf();
    assert.equal(row.shippingAddress, 'Site 4, as on the PO');
  });

  test("leaves the other customer's records alone", async () => {
    const oldOwner = await makeUser(customerFields());
    const next = await makeUser(customerFields());
    await makeBooking(oldOwner);
    await Reservation.create({
      reservationId: 'R-other', customerId: oldOwner._id, reservedBy: oldOwner._id,
      productId: new mongoose.Types.ObjectId(), skuCode: 'SKU-Z', quantity: 1,
      expiryDate: new Date(Date.now() + 86400000), status: 'Pending', indentNumber: 'PI-2026-000099',
    });

    await updateDetails({ orderId: ORDER_ID, patch: { customerId: String(next._id) }, actor: ACTOR });

    const other = await Reservation.findOne({ reservationId: 'R-other' }).lean();
    assert.equal(String(other.customerId), String(oldOwner._id));
  });

  test('the SI Team stays the original creator when someone else edits', async () => {
    const creator = await makeUser({ role: 'Sales', user: 'Priya Sales' });
    const oldOwner = await makeUser(customerFields());
    const next = await makeUser(customerFields());
    await makeBooking(oldOwner, {
      createdBy: creator._id, createdByName: 'Priya Sales', createdByEmail: creator.email, createdByRole: 'Sales',
    });

    await updateDetails({ orderId: ORDER_ID, patch: { customerId: String(next._id) }, actor: ACTOR });

    for (const row of await rowsOf()) {
      assert.equal(String(row.createdBy), String(creator._id));
      assert.equal(row.createdByName, 'Priya Sales');
    }
  });

  test('a legacy booking under a staff account records that staff member as the SI Team', async () => {
    const staff = await makeUser({ role: 'Sales', user: 'Rahul Sales' });
    const next = await makeUser(customerFields({ customerName: 'Real Customer' }));
    await makeBooking(staff);

    await updateDetails({ orderId: ORDER_ID, patch: { customerId: String(next._id) }, actor: ACTOR });

    for (const row of await rowsOf()) {
      assert.equal(String(row.user), String(next._id));
      assert.equal(String(row.createdBy), String(staff._id));
      assert.equal(row.createdByName, 'Rahul Sales');
      assert.equal(row.createdByRole, 'Sales');
    }
  });

  test('a booking placed by the customer themselves gets no SI Team', async () => {
    const oldOwner = await makeUser(customerFields());
    const next = await makeUser(customerFields());
    await makeBooking(oldOwner);

    await updateDetails({ orderId: ORDER_ID, patch: { customerId: String(next._id) }, actor: ACTOR });

    const [row] = await rowsOf();
    assert.equal(row.createdBy ?? null, null);
  });

  test('choosing the customer it already belongs to changes nothing and records nothing', async () => {
    const owner = await makeUser(customerFields({ company: 'Profile Co' }));
    await makeBooking(owner);

    const { changes } = await updateDetails({
      orderId: ORDER_ID, patch: { customerId: String(owner._id) }, actor: ACTOR,
    });

    assert.deepEqual(changes, []);
    const [row] = await rowsOf();
    assert.equal(row.company, 'Old Co', "the booking's own snapshot is not re-stamped");
    assert.equal(await AuditLog.countDocuments({}), 0);
  });

  test('records the customer change in the audit trail', async () => {
    const oldOwner = await makeUser(customerFields({ customerName: 'Old Customer' }));
    const next = await makeUser(customerFields({ customerName: 'New Customer' }));
    await makeBooking(oldOwner);

    await updateDetails({ orderId: ORDER_ID, patch: { customerId: String(next._id) }, actor: ACTOR });

    const entry = await AuditLog.findOne({ action: 'Booking Details Edited' }).lean();
    assert.ok(entry, 'audit row written');
    assert.match(entry.remarks, /Customer "Old Customer" → "New Customer"/);
    assert.equal(entry.meta.customerChange.to, String(next._id));
    assert.equal(entry.meta.customerChange.indents, 1);
    assert.equal(entry.meta.customerChange.statusEvents, 1);
  });

  describe('refuses, and writes nothing', () => {
    const cases = [
      ['an unknown customer', async () => String(new mongoose.Types.ObjectId()), 404],
      ['a malformed id', async () => 'not-an-id', 404],
      ['a staff account', async () => String((await makeUser({ role: 'Sales' }))._id), 400],
      ['an inactive customer', async () => String((await makeUser(customerFields({ status: 'Inactive' })))._id), 409],
      ['a customer without the booking brand', async () => String((await makeUser(customerFields({ brandAccess: { bix: true } })))._id), 409],
      ['an MSIL customer for a standard booking', async () => String((await makeUser(customerFields({ customerCategory: 'MSIL' })))._id), 409],
    ];
    for (const [name, pick, status] of cases) {
      test(name, async () => {
        const owner = await makeUser(customerFields());
        await makeBooking(owner);
        const before = await rowsOf();
        const target = await pick();

        await assert.rejects(
          updateDetails({ orderId: ORDER_ID, patch: { customerId: target, remarks: 'x' }, actor: ACTOR }),
          (err) => err.status === status && err.field === 'customerId',
        );

        assert.deepEqual(await rowsOf(), before);
        assert.equal(await Reservation.countDocuments({ customerId: owner._id }), 1);
        assert.equal(await AuditLog.countDocuments({}), 0);
      });
    }
  });

  test('a legacy staff-owned booking may go to an MSIL customer', async () => {
    const staff = await makeUser({ role: 'Admin', user: 'Desk Admin' });
    const msil = await makeUser(customerFields({ customerCategory: 'MSIL' }));
    await makeBooking(staff);

    await updateDetails({ orderId: ORDER_ID, patch: { customerId: String(msil._id) }, actor: ACTOR });

    const [row] = await rowsOf();
    assert.equal(String(row.user), String(msil._id));
  });

  test('ordinary detail edits are unchanged when no customer is chosen', async () => {
    const owner = await makeUser(customerFields());
    await makeBooking(owner);

    const { changes } = await updateDetails({ orderId: ORDER_ID, patch: { shopNumber: 'S-2' }, actor: ACTOR });

    assert.deepEqual(changes.map((c) => c.field), ['shopNumber']);
    const [row] = await rowsOf();
    assert.equal(String(row.user), String(owner._id));
    assert.equal(row.emailId, 'old@example.com');
  });

  test('snapshotFromCustomer covers exactly the customer fields booking creation stamps', () => {
    assert.deepEqual(Object.keys(snapshotFromCustomer({})).sort(), [
      'billingAddress', 'customerName', 'emailId', 'gstCode', 'location', 'phoneNumber',
      'shippingAddress', 'shopNumber',
    ]);
  });
});
