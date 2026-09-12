/**
 * The full order value: what stock covered, plus what is still on indent.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE GUARDING
 * ---------------------------------------------------------------------------
 *
 * A reservation carries a quantity and no price, so valuing the indent means
 * FINDING a rate. Every plausible shortcut is wrong in a way that looks right:
 *
 *   - Valuing it at zero makes a part-fulfilled order look cheaper than it is,
 *     and the desk quotes that number to the customer.
 *   - Taking the rate from the product master when the booking's own row has
 *     one ignores the tier this customer was actually given.
 *   - Skipping the SKUs that never got an order row drops whole lines from the
 *     total — and those are the lines most likely to still be on indent.
 *
 * The PO's own figure must not move either: `pricingSummary` values confirmed
 * quantity only, on purpose, because an indent remainder has not shipped.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import Order from '../models/Order.js';
import Reservation from '../models/Reservation.js';
import { Product } from '../models/Product.js';
import { valueBooking } from '../modules/sales/pricing.service.js';
import { pricingSummary } from '../modules/sales/booking.shape.js';

const ORDER_ID = 'BO-2026-000001';
const CUSTOMER = new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Order, Reservation, Product);
});
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

/** A booking line already priced at the trader tier. */
const line = (skuCode, confirmedQty, unitPrice, over = {}) => ({
  orderId: ORDER_ID,
  brand: 'Koken',
  user: CUSTOMER,
  status: 'PO Received',
  skuCode,
  confirmedQty,
  requestedQty: confirmedQty,
  bookedQty: confirmedQty,
  priceType: unitPrice === null ? null : 'trader',
  unitPrice,
  ...over,
});

const indentMap = (pairs) => new Map(Object.entries(pairs));

// ---------------------------------------------------------------------------

describe('valuing the indent', () => {
  test('adds the indent to the booking at the rate the customer was given', async () => {
    const rows = [line('SKU-A', 10, 100)];
    // 10 confirmed at 100 = 1000, plus 5 on indent at the same 100 = 500.
    const value = await valueBooking({ rows, indentBySku: indentMap({ 'SKU-A': 5 }) });

    assert.equal(value.booking.amount, 1000);
    assert.equal(value.indent.amount, 500);
    assert.equal(value.subtotal, 1500);
  });

  test('prefers the BOOKING row rate over the product master', async () => {
    // The master says 999; this customer was given 100 and will be charged 100
    // when the indent is fulfilled.
    await Product.create({
      skuCode: 'SKU-A', brand: 'Koken', name: 'Widget',
      prices: { trader: 999 },
    });
    const rows = [line('SKU-A', 10, 100)];

    const value = await valueBooking({ rows, indentBySku: indentMap({ 'SKU-A': 5 }) });
    assert.equal(value.indent.amount, 500, 'the snapshotted rate wins');
  });

  test('values a SKU that never got an order row, from the master', async () => {
    // Nothing could be fulfilled for SKU-B, so confirmation created no row for
    // it — it exists only as a reservation, and it is exactly the kind of line
    // that is still outstanding.
    await Product.create({
      skuCode: 'SKU-B', brand: 'Koken', name: 'Unavailable',
      prices: { trader: 50 },
    });
    const rows = [line('SKU-A', 10, 100)];

    const value = await valueBooking({
      rows,
      indentBySku: indentMap({ 'SKU-A': 5, 'SKU-B': 4 }),
    });

    // 1000 booked + (5 x 100) + (4 x 50) = 1700
    assert.equal(value.subtotal, 1700);
    assert.equal(value.indent.amount, 700);
    assert.equal(value.indent.pricedSkus, 2);
  });

  test('resolves the master price at the BOOKING price type', async () => {
    await Product.create({
      skuCode: 'SKU-B', brand: 'Koken', name: 'Unavailable',
      prices: { trader: 50, endUser: 80 },
    });
    const rows = [line('SKU-A', 10, 100)]; // priceType 'trader'

    const value = await valueBooking({ rows, indentBySku: indentMap({ 'SKU-B': 2 }) });
    // 100, not 160 — the tier chosen for this booking, not another one.
    assert.equal(value.indent.amount, 100);
  });

  test('counts a SKU with no rate on file rather than valuing it at zero', async () => {
    const rows = [line('SKU-A', 10, 100)];

    const value = await valueBooking({
      rows,
      indentBySku: indentMap({ 'SKU-A': 5, 'SKU-NO-PRICE': 3 }),
    });

    assert.equal(value.indent.pricedSkus, 1);
    // Surfaced so the screen can say the figure is partial. Counting it as 0
    // would understate the order and look authoritative doing it.
    assert.equal(value.indent.unpricedSkus, 1);
    assert.equal(value.indent.amount, 500);
  });

  test('reports the indent quantity even when nothing is priced', async () => {
    const rows = [line('SKU-A', 10, null)]; // no price type chosen yet

    const value = await valueBooking({ rows, indentBySku: indentMap({ 'SKU-A': 5 }) });

    // No rate was ever chosen, so there is no value to report - but the
    // quantity is still a fact and the screen can show it.
    assert.equal(value.subtotal, null);
    assert.equal(value.indent.amount, null);
    assert.equal(value.indent.quantity, 5);
  });

  test('an unpriced booking totals null, not zero', async () => {
    const rows = [line('SKU-A', 10, null)];
    const value = await valueBooking({ rows, indentBySku: new Map() });

    // Zero would read as "this order is worth nothing" rather than "nobody has
    // priced it yet".
    assert.equal(value.subtotal, null);
    assert.equal(value.booking.amount, null);
  });

  test('a booking with no indent values exactly as the PO does', async () => {
    const rows = [line('SKU-A', 10, 100), line('SKU-B', 4, 25)];

    const value = await valueBooking({ rows, indentBySku: new Map() });
    // (10 x 100) + (4 x 25)
    assert.equal(value.subtotal, 1100);
    // The two figures agree when there is nothing on indent, which is what
    // makes the wider one safe to show beside the PO.
    assert.equal(value.subtotal, pricingSummary(rows).totalAmount);
  });

  test('an empty booking is null, not a crash', async () => {
    const value = await valueBooking({ rows: [], indentBySku: new Map() });
    assert.equal(value.subtotal, null);
  });
});

// ---------------------------------------------------------------------------

describe('the PO figure is left alone', () => {
  test('pricingSummary still values confirmed quantity only', async () => {
    const rows = [line('SKU-A', 10, 100, { pendingQty: 5 })];

    // The PO charges for what shipped. Widening this would silently re-value
    // every purchase order in the system.
    assert.equal(pricingSummary(rows).totalAmount, 1000);

    const value = await valueBooking({ rows, indentBySku: indentMap({ 'SKU-A': 5 }) });
    assert.equal(value.booking.amount, 1000, 'the booking half matches the PO');
    assert.equal(value.subtotal, 1500, 'the wider figure adds the indent');
  });
});
