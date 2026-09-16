/**
 * Who may see what a booking's open indent is WORTH.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDED A GATE OF ITS OWN
 * ---------------------------------------------------------------------------
 *
 * The PO preview now reports the indent's value beside the amount it charges,
 * so the paper can be reconciled against the sales desk's Total Amount card.
 * That figure is a PRICE - it is quantity multiplied by the rate this customer
 * was given - so it has to be shown on exactly the terms `unitPrice` is, and
 * `utils/pricingVisibility.js` spells those out:
 *
 *   view_pricing            everything
 *   the owner, PO raised    their own rate, and now their own indent value
 *   anybody else            nothing
 *
 * The third case is the one worth testing. A role can hold view_all_bookings
 * WITHOUT view_pricing - the permission matrix allows exactly that - and the
 * orders endpoint hands such a reader every booking in the system. If the
 * indent value rode along on the response it would be the same leak the rate
 * redaction exists to prevent, one devtools panel away regardless of what the
 * UI renders.
 *
 * The owner's own booking BEFORE the PO is raised matters too: a price is the
 * customer's business once the purchase order quoting it exists, and not
 * before, while it is still a working figure at the desk.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import Order from '../models/Order.js';
import Reservation from '../models/Reservation.js';
import { Product } from '../models/Product.js';
import { attachBookingValues } from '../utils/bookingIndentValue.js';
import { indentIdFor } from '../utils/bookingJourney.js';

const ORDER_ID = 'BO-2026-000077';
const CUSTOMER = new mongoose.Types.ObjectId();
const SOMEONE_ELSE = new mongoose.Types.ObjectId();

const SALES = { _id: new mongoose.Types.ObjectId(), role: 'Sales', status: 'Active' };
const OWNER = { _id: CUSTOMER, role: 'Customer', status: 'Active' };
const OTHER_CUSTOMER = { _id: SOMEONE_ELSE, role: 'Customer', status: 'Active' };

before(async () => {
  await startTestMongo();
  await syncIndexes(Order, Reservation, Product);
});
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

/** A reservation the model accepts - the shape booking-totals.test.js uses. */
const indent = (orderId, skuCode, quantity, status = 'Pending') => ({
  reservationId: `RES-${orderId}-${skuCode}`,
  customerId: CUSTOMER,
  productId: new mongoose.Types.ObjectId(),
  skuCode,
  quantity,
  expiryDate: new Date(Date.now() + 7 * 864e5),
  reservedBy: CUSTOMER,
  status,
  indentNumber: indentIdFor(orderId),
});

/**
 * A priced booking with an open indent behind it.
 *
 * `poGeneratedAt` is what makes it "raised" — see utils/bookingLock.js — and it
 * is the switch the owner's visibility turns on.
 */
const seed = async ({ poRaised = true } = {}) => {
  const rows = await Order.create([
    {
      orderId: ORDER_ID,
      brand: 'Koken',
      user: CUSTOMER,
      status: 'PO Received',
      skuCode: 'SKU-A',
      requestedQty: 20,
      bookedQty: 20,
      confirmedQty: 20,
      pendingQty: 12,
      priceType: 'trader',
      unitPrice: 250,
      poNumber: poRaised ? 'PO-900' : '-',
      poGeneratedAt: poRaised ? new Date() : null,
    },
  ]);

  // The live indent. 12 units at the same trader rate = 3,000.
  await Reservation.create(indent(ORDER_ID, 'SKU-A', 12));

  return rows.map((r) => r.toObject());
};

/** The rows as the endpoint hands them out: redaction has already happened. */
const redactedCopies = (rows) => rows.map((r) => ({ ...r }));

describe('the indent value rides on the same gate as the rate', () => {
  test('a view_pricing reader gets it', async () => {
    const rows = await seed();
    const out = await attachBookingValues(redactedCopies(rows), SALES, rows);

    assert.ok(out[0].value, 'Sales should see the indent value');
    assert.equal(out[0].value.booking.amount, 5000);
    assert.equal(out[0].value.indent.amount, 3000);
    assert.equal(out[0].value.indent.quantity, 12);
  });

  test('the owner gets it once their PO is raised', async () => {
    const rows = await seed({ poRaised: true });
    const out = await attachBookingValues(redactedCopies(rows), OWNER, rows);

    assert.ok(out[0].value, 'the owner should see their own indent value');
    assert.equal(out[0].value.indent.amount, 3000);
  });

  test('the owner does NOT get it before the PO exists', async () => {
    const rows = await seed({ poRaised: false });
    const out = await attachBookingValues(redactedCopies(rows), OWNER, rows);

    // Until the purchase order quoting it exists, the figure is still a working
    // number at the desk.
    assert.equal(out[0].value, undefined);
  });

  test('another customer gets nothing, PO or no PO', async () => {
    const rows = await seed();
    const out = await attachBookingValues(redactedCopies(rows), OTHER_CUSTOMER, rows);

    assert.equal(out[0].value, undefined);
  });

  test('a reader with no user at all gets nothing', async () => {
    const rows = await seed();
    const out = await attachBookingValues(redactedCopies(rows), null, rows);

    assert.equal(out[0].value, undefined);
  });
});

describe('what it costs when there is nothing to report', () => {
  test('a booking with no open indent gets no value block', async () => {
    const rows = await Order.create([{
      orderId: ORDER_ID,
      brand: 'Koken',
      user: CUSTOMER,
      status: 'PO Received',
      skuCode: 'SKU-A',
      requestedQty: 20,
      bookedQty: 20,
      confirmedQty: 20,
      pendingQty: 0,
      priceType: 'trader',
      unitPrice: 250,
      poNumber: 'PO-900',
      poGeneratedAt: new Date(),
    }]);
    const plain = rows.map((r) => r.toObject());

    const out = await attachBookingValues(redactedCopies(plain), SALES, plain);

    // Nothing outstanding, so nothing is attached — and, just as importantly,
    // no product lookup was fired for it. That guard is what keeps this off the
    // hot path for an Admin whose result set is every booking in the system.
    assert.equal(out[0].value, undefined);
  });
});

describe('it reads the live reservation, not the frozen pendingQty', () => {
  test('a shortfall that has since been part-filled reports what is LEFT', async () => {
    const rows = await seed();           // pendingQty 12, reservation 12
    // Stock arrived and auto-booked 7 of the 12. The order row still says 12;
    // the reservation is the live balance.
    await Reservation.updateOne({ skuCode: 'SKU-A' }, { $set: { quantity: 5 } });

    const out = await attachBookingValues(redactedCopies(rows), SALES, rows);

    assert.equal(out[0].pendingQty, 12, 'the row still carries the frozen figure');
    assert.equal(out[0].value.indent.quantity, 5, 'the value reports the live balance');
    assert.equal(out[0].value.indent.amount, 1250);  // 5 x 250
  });

  test('a SKU that never got an order row is still valued', async () => {
    const rows = await seed();
    // Nothing could be fulfilled for SKU-B, so confirmation pushed no row for
    // it — it exists only as a reservation. Summing order rows would miss it.
    await Product.create({
      skuCode: 'SKU-B', brand: 'Koken', name: 'Second item',
      prices: { trader: 100 },
    });
    await Reservation.create(indent(ORDER_ID, 'SKU-B', 4));

    const out = await attachBookingValues(redactedCopies(rows), SALES, rows);

    assert.equal(out[0].value.indent.quantity, 16);       // 12 + 4
    assert.equal(out[0].value.indent.amount, 3400);       // 3,000 + 400
  });
});
