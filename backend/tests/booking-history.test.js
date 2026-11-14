/**
 * Sales Desk Booking History — GET /sales/bookings/:orderId/history
 *
 * Every scenario runs the real flows (booking, stock arriving, Indent Stock
 * Assignment, PO, status, cancellation, moves between bookings) against a
 * transactional database, then reads the history back. What is pinned:
 *   - each thing that happened appears ONCE, though most write two records;
 *   - entries are the stored records, in time order, linked to the booking;
 *   - each says where it was raised from and by whom;
 *   - the history is still whole after the booking is cancelled;
 *   - rate tiers stay out of it for a caller who may not see pricing.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
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
const { cancelBooking, updateBookingStatus } = await import('../modules/orders/order.controller.js');
const { raisePo, getBookingHistory: historyRoute } = await import('../modules/sales/sales.controller.js');
const { getBookingHistory } = await import('../modules/sales/bookingHistory.service.js');
const { processAvailableIndents } = await import('../modules/inventory/indentAvailability.service.js');
const { autoAssign, assignToIndent, reassignAllocation } = await import('../modules/inventory/indentAssignment.service.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');

before(async () => { await startTestReplSet(); });
after(async () => { await stopTestMongo(); });

let sales; // a real account, so the history can name who did what
beforeEach(async () => {
  await clearCollections();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'manual', effectiveFrom: new Date(0) });
  const doc = await User.create({ email: 'priya@example.com', password: 'x', user: 'Priya Sales', role: 'Sales' });
  sales = { ...doc.toObject(), permissions: ['*'] };
});

/** A request as the route would see it, so the entry knows the screen it came from. */
const reqAt = (originalUrl, method = 'POST') => ({ method, originalUrl, headers: {}, ip: '10.0.0.1' });

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const full = { body: {}, params: {}, query: {}, ...reqAt('/test'), ...req };
  let err = null;
  await handler(full, res, (e) => { err = e; });
  if (err) errorHandler(err, full, res, () => {});
  return res;
};

let seq = 0;
const customer = async (over = {}) => (await User.create({
  email: `c${++seq}@example.com`, password: 'x', user: `Contact ${seq}`, company: `Co ${seq}`,
  role: 'Customer', brandAccess: { koken: true }, moq: 'SKIP', ...over,
})).toObject();
const product = (sku, units) => ProductKoken.create({ skuCode: sku, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0 });
const book = async (user, p, qty) => {
  const res = await call(createDirectBooking, {
    user, body: { items: [{ productId: String(p._id), quantity: qty }] }, originalUrl: '/api/v1/reservations/direct-booking',
  });
  assert.ok(res.statusCode < 300, JSON.stringify(res.payload));
  const d = res.payload.data;
  return d.orderId || d.indentId.replace(/^PI-/, 'BO-');
};
const arrive = async (p, units) => {
  await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: units, totalAvailableQuantity: units } });
  await StockBalance.deleteMany({ skuCode: p.skuCode });
  const free = (await ProductKoken.findById(p._id).lean()).availableForSale;
  const { _id: location } = await Location.findOne({ code: 'MAIN' }).lean();
  await StockBalance.create({ skuCode: p.skuCode, brand: 'Koken', location, locationCode: 'MAIN', onHand: free, reserved: 0 });
  return processAvailableIndents([p.skuCode]);
};
const indentOf = (orderId) => Reservation.findOne({ indentNumber: orderId.replace(/^BO-/, 'PI-') }).lean();
const assign = async (orderId, quantity) => assignToIndent({
  indentId: (await indentOf(orderId))._id, quantity, actor: sales, req: reqAt('/api/v1/inventory/indent-assignment/assign'),
});

const titles = (h) => h.events.map((e) => e.title);
const only = (h, kind) => h.events.filter((e) => e.kind === kind);

describe('one booking, from creation to dispatch', () => {
  test('created, indent raised, allocated, PO raised, status — once each, oldest first', async () => {
    const a = await customer({ customerName: 'Sharma Auto Parts', company: 'SAP Group' });
    const p = await product('SKU-1', 2);
    const A = await book(a, p, 10); // 2 from stock, 8 to indent
    await arrive(p, 5); // held: manual mode
    await assign(A, 3);
    const po = await call(raisePo, {
      user: sales, params: { orderId: A }, body: { poNumber: 'PO-H-1' }, originalUrl: `/api/v1/sales/bookings/${A}/po`,
    });
    assert.equal(po.statusCode, 200, JSON.stringify(po.payload));
    const st = await call(updateBookingStatus, {
      user: sales, params: { orderId: A }, body: { status: 'Ready for Dispatch' },
      originalUrl: `/api/v1/orders/booking/${A}/status`, method: 'PUT',
    });
    assert.equal(st.statusCode, 200, JSON.stringify(st.payload));

    const h = await getBookingHistory(A);
    const indent = A.replace(/^BO-/, 'PI-');
    assert.deepEqual(titles(h), [
      'Booking created',
      `Indent ${indent} raised`,
      'Stock allocated from indent',
      'Booking confirmed — PO raised',
      'Status: Ready for Dispatch',
    ]);
    const times = h.events.map((e) => new Date(e.at).getTime());
    assert.deepEqual(times, [...times].sort((x, y) => x - y), 'oldest first');

    const [created, raised, allocated, confirmed, status] = h.events;
    assert.equal(created.source.label, 'Customer Portal');
    assert.equal(created.actor.name, 'Contact 1');
    assert.deepEqual(created.items, [{ skuCode: 'SKU-1', quantity: 10, note: '2 confirmed · 8 to indent' }]);
    assert.deepEqual(raised.items, [{ skuCode: 'SKU-1', quantity: 8, note: 'waiting for stock' }]);

    // Two audit entries record the hand assignment; it is listed once, as theirs.
    assert.ok(await AuditLog.exists({ action: 'Indent Stock Assigned' }));
    assert.ok(await AuditLog.exists({ action: 'Indent Allocated' }));
    assert.equal(only(h, 'allocation').length, 1);
    assert.equal(allocated.source.label, 'Indent Stock Assignment');
    assert.deepEqual(allocated.actor, { name: 'Priya Sales', role: 'Sales' });
    assert.equal(allocated.items[0].quantity, 3);
    assert.match(allocated.items[0].note, new RegExp(`allocation #1 · from indent ${indent} · 5 still waiting`));

    assert.equal(confirmed.source.label, 'Sales Desk');
    assert.equal(confirmed.refs.poNumber, 'PO-H-1');
    assert.equal(confirmed.actor.name, 'Priya Sales');

    // The status event and its 'Booking Status Updated' audit entry: one entry.
    assert.equal(only(h, 'status').length, 1);
    assert.equal(status.source.label, 'Sales Desk / Booking History');
    assert.ok(status.notification?.state, 'carries whether the customer was emailed');

    // No entry twice.
    assert.equal(new Set(h.events.map((e) => e.id)).size, h.events.length);
  });

  test('the summary links the booking, its indent, its allocations and its PO', async () => {
    const a = await customer({ customerName: 'Sharma Auto Parts', company: 'SAP Group' });
    const p = await product('SKU-1', 2);
    const A = await book(a, p, 10);
    await arrive(p, 5);
    await assign(A, 3);
    await call(raisePo, { user: sales, params: { orderId: A }, body: { poNumber: 'PO-H-2' }, originalUrl: `/api/v1/sales/bookings/${A}/po` });

    const { booking, lines, indents } = await getBookingHistory(A);
    const indent = A.replace(/^BO-/, 'PI-');
    assert.equal(booking.orderId, A);
    assert.equal(booking.indentNumber, indent);
    assert.equal(booking.customerName, 'Sharma Auto Parts');
    assert.equal(booking.company, 'SAP Group');
    assert.equal(booking.poNumber, 'PO-H-2');
    assert.equal(booking.locked, true);
    assert.equal(booking.poRaisedBy.name, 'Priya Sales');
    assert.equal(booking.createdFrom.label, 'Customer Portal');
    assert.deepEqual(booking.totals.atBooking, { requested: 10, confirmed: 2, pending: 8 });
    assert.equal(booking.totals.allocated, 3);
    assert.equal(booking.totals.waitingOnIndent, 5);
    assert.equal(booking.totals.confirmedNow, 5);

    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0].atBooking, { requested: 10, confirmed: 2, pending: 8 });
    assert.equal(lines[0].allocations.length, 1);
    assert.equal(lines[0].allocations[0].indentNumber, indent);
    assert.equal(lines[0].allocations[0].source.label, 'Indent Stock Assignment');

    assert.equal(indents.length, 1);
    assert.equal(indents[0].indentNumber, indent);
    assert.equal(indents[0].relation, 'raised-with-booking');
    assert.equal(indents[0].raisedQty, 8);
    assert.equal(indents[0].waiting, 5);
    assert.equal(indents[0].open, true);
  });
});

describe('where an allocation was raised from', () => {
  test('stock arriving in automatic mode goes to the oldest indent — the system did it', async () => {
    await InventoryConfig.updateOne({ scope: 'global' }, { $set: { indentAssignmentMode: 'auto' } });
    const p = await product('SKU-1', 0);
    const A = await book(await customer(), p, 4); // nothing free: all on indent
    await arrive(p, 4);
    const h = await getBookingHistory(A);
    const [allocated] = only(h, 'allocation');
    assert.equal(allocated.source.label, 'Automatic (system)');
    assert.equal(allocated.actor, null);
    assert.match(allocated.details.join(' '), /oldest waiting indent first/);
  });

  test('a FIFO run started from Indent Stock Assignment names who ran it', async () => {
    const p = await product('SKU-1', 0);
    const A = await book(await customer(), p, 4);
    await arrive(p, 4); // held
    await autoAssign({ skuCodes: ['SKU-1'], actor: sales, req: reqAt('/api/v1/inventory/indent-assignment/auto') });
    const [allocated] = only(await getBookingHistory(A), 'allocation');
    assert.equal(allocated.source.label, 'Indent Stock Assignment');
    assert.equal(allocated.actor.name, 'Priya Sales');
    assert.match(allocated.details.join(' '), /Auto-assign \(FIFO\)/);
  });
});

describe('when the booking changes later', () => {
  test('a cancelled booking keeps its whole history, and the cancellation is one entry', async () => {
    const p = await product('SKU-1', 2);
    const A = await book(await customer(), p, 10);
    await arrive(p, 5);
    await assign(A, 3);
    const res = await call(cancelBooking, {
      user: sales, params: { orderId: A }, body: { reason: 'Customer withdrew' }, originalUrl: `/api/v1/orders/${A}/cancel`,
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));

    const h = await getBookingHistory(A);
    assert.equal(h.booking.status, 'Cancelled');
    assert.deepEqual(h.events.map((e) => e.kind), ['booking', 'indent', 'allocation', 'cancel']);
    const [cancel] = only(h, 'cancel');
    assert.equal(cancel.title, 'Booking cancelled');
    assert.match(cancel.details.join(' '), /Reason: Customer withdrew/);
    assert.match(cancel.details.join(' '), /released back to stock/);
    assert.equal(cancel.actor.name, 'Priya Sales');
    // The allocation is still listed, as cancelled.
    assert.equal(h.lines[0].allocations.length, 1);
  });

  test('stock moved between bookings: the source shows it leaving, the target arriving — once each', async () => {
    const p = await product('SKU-1', 2);
    const A = await book(await customer(), p, 10); // 2 booked, 8 on indent
    const B = await book(await customer(), p, 6); // nothing left: 6 on indent
    await arrive(p, 5);
    await assign(A, 3);
    const line = await Order.findOne({ orderId: A }).lean();
    await reassignAllocation({
      orderId: A, lineId: line._id, seq: 1, toIndentId: (await indentOf(B))._id, quantity: 2,
      actor: sales, req: reqAt('/api/v1/inventory/indent-assignment/reassign'),
    });

    const hA = await getBookingHistory(A);
    assert.deepEqual(titles(hA).slice(-2), ['Stock allocated from indent', 'Stock moved to another booking']);
    const out = hA.events.at(-1);
    assert.equal(out.source.label, 'Indent Stock Assignment');
    assert.match(out.details[0], new RegExp(`2 units of SKU-1 moved from allocation #1 to indent .* on ${B}`));
    // The allocation entry keeps what was allocated (3), though the record now holds 1.
    assert.equal(only(hA, 'allocation')[0].items[0].quantity, 3);
    assert.equal(hA.lines[0].allocations[0].quantity, 1);

    const hB = await getBookingHistory(B);
    assert.deepEqual(titles(hB), [
      'Booking created', `Indent ${B.replace(/^BO-/, 'PI-')} raised`, 'Stock moved in from another booking',
    ]);
    const moved = hB.events.at(-1);
    assert.equal(moved.source.label, 'Indent Stock Assignment');
    assert.match(moved.details.join(' '), new RegExp(`Moved here from ${A}`));
    assert.equal(only(hB, 'allocation').length, 1, 'the move and its allocation are one entry');
  });

  test('a booking raised from a waiting indent says so, and links that indent', async () => {
    const a = await customer();
    const p = await product('SKU-2', 2);
    const A = await book(a, p, 6); // 2 booked, 4 on indent
    // An older cancelled booking whose indent was left open.
    await Order.updateMany({ orderId: A }, { $set: { status: 'Cancelled', stockState: 'released' } });
    await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: 2, bookedQuantity: -2 } });
    await arrive(p, 2);
    const made = await assign(A, 4); // whole only: becomes a booking of its own
    const C = made.orderId;
    assert.notEqual(C, A);

    const h = await getBookingHistory(C);
    const [created] = h.events;
    assert.equal(created.title, 'Booking created from indent');
    assert.equal(created.source.label, 'Indent Stock Assignment');
    assert.equal(created.actor.name, 'Priya Sales');
    assert.deepEqual(created.refs.indentNumbers, [A.replace(/^BO-/, 'PI-')]);
    assert.equal(h.indents.length, 1);
    assert.equal(h.indents[0].relation, 'became-this-booking');
    assert.equal(only(h, 'allocation').length, 0, 'the hand assignment is the creation, not a second entry');
  });
});

describe('older and partial records', () => {
  test('a booking with no audit trail shows what its own records hold, and says who is unknown', async () => {
    const u = await customer();
    const at = new Date('2026-01-05T06:00:00Z');
    await Order.create({
      orderId: 'BO-2026-900001', brand: 'Koken', user: u._id, skuCode: 'OLD-1', status: 'PO Received',
      orderTimestamp: at, date: at, bookedQty: 5, confirmedQty: 5, requestedQty: 5, poNumber: '-',
      allocations: [{ seq: 1, quantity: 2, indentNumber: 'PI-2026-900001', at: new Date('2026-01-09T06:00:00Z') }],
    });
    const h = await getBookingHistory('BO-2026-900001');
    assert.deepEqual(h.events.map((e) => [e.kind, e.source.key]), [['booking', 'record'], ['allocation', 'record']]);
    assert.match(h.events[0].details.join(' '), /who placed it was not recorded/);
    assert.equal(h.booking.poNumber, null);
  });

  test('rate tiers are left out for a caller who may not see pricing', async () => {
    const p = await product('SKU-1', 5);
    const A = await book(await customer(), p, 2);
    await AuditLog.create({
      action: 'Booking Priced', user: sales._id, method: 'PUT', endpoint: `/api/v1/sales/bookings/${A}/pricing`,
      remarks: `Booking ${A} priced at the Trader rate. 1 of 1 line(s) rated.`, meta: { orderId: A, to: 'trader' },
    });
    assert.ok(!titles(await getBookingHistory(A)).includes('Pricing updated'));
    const withPricing = await getBookingHistory(A, { includePricing: true });
    const priced = withPricing.events.find((e) => e.title === 'Pricing updated');
    assert.equal(priced.source.label, 'Sales Desk');
    assert.deepEqual(priced.details, [`Booking ${A} priced at the Trader rate. 1 of 1 line(s) rated.`]);
  });

  test('an unknown booking is a 404', async () => {
    assert.equal(await getBookingHistory('BO-2026-999999'), null);
    const res = await call(historyRoute, { user: sales, params: { orderId: 'BO-2026-999999' }, method: 'GET' });
    assert.equal(res.statusCode, 404);
  });
});
