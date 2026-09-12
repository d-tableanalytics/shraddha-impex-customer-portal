/**
 * The Total Quantity figure, and the indent balance behind it.
 *
 * ---------------------------------------------------------------------------
 * THE TWO TRAPS
 * ---------------------------------------------------------------------------
 *
 * 1. DOUBLE COUNTING. At the split, `resItem.quantity = pendingQty` — the
 *    booking row's shortfall and the reservation hold the SAME units. Adding
 *    `confirmedQty + pendingQty + indent` reports the shortfall twice, and it
 *    looks perfectly plausible on screen.
 *
 * 2. THE STALE SNAPSHOT. `pendingQty` is frozen at confirmation. When stock
 *    arrives and auto-books part of the indent, the reservation shrinks and the
 *    row does not — so a total built on `pendingQty` keeps reporting units the
 *    customer already has.
 *
 * A card that is wrong in either direction is worse than no card, because the
 * desk is using it to decide whether the booking matches the customer's PO.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import Order from '../models/Order.js';
import Reservation from '../models/Reservation.js';
import { shapeBooking } from '../modules/sales/booking.shape.js';
import { openIndentsByOrder, openIndentBySku, indentIdFor } from '../utils/bookingJourney.js';

const CUSTOMER = new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Order, Reservation);
});
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

const line = (orderId, skuCode, confirmedQty, pendingQty = 0, lineSeq = 0) => ({
  orderId,
  brand: 'Koken',
  user: CUSTOMER,
  status: 'PO Received',
  company: 'ABC Motors',
  skuCode,
  lineSeq,
  requestedQty: confirmedQty,
  bookedQty: confirmedQty + pendingQty,
  confirmedQty,
  pendingQty,
});

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

const totalsFor = async (orderId) => {
  const rows = await Order.find({ orderId });
  return shapeBooking(rows, new Map(), { indentBySku: await openIndentBySku(orderId) }).totals;
};

// ---------------------------------------------------------------------------

describe('the indent balance', () => {
  test('is found by the PI number that shares the booking sequence', () => {
    // BO-2026-001312 and PI-2026-001312 are one confirmation.
    assert.equal(indentIdFor('BO-2026-001312'), 'PI-2026-001312');
  });

  test('counts only what is still outstanding', async () => {
    const id = 'BO-2026-000001';
    await Reservation.insertMany([
      indent(id, 'SKU-A', 5, 'Pending'),
      indent(id, 'SKU-B', 7, 'Partially Confirmed'),
      // Neither of these is still owed to the customer.
      { ...indent(id, 'SKU-C', 99, 'Confirmed'), reservationId: 'RES-C' },
      { ...indent(id, 'SKU-D', 50, 'Cancelled'), reservationId: 'RES-D' },
    ]);

    const bySku = await openIndentBySku(id);
    assert.equal([...bySku.values()].reduce((a, b) => a + b, 0), 12);
  });

  test('does not leak between bookings', async () => {
    await Reservation.insertMany([
      indent('BO-2026-000001', 'SKU-A', 5),
      { ...indent('BO-2026-000002', 'SKU-A', 40), reservationId: 'RES-OTHER' },
    ]);

    const bySku = await openIndentBySku('BO-2026-000001');
    assert.equal(bySku.get('SKU-A'), 5);
  });

  test('resolves many bookings in one query', async () => {
    await Reservation.insertMany([
      indent('BO-2026-000001', 'SKU-A', 5),
      { ...indent('BO-2026-000002', 'SKU-B', 8), reservationId: 'RES-2' },
    ]);

    const all = await openIndentsByOrder(['BO-2026-000001', 'BO-2026-000002', 'BO-2026-000003']);
    assert.equal(all.get('BO-2026-000001').get('SKU-A'), 5);
    assert.equal(all.get('BO-2026-000002').get('SKU-B'), 8);
    // A booking with no indent still gets an entry, so a caller can read it
    // without a null check and without mistaking "none" for "not asked".
    assert.equal(all.get('BO-2026-000003').size, 0);
  });
});

// ---------------------------------------------------------------------------

describe('Total Quantity', () => {
  test('is confirmed plus indent', async () => {
    const id = 'BO-2026-000001';
    await Order.insertMany([line(id, 'SKU-A', 10, 5, 0), line(id, 'SKU-B', 20, 0, 1)]);
    await Reservation.create(indent(id, 'SKU-A', 5));

    assert.deepEqual(await totalsFor(id), { booked: 30, indent: 5, total: 35 });
  });

  test('does NOT double-count the shortfall', async () => {
    const id = 'BO-2026-000001';
    // The classic shape: 10 confirmed, 5 short. The row records the 5 as
    // pendingQty AND the reservation holds the same 5.
    await Order.insertMany([line(id, 'SKU-A', 10, 5)]);
    await Reservation.create(indent(id, 'SKU-A', 5));

    const totals = await totalsFor(id);
    // 15, not 20. confirmedQty + pendingQty + indent would give 20.
    assert.equal(totals.total, 15);
  });

  test('follows the indent down as stock auto-books against it', async () => {
    const id = 'BO-2026-000001';
    // pendingQty stays frozen at 5 while the reservation shrinks to 2.
    await Order.insertMany([line(id, 'SKU-A', 10, 5)]);
    await Reservation.create(indent(id, 'SKU-A', 2, 'Partially Confirmed'));

    const totals = await totalsFor(id);
    // 12, not 15. Reading pendingQty would keep promising units already
    // delivered.
    assert.equal(totals.indent, 2);
    assert.equal(totals.total, 12);
  });

  test('counts a line that got no order row at all', async () => {
    const id = 'BO-2026-000001';
    // Confirmation only creates an order row when confirmedQty > 0, so a SKU
    // that was entirely unavailable exists ONLY as a reservation. Summing the
    // indent per order row would miss it — and it is exactly the mismatch the
    // desk is looking for.
    await Order.insertMany([line(id, 'SKU-A', 10, 0)]);
    await Reservation.create(indent(id, 'SKU-UNAVAILABLE', 25));

    assert.deepEqual(await totalsFor(id), { booked: 10, indent: 25, total: 35 });
  });

  test('a fully confirmed booking has no indent and totals the confirmed units', async () => {
    const id = 'BO-2026-000001';
    await Order.insertMany([line(id, 'SKU-A', 10, 0, 0), line(id, 'SKU-B', 4, 0, 1)]);

    assert.deepEqual(await totalsFor(id), { booked: 14, indent: 0, total: 14 });
  });

  test('reports null, not zero, when the indent was not supplied', async () => {
    const id = 'BO-2026-000001';
    await Order.insertMany([line(id, 'SKU-A', 10, 5)]);
    const rows = await Order.find({ orderId: id });

    // A caller that forgot the indent must not be handed a confident 10.
    const totals = shapeBooking(rows, new Map()).totals;
    assert.equal(totals.booked, 10);
    assert.equal(totals.indent, null);
    assert.equal(totals.total, null);
  });

  test('leaves the existing totalQuantity meaning untouched', async () => {
    const id = 'BO-2026-000001';
    await Order.insertMany([line(id, 'SKU-A', 10, 5)]);
    await Reservation.create(indent(id, 'SKU-A', 5));
    const rows = await Order.find({ orderId: id });

    const shaped = shapeBooking(rows, new Map(), { indentBySku: await openIndentBySku(id) });
    // Existing readers treat this as "confirmed units on the booking".
    // Widening it in place would have changed what they report.
    assert.equal(shaped.totalQuantity, 10);
    assert.equal(shaped.totals.total, 15);
  });
});
