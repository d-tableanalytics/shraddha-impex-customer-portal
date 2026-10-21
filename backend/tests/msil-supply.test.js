/**
 * MSIL Supply Date and the automatic indent-to-booking conversion.
 *
 * An MSIL customer's indent converts by itself only when its stock arrives on
 * or before the booking's Supply Date AND within 7 days of the booking. A late
 * arrival is held as "Awaiting decision" — not converted, stock left free — and
 * the desk Converts or Cancels it. Everyone else, and an MSIL booking with no
 * Supply Date, converts exactly as before.
 *
 * Real bookings (createDirectBooking), real stock arrival (the FIFO pass) and
 * the desk endpoints, against a transactional database.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

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
const { default: Notification } = await import('../models/Notification.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { ProductKoken } = await import('../models/Product.js');
const { supplyDecision, endOfDay } = await import('../utils/msilSupply.js');
const { parseIstDay, istYmd } = await import('../utils/businessDay.js');
const { createDirectBooking } = await import('../modules/reservations/reservation.controller.js');
const { processAvailableIndents } = await import('../modules/inventory/indentAvailability.service.js');
const {
  getBookingDetail, getBookings, setBookingSupplyDate, convertHeldIndent, cancelHeldIndent,
} = await import('../modules/sales/sales.controller.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');

const DAY = 864e5;
const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', permissions: ['*'] };

before(async () => { await startTestReplSet(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => {
  await clearCollections();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'auto', effectiveFrom: new Date(0) });
  // notifyAdmins() tells accounts on the Admin role.
  await User.create({ email: 'admin@example.com', password: 'x', user: 'Admin', role: 'Admin' });
});

// ── Harness ─────────────────────────────────────────────────────────────────

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const full = { body: {}, params: {}, query: {}, headers: {}, method: 'POST', originalUrl: '/test', ...req };
  let err = null;
  await handler(full, res, (e) => { err = e; });
  if (err) {
    const log = console.error;
    console.error = () => {};
    try { errorHandler(err, full, res, () => {}); } finally { console.error = log; }
  }
  return res;
};

let seq = 0;
const customer = async (category = 'MSIL') => (await User.create({
  email: `c${++seq}@example.com`, password: 'x', user: `Customer ${seq}`, company: `Co ${seq}`,
  role: 'Customer', customerCategory: category, brandAccess: { koken: true }, moq: 'SKIP',
})).toObject();

const product = (sku, units) => ProductKoken.create({
  skuCode: sku, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0,
});

/** Book `qty` of `p`; whatever stock cannot cover becomes the indent. */
const book = async (user, p, qty) => {
  const res = await call(createDirectBooking, { user, body: { items: [{ productId: String(p._id), quantity: qty }] } });
  assert.equal(res.statusCode < 300, true, JSON.stringify(res.payload));
  const data = res.payload.data;
  return data.orderId || data.indentId.replace(/^PI-/, 'BO-');
};

/** Pretend the booking (and its indent) was made `days` ago. */
const age = async (orderId, days) => {
  const when = new Date(Date.now() - days * DAY);
  await Order.collection.updateMany({ orderId }, { $set: { orderTimestamp: when, createdAt: when } });
  await Reservation.collection.updateMany(
    { indentNumber: orderId.replace(/^BO-/, 'PI-') },
    { $set: { reservationDate: when, createdAt: when } },
  );
};

/** Stock arrives: product and balance updated, then the same pass a receipt runs. */
const arrive = async (p, units) => {
  await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: units, totalAvailableQuantity: units } });
  await StockBalance.deleteMany({ skuCode: p.skuCode });
  const free = (await ProductKoken.findById(p._id).lean()).availableForSale;
  await StockBalance.create({
    skuCode: p.skuCode, brand: 'Koken', location: new mongoose.Types.ObjectId(), locationCode: 'MAIN', onHand: free, reserved: 0,
  });
  return processAvailableIndents([p.skuCode]);
};

const indentOf = (orderId) => Reservation.findOne({ indentNumber: orderId.replace(/^BO-/, 'PI-') }).lean();
const free = async (p) => (await ProductKoken.findById(p._id).lean()).availableForSale;

/** 'YYYY-MM-DD' of the IST day `offset` days from today — Supply Dates are Indian days. */
const ymd = (offset) => istYmd(new Date(Date.now() + offset * DAY));

const setDate = (orderId, supplyDate, user = ADMIN) =>
  call(setBookingSupplyDate, { user, method: 'PUT', params: { orderId }, body: { supplyDate } });

/** An MSIL booking of 10 with 2 in stock: 2 booked, 8 on the indent. */
const msilBooking = async ({ category = 'MSIL', bookedDaysAgo = 0, supplyInDays = null } = {}) => {
  const c = await customer(category);
  const p = await product('SKU-1', 2);
  const orderId = await book(c, p, 10);
  if (bookedDaysAgo) await age(orderId, bookedDaysAgo);
  if (supplyInDays !== null) {
    // Set straight on the data: the endpoint refuses a date before the booking,
    // and some cases need exactly that past date to exist.
    const day = parseIstDay(ymd(supplyInDays));
    await Order.updateMany({ orderId }, { $set: { msilSupplyDate: day } });
    await Reservation.updateMany({ indentNumber: orderId.replace(/^BO-/, 'PI-') }, { $set: { supplyDate: day } });
  }
  return { c, p, orderId };
};

// ── The rule on its own ─────────────────────────────────────────────────────

describe('supplyDecision', () => {
  const msil = { customerCategory: 'MSIL' };
  // Dates are Indian business days (utils/businessDay.js); instants are UTC.
  const booked = new Date('2026-10-01T04:30:00Z'); // 10:00 IST

  test('applies only to MSIL customers with a Supply Date', () => {
    assert.deepEqual(supplyDecision({ customer: { customerCategory: 'Customer' }, supplyDate: booked, bookingDate: booked }), { applies: false });
    assert.deepEqual(supplyDecision({ customer: msil, supplyDate: null, bookingDate: booked }), { applies: false });
  });

  test('arriving any time ON the Supply Date is on time', () => {
    const supply = parseIstDay('2026-10-05');
    const d = supplyDecision({ customer: msil, supplyDate: supply, bookingDate: booked, at: new Date('2026-10-05T18:00:00Z') }); // 23:30 IST
    assert.equal(d.onTime, true);
    assert.equal(d.supplyBy.getTime(), endOfDay(supply).getTime());
  });

  test('arriving the day after the Supply Date is late, and says so', () => {
    const d = supplyDecision({ customer: msil, supplyDate: parseIstDay('2026-10-05'), bookingDate: booked, at: new Date('2026-10-05T18:31:00Z') }); // 00:01 IST on the 6th
    assert.equal(d.onTime, false);
    assert.match(d.reason, /after the Supply Date/);
    assert.doesNotMatch(d.reason, /7 days/);
  });

  test('arriving more than 7 days after the booking is late even before the Supply Date', () => {
    const d = supplyDecision({ customer: msil, supplyDate: parseIstDay('2026-10-20'), bookingDate: booked, at: new Date('2026-10-08T04:31:00Z') }); // 7 days + 1 min
    assert.equal(d.onTime, false);
    assert.match(d.reason, /more than 7 days after the booking/);
  });

  test('exactly 7 days after the booking is still inside the window', () => {
    const d = supplyDecision({ customer: msil, supplyDate: parseIstDay('2026-10-20'), bookingDate: booked, at: new Date('2026-10-08T04:30:00Z') }); // exactly 7 days
    assert.equal(d.onTime, true);
  });
});

// ── Automatic conversion ────────────────────────────────────────────────────

describe('when stock arrives for an MSIL indent', () => {
  test('on time: it converts by itself and is marked Auto-converted', async () => {
    const { p, orderId } = await msilBooking({ bookedDaysAgo: 2, supplyInDays: 3 });
    const out = await arrive(p, 8);
    assert.equal(out.awaitingDecision, 0);
    assert.equal(out.booked, 1);

    const indent = await indentOf(orderId);
    assert.equal(indent.status, 'Confirmed');
    assert.equal(indent.supplyCheck.status, 'Auto-converted');
    assert.equal(await free(p), 0);
  });

  test('after the Supply Date: NOT converted, stock left free, held for a decision', async () => {
    const { p, orderId } = await msilBooking({ bookedDaysAgo: 4, supplyInDays: -1 });
    const before = await indentOf(orderId);
    const out = await arrive(p, 8);
    assert.equal(out.awaitingDecision, 1);
    assert.equal(out.booked, 0);

    const indent = await indentOf(orderId);
    assert.equal(indent.status, before.status, 'still open, exactly as it was');
    assert.equal(indent.quantity, 8);
    assert.equal(indent.supplyCheck.status, 'Awaiting decision');
    assert.match(indent.supplyCheck.reason, /after the Supply Date/);
    assert.equal(await free(p), 8, 'the units were not taken');

    // An admin is told once — a second movement does not repeat it.
    assert.equal(await Notification.countDocuments({ title: 'MSIL indent needs a decision' }), 1);
    await arrive(p, 1);
    assert.equal(await Notification.countDocuments({ title: 'MSIL indent needs a decision' }), 1);
  });

  test('past the 7-day window: held even though the Supply Date is still ahead', async () => {
    const { p, orderId } = await msilBooking({ bookedDaysAgo: 9, supplyInDays: 5 });
    await arrive(p, 8);
    const indent = await indentOf(orderId);
    assert.equal(indent.supplyCheck.status, 'Awaiting decision');
    assert.match(indent.supplyCheck.reason, /more than 7 days after the booking/);
  });

  test('MSIL booking with no Supply Date: converts exactly as before', async () => {
    const { p, orderId } = await msilBooking({ bookedDaysAgo: 9 });
    await arrive(p, 8);
    const indent = await indentOf(orderId);
    assert.equal(indent.status, 'Confirmed');
    assert.equal(indent.supplyCheck?.status ?? null, null);
  });

  test('non-MSIL customer, same late timing: converts exactly as before', async () => {
    const { p, orderId } = await msilBooking({ category: 'Customer', bookedDaysAgo: 9, supplyInDays: -1 });
    await arrive(p, 8);
    assert.equal((await indentOf(orderId)).status, 'Confirmed');
  });

  test('a held indent does not block the queue: the next indent gets the stock', async () => {
    const held = await msilBooking({ bookedDaysAgo: 9, supplyInDays: -1 }); // older, held
    const other = await customer('Customer');
    const nextOrder = await book(other, held.p, 5); // nothing left in stock: 5 on indent
    await arrive(held.p, 5);

    assert.equal((await indentOf(held.orderId)).supplyCheck.status, 'Awaiting decision');
    assert.equal((await indentOf(nextOrder)).status, 'Confirmed');
    assert.equal(await free(held.p), 0);
  });
});

// ── The desk's decision ─────────────────────────────────────────────────────

describe('Convert / Cancel', () => {
  const heldBooking = async () => {
    const b = await msilBooking({ bookedDaysAgo: 4, supplyInDays: -1 });
    await arrive(b.p, 8);
    return { ...b, indent: await indentOf(b.orderId) };
  };

  test('Convert books the held indent onto its booking', async () => {
    const { p, orderId, indent } = await heldBooking();
    const res = await call(convertHeldIndent, { user: ADMIN, params: { id: indent.reservationId } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.data.orderId, orderId);
    assert.equal(res.payload.data.quantity, 8);

    const after = await indentOf(orderId);
    assert.equal(after.status, 'Confirmed');
    assert.equal(after.supplyCheck.status, 'Converted manually');
    assert.equal(String(after.supplyCheck.decidedBy), String(ADMIN._id));
    assert.equal(await free(p), 0);
    assert.ok(await AuditLog.findOne({ action: 'MSIL Indent Converted' }));
  });

  test('Convert with only part of the stock free converts that part and leaves the rest waiting', async () => {
    const { p, orderId, indent } = await heldBooking();
    await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: -5, bookedQuantity: 5 } });
    const res = await call(convertHeldIndent, { user: ADMIN, params: { id: indent.reservationId } });
    assert.equal(res.payload.data.quantity, 3);
    assert.equal(res.payload.data.remaining, 5);
    assert.equal((await indentOf(orderId)).quantity, 5);
  });

  test('Convert with nothing free is refused, and the indent stays held', async () => {
    const { p, orderId, indent } = await heldBooking();
    await ProductKoken.updateOne({ _id: p._id }, { $inc: { availableForSale: -8, bookedQuantity: 8 } });
    const res = await call(convertHeldIndent, { user: ADMIN, params: { id: indent.reservationId } });
    assert.equal(res.statusCode, 409);
    assert.equal((await indentOf(orderId)).supplyCheck.status, 'Awaiting decision');
  });

  test('Cancel drops the indent and records why', async () => {
    const { p, orderId, indent } = await heldBooking();
    const res = await call(cancelHeldIndent, { user: ADMIN, params: { id: indent.reservationId }, body: { reason: 'Customer sourced elsewhere' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));

    const after = await indentOf(orderId);
    assert.equal(after.status, 'Cancelled');
    assert.equal(after.cancellationReason, 'Customer sourced elsewhere');
    assert.equal(after.supplyCheck.status, 'Cancelled');
    assert.equal(await free(p), 8, 'nothing was reserved, nothing moved');
    assert.ok(await AuditLog.findOne({ action: 'MSIL Indent Cancelled' }));
  });

  test('neither action works on an indent that is not waiting for a decision', async () => {
    const { orderId } = await msilBooking({ bookedDaysAgo: 1, supplyInDays: 3 });
    const indent = await indentOf(orderId);
    assert.equal((await call(convertHeldIndent, { user: ADMIN, params: { id: indent.reservationId } })).statusCode, 409);
    assert.equal((await call(cancelHeldIndent, { user: ADMIN, params: { id: indent.reservationId } })).statusCode, 409);
    assert.equal((await indentOf(orderId)).status, indent.status, 'untouched');
  });
});

// ── Supply Date on the Sales Desk ───────────────────────────────────────────

describe('Supply Date on the Sales Desk', () => {
  test('is stored on every booking row and mirrored onto the open indent', async () => {
    const { orderId } = await msilBooking();
    const res = await setDate(orderId, ymd(5));
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));

    const rows = await Order.find({ orderId }).lean();
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.msilSupplyDate.getTime(), parseIstDay(ymd(5)).getTime());
      assert.equal(String(r.msilSupplyDateSetBy), String(ADMIN._id));
    }
    assert.equal((await indentOf(orderId)).supplyDate.getTime(), rows[0].msilSupplyDate.getTime());
    assert.ok(await AuditLog.findOne({ action: 'MSIL Supply Date Set' }));
  });

  test('is refused for a non-MSIL booking, a bad date, and a date before the booking', async () => {
    const plain = await msilBooking({ category: 'Customer' });
    assert.equal((await setDate(plain.orderId, ymd(3))).statusCode, 400);

    await clearCollections();
    const { orderId } = await msilBooking({ bookedDaysAgo: 2 });
    assert.equal((await setDate(orderId, '25/10/2026')).statusCode, 400);
    assert.equal((await setDate(orderId, ymd(-5))).statusCode, 400);
    assert.equal((await setDate(orderId, ymd(-2))).statusCode, 200, 'the booking day itself is allowed');
  });

  test('moving the date later converts a held indent by itself when stock is free', async () => {
    const { p, orderId } = await msilBooking({ bookedDaysAgo: 3, supplyInDays: -1 });
    await arrive(p, 8);
    assert.equal((await indentOf(orderId)).supplyCheck.status, 'Awaiting decision');

    const res = await setDate(orderId, ymd(2));
    assert.equal(res.statusCode, 200);
    const indent = await indentOf(orderId);
    assert.equal(indent.status, 'Confirmed');
    assert.equal(indent.supplyCheck.status, 'Auto-converted');
  });

  test('clearing the date returns the booking to the old behaviour', async () => {
    const { p, orderId } = await msilBooking({ bookedDaysAgo: 3, supplyInDays: -1 });
    await arrive(p, 8);
    await setDate(orderId, null);
    const indent = await indentOf(orderId);
    assert.equal(indent.status, 'Confirmed');
    assert.equal(indent.supplyDate, null);
  });

  test('the desk sees the date, the held line with its reason, and a count in the list', async () => {
    const { p, orderId } = await msilBooking({ bookedDaysAgo: 4, supplyInDays: -1 });
    await arrive(p, 8);

    const detail = await call(getBookingDetail, { user: ADMIN, method: 'GET', params: { orderId } });
    assert.equal(detail.statusCode, 200);
    assert.ok(detail.payload.data.msilSupplyDate);
    assert.equal(detail.payload.data.customerProfile.customerCategory, 'MSIL');
    const line = detail.payload.data.indent.lines[0];
    assert.equal(line.supplyCheck.status, 'Awaiting decision');
    assert.match(line.supplyCheck.reason, /Supply Date/);

    const list = await call(getBookings, { user: ADMIN, method: 'GET', query: {} });
    assert.equal(list.payload.data.find((b) => b.orderId === orderId).awaitingDecision, 1);
  });
});
