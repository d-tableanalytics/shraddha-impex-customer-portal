/**
 * Manual rates: "No pricing" chosen on the Sales Desk, then a price typed into
 * each line of the booking table.
 *
 * The typed rate has to behave exactly like a tier's rate once saved — in the
 * booking's summary, its full value and the PO — and must survive the PO being
 * raised, which re-applies whatever price type the dialog sends.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import Order from '../models/Order.js';
import { Product } from '../models/Product.js';
import { applyPricing, applyManualPricing, valueBooking } from '../modules/sales/pricing.service.js';
import { pricingSummary } from '../modules/sales/booking.shape.js';
import { normalisePriceType, labelForPriceType, PRICE_TYPE_KEYS } from '../config/pricing.js';

const ORDER_ID = 'BO-2026-000001';
const CUSTOMER = new mongoose.Types.ObjectId();
const actor = { _id: new mongoose.Types.ObjectId() };

before(async () => {
  await startTestMongo();
  await syncIndexes(Order, Product);
});
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

const line = (skuCode, confirmedQty, over = {}) => ({
  orderId: ORDER_ID, brand: 'Koken', user: CUSTOMER, status: 'Booked',
  skuCode, confirmedQty, requestedQty: confirmedQty, bookedQty: confirmedQty,
  priceType: null, unitPrice: null, ...over,
});

const rowsOf = () => Order.find({ orderId: ORDER_ID }).sort({ skuCode: 1 });

describe('manual pricing', () => {
  test('"manual" is a recognised marker but not one of the tiers', () => {
    assert.equal(normalisePriceType('Manual'), 'manual');
    assert.equal(labelForPriceType('manual'), 'Manual');
    assert.equal(PRICE_TYPE_KEYS.includes('manual'), false);
  });

  test('typed rates are saved per line and valued like any other rate', async () => {
    const [a, b] = await Order.create([line('A', 2), line('B', 3)]);

    const result = await applyManualPricing({
      orderId: ORDER_ID, rows: await rowsOf(), prices: { [a._id]: '150.5', [b._id]: 40 }, actor,
    });
    assert.equal(result.priceType, 'manual');
    assert.equal(result.totalAmount, 421);

    const rows = await rowsOf();
    assert.deepEqual(rows.map((r) => [r.priceType, r.unitPrice]), [['manual', 150.5], ['manual', 40]]);
    const summary = pricingSummary(rows);
    assert.equal(summary.priceTypeLabel, 'Manual');
    assert.equal(summary.totalAmount, 421);
    assert.equal((await valueBooking({ rows })).booking.amount, 421);
  });

  test('a line left blank stays unrated; other lines keep their earlier rate', async () => {
    const [a, b] = await Order.create([line('A', 2), line('B', 3)]);
    await applyManualPricing({ orderId: ORDER_ID, rows: await rowsOf(), prices: { [a._id]: 10, [b._id]: 20 }, actor });

    // Only B is edited (cleared); A keeps 10.
    const result = await applyManualPricing({ orderId: ORDER_ID, rows: await rowsOf(), prices: { [b._id]: '' }, actor });
    assert.equal(result.pricedLines, 1);
    assert.equal(result.unpricedLines, 1);
    assert.deepEqual((await rowsOf()).map((r) => r.unitPrice), [10, null]);
  });

  test('clearing every rate returns the booking to no pricing', async () => {
    const [a] = await Order.create([line('A', 2)]);
    await applyManualPricing({ orderId: ORDER_ID, rows: await rowsOf(), prices: { [a._id]: 10 }, actor });
    const result = await applyManualPricing({ orderId: ORDER_ID, rows: await rowsOf(), prices: { [a._id]: null }, actor });
    assert.equal(result.priceType, null);
    assert.equal(pricingSummary(await rowsOf()), null);
  });

  test('switching from a tier starts every line blank', async () => {
    const [a] = await Order.create([
      line('A', 2, { priceType: 'trader', unitPrice: 99 }),
      line('B', 1, { priceType: 'trader', unitPrice: 50 }),
    ]);
    await applyManualPricing({ orderId: ORDER_ID, rows: await rowsOf(), prices: { [a._id]: 70 }, actor });
    assert.deepEqual((await rowsOf()).map((r) => [r.priceType, r.unitPrice]), [['manual', 70], ['manual', null]]);
  });

  test('a bad price or a foreign line is refused and nothing is written', async () => {
    const [a] = await Order.create([line('A', 2)]);
    for (const prices of [{ [a._id]: '0' }, { [a._id]: 'abc' }, { [new mongoose.Types.ObjectId()]: 5 }]) {
      await assert.rejects(
        applyManualPricing({ orderId: ORDER_ID, rows: await rowsOf(), prices, actor }),
        (err) => err.statusCode === 400,
      );
    }
    assert.equal((await rowsOf())[0].priceType, null);
  });

  test('raising the PO with the manual marker keeps the typed rates', async () => {
    const [a] = await Order.create([line('A', 4)]);
    await applyManualPricing({ orderId: ORDER_ID, rows: await rowsOf(), prices: { [a._id]: 25 }, actor });

    const result = await applyPricing({ orderId: ORDER_ID, rows: await rowsOf(), priceType: 'manual', actor });
    assert.equal(result.priceType, 'manual');
    assert.equal(result.totalAmount, 100);
    assert.equal((await rowsOf())[0].unitPrice, 25);
  });

  test('the indent of a hand-priced booking is not valued from the pricelist', async () => {
    await Product.create({ skuCode: 'X', brand: 'Koken', prices: { trader: 500 } });
    const [a] = await Order.create([line('A', 1)]);
    await applyManualPricing({ orderId: ORDER_ID, rows: await rowsOf(), prices: { [a._id]: 10 }, actor });

    const value = await valueBooking({ rows: await rowsOf(), indentBySku: new Map([['A', 2], ['X', 1]]) });
    assert.equal(value.indent.amount, 20, 'A on indent at its typed rate; X has none');
    assert.equal(value.indent.unpricedSkus, 1);
  });
});
