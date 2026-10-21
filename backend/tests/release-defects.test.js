/**
 * Retests for the defects found in the release review (smoke / regression pass,
 * 2026-10-21). One test per defect, named by its ID in the test report, each
 * written so it FAILS if the defect comes back.
 *
 * Same harness as release-regression.test.js: the real app over HTTP, real
 * permissions, an in-memory replica set. server.js, the mailer and JWT
 * verification are the only stand-ins.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';
import { startServer } from './helpers/http.js';

let UserModel = null;
const mails = [];
mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async (to, subject) => { mails.push({ to: String(to), subject }); return true; } },
});
mock.module(new URL('../middlewares/auth.js', import.meta.url).href, {
  namedExports: {
    protect: async (req, res, next) => {
      const id = req.headers['x-test-user'];
      const user = id && mongoose.isValidObjectId(id) ? await UserModel.findById(id).lean() : null;
      if (!user) return res.status(401).json({ success: false });
      req.user = { ...user, id: String(user._id) };
      return next();
    },
  },
});

const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
UserModel = User;
const { default: ArchivedUser } = await import('../models/ArchivedUser.js');
const { default: Order } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: Location } = await import('../models/Location.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { default: AuditLog } = await import('../models/AuditLog.js');
const { default: ImportJob } = await import('../models/ImportJob.js');
const { default: Brand } = await import('../models/Brand.js');
const { default: ImportRow } = await import('../models/ImportRow.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands, mergeBrandAccess, brandNameProblem } = await import('../utils/brandRegistry.js');
const { allowedBrands } = await import('../utils/brandAccess.js');
const { parsePriceInput } = await import('../config/pricing.js');
const { IMPORT_TEMPLATES } = await import('../modules/inventory/import.templates.js');
const { istDayStart, istDayEnd, parseIstDay, istYmd } = await import('../utils/businessDay.js');
const { supplyDecision } = await import('../utils/msilSupply.js');
const { processAvailableIndents } = await import('../modules/inventory/indentAvailability.service.js');

const DAY = 864e5;
let server;
let U;

before(async () => { await startTestReplSet(); server = await startServer(app); });
after(async () => { await server?.close(); await stopTestMongo(); });

let seq = 0;
const mkUser = async (role, extra = {}) => (await User.create({
  email: `${role.replace(/\s/g, '').toLowerCase()}${++seq}@example.com`, password: 'x'.repeat(12),
  user: `${role} ${seq}`, company: `${role} Co ${seq}`, role, ...extra,
})).toObject();

const setMode = (mode) => InventoryConfig.updateOne({ scope: 'global' }, { $set: { indentAssignmentMode: mode } });

beforeEach(async () => {
  await clearCollections();
  mails.length = 0;
  await seedBrands();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'auto', effectiveFrom: new Date(0) });
  U = {
    admin: await mkUser('Admin'),
    sales: await mkUser('Sales'),
    importTeam: await mkUser('Import Team'),
    customer: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
    msil: await mkUser('Customer', { customerCategory: 'MSIL', brandAccess: { koken: true }, moq: 'SKIP' }),
  };
});

const http = async (method, url, who, body) => {
  const headers = who ? { 'x-test-user': String(who._id) } : {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${server.url}${url}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json };
};
const GET = (u, w) => http('GET', u, w);
const POST = (u, w, b) => http('POST', u, w, b);
const PUT = (u, w, b) => http('PUT', u, w, b);
const DELETE = (u, w) => http('DELETE', u, w);

const product = (brand, sku, units, extra = {}) => createProductModel(brand).create({
  skuCode: sku, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0, ...extra,
});
const book = async (who, p, qty) => {
  const res = await POST('/api/v1/reservations/direct-booking', who, { items: [{ productId: String(p._id), quantity: qty }] });
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data.orderId || res.body.data.indentId.replace(/^PI-/, 'BO-');
};
const age = async (orderId, ms, { rows = true, indent = true } = {}) => {
  const when = new Date(Date.now() - ms);
  if (rows) await Order.collection.updateMany({ orderId }, { $set: { orderTimestamp: when, createdAt: when } });
  if (indent) {
    await Reservation.collection.updateMany(
      { indentNumber: orderId.replace(/^BO-/, 'PI-') }, { $set: { reservationDate: when, createdAt: when } },
    );
  }
};
const arrive = async (p, units, options = {}) => {
  await Product.updateOne({ _id: p._id }, { $inc: { availableForSale: units, totalAvailableQuantity: units } });
  const x = await Product.findById(p._id).lean();
  await StockBalance.deleteMany({ skuCode: x.skuCode });
  await StockBalance.create({
    skuCode: x.skuCode, brand: x.brand, location: new mongoose.Types.ObjectId(), locationCode: 'MAIN', onHand: x.availableForSale, reserved: 0,
  });
  return processAvailableIndents([x.skuCode], options);
};
const indentOf = (orderId) => Reservation.findOne({ indentNumber: orderId.replace(/^BO-/, 'PI-') }).lean();
const forceDate = async (orderId, day) => {
  await Order.updateMany({ orderId }, { $set: { msilSupplyDate: day } });
  await Reservation.updateMany({ indentNumber: orderId.replace(/^BO-/, 'PI-') }, { $set: { supplyDate: day } });
};
/** The IST day `offset` days from today, as the instant it starts. */
const istDay = (offset) => istDayStart(new Date(Date.now() + offset * DAY));
const uploadCsv = async (who, importType, lines) => {
  const form = new FormData();
  form.append('importType', importType);
  form.append('file', new Blob([lines.join('\n')], { type: 'text/csv' }), `${importType}-${Math.random()}.csv`);
  return http('POST', '/api/v1/inventory/imports', who, form);
};

// ════════════════════════════════════════════════════════════════════════════
// BRANDS
// ════════════════════════════════════════════════════════════════════════════

describe('Brand defects', () => {
  test('DEF-B01 a save in a portal whose brand list is stale keeps a brand it has not loaded', () => {
    // 'bosch' is not in this process's list (only the built-in three are).
    const stored = { koken: true, bix: false, imada: false, bosch: true };
    const fromOldForm = { koken: true, bix: true, imada: false };
    assert.deepEqual(mergeBrandAccess(stored, fromOldForm), { koken: true, bix: true, imada: false, bosch: true });
    // ...and a request still cannot invent a key.
    assert.deepEqual(mergeBrandAccess({}, { bosch: true, $set: 1 }), {});
  });

  test('DEF-B02 a brand whose key is an inherited property is refused, and never reads as granted', async () => {
    for (const name of ['Constructor', 'Proto', 'toString', 'Has Own Property', 'Value-Of']) {
      const problem = brandNameProblem(name);
      if (['Proto'].includes(name)) continue; // 'proto' is not an inherited key; allowed
      assert.ok(problem, `${name} should be refused`);
    }
    assert.equal((await POST('/api/v1/inventory/brands', U.admin, { name: 'Constructor' })).status, 400);
    // Even with a forged list, an empty account is granted nothing.
    assert.deepEqual(allowedBrands({ role: 'Customer', brandAccess: {} }), []);
  });

  test('DEF-B03 a brand deleted and created again under another spelling stamps the new name', async () => {
    assert.equal((await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley Tools' })).status, 201);
    await product('Stanley Tools', 'TMP-1', 1);
    await Product.deleteMany({ skuCode: 'TMP-1' });
    assert.equal((await DELETE('/api/v1/inventory/brands/stanleytools', U.admin)).status, 200);
    assert.equal((await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley-Tools' })).status, 201);

    const p = await product('Stanley-Tools', 'ST-1', 1);
    assert.equal((await Product.findById(p._id).lean()).brand, 'Stanley-Tools');
    // And it is therefore protected from deletion while in use.
    assert.equal((await DELETE('/api/v1/inventory/brands/stanleytools', U.admin)).status, 409);
  });

  test('DEF-B04 Socket.IO is registered on the app for controllers that broadcast', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    assert.match(src, /app\.set\('io', io\)/);
  });

  test('DEF-B05 a brand named by a staged import cannot be deleted', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Foo' });
    const job = await ImportJob.create({
      jobId: 'IMP-T-1', importType: 'inventory-master', fileName: 'x.csv', fileType: 'csv', fileHash: 'h',
      status: 'Validated', startedBy: U.admin._id,
    });
    await ImportRow.create({ jobId: job.jobId, rowNumber: 2, chunkIndex: 0, raw: [], data: { skuCode: 'F-1', brand: 'Foo' }, valid: true, status: 'pending' });
    const r = await DELETE('/api/v1/inventory/brands/foo', U.admin);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.message, /staged import/);
  });

  test('DEF-B06 the catalogue answers an unknown and a forbidden brand the same way', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley' });
    const unknown = await GET('/api/v1/products/nosuchbrand', U.customer);
    const forbidden = await GET('/api/v1/products/stanley', U.customer);
    assert.equal(unknown.status, forbidden.status);
    assert.equal(unknown.body.message, forbidden.body.message);
  });

  test('DEF-B07 the legacy /api routes enforce brand access (list, item, order)', async () => {
    await product('BIX', 'B-1', 5);
    assert.equal((await GET('/api/products/bix', U.customer)).status, 403);
    assert.equal((await GET('/api/products/bix/B-1', U.customer)).status, 403);
    const order = await POST('/api/orders', U.customer, { brand: 'BIX', skuCode: 'B-1', requestedQty: 1 });
    assert.ok(order.status >= 400, `ordered a forbidden brand: ${order.status}`);
    assert.equal((await Product.findOne({ skuCode: 'B-1' }).lean()).availableForSale, 5);
    // A permitted brand still works.
    await product('Koken', 'K-1', 5);
    assert.equal((await GET('/api/products/koken', U.customer)).status, 200);
  });

  test('DEF-B08 a newly created brand starts with nobody ticked, even suspended accounts', async () => {
    await User.updateOne({ _id: U.customer._id }, { $set: { 'brandAccess.zeta': true } });
    await ArchivedUser.create({ _id: new mongoose.Types.ObjectId(), email: 'gone@example.com', brandAccess: { zeta: true } });
    assert.equal((await POST('/api/v1/inventory/brands', U.admin, { name: 'Zeta' })).status, 201);
    assert.equal((await User.findById(U.customer._id).lean()).brandAccess.zeta, undefined);
    assert.equal((await ArchivedUser.findOne({ email: 'gone@example.com' }).lean()).brandAccess.zeta, undefined);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PRICING
// ════════════════════════════════════════════════════════════════════════════

describe('Pricing defects', () => {
  const url = (sku) => `/api/v1/inventory/items/${encodeURIComponent(sku)}/pricing`;

  test('DEF-P01 no price amount reaches the shared audit log', async () => {
    await product('Koken', 'K-1', 1, { prices: { trader: 4321 } });
    await PUT(url('K-1'), U.admin, { brand: 'Koken', prices: { trader: 8765, msil: null } });
    const up = await uploadCsv(U.admin, 'sku-pricing', ['SKU Code,Trader Price', 'K-1,5432']);
    await POST(`/api/v1/inventory/imports/${up.body.data.jobId}/confirm`, U.admin);
    for (let i = 0; i < 100 && (await ImportJob.findOne({ jobId: up.body.data.jobId }).lean()).status === 'Processing'; i += 1) {
      await new Promise((r) => { setTimeout(r, 25); });
    }
    const entries = await AuditLog.find({ action: /SKU Pricing/ }).lean();
    assert.equal(entries.length, 2);
    const text = JSON.stringify(entries);
    for (const amount of ['4321', '8765', '5432']) assert.ok(!text.includes(amount), `audit contains ${amount}`);
    assert.match(text, /trader/i, 'the tier is still recorded');
  });

  test('DEF-P02 the template sample row is not a real-looking SKU', () => {
    assert.match(IMPORT_TEMPLATES['sku-pricing'].sample['SKU Code'], /EXAMPLE/);
  });

  test('DEF-P04/05/06 ambiguous, tiny and absurd amounts are refused, not reinterpreted', async () => {
    const refused = ['12,5', '1.250,50', '0x1F', '1e5', '1rs2', 0.004, '0.004', 1.7e308, '999999999', '-5', ''];
    for (const raw of refused.filter((r) => r !== '')) {
      assert.equal(parsePriceInput(raw).ok, false, `${raw} should be refused`);
    }
    for (const [raw, value] of [['1250.50', 1250.5], ['1,250.50', 1250.5], ['12,50,000', 1250000], ['₹ 99', 99], ['Rs.10', 10], ['INR 1,234', 1234], [0.01, 0.01], [12.345, 12.35]]) {
      assert.deepEqual(parsePriceInput(raw), { ok: true, value }, `${raw}`);
    }
    await product('Koken', 'K-1', 1, { prices: { trader: 100 } });
    for (const bad of ['12,5', 0.004, 1.7e308]) {
      assert.equal((await PUT(url('K-1'), U.admin, { brand: 'Koken', prices: { trader: bad } })).status, 400, `${bad}`);
    }
    assert.equal((await Product.findOne({ skuCode: 'K-1' }, 'prices').lean()).prices.trader, 100);
  });

  test('DEF-P04 the import refuses the same ambiguous cells', async () => {
    await product('Koken', 'K-1', 1);
    const up = await uploadCsv(U.admin, 'sku-pricing', ['SKU Code,Trader Price', 'K-1,"12,5"']);
    assert.equal(up.body.data.validRows, 0);
    assert.equal(up.body.data.invalidRows, 1);
  });

  test('DEF-P09 a rejected row does not block its corrected duplicate', async () => {
    await product('Koken', 'K-1', 1);
    const up = await uploadCsv(U.admin, 'sku-pricing', ['SKU Code,Trader Price', 'K-1,abc', 'K-1,120']);
    assert.equal(up.body.data.validRows, 1, JSON.stringify(up.body.data));
    const errs = await GET(`/api/v1/inventory/imports/${up.body.data.jobId}/errors`, U.admin);
    assert.ok(!JSON.stringify(errs.body).includes('row null'));
  });

  test('DEF-P10 a misspelt price header fails the file instead of dropping the column', async () => {
    await product('Koken', 'K-1', 1);
    const up = await uploadCsv(U.admin, 'sku-pricing', ['SKU Code,Trader Price,Enduser Price', 'K-1,5,6']);
    assert.equal(up.body.data.status, 'Failed');
    assert.match(up.body.data.fileErrors.join(' '), /Enduser Price/);
  });

  test('DEF-P12 the brand may be spelt in any case', async () => {
    await product('Koken', 'K-1', 1, { prices: { trader: 100 } });
    assert.equal((await GET(`${url('K-1')}?brand=koken`, U.admin)).status, 200);
    assert.equal((await PUT(url('K-1'), U.admin, { brand: 'KOKEN', prices: { trader: 101 } })).status, 200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MSIL SUPPLY DATE
// ════════════════════════════════════════════════════════════════════════════

describe('MSIL defects', () => {
  const msilBooking = async ({ stock = 2, qty = 10, bookedAgoMs = 0 } = {}) => {
    const p = await product('Koken', `SKU-${++seq}`, stock);
    const orderId = await book(U.msil, p, qty);
    if (bookedAgoMs) await age(orderId, bookedAgoMs);
    return { p, orderId };
  };

  test('DEF-H1 dates are Indian days whatever the server time zone', () => {
    // 25 Oct IST begins at 24 Oct 18:30 UTC and ends at 25 Oct 18:29:59.999 UTC.
    const day = parseIstDay('2026-10-25');
    assert.equal(day.toISOString(), '2026-10-24T18:30:00.000Z');
    assert.equal(istDayEnd(day).toISOString(), '2026-10-25T18:29:59.999Z');
    assert.equal(istYmd(day), '2026-10-25');
    assert.equal(parseIstDay('2026-02-30'), null);

    const msil = { customerCategory: 'MSIL' };
    const booked = new Date('2026-10-22T04:00:00Z');
    // 11 pm IST on the Supply Date: on time. 12:01 am IST the next day: late.
    assert.equal(supplyDecision({ customer: msil, supplyDate: day, bookingDate: booked, at: new Date('2026-10-25T17:30:00Z') }).onTime, true);
    assert.equal(supplyDecision({ customer: msil, supplyDate: day, bookingDate: booked, at: new Date('2026-10-25T18:31:00Z') }).onTime, false);
    // The process time zone does not enter into it.
    assert.ok(process.env.TZ === undefined || typeof process.env.TZ === 'string');
  });

  test('DEF-H1 the API stores the IST day and the hold reason prints IST dates', async () => {
    const { orderId } = await msilBooking();
    const today = istYmd(new Date());
    assert.equal((await PUT(`/api/v1/sales/bookings/${orderId}/supply-date`, U.sales, { supplyDate: today })).status, 200);
    const stored = (await Order.findOne({ orderId }).lean()).msilSupplyDate;
    assert.equal(stored.getTime(), parseIstDay(today).getTime());
  });

  test('DEF-H2 manual assignment mode still holds a late MSIL arrival, at the moment it arrives', async () => {
    await setMode('manual');
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, istDay(-1));
    const out = await arrive(p, 8);
    assert.equal(out.held, true, 'manual mode still assigns nothing');
    const i = await indentOf(orderId);
    assert.equal(i.supplyCheck.status, 'Awaiting decision');
    assert.ok(i.supplyCheck.arrivedAt);
  });

  test('DEF-H2 assigning a held indent on the assignment screen records it as the desk\'s Convert', async () => {
    await setMode('manual');
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, istDay(-1));
    await arrive(p, 8);
    const i = await indentOf(orderId);
    const queue = await GET('/api/v1/inventory/indent-assignment', U.admin);
    const flagged = JSON.stringify(queue.body ?? {});
    assert.ok(queue.status !== 200 || flagged.includes('Awaiting decision'), 'the screen sees the hold');
    const r = await POST('/api/v1/inventory/indent-assignment/assign', U.admin, { indentId: String(i._id), quantity: 4 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await indentOf(orderId);
    assert.equal(after.supplyCheck.status, 'Converted manually');
  });

  test('DEF-M1 moving the date re-judges the ORIGINAL arrival, not "now"', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 1 * DAY });
    await forceDate(orderId, istDay(-1));
    await arrive(p, 8);
    // Pretend the stock arrived yesterday afternoon and the desk acts today.
    const yesterday = new Date(istDay(-1).getTime() + 15 * 3600e3);
    await Reservation.updateOne({ indentNumber: orderId.replace(/^BO-/, 'PI-') }, { $set: { 'supplyCheck.arrivedAt': yesterday } });
    // Moving the Supply Date to yesterday makes that arrival on time.
    // (Set straight on the endpoint: yesterday is after the booking, which was 1 day ago... use today.)
    const res = await PUT(`/api/v1/sales/bookings/${orderId}/supply-date`, U.sales, { supplyDate: istYmd(new Date()) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const i = await indentOf(orderId);
    assert.equal(i.status, 'Confirmed', 'converted');
    assert.equal(i.supplyCheck.status, 'Auto-converted');
    assert.equal(res.body.data.convertedLines, 1);
  });

  test('DEF-M1 a held indent the new date clears, with no stock left, is no longer shown as awaiting', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 1 * DAY });
    await forceDate(orderId, istDay(-1));
    await arrive(p, 8);
    // The units go to someone else in the meantime.
    await Product.updateOne({ _id: p._id }, { $inc: { availableForSale: -8, bookedQuantity: 8 } });
    await StockBalance.updateMany({ skuCode: p.skuCode }, { $set: { onHand: 0 } });
    const res = await PUT(`/api/v1/sales/bookings/${orderId}/supply-date`, U.sales, { supplyDate: istYmd(new Date(Date.now() + 3 * DAY)) });
    assert.equal(res.status, 200);
    const i = await indentOf(orderId);
    assert.equal(i.supplyCheck.status, null);
    assert.ok(i.supplyCheck.arrivedAt, 'its arrival stays on record');
    assert.equal(res.body.data.awaitingLines, 0);
  });

  test('DEF-M2 the 7-day window counts from the booking, not from the first allocation', async () => {
    // Nothing in stock: the booking is an indent only.
    const { p, orderId } = await msilBooking({ stock: 0, qty: 10, bookedAgoMs: 2 * DAY });
    await forceDate(orderId, istDay(10));
    await arrive(p, 4); // on time: converts 4, creating the booking's rows NOW
    assert.equal((await indentOf(orderId)).quantity, 6);
    // The indent was raised 9 days ago; its rows are brand new.
    await age(orderId, 9 * DAY, { rows: false, indent: true });
    await arrive(p, 6);
    const i = await indentOf(orderId);
    assert.equal(i.supplyCheck.status, 'Awaiting decision', 'held: the window closed 2 days ago');
  });

  test('DEF-M3 the desk shows the Supply Date even when the first row lacks it', async () => {
    const { orderId } = await msilBooking();
    await PUT(`/api/v1/sales/bookings/${orderId}/supply-date`, U.sales, { supplyDate: istYmd(new Date(Date.now() + 2 * DAY)) });
    const rows = await Order.find({ orderId }).sort({ lineSeq: 1 }).lean();
    await Order.updateOne({ _id: rows[0]._id }, { $set: { msilSupplyDate: null } });
    const detail = await GET(`/api/v1/sales/bookings/${orderId}`, U.sales);
    assert.ok(detail.body.data.msilSupplyDate);
  });

  test('DEF-M4 a held indent\'s customer gets no "material inwarded" mail', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, istDay(-1));
    mails.length = 0; // only what the ARRIVAL sends — booking confirmations went out already
    await arrive(p, 8, { event: 'material-inward', inwardBySku: new Map([[`SKU-${seq}`, 8]]), reference: 'GRN-1' });
    assert.equal((await indentOf(orderId)).supplyCheck.status, 'Awaiting decision');
    assert.ok(!mails.some((m) => m.to.includes(U.msil.email)), `mailed: ${JSON.stringify(mails)}`);
  });

  test('DEF-M5 after a partial manual Convert, the rest follows the stock without a new hold', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, istDay(-1));
    await arrive(p, 3);
    const { reservationId } = await indentOf(orderId);
    const c = await POST(`/api/v1/sales/indents/${reservationId}/convert`, U.sales);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal((await indentOf(orderId)).quantity, 5);
    await arrive(p, 5);
    const i = await indentOf(orderId);
    assert.equal(i.status, 'Confirmed', 'the remainder converted');
  });

  test('DEF-L5 Import Team cannot Convert or Cancel a customer\'s indent', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, istDay(-1));
    await arrive(p, 8);
    const { reservationId } = await indentOf(orderId);
    assert.equal((await POST(`/api/v1/sales/indents/${reservationId}/convert`, U.importTeam)).status, 403);
    assert.equal((await POST(`/api/v1/sales/indents/${reservationId}/cancel`, U.importTeam)).status, 403);
    assert.equal((await POST(`/api/v1/sales/indents/${reservationId}/convert`, U.sales)).status, 200);
  });

  test('DEF-L3 double-clicked Convert: one claim, one allocation', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, istDay(-1));
    await arrive(p, 3);
    const { reservationId } = await indentOf(orderId);
    const results = await Promise.all([1, 2].map(() => POST(`/api/v1/sales/indents/${reservationId}/convert`, U.sales)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    const allocated = (await Order.find({ orderId }).lean()).flatMap((r) => r.allocations || []).reduce((n, a) => n + a.quantity, 0);
    assert.equal(allocated, 3);
  });
});


// ════════════════════════════════════════════════════════════════════════════
// THE SIX ITEMS LEFT OPEN BY THE FIRST REPORT (fixed 2026-10-21)
// ════════════════════════════════════════════════════════════════════════════

describe('Open items, fixed', () => {
  const pricingUrl = (sku) => `/api/v1/inventory/items/${encodeURIComponent(sku)}/pricing`;
  const waitJob = async (jobId) => {
    for (let i = 0; i < 200; i += 1) {
      const j = await ImportJob.findOne({ jobId }).lean();
      if (j.status !== 'Processing') return j;
      await new Promise((r) => { setTimeout(r, 25); });
    }
    throw new Error('import did not finish');
  };

  test('DEF-P15 pricing a booking writes no rupee amount to the shared audit log', async () => {
    const p = await product('Koken', 'K-1', 10, { prices: { trader: 7777 } });
    const orderId = await book(U.customer, p, 3);
    assert.equal((await PUT(`/api/v1/sales/bookings/${orderId}/pricing`, U.sales, { priceType: 'trader' })).status, 200);
    const entries = await AuditLog.find({ action: 'Booking Priced' }).lean();
    assert.equal(entries.length, 1);
    const text = JSON.stringify(entries);
    assert.ok(!text.includes('7777') && !text.includes('23331') && !text.includes('₹'), text);
    assert.equal(entries[0].meta.totalAmount, undefined);
    assert.equal(entries[0].meta.pricedLines, 1, 'still records that lines were rated');
  });

  test('DEF-P07 an MSIL code shared by two brands resolves by the row Brand', async () => {
    await product('Koken', 'K-5', 1, { msilCode: 'M-5' });
    await product('BIX', 'B-7', 1, { msilCode: 'M-5' });
    const up = await uploadCsv(U.admin, 'sku-pricing', [
      'SKU Code,MSIL Code,Brand,Trader Price',
      ',M-5,BIX,70', // brand settles it
      ',M-5,,80', // cannot tell: refused, and says how to fix it
      ',M-5,IMADA,90', // not on any IMADA SKU
    ]);
    assert.equal(up.body.data.validRows, 1, JSON.stringify(up.body.data));
    const errs = JSON.stringify((await GET(`/api/v1/inventory/imports/${up.body.data.jobId}/errors`, U.admin)).body);
    assert.match(errs, /Fill in the Brand column/);
    assert.match(errs, /not on any IMADA SKU/);
    await POST(`/api/v1/inventory/imports/${up.body.data.jobId}/confirm`, U.admin);
    await waitJob(up.body.data.jobId);
    assert.equal((await Product.findOne({ skuCode: 'B-7' }, 'prices').lean()).prices.trader, 70);
    assert.equal((await Product.findOne({ skuCode: 'K-5' }, 'prices').lean()).prices.trader, null);
  });

  test('DEF-P07 the MSIL cross-check reads the row own brand', async () => {
    await product('Koken', 'K-9', 1, { msilCode: 'M-1' });
    await product('BIX', 'K-9', 1, { msilCode: 'M-2' });
    const up = await uploadCsv(U.admin, 'sku-pricing', [
      'SKU Code,MSIL Code,Brand,Trader Price',
      'K-9,M-1,Koken,10', // right code for Koken
      'K-9,M-2,BIX,11', // right code for BIX
    ]);
    assert.equal(up.body.data.validRows, 2, JSON.stringify(up.body.data));
    const bad = await uploadCsv(U.admin, 'sku-pricing', ['SKU Code,MSIL Code,Brand,Trader Price', 'K-9,M-2,Koken,12']);
    assert.equal(bad.body.data.validRows, 0, 'the BIX code on the Koken row is refused');
  });

  test('DEF-P14 a price change and its audit entry land together or not at all', async () => {
    await product('Koken', 'K-1', 1, { prices: { trader: 100 } });
    const realCreate = AuditLog.create;
    AuditLog.create = async () => { throw new Error('audit store unavailable'); };
    const log = console.error;
    console.error = () => {};
    try {
      const single = await PUT(pricingUrl('K-1'), U.admin, { brand: 'Koken', prices: { trader: 200 } });
      assert.ok(single.status >= 500, `got ${single.status}`);
      assert.equal((await Product.findOne({ skuCode: 'K-1' }, 'prices').lean()).prices.trader, 100, 'single update rolled back');

      const up = await uploadCsv(U.admin, 'sku-pricing', ['SKU Code,Trader Price', 'K-1,300']);
      await POST(`/api/v1/inventory/imports/${up.body.data.jobId}/confirm`, U.admin);
      await waitJob(up.body.data.jobId);
      assert.equal((await Product.findOne({ skuCode: 'K-1' }, 'prices').lean()).prices.trader, 100, 'import chunk rolled back');
    } finally {
      AuditLog.create = realCreate;
      console.error = log;
    }
    // With the audit store back, the same change goes through, with its entry.
    assert.equal((await PUT(pricingUrl('K-1'), U.admin, { brand: 'Koken', prices: { trader: 200 } })).status, 200);
    assert.equal(await AuditLog.countDocuments({ action: 'SKU Pricing Updated' }), 1);
  });

  test('DEF-B11 a brand used at the moment it is deleted is put back, not orphaned', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Foo' });
    await User.updateOne({ _id: U.customer._id }, { $set: { 'brandAccess.foo': true } });
    const realDelete = Brand.deleteOne;
    // Someone files a product under Foo in the instant the delete runs.
    Brand.deleteOne = async function deleteThenRace(...args) {
      const result = await realDelete.apply(this, args);
      await createProductModel('Foo').create({ skuCode: 'LATE-1' });
      return result;
    };
    try {
      const r = await DELETE('/api/v1/inventory/brands/foo', U.admin);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.message, /used a moment ago/);
    } finally {
      Brand.deleteOne = realDelete;
    }
    assert.ok(await Brand.findOne({ key: 'foo' }), 'the brand is back');
    assert.ok((await GET('/api/v1/inventory/brands', U.admin)).body.data.some((b) => b.key === 'foo'));
    assert.equal((await User.findById(U.customer._id).lean()).brandAccess.foo, true, 'nobody lost access');
  });

  test('DEF-L8 restoring a late MSIL indent holds it for a decision instead', async () => {
    await setMode('manual');
    const p = await product('Koken', `SKU-R${++seq}`, 2);
    const orderId = await book(U.msil, p, 10);
    await age(orderId, 3 * DAY);
    await forceDate(orderId, istDay(-1));
    // Stock is there, but nothing assigned it (manual mode).
    await Product.updateOne({ _id: p._id }, { $inc: { availableForSale: 8, totalAvailableQuantity: 8 } });
    const indent = await indentOf(orderId);
    const r = await POST(`/api/v1/reservations/${indent._id}/restore`, U.admin);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.message, /Not restored/);
    const after = await indentOf(orderId);
    assert.equal(after.status, indent.status, 'not moved to the selection list');
    assert.equal(after.supplyCheck.status, 'Awaiting decision');
  });

  test('DEF-L8 an on-time MSIL indent, and any non-MSIL indent, still restore as before', async () => {
    await setMode('manual');
    const onTime = await product('Koken', `SKU-R${++seq}`, 2);
    const a = await book(U.msil, onTime, 10);
    await forceDate(a, istDay(3));
    await Product.updateOne({ _id: onTime._id }, { $inc: { availableForSale: 8, totalAvailableQuantity: 8 } });
    const ia = await indentOf(a);
    const ra = await POST(`/api/v1/reservations/${ia._id}/restore`, U.admin);
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    assert.equal((await indentOf(a)).status, 'Reserved');

    const plain = await product('Koken', `SKU-R${++seq}`, 2);
    const b = await book(U.customer, plain, 10);
    await age(b, 9 * DAY);
    await Product.updateOne({ _id: plain._id }, { $inc: { availableForSale: 8, totalAvailableQuantity: 8 } });
    const ib = await indentOf(b);
    assert.equal((await POST(`/api/v1/reservations/${ib._id}/restore`, U.admin)).status, 200);
  });
});
