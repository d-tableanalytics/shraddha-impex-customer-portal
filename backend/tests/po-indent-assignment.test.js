/**
 * PO-WISE Indent Stock Assignment: settling every waiting indent on one PO in
 * one click.
 *
 * The individual screen is unchanged (see indent-assignment.test.js, which
 * still passes); this adds the other question — "this PO's material is in,
 * give every line on it its stock". Each indent goes through the same
 * assignToIndent the individual screen uses, so what is tested here is the
 * choosing: which indents a PO covers, in which order, how much each gets,
 * what happens when the stock runs out part-way, and what is reported back.
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
  namedExports: { sendEmail: async (to, subject) => { sent.push({ to, subject }); return true; } },
});

const { default: Order } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: User } = await import('../models/User.js');
const { default: Location } = await import('../models/Location.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { default: AuditLog } = await import('../models/AuditLog.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { ProductKoken } = await import('../models/Product.js');
const { createDirectBooking } = await import('../modules/reservations/reservation.controller.js');
const { updateOrderPO } = await import('../modules/orders/order.controller.js');
const { processAvailableIndents } = await import('../modules/inventory/indentAvailability.service.js');
const { assignmentQueue, assignToIndent } = await import('../modules/inventory/indentAssignment.service.js');
const { assignPoIndents, indentsUnderPo } = await import('../modules/inventory/poIndentAssignment.service.js');
const { postAssignPo } = await import('../modules/inventory/poIndentAssignment.controller.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');

before(async () => { await startTestReplSet(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => {
  await clearCollections();
  sent.length = 0;
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'manual', effectiveFrom: new Date(0) });
});

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const full = { body: {}, params: {}, headers: {}, method: 'POST', originalUrl: '/test', ...req };
  let err = null;
  await handler(full, res, (e) => { err = e; });
  if (err) errorHandler(err, full, res, () => {});
  return res;
};

let seq = 0;
const customer = async () => (await User.create({
  email: `c${++seq}@example.com`, password: 'x', user: `Customer ${seq}`, company: `Co ${seq}`,
  role: 'Customer', brandAccess: { koken: true }, moq: 'SKIP',
})).toObject();
const SALES = { _id: new mongoose.Types.ObjectId(), role: 'Sales', email: 'sales@example.com' };
const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', permissions: ['*'] };

const product = (sku, units = 0) => ProductKoken.create({
  skuCode: sku, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0,
});

/** A booking for several SKUs at once; with nothing in stock each line indents. */
const book = async (user, items) => (await call(createDirectBooking, {
  user,
  body: { items: items.map(([p, quantity]) => ({ productId: String(p._id), quantity })) },
})).payload.data;

/** Stock arrives. In manual mode the pass holds it rather than assigning it. */
const arrive = async (p, units) => {
  await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: units, totalAvailableQuantity: units } });
  await StockBalance.deleteMany({ skuCode: p.skuCode });
  const free = (await ProductKoken.findById(p._id).lean()).availableForSale;
  await StockBalance.create({
    skuCode: p.skuCode, brand: 'Koken', location: new mongoose.Types.ObjectId(),
    locationCode: 'MAIN', onHand: free, reserved: 0,
  });
  return processAvailableIndents([p.skuCode]);
};

const indentOf = (orderId, skuCode) => Reservation.findOne({
  indentNumber: orderId.replace(/^BO-/, 'PI-'), ...(skuCode ? { skuCode } : {}),
}).lean();
const pendingOf = async (orderId, skuCode) => (await indentOf(orderId, skuCode))?.quantity ?? null;
/** An indent served in full is closed as Confirmed rather than zeroed. */
const statusOf = async (orderId, skuCode) => (await indentOf(orderId, skuCode))?.status ?? null;
const free = async (p) => (await ProductKoken.findById(p._id).lean()).availableForSale;

/**
 * One customer, one booking of two SKUs each only partly in stock, and a PO
 * raised over that booking: SKU-A is waiting for 8 more units, SKU-B for 3.
 * That is the shape this screen is for — a PO exists because its booking
 * does, and the booking still has lines owed stock.
 */
const poWithTwoIndents = async ({ po = 'PO-2026-5501' } = {}) => {
  const user = await customer();
  const a = await product('SKU-A', 2);
  const b = await product('SKU-B', 1);
  const booking = await book(user, [[a, 10], [b, 4]]);
  const orderId = booking.orderId || booking.indentId.replace(/^PI-/, 'BO-');
  await call(updateOrderPO, { user: ADMIN, params: { orderId }, body: { poNumber: po } });
  return { user, a, b, orderId, po };
};

const poOf = async (orderId) => {
  const { skus } = await assignmentQueue();
  return skus.flatMap((s) => s.indents).filter((i) => i.bookingId === orderId).map((i) => i.poNumber);
};

describe('the PO-wise queue', () => {
  test('a PO covers every waiting indent that goes by it, oldest first', async () => {
    const { a, b, orderId, po } = await poWithTwoIndents();
    await arrive(a, 6);
    await arrive(b, 3);
    assert.deepEqual(await poOf(orderId), [po, po], 'both lines go by the PO');

    const { skus } = await assignmentQueue();
    const rows = indentsUnderPo(skus, po);
    assert.deepEqual(rows.map((r) => r.sku.skuCode).sort(), ['SKU-A', 'SKU-B']);
  });

  test('the PO number is matched without regard to case or padding', async () => {
    const { a, orderId, po } = await poWithTwoIndents();
    await arrive(a, 6);
    const { skus } = await assignmentQueue();
    assert.equal(indentsUnderPo(skus, `  ${po.toLowerCase()} `).length, 2);
    assert.equal(indentsUnderPo(skus, 'PO-SOMETHING-ELSE').length, 0);
    assert.equal((await poOf(orderId))[0], po);
  });

  test('an indent with no PO yet belongs to no PO', async () => {
    const user = await customer();
    const p = await product('SKU-C', 1);
    await book(user, [[p, 5]]);
    await arrive(p, 4);
    const { skus } = await assignmentQueue();
    assert.deepEqual(skus.flatMap((s) => s.indents).map((i) => i.poNumber), [null]);
    assert.equal(indentsUnderPo(skus, 'PO-2026-5501').length, 0);
  });
});

describe('assigning a whole PO', () => {
  test('every indent on the PO gets its stock in one call', async () => {
    const { a, b, orderId, po } = await poWithTwoIndents();
    await arrive(a, 8);
    await arrive(b, 3);

    const res = await assignPoIndents({ poNumber: po, actor: SALES });

    assert.equal(res.indents, 2);
    assert.equal(res.assigned.length, 2);
    assert.deepEqual(res.skipped, []);
    assert.equal(res.units, 11);
    assert.deepEqual(res.assigned.map((x) => [x.skuCode, x.quantity]).sort(), [['SKU-A', 8], ['SKU-B', 3]]);
    assert.deepEqual(res.assigned.map((x) => x.orderId), [orderId, orderId], 'onto their own booking');

    // Both lines are confirmed, nothing waits, the stock is reserved not lost.
    const lines = await Order.find({ orderId }).lean();
    assert.deepEqual(lines.map((l) => [l.skuCode, l.confirmedQty, l.pendingQty]).sort(),
      [['SKU-A', 10, 0], ['SKU-B', 4, 0]]);
    assert.equal(await free(a), 0);
    assert.equal(await free(b), 0);
    assert.equal((await indentOf(orderId, 'SKU-A')).status, 'Confirmed');
    assert.equal((await indentOf(orderId, 'SKU-B')).status, 'Confirmed');
  });

  test('each indent is allocated through the ordinary assign — same audit trail, same mail', async () => {
    const { a, b, po } = await poWithTwoIndents();
    await arrive(a, 8);
    await arrive(b, 3);
    await assignPoIndents({ poNumber: po, actor: SALES });

    assert.equal(await AuditLog.countDocuments({ action: 'Indent Stock Assigned' }), 2, 'one per indent, as if clicked');
    const summary = await AuditLog.findOne({ action: 'Indent Stock Assigned (PO-wise)' }).lean();
    assert.ok(summary, 'and one for the PO-wise run');
    assert.equal(summary.meta.poNumber, po);
    assert.equal(summary.meta.units, 11);
    assert.ok(sent.length >= 2, 'the customer is told about each allocation, as on the individual screen');
  });

  test('short stock: what is free is assigned, the rest is reported as left waiting', async () => {
    const { a, b, orderId, po } = await poWithTwoIndents();
    await arrive(a, 5); // 8 are still wanted
    // Nothing at all arrives for SKU-B.
    assert.ok(b);

    const res = await assignPoIndents({ poNumber: po, actor: SALES });

    assert.deepEqual(res.assigned.map((x) => [x.skuCode, x.quantity]), [['SKU-A', 5]]);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].skuCode, 'SKU-B');
    assert.match(res.skipped[0].reason, /No SKU-B stock is free/);
    assert.equal(res.units, 5);

    assert.equal(await pendingOf(orderId, 'SKU-A'), 3, 'still waiting for the rest');
    assert.equal(await pendingOf(orderId, 'SKU-B'), 3, 'untouched');
    assert.equal(await free(a), 0);
  });

  test('two indents for one SKU under a PO never share the same units', async () => {
    // Two customers, two bookings, one PO number across both: 4 units are
    // owed in all and only 3 are free when the PO is assigned.
    const one = await customer();
    const p = await product('SKU-D', 4);
    const first = await book(one, [[p, 6]]); // 4 confirmed, 2 on indent
    const idOne = first.orderId || first.indentId.replace(/^PI-/, 'BO-');
    await call(updateOrderPO, { user: ADMIN, params: { orderId: idOne }, body: { poNumber: 'PO-SHARED' } });

    const two = await customer();
    await arrive(p, 1); // held, not assigned: manual mode
    const second = await book(two, [[p, 3]]); // 1 confirmed, 2 on indent
    const idTwo = second.orderId || second.indentId.replace(/^PI-/, 'BO-');
    await call(updateOrderPO, { user: ADMIN, params: { orderId: idTwo }, body: { poNumber: 'PO-SHARED' } });

    await arrive(p, 3); // 3 free against 4 owed

    const res = await assignPoIndents({ poNumber: 'PO-SHARED', actor: SALES });

    assert.equal(res.units, 3, 'never more than was free');
    assert.equal(await free(p), 0);
    assert.deepEqual(res.assigned.map((x) => x.quantity), [2, 1], 'the older indent first, the newer what was left');
    assert.equal(await statusOf(idOne, 'SKU-D'), 'Confirmed', 'the older indent is served in full');
    assert.equal(await pendingOf(idTwo, 'SKU-D'), 1, 'the newer one is still owed one');
    assert.equal(await statusOf(idTwo, 'SKU-D'), 'Partially Confirmed');
  });

  test('only this PO is touched', async () => {
    const { a, po } = await poWithTwoIndents();
    const other = await customer();
    const c = await product('SKU-E', 1);
    const otherBooking = await book(other, [[c, 3]]); // 1 confirmed, 2 on indent
    const otherId = otherBooking.orderId || otherBooking.indentId.replace(/^PI-/, 'BO-');
    await call(updateOrderPO, { user: ADMIN, params: { orderId: otherId }, body: { poNumber: 'PO-OTHER' } });
    await arrive(a, 8);
    await arrive(c, 2);

    await assignPoIndents({ poNumber: po, actor: SALES });

    assert.equal(await pendingOf(otherId, 'SKU-E'), 2, "the other PO is left alone");
    assert.equal(await free(c), 2);
  });

  test('an unknown PO is refused, and nothing moves', async () => {
    const { a, orderId, po } = await poWithTwoIndents();
    await arrive(a, 8);
    await assert.rejects(
      assignPoIndents({ poNumber: 'PO-NOT-A-THING', actor: SALES }),
      (e) => e.statusCode === 404 && /No indent is waiting/.test(e.message),
    );
    assert.equal(await pendingOf(orderId, 'SKU-A'), 8);
    assert.ok(po);
  });

  test('a blank PO number is refused', async () => {
    await assert.rejects(assignPoIndents({ poNumber: '  ', actor: SALES }), (e) => e.statusCode === 400);
  });

  test('a PO whose indents were all served already says so rather than assigning twice', async () => {
    const { a, b, orderId, po } = await poWithTwoIndents();
    await arrive(a, 8);
    await arrive(b, 3);
    await assignPoIndents({ poNumber: po, actor: SALES });

    await assert.rejects(assignPoIndents({ poNumber: po, actor: SALES }), (e) => e.statusCode === 404);
    const lines = await Order.find({ orderId }).lean();
    assert.deepEqual(lines.map((l) => l.confirmedQty).sort(), [10, 4].sort(), 'nothing was allocated a second time');
    assert.equal(await free(a), 0);
  });

  test('two users assigning the same PO at once hand out the stock once', async () => {
    const { a, b, po } = await poWithTwoIndents();
    await arrive(a, 8);
    await arrive(b, 3);

    const [one, two] = await Promise.allSettled([
      assignPoIndents({ poNumber: po, actor: SALES }),
      assignPoIndents({ poNumber: po, actor: ADMIN }),
    ]);

    const units = [one, two]
      .filter((r) => r.status === 'fulfilled')
      .reduce((n, r) => n + r.value.units, 0);
    assert.equal(units, 11, 'between them, exactly the free stock');
    assert.equal(await free(a), 0);
    assert.equal(await free(b), 0);
  });
});

describe('the endpoint', () => {
  test('returns the run, and 404 for a PO with nothing waiting', async () => {
    const { a, b, po } = await poWithTwoIndents();
    await arrive(a, 8);
    await arrive(b, 3);

    const ok = await call(postAssignPo, { user: SALES, body: { poNumber: po } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.payload.data.units, 11);
    assert.equal(ok.payload.data.assigned.length, 2);

    const missing = await call(postAssignPo, { user: SALES, body: { poNumber: 'PO-NOPE' } });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.payload.success, false);
  });
});

describe('the individual path is untouched', () => {
  test('assigning one indent by itself still works exactly as before', async () => {
    const { a, orderId } = await poWithTwoIndents();
    await arrive(a, 8);
    const res = await assignToIndent({
      indentId: (await indentOf(orderId, 'SKU-A'))._id, quantity: 3, actor: SALES,
    });
    assert.equal(res.quantity, 3);
    assert.equal(await pendingOf(orderId, 'SKU-A'), 5);
    assert.equal(await free(a), 5);
  });

  test('a PO-wise run after a part assignment finishes what is left', async () => {
    const { a, b, orderId, po } = await poWithTwoIndents();
    await arrive(a, 8);
    await arrive(b, 3);
    await assignToIndent({ indentId: (await indentOf(orderId, 'SKU-A'))._id, quantity: 3, actor: SALES });

    const res = await assignPoIndents({ poNumber: po, actor: SALES });

    assert.equal(res.units, 8, 'the 5 still owed on A and all 3 of B');
    assert.equal(await statusOf(orderId, 'SKU-A'), 'Confirmed');
    assert.equal(await statusOf(orderId, 'SKU-B'), 'Confirmed');
    const lines = await Order.find({ orderId }).lean();
    assert.deepEqual(lines.map((l) => [l.skuCode, l.confirmedQty, l.pendingQty]).sort(),
      [['SKU-A', 10, 0], ['SKU-B', 4, 0]], 'the whole booking is covered');
  });
});
