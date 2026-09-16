/**
 * The open indent, as LINES — the section under Booking Items on the sales desk.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SECTION IS FOR, AND WHY A TOTAL COULD NOT DO IT
 * ---------------------------------------------------------------------------
 *
 * The desk cross-checks a booking against the customer's paper PO. The indent
 * is the half of that with nothing to look at: a line stock could not cover AT
 * ALL never becomes an order row — confirmation only pushes one when
 * `confirmedQty > 0` — so it exists purely as a reservation and appears NOWHERE
 * in Booking Items.
 *
 * The desk already had the indent's total quantity and its value. Neither can
 * answer "which SKUs", which is the question a paper PO forces. These pin the
 * lines that answer it, and the two things that make them trustworthy: they
 * read the LIVE reservation rather than the quantity frozen onto the order row,
 * and their money is the same money the booking's own total was built from.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import Order from '../models/Order.js';
import Reservation from '../models/Reservation.js';
import { Product } from '../models/Product.js';
import { indentIdFor, openIndentLinesFor } from '../utils/bookingJourney.js';
import { valueIndentLines, ratesForSkus } from '../modules/sales/pricing.service.js';
import { shapeBooking } from '../modules/sales/booking.shape.js';

const ORDER_ID = 'BO-2026-000077';
const CUSTOMER = new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Order, Reservation, Product);
});
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

const indent = (skuCode, quantity, status = 'Pending', over = {}) => ({
  reservationId: `RES-${skuCode}-${status}`,
  customerId: CUSTOMER,
  productId: new mongoose.Types.ObjectId(),
  skuCode,
  msilCode: `MSIL-${skuCode}`,
  quantity,
  expiryDate: new Date(Date.now() + 7 * 864e5),
  reservedBy: CUSTOMER,
  status,
  indentNumber: indentIdFor(ORDER_ID),
  ...over,
});

/** One order row, as the confirmation writes it. */
const row = (skuCode, { confirmedQty = 10, pendingQty = 0, unitPrice = 250 } = {}) => ({
  orderId: ORDER_ID,
  brand: 'Koken',
  user: CUSTOMER,
  status: 'PO Received',
  skuCode,
  requestedQty: confirmedQty + pendingQty,
  bookedQty: confirmedQty + pendingQty,
  confirmedQty,
  pendingQty,
  priceType: 'trader',
  unitPrice,
});

// ===========================================================================
// The lookup
// ===========================================================================

describe('openIndentLinesFor', () => {
  test('returns the open reservations, with the indent number they hang off', async () => {
    await Reservation.create([indent('SKU-A', 12), indent('SKU-B', 5)]);

    const out = await openIndentLinesFor(ORDER_ID);

    // BO-2026-000077 -> PI-2026-000077. The booking and its indent share a
    // number, which is what lets the desk match the two documents at all.
    assert.equal(out.indentNumber, 'PI-2026-000077');
    assert.deepEqual(out.lines.map((l) => [l.skuCode, l.quantity]), [
      ['SKU-A', 12],
      ['SKU-B', 5],
    ]);
  });

  test('🔴 leaves out anything no longer outstanding', async () => {
    await Reservation.create([
      indent('SKU-A', 12),
      indent('SKU-B', 5, 'Partially Confirmed'),
      // Neither of these is something the customer is still waiting for: one
      // became stock on the booking, the other went away.
      indent('SKU-C', 7, 'Confirmed'),
      indent('SKU-D', 9, 'Cancelled'),
    ]);

    const out = await openIndentLinesFor(ORDER_ID);

    assert.deepEqual(out.lines.map((l) => l.skuCode).sort(), ['SKU-A', 'SKU-B']);
  });

  test('another booking\'s indent is not borrowed', async () => {
    await Reservation.create([
      indent('SKU-A', 12),
      { ...indent('SKU-X', 99), indentNumber: indentIdFor('BO-2026-000999') },
    ]);

    const out = await openIndentLinesFor(ORDER_ID);
    assert.deepEqual(out.lines.map((l) => l.skuCode), ['SKU-A']);
  });

  test('a booking with no open indent gets a number and an empty list', async () => {
    const out = await openIndentLinesFor(ORDER_ID);

    // Empty, NOT null. The screen says "stock covered this in full", which is a
    // different sentence from "we did not look".
    assert.equal(out.indentNumber, 'PI-2026-000077');
    assert.deepEqual(out.lines, []);
  });
});

// ===========================================================================
// The money
// ===========================================================================

describe('valueIndentLines', () => {
  test('rates a line at the price THAT CUSTOMER was given, not today\'s', async () => {
    // The master says 999; the booking was struck at 250. The snapshot wins.
    await Product.create({
      skuCode: 'SKU-A', brand: 'Koken', name: 'A', category: 'X',
      prices: { trader: 999 },
    });

    const lines = await valueIndentLines({
      rows: [row('SKU-A', { unitPrice: 250 })],
      lines: [{ skuCode: 'SKU-A', quantity: 12 }],
    });

    assert.equal(lines[0].unitPrice, 250);
    assert.equal(lines[0].amount, 3000);
  });

  test('🔴 an ORPHAN — on the indent but never an order row — is rated from the master', async () => {
    // The case the whole section exists for: stock covered none of SKU-B, so it
    // has no order row and the booking holds no rate for it.
    await Product.create({
      skuCode: 'SKU-B', brand: 'Koken', name: 'B', category: 'X',
      prices: { trader: 40 },
    });

    const lines = await valueIndentLines({
      rows: [row('SKU-A', { unitPrice: 250 })],
      lines: [{ skuCode: 'SKU-B', quantity: 5 }],
    });

    assert.equal(lines[0].unitPrice, 40);
    assert.equal(lines[0].amount, 200);
  });

  test('🔴 a line nothing can rate stays NULL, never zero', async () => {
    const lines = await valueIndentLines({
      rows: [row('SKU-A', { unitPrice: 250 })],
      lines: [{ skuCode: 'SKU-UNKNOWN', quantity: 5 }],
    });

    // "We do not know what this costs" and "it is free" are different facts,
    // and a zero here would total as if the customer owed nothing for it.
    assert.equal(lines[0].unitPrice, null);
    assert.equal(lines[0].amount, null);
  });

  test('a booking with no price type rates nothing at all', async () => {
    await Product.create({
      skuCode: 'SKU-A', brand: 'Koken', name: 'A', category: 'X',
      prices: { trader: 999 },
    });

    const rows = [{ ...row('SKU-A'), priceType: null, unitPrice: null }];
    const lines = await valueIndentLines({ rows, lines: [{ skuCode: 'SKU-A', quantity: 12 }] });

    // No rate was ever chosen for this booking, so there is no tier to read the
    // master at either.
    assert.equal(lines[0].unitPrice, null);
    assert.equal(await ratesForSkus({ rows, skus: ['SKU-A'] }).then((m) => m.size), 0);
  });
});

// ===========================================================================
// What the response carries
// ===========================================================================

describe('the shaped booking', () => {
  const shaped = (opts) => shapeBooking([row('SKU-A')], new Map(), opts);

  test('carries the indent block, totalled, when it is asked for', () => {
    const out = shaped({
      includePricing: true,
      indent: {
        indentNumber: 'PI-2026-000077',
        lines: [
          { skuCode: 'SKU-A', quantity: 12, unitPrice: 250, amount: 3000 },
          { skuCode: 'SKU-B', quantity: 5, unitPrice: 40, amount: 200 },
        ],
      },
    });

    assert.equal(out.indent.indentNumber, 'PI-2026-000077');
    assert.equal(out.indent.totalQuantity, 17);
    assert.equal(out.indent.amount, 3200);
    assert.equal(out.indent.unpricedLines, 0);
  });

  test('an unrated line is counted, and left out of the total', () => {
    const out = shaped({
      includePricing: true,
      indent: {
        indentNumber: 'PI-1',
        lines: [
          { skuCode: 'SKU-A', quantity: 12, unitPrice: 250, amount: 3000 },
          { skuCode: 'SKU-B', quantity: 5, unitPrice: null, amount: null },
        ],
      },
    });

    // The quantity is still a fact; the money is not.
    assert.equal(out.indent.totalQuantity, 17);
    assert.equal(out.indent.amount, 3000);
    assert.equal(out.indent.unpricedLines, 1);
  });

  test('🔴 no money reaches a reader without view_pricing', () => {
    const out = shaped({
      includePricing: false,
      indent: {
        indentNumber: 'PI-1',
        lines: [{ skuCode: 'SKU-A', quantity: 12 }],
      },
    });

    // The quantities are not pricing and stay. The totals that ARE pricing are
    // absent rather than zeroed — the same rule a line's `unitPrice` follows.
    assert.equal(out.indent.totalQuantity, 12);
    assert.equal('amount' in out.indent, false);
    assert.equal('unpricedLines' in out.indent, false);
    assert.equal('unitPrice' in out.lines[0], false);
  });

  test('🔴 the LIST shape carries no indent block at all', () => {
    // The bookings list does not ask for it: listing reservation lines would be
    // a query per row for something no column on that table shows. Null rather
    // than an empty block, so the drawer can tell "not fetched" from "none" and
    // knows to go and get the detail.
    assert.equal(shaped({ includePricing: true }).indent, null);
  });
});
