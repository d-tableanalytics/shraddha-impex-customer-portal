/**
 * Indent Stock Assignment: choosing which customer indent arriving stock goes to.
 *
 * In MANUAL mode arriving stock is held; Admin / Sales / Import Team run the
 * FIFO auto-assign on demand, assign to a chosen indent (partial allowed), or
 * move an allocation from one customer's indent to another's before a PO.
 * Every path allocates through the same code as the FIFO pass, against a real
 * transactional database.
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
const { cancelBooking, updateOrderPO } = await import('../modules/orders/order.controller.js');
const { processAvailableIndents } = await import('../modules/inventory/indentAvailability.service.js');
const {
  assignmentQueue, autoAssign, assignToIndent, reassignAllocation,
} = await import('../modules/inventory/indentAssignment.service.js');
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

const product = (sku, units) => ProductKoken.create({ skuCode: sku, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0 });
const stock = async (p) => {
  const x = await ProductKoken.findById(p._id).lean();
  assert.equal(x.availableForSale + x.bookedQuantity, x.totalAvailableQuantity, 'invariant');
  return { available: x.availableForSale, booked: x.bookedQuantity, total: x.totalAvailableQuantity };
};
const book = async (user, p, qty) => (await call(createDirectBooking, {
  user, body: { items: [{ productId: String(p._id), quantity: qty }] },
})).payload.data;
/** Stock arrives; the balance the FIFO pass reads is set to what is free. */
const arrive = async (p, units) => {
  await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: units, totalAvailableQuantity: units } });
  await StockBalance.deleteMany({ skuCode: p.skuCode });
  const free = (await ProductKoken.findById(p._id).lean()).availableForSale;
  await StockBalance.create({ skuCode: p.skuCode, brand: 'Koken', location: new mongoose.Types.ObjectId(), locationCode: 'MAIN', onHand: free, reserved: 0 });
  return processAvailableIndents([p.skuCode]);
};
const indentOf = (orderId) => Reservation.findOne({ indentNumber: orderId.replace(/^BO-/, 'PI-') }).lean();
const ageIndent = (orderId, days) => Reservation.updateMany(
  { indentNumber: orderId.replace(/^BO-/, 'PI-') },
  { $set: { reservationDate: new Date(Date.now() - days * 864e5) } },
);

/** Two customers waiting on one SKU: A (older) for 8, B (newer) for 6. */
const twoWaiting = async () => {
  const a = await customer();
  const b = await customer();
  const p = await product('SKU-1', 2);
  const bookingA = await book(a, p, 10); // 2 booked, 8 on indent
  await ageIndent(bookingA.orderId, 10);
  const bookingB = await book(b, p, 6); // nothing in stock: 6 on indent
  return { a, b, p, A: bookingA.orderId, B: bookingB.orderId || bookingB.indentId.replace(/^PI-/, 'BO-') };
};

describe('manual mode', () => {
  test('arriving stock is held, not assigned', async () => {
    const { p, A } = await twoWaiting();
    const out = await arrive(p, 5);
    assert.equal(out.held, true);
    assert.equal((await indentOf(A)).quantity, 8, 'nobody got it');
    assert.deepEqual(await stock(p), { available: 5, booked: 2, total: 7 });
  });

  test('the queue lists free stock and the waiting indents, oldest first', async () => {
    const { p, A, B } = await twoWaiting();
    await arrive(p, 5);
    const { mode, skus } = await assignmentQueue();
    assert.equal(mode, 'manual');
    const row = skus.find((s) => s.skuCode === 'SKU-1');
    assert.equal(row.available, 5);
    assert.deepEqual(row.indents.map((i) => [i.bookingId, i.requested, i.pending]), [[A, 10, 8], [B, 6, 6]]);
  });

  test('a user can choose the newer indent, partially', async () => {
    const { p, A, B } = await twoWaiting();
    await arrive(p, 5);
    const target = await indentOf(B);

    const res = await assignToIndent({ indentId: target._id, quantity: 4, actor: SALES });
    assert.equal(res.orderId, B);
    assert.equal((await indentOf(B)).quantity, 2, 'B still waits for 2');
    assert.equal((await indentOf(A)).quantity, 8, 'A untouched');
    const line = await Order.findOne({ orderId: B }).lean();
    assert.deepEqual(line.allocations.map((x) => x.quantity), [4]);
    assert.deepEqual(await stock(p), { available: 1, booked: 6, total: 7 });

    const audit = await AuditLog.findOne({ action: 'Indent Stock Assigned' }).lean();
    assert.equal(String(audit.user), String(SALES._id));
    assert.equal(audit.meta.quantity, 4);
    assert.ok(sent.some((m) => /indented stock allocated/.test(m.subject)), 'the customer is told');
  });

  test('cannot assign more than is free or more than the indent waits for', async () => {
    const { p, A } = await twoWaiting();
    await arrive(p, 5);
    const target = await indentOf(A);
    await assert.rejects(assignToIndent({ indentId: target._id, quantity: 6, actor: SALES }), /Only 5 unit\(s\)/);
    await assert.rejects(assignToIndent({ indentId: target._id, quantity: 9, actor: SALES }), /waiting for 8/);
    assert.deepEqual(await stock(p), { available: 5, booked: 2, total: 7 }, 'nothing moved');
  });

  test('two users assigning the last units at once: one wins, none oversold', async () => {
    const { p, A, B } = await twoWaiting();
    await arrive(p, 5);
    const [ra, rb] = await Promise.allSettled([
      assignToIndent({ indentId: (await indentOf(A))._id, quantity: 5, actor: SALES }),
      assignToIndent({ indentId: (await indentOf(B))._id, quantity: 5, actor: ADMIN }),
    ]);
    assert.equal([ra, rb].filter((r) => r.status === 'fulfilled').length, 1);
    assert.deepEqual(await stock(p), { available: 0, booked: 7, total: 7 });
  });

  test('Auto-assign runs the existing FIFO on demand', async () => {
    const { p, A } = await twoWaiting();
    await arrive(p, 5);
    await autoAssign({ skuCodes: ['SKU-1'], actor: SALES });
    assert.equal((await indentOf(A)).quantity, 3, 'the oldest got all 5');
    assert.ok(await AuditLog.findOne({ action: 'Indent Stock Auto-Assigned' }));
  });

  test("an older cancelled booking's still-open indent can only be booked whole", async () => {
    // Cancelling now closes the indent too; this is data from before that, a
    // cancelled booking whose indent was left open.
    const a = await customer();
    const p = await product('SKU-2', 2);
    const { orderId } = await book(a, p, 6); // 2 booked, 4 on indent
    await Order.updateMany({ orderId }, { $set: { status: 'Cancelled', stockState: 'released' } });
    await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: 2, bookedQuantity: -2 } });
    await arrive(p, 2); // 4 free now, held (manual mode)
    const indent = await indentOf(orderId);
    await assert.rejects(assignToIndent({ indentId: indent._id, quantity: 2, actor: SALES }), /only be booked whole/);
    const res = await assignToIndent({ indentId: indent._id, quantity: 4, actor: SALES });
    assert.notEqual(res.orderId, orderId, 'a booking of its own');
  });
});

describe('reassignment', () => {
  /** A's allocation of 5 to move to B. */
  const allocatedToA = async () => {
    const ctx = await twoWaiting();
    await arrive(ctx.p, 5);
    await assignToIndent({ indentId: (await indentOf(ctx.A))._id, quantity: 5, actor: SALES });
    const line = await Order.findOne({ orderId: ctx.A }).lean();
    return { ...ctx, line };
  };

  test('moves the allocation: A waits again, B gets it, stock unchanged overall', async () => {
    const { p, A, B, line } = await allocatedToA();
    const before = await stock(p);

    const res = await reassignAllocation({
      orderId: A, lineId: line._id, seq: 1, toIndentId: (await indentOf(B))._id, actor: SALES,
    });
    assert.equal(res.to, B);

    const lineA = await Order.findOne({ orderId: A }).lean();
    assert.equal(lineA.confirmedQty, 2, 'back to what A had at booking');
    assert.equal(lineA.allocations.length, 0);
    assert.equal((await indentOf(A)).quantity, 8, 'A is owed the 5 again');
    assert.equal((await indentOf(B)).quantity, 1, 'B got 5 of its 6');
    assert.deepEqual(await stock(p), before, 'reserved before, reserved after — just for someone else');
    assert.ok(await AuditLog.findOne({ action: 'Indent Stock Reassigned' }));
  });

  test('part of an allocation can be moved', async () => {
    const { p, A, B, line } = await allocatedToA();
    await reassignAllocation({ orderId: A, lineId: line._id, seq: 1, toIndentId: (await indentOf(B))._id, quantity: 2, actor: SALES });
    const lineA = await Order.findOne({ orderId: A }).lean();
    assert.deepEqual(lineA.allocations.map((x) => x.quantity), [3]);
    assert.equal((await indentOf(B)).quantity, 4);
    assert.equal((await stock(p)).available, 0);
  });

  test('not once the booking has a PO', async () => {
    const { A, B, line } = await allocatedToA();
    await call(updateOrderPO, { user: ADMIN, params: { orderId: A }, body: { poNumber: 'PO-A' } });
    await assert.rejects(
      reassignAllocation({ orderId: A, lineId: line._id, seq: 1, toIndentId: (await indentOf(B))._id, actor: SALES }),
      /has a PO/,
    );
  });

  test('two users moving the same allocation at once: it moves once', async () => {
    const { p, A, B, line } = await allocatedToA();
    const target = (await indentOf(B))._id;
    const results = await Promise.allSettled([
      reassignAllocation({ orderId: A, lineId: line._id, seq: 1, toIndentId: target, actor: SALES }),
      reassignAllocation({ orderId: A, lineId: line._id, seq: 1, toIndentId: target, actor: ADMIN }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await indentOf(B)).quantity, 1);
    assert.equal((await indentOf(A)).quantity, 8);
    const s = await stock(p);
    assert.equal(s.booked, 7);
  });

  test('the queue offers it for moving until the PO is raised', async () => {
    const { A } = await allocatedToA();
    let row = (await assignmentQueue()).skus.find((s) => s.skuCode === 'SKU-1');
    assert.deepEqual(row.reassignable.map((x) => [x.orderId, x.quantity]), [[A, 5]]);
    await call(updateOrderPO, { user: ADMIN, params: { orderId: A }, body: { poNumber: 'PO-A' } });
    row = (await assignmentQueue()).skus.find((s) => s.skuCode === 'SKU-1');
    assert.deepEqual(row.reassignable, []);
  });
});

describe('auto mode (the default) is unchanged', () => {
  test('arriving stock still goes to the oldest indent by itself', async () => {
    await InventoryConfig.deleteMany({});
    const { p, A } = await twoWaiting();
    await arrive(p, 5);
    assert.equal((await indentOf(A)).quantity, 3);
  });
});
