/**
 * Release regression suite — Brands, SKU Pricing ("Price Inward") and the MSIL
 * Supply Date, driven through the REAL Express app over HTTP.
 *
 * Earlier tests for these features called controllers and services directly,
 * which skips the route-level permission gates. Here every request goes through
 * app.js: the real routers, the real `authorize` checks and the real role
 * baselines. Only three things are replaced:
 *
 *   server.js   (Socket.IO)    — would boot the live server
 *   mailer.js                  — would send real email
 *   auth.js `protect`          — reads the signed-in user's id from a header
 *                                and loads that user from the test database,
 *                                instead of verifying a JWT
 *
 * Runs against an in-memory MongoDB replica set. Never the shared database.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';
import { startServer } from './helpers/http.js';

let UserModel = null;
mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});
mock.module(new URL('../middlewares/auth.js', import.meta.url).href, {
  namedExports: {
    protect: async (req, res, next) => {
      const id = req.headers['x-test-user'];
      const user = id && mongoose.isValidObjectId(id) ? await UserModel.findById(id).lean() : null;
      if (!user) return res.status(401).json({ success: false, message: 'Not authorized to access this route.' });
      req.user = { ...user, id: String(user._id) };
      return next();
    },
  },
});

const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
UserModel = User;
const { default: Order } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: Location } = await import('../models/Location.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { default: StockMovement } = await import('../models/StockMovement.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { default: ImportJob } = await import('../models/ImportJob.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { processAvailableIndents } = await import('../modules/inventory/indentAvailability.service.js');
const { parseIstDay, istYmd } = await import('../utils/businessDay.js');
const { runPoSettlement } = await import('../modules/orders/poExpiryJob.js');

const DAY = 864e5;
let server;
let U; // the signed-in users, by role

before(async () => {
  await startTestReplSet();
  server = await startServer(app);
});
after(async () => {
  await server?.close();
  await stopTestMongo();
});

let seq = 0;
const mkUser = async (role, extra = {}) => (await User.create({
  email: `${role.replace(/\s/g, '').toLowerCase()}${++seq}@example.com`, password: 'x'.repeat(12),
  user: `${role} ${seq}`, company: `${role} Co ${seq}`, role, ...extra,
})).toObject();

beforeEach(async () => {
  await clearCollections();
  await seedBrands();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'auto', effectiveFrom: new Date(0) });
  U = {
    admin: await mkUser('Admin'),
    sales: await mkUser('Sales', { brandAccess: { koken: true, bix: true, imada: true } }),
    im: await mkUser('Inventory Manager'),
    mgmt: await mkUser('Management'),
    importTeam: await mkUser('Import Team'),
    wh: await mkUser('Warehouse User'),
    customer: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
    msil: await mkUser('Customer', { customerCategory: 'MSIL', brandAccess: { koken: true }, moq: 'SKIP' }),
  };
});

// ── HTTP ────────────────────────────────────────────────────────────────────

const http = async (method, url, who, body, { raw = false } = {}) => {
  const headers = who ? { 'x-test-user': String(who._id) } : {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${server.url}${url}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = raw ? text : null; }
  return { status: res.status, body: json };
};
const GET = (url, who) => http('GET', url, who);
const POST = (url, who, body) => http('POST', url, who, body);
const PUT = (url, who, body) => http('PUT', url, who, body);
const PATCH = (url, who, body) => http('PATCH', url, who, body);
const DELETE = (url, who) => http('DELETE', url, who);

// ── Fixtures ────────────────────────────────────────────────────────────────

const product = (brand, sku, units, extra = {}) => createProductModel(brand).create({
  skuCode: sku, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0, ...extra,
});

const invariant = async (p) => {
  const x = await Product.findById(p._id).lean();
  assert.equal(x.availableForSale + x.bookedQuantity, x.totalAvailableQuantity,
    `stock invariant broken for ${x.skuCode}: ${JSON.stringify(x)}`);
  return x;
};

/** Book through the real route, as the customer. */
const book = async (who, p, qty) => {
  const res = await POST('/api/v1/reservations/direct-booking', who, { items: [{ productId: String(p._id), quantity: qty }] });
  assert.ok(res.status < 300, `booking failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.orderId || res.body.data.indentId.replace(/^PI-/, 'BO-');
};

const age = async (orderId, ms) => {
  const when = new Date(Date.now() - ms);
  await Order.collection.updateMany({ orderId }, { $set: { orderTimestamp: when, createdAt: when } });
  await Reservation.collection.updateMany(
    { indentNumber: orderId.replace(/^BO-/, 'PI-') }, { $set: { reservationDate: when, createdAt: when } },
  );
};

const arrive = async (p, units) => {
  await Product.updateOne({ _id: p._id }, { $inc: { availableForSale: units, totalAvailableQuantity: units } });
  const x = await Product.findById(p._id).lean();
  await StockBalance.deleteMany({ skuCode: x.skuCode });
  await StockBalance.create({
    skuCode: x.skuCode, brand: x.brand, location: new mongoose.Types.ObjectId(), locationCode: 'MAIN',
    onHand: x.availableForSale, reserved: 0,
  });
  return processAvailableIndents([x.skuCode]);
};

const indentOf = (orderId) => Reservation.findOne({ indentNumber: orderId.replace(/^BO-/, 'PI-') }).lean();
/** 'YYYY-MM-DD' of the IST day `offsetDays` from today — Supply Dates are Indian days. */
const ymd = (offsetDays) => istYmd(new Date(Date.now() + offsetDays * DAY));

/** Upload a CSV through the real import route. */
const uploadCsv = async (who, importType, lines) => {
  const form = new FormData();
  form.append('importType', importType);
  form.append('file', new Blob([lines.join('\n')], { type: 'text/csv' }), `${importType}-${Date.now()}-${Math.random()}.csv`);
  return http('POST', '/api/v1/inventory/imports', who, form);
};
const waitForJob = async (jobId, who) => {
  for (let i = 0; i < 200; i += 1) {
    const r = await GET(`/api/v1/inventory/imports/${jobId}`, who);
    if (r.body?.data?.status !== 'Processing') return r.body.data;
    await new Promise((res) => { setTimeout(res, 25); });
  }
  throw new Error('import did not finish');
};

// ════════════════════════════════════════════════════════════════════════════
// 1. BRANDS (the request's "Branch")
// ════════════════════════════════════════════════════════════════════════════

describe('1. Brands', () => {
  test('TC-B01 Admin creates a brand; it is listed and reaches /auth/me', async () => {
    const created = await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley Tools' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const list = await GET('/api/v1/inventory/brands', U.admin);
    assert.deepEqual(list.body.data.map((b) => b.name), ['Koken', 'BIX', 'IMADA', 'Stanley Tools']);
    const me = await GET('/api/v1/auth/me', U.admin);
    assert.ok(me.body.data.brands.some((b) => b.name === 'Stanley Tools' && b.key === 'stanleytools'));
  });

  test('TC-B02 mandatory field and input validation', async () => {
    for (const [body, why] of [
      [{}, 'missing'], [{ name: '' }, 'blank'], [{ name: ' ' }, 'spaces'], [{ name: 'A' }, 'too short'],
      [{ name: 'X'.repeat(31) }, 'too long'], [{ name: '123' }, 'no letter'], [{ name: 'Bad<b>' }, 'markup'],
      [{ name: { $gt: '' } }, 'operator object'],
    ]) {
      const r = await POST('/api/v1/inventory/brands', U.admin, body);
      assert.equal(r.status, 400, `${why}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  test('TC-B03 duplicate handling: exact, case-insensitive, punctuation variants', async () => {
    assert.equal((await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley' })).status, 201);
    for (const name of ['Stanley', 'STANLEY', 'stanley', 'Stan-ley', 'Koken', 'Ko.ken']) {
      const r = await POST('/api/v1/inventory/brands', U.admin, { name });
      assert.equal(r.status, 409, `${name}: ${r.status}`);
    }
  });

  test('TC-B04 edit: the MSIL visibility flag can be changed; name cannot', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Taparia' });
    const r = await PATCH('/api/v1/inventory/brands/taparia', U.admin, { hiddenFromMsil: true });
    assert.equal(r.status, 200);
    assert.equal((await GET('/api/v1/inventory/brands', U.admin)).body.data.find((b) => b.key === 'taparia').hiddenFromMsil, true);
    assert.equal((await PATCH('/api/v1/inventory/brands/taparia', U.admin, { hiddenFromMsil: 'yes' })).status, 400);
    assert.equal((await PATCH('/api/v1/inventory/brands/nope', U.admin, { hiddenFromMsil: true })).status, 404);
    // There is no rename endpoint by design (the name is stored on every document).
    await PATCH('/api/v1/inventory/brands/taparia', U.admin, { name: 'Other' });
    assert.ok((await GET('/api/v1/inventory/brands', U.admin)).body.data.some((b) => b.name === 'Taparia'));
  });

  test('TC-B05 delete: unused only, never built-in, never in use', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley' });
    assert.equal((await DELETE('/api/v1/inventory/brands/koken', U.admin)).status, 409);
    await product('Stanley', 'ST-1', 1);
    assert.equal((await DELETE('/api/v1/inventory/brands/stanley', U.admin)).status, 409);
    await Product.deleteMany({ skuCode: 'ST-1' });
    assert.equal((await DELETE('/api/v1/inventory/brands/stanley', U.admin)).status, 200);
    assert.equal((await GET('/api/v1/inventory/brands', U.admin)).body.data.length, 3);
  });

  test('TC-B06 permissions: only configure_inventory may list, create, edit or delete', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley' });
    for (const who of ['sales', 'im', 'wh', 'customer', 'msil']) {
      assert.equal((await GET('/api/v1/inventory/brands', U[who])).status, 403, `${who} list`);
      assert.equal((await POST('/api/v1/inventory/brands', U[who], { name: 'Hacked' })).status, 403, `${who} create`);
      assert.equal((await PATCH('/api/v1/inventory/brands/stanley', U[who], { hiddenFromMsil: true })).status, 403, `${who} edit`);
      assert.equal((await DELETE('/api/v1/inventory/brands/stanley', U[who])).status, 403, `${who} delete`);
    }
    assert.equal((await GET('/api/v1/inventory/brands')).status, 401, 'signed out');
  });

  test('TC-B07 data visibility: customers see a new brand only once granted, and never learn its name otherwise', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley' });
    await product('Stanley', 'ST-1', 5);
    await product('Koken', 'K-1', 5);

    const before = await GET('/api/v1/products', U.customer);
    assert.equal(before.status, 200);
    assert.ok(!JSON.stringify(before.body).includes('ST-1'), 'no Stanley products before access');
    assert.ok(!(await GET('/api/v1/auth/me', U.customer)).body.data.brands.some((b) => b.name === 'Stanley'));

    await User.updateOne({ _id: U.customer._id }, { $set: { 'brandAccess.stanley': true } });
    const afterRes = await GET('/api/v1/products', U.customer);
    assert.ok(JSON.stringify(afterRes.body).includes('ST-1'), 'Stanley products after access');
    assert.ok((await GET('/api/v1/auth/me', U.customer)).body.data.brands.some((b) => b.name === 'Stanley'));
  });

  test('TC-B08 inventory staff see the new brand without being granted it', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley' });
    await product('Stanley', 'ST-1', 5);
    const r = await GET('/api/v1/inventory/items?brand=Stanley', U.im);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(JSON.stringify(r.body).includes('ST-1'));
  });

  test('TC-B09 a multi-word brand works in URL paths (catalogue by brand)', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley Tools' });
    await product('Stanley Tools', 'STT-1', 5);
    for (const seg of ['stanley%20tools', 'Stanley%20Tools', 'stanleytools']) {
      const r = await GET(`/api/v1/products/${seg}`, U.admin);
      assert.equal(r.status, 200, `${seg}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.ok(JSON.stringify(r.body).includes('STT-1'), `${seg}: product listed`);
    }
  });

  test('TC-B10 regression: saving a user from an old 3-brand form keeps the new brand', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley' });
    await User.updateOne({ _id: U.customer._id }, { $set: { brandAccess: { koken: true, stanley: true } } });
    const r = await PATCH(`/api/v1/users/${U.customer._id}`, U.admin, { brandAccess: { koken: true, bix: true, imada: false } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await User.findById(U.customer._id).lean()).brandAccess, { koken: true, bix: true, imada: false, stanley: true });
  });

  test('TC-B11 regression: a new brand\'s product books, reserves and reports under its own brand', async () => {
    await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley' });
    await User.updateOne({ _id: U.customer._id }, { $set: { 'brandAccess.stanley': true } });
    const p = await product('Stanley', 'ST-1', 10);
    const orderId = await book({ ...U.customer }, p, 4);
    const rows = await Order.find({ orderId }).lean();
    assert.deepEqual([...new Set(rows.map((r) => r.brand))], ['Stanley']);
    const x = await invariant(p);
    assert.equal(x.bookedQuantity, 4);
    const desk = await GET(`/api/v1/sales/bookings/${orderId}`, U.sales);
    // Sales is not granted Stanley, and the desk shows every booking anyway.
    assert.equal(desk.status, 200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. SKU PRICING (the request's "Price Inward")
// ════════════════════════════════════════════════════════════════════════════

describe('2. SKU Pricing', () => {
  const url = (sku) => `/api/v1/inventory/items/${encodeURIComponent(sku)}/pricing`;

  test('TC-P01 Admin reads and updates one SKU end to end', async () => {
    await product('Koken', 'K-1', 7, { prices: { trader: 100 } });
    const read = await http('GET', `${url('K-1')}?brand=Koken`, U.admin);
    assert.equal(read.status, 200);
    assert.equal(read.body.data.prices.trader, 100);
    const r = await PUT(url('K-1'), U.admin, { brand: 'Koken', prices: { trader: '1,250.50', msil: 99.999 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const x = await Product.findOne({ skuCode: 'K-1' }, 'prices availableForSale totalAvailableQuantity').lean();
    assert.equal(x.prices.trader, 1250.5);
    assert.equal(x.prices.msil, 100);
    assert.equal(x.availableForSale, 7, 'stock untouched');
    assert.equal(await StockMovement.countDocuments(), 0, 'no ledger movement');
  });

  test('TC-P02 invalid inputs and boundaries', async () => {
    await product('Koken', 'K-1', 7, { prices: { trader: 100 } });
    const cases = [
      [{ trader: 0 }, 400], [{ trader: -1 }, 400], [{ trader: 'abc' }, 400], [{ dealer: 5 }, 400],
      [{}, 400], [{ trader: 100 }, 400 /* no change */], [{ trader: 0.01 }, 200], [{ trader: '1e3' }, 400 /* exponent: refused since DEF-P04 */], [{ trader: '12,5' }, 400],
    ];
    for (const [prices, status] of cases) {
      const r = await PUT(url('K-1'), U.admin, { brand: 'Koken', prices });
      assert.equal(r.status, status, `${JSON.stringify(prices)} -> ${r.status} ${r.body?.message}`);
    }
    assert.equal((await PUT(url('NOPE'), U.admin, { brand: 'Koken', prices: { trader: 1 } })).status, 404);
    assert.equal((await PUT(url('K-1'), U.admin, { prices: { trader: 1 } })).status, 400, 'brand required');
    assert.equal((await PUT(url('K-1'), U.admin, { brand: 'Koken', prices: 'x' })).status, 400);
  });

  test('TC-P03 permissions: Admin, Sales, Inventory Manager, Management, Import Team update; Warehouse and customers cannot', async () => {
    await product('Koken', 'K-1', 7, { prices: { trader: 100 } });
    let next = 101;
    for (const who of ['sales', 'im', 'mgmt', 'importTeam']) {
      assert.equal((await http('GET', `${url('K-1')}?brand=Koken`, U[who])).status, 200, `${who} read`);
      assert.equal((await PUT(url('K-1'), U[who], { brand: 'Koken', prices: { trader: next } })).status, 200, `${who} write`);
      next += 1;
    }
    await Product.updateOne({ skuCode: 'K-1' }, { $set: { 'prices.trader': 100 } });
    for (const who of ['wh', 'customer', 'msil']) {
      assert.equal((await http('GET', `${url('K-1')}?brand=Koken`, U[who])).status, 403, `${who} read`);
      assert.equal((await PUT(url('K-1'), U[who], { brand: 'Koken', prices: { trader: 1 } })).status, 403, `${who} write`);
    }
    assert.equal((await Product.findOne({ skuCode: 'K-1' }, 'prices').lean()).prices.trader, 100);
  });

  test('TC-P04 no price leaks through the inventory screens', async () => {
    await product('Koken', 'K-1', 7, { prices: { trader: 123456, endUser: 654321 } });
    for (const who of ['im', 'wh', 'admin']) {
      for (const path of ['/api/v1/inventory/items', '/api/v1/inventory/items/K-1', '/api/v1/products']) {
        const r = await GET(path, U[who]);
        const text = JSON.stringify(r.body);
        assert.ok(!text.includes('123456') && !text.includes('654321'), `${who} ${path} leaked a price`);
      }
    }
  });

  test('TC-P05 bulk import through the real routes: validate, preview gate, apply, report', async () => {
    await product('Koken', 'K-1', 7, { prices: { trader: 100 }, msilCode: 'M-1' });
    await product('Koken', 'K-2', 3);
    const up = await uploadCsv(U.admin, 'sku-pricing', [
      'SKU Code,MSIL Code,Brand,Venus Automation Price,Trader Price,End User Price,MSIL Price',
      'K-1,,,,110,,',
      'K-2,,,"₹2,000",,,',
      'GHOST,,,,5,,',
      'K-2,,,,0,,',
      ',M-1,,,,150,',
    ]);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const job = up.body.data;
    assert.equal(job.totalRows, 5);
    assert.equal(job.validRows, 2, JSON.stringify(job));

    // Preview: the rows are the price list.
    assert.equal((await GET(`/api/v1/inventory/imports/${job.jobId}/preview`, U.wh)).status, 404, 'Warehouse cannot read');
    // Warehouse holds view_inventory, so the route admits them; the pricing
    // gate then answers 404 — the rows are the price list. Sales may read them
    // (pricing holder since 2026-10-21).
    assert.equal((await GET(`/api/v1/inventory/imports/${job.jobId}/errors`, U.wh)).status, 404, 'Warehouse cannot read');
    assert.equal((await GET(`/api/v1/inventory/imports/${job.jobId}/errors`, U.sales)).status, 200, 'Sales can read');
    const pv = await GET(`/api/v1/inventory/imports/${job.jobId}/preview`, U.admin);
    assert.equal(pv.status, 200);
    const errs = await GET(`/api/v1/inventory/imports/${job.jobId}/errors`, U.admin);
    assert.equal(errs.body.pagination.total >= 3, true);

    assert.equal((await POST(`/api/v1/inventory/imports/${job.jobId}/confirm`, U.admin)).status, 200);
    const done = await waitForJob(job.jobId, U.admin);
    assert.equal(done.status, 'Partial');
    assert.equal(done.successfulRows, 2);

    const k1 = await Product.findOne({ skuCode: 'K-1' }, 'prices availableForSale').lean();
    const k2 = await Product.findOne({ skuCode: 'K-2' }, 'prices availableForSale').lean();
    assert.equal(k1.prices.trader, 110);
    assert.equal(k2.prices.venusAutomation, 2000);
    assert.equal(k1.availableForSale, 7);
    assert.equal(k2.availableForSale, 3);
    assert.equal(await Product.countDocuments(), 2, 'no SKU created');
  });

  test('TC-P06 bulk import permissions', async () => {
    await product('Koken', 'K-1', 7);
    assert.equal((await uploadCsv(U.wh, 'sku-pricing', ['SKU Code,Trader Price', 'K-1,5'])).status, 403, 'Warehouse');
    // Sales may run the pricing sheet, and only that one.
    assert.equal((await uploadCsv(U.sales, 'sku-pricing', ['SKU Code,Trader Price', 'K-1,6'])).status, 201, 'Sales');
    const types = (await GET('/api/v1/inventory/imports/types', U.sales)).body.data;
    assert.deepEqual(types.filter((t) => t.allowed).map((t) => t.importType), ['sku-pricing']);
    assert.equal((await GET('/api/v1/inventory/imports/types', U.wh)).body.data.find((t) => t.importType === 'sku-pricing').allowed, false);
  });

  test('TC-P07 duplicate upload of the same file is caught', async () => {
    await product('Koken', 'K-1', 7);
    const lines = ['SKU Code,Trader Price', 'K-1,5'];
    const form = () => {
      const f = new FormData();
      f.append('importType', 'sku-pricing');
      f.append('file', new Blob([lines.join('\n')], { type: 'text/csv' }), 'same.csv');
      return f;
    };
    const first = await http('POST', '/api/v1/inventory/imports', U.admin, form());
    assert.equal(first.status, 201);
    const second = await http('POST', '/api/v1/inventory/imports', U.admin, form());
    assert.equal(second.status, 409);
  });

  test('TC-P08 a changed price reaches the Sales Desk quote; already-priced bookings keep theirs', async () => {
    const p = await product('Koken', 'K-1', 10, { prices: { trader: 100 } });
    const orderId = await book(U.customer, p, 2);

    const quote1 = await GET(`/api/v1/sales/bookings/${orderId}/pricing`, U.sales);
    assert.equal(quote1.status, 200, JSON.stringify(quote1.body));
    assert.equal(quote1.body.data.lines[0].prices.trader, 100);

    assert.equal((await PUT(url('K-1'), U.admin, { brand: 'Koken', prices: { trader: 150 } })).status, 200);
    const quote2 = await GET(`/api/v1/sales/bookings/${orderId}/pricing`, U.sales);
    assert.equal(quote2.body.data.lines[0].prices.trader, 150);

    const applied = await PUT(`/api/v1/sales/bookings/${orderId}/pricing`, U.sales, { priceType: 'trader' });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal((await Order.findOne({ orderId }).lean()).unitPrice, 150);

    await PUT(url('K-1'), U.admin, { brand: 'Koken', prices: { trader: 999 } });
    assert.equal((await Order.findOne({ orderId }).lean()).unitPrice, 150, 'snapshot kept');
  });

  test('TC-P11 a booking keeps the price it was first given; only unpriced lines and a new tier read the list', async () => {
    const a = await product('Koken', 'K-A', 10, { prices: { trader: 100, endUser: 300 } });
    const b = await product('Koken', 'K-B', 10, { prices: { endUser: 400 } }); // no Trader price yet
    const res = await POST('/api/v1/reservations/direct-booking', U.customer, {
      items: [{ productId: String(a._id), quantity: 2 }, { productId: String(b._id), quantity: 1 }],
    });
    assert.ok(res.status < 300, JSON.stringify(res.body));
    const orderId = res.body.data.orderId;
    const rate = async (sku) => (await Order.findOne({ orderId, skuCode: sku }).lean()).unitPrice;
    const apply = (priceType) => PUT(`/api/v1/sales/bookings/${orderId}/pricing`, U.sales, { priceType });

    assert.equal((await apply('trader')).status, 200);
    assert.equal(await rate('K-A'), 100);
    assert.equal(await rate('K-B'), null, 'no Trader price on file');

    // The list changes after the booking was priced.
    await PUT('/api/v1/inventory/items/K-A/pricing', U.admin, { brand: 'Koken', prices: { trader: 120 } });
    await PUT('/api/v1/inventory/items/K-B/pricing', U.admin, { brand: 'Koken', prices: { trader: 55 } });

    // Same tier again (what raising the PO does): K-A keeps 100; K-B, never priced, takes 55.
    const again = await apply('trader');
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(await rate('K-A'), 100, 'kept the price first given');
    assert.equal(await rate('K-B'), 55, 'an unpriced line takes the current figure');
    assert.equal(again.body.pricing.totalAmount, 2 * 100 + 1 * 55);

    // A different tier is a new pricing decision: today's list.
    await apply('endUser');
    assert.equal(await rate('K-A'), 300);
    assert.equal(await rate('K-B'), 400);
  });

  test('TC-P09 regression: the Inventory Master stock import still adds stock', async () => {
    const p = await product('Koken', 'K-1', 0);
    await StockBalance.create({ skuCode: 'K-1', brand: 'Koken', location: new mongoose.Types.ObjectId(), locationCode: 'MAIN', onHand: 0, reserved: 0 });
    const up = await uploadCsv(U.admin, 'inventory-master', ['SKU Code,MSIL Code,Quantity,Box No', 'K-1,,12,']);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal((await POST(`/api/v1/inventory/imports/${up.body.data.jobId}/confirm`, U.admin)).status, 200);
    const done = await waitForJob(up.body.data.jobId, U.admin);
    assert.equal(done.status, 'Completed', JSON.stringify(done.fileErrors));
    const bal = await StockBalance.findOne({ skuCode: 'K-1' }).lean();
    assert.equal(bal.onHand, 12);
    await invariant(p);
  });

  test('TC-P10 regression: the single-SKU stock adjustment still works, and refusals are 4xx not 500', async () => {
    const p = await product('Koken', 'K-1', 5);
    await StockBalance.create({ skuCode: 'K-1', brand: 'Koken', location: new mongoose.Types.ObjectId(), locationCode: 'MAIN', onHand: 5, reserved: 0 });
    const ok = await POST('/api/v1/inventory/items/K-1/adjust', U.admin, { brand: 'Koken', mode: 'set', quantity: 9 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const bad = await POST('/api/v1/inventory/items/K-1/adjust', U.admin, { brand: 'Koken', mode: 'set', quantity: -5 });
    assert.ok(bad.status >= 400 && bad.status < 500, `got ${bad.status}`);
    const hidden = await POST('/api/v1/inventory/items/K-1/adjust', U.admin, { brand: 'Nope', mode: 'set', quantity: 1 });
    assert.ok(hidden.status >= 400 && hidden.status < 500, `got ${hidden.status}`);
    await invariant(p);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. MSIL SUPPLY DATE
// ════════════════════════════════════════════════════════════════════════════

describe('3. MSIL Supply Date and indent conversion', () => {
  /** MSIL booking of 10 with 2 in stock → 8 on indent. */
  const msilBooking = async ({ who = 'msil', bookedAgoMs = 0 } = {}) => {
    const p = await product('Koken', `SKU-${++seq}`, 2);
    const orderId = await book(U[who], p, 10);
    if (bookedAgoMs) await age(orderId, bookedAgoMs);
    return { p, orderId };
  };
  const setDate = (orderId, supplyDate, who = 'sales') =>
    PUT(`/api/v1/sales/bookings/${orderId}/supply-date`, U[who], { supplyDate });
  /** Write a date the endpoint would refuse (before the booking), straight to the data. */
  const forceDate = async (orderId, offset) => {
    const day = parseIstDay(ymd(offset));
    await Order.updateMany({ orderId }, { $set: { msilSupplyDate: day } });
    await Reservation.updateMany({ indentNumber: orderId.replace(/^BO-/, 'PI-') }, { $set: { supplyDate: day } });
  };

  test('TC-M01 Sales and Admin set and update the date; it is saved and shown on the booking and indent', async () => {
    const { orderId } = await msilBooking();
    assert.equal((await setDate(orderId, ymd(3))).status, 200);
    assert.equal((await setDate(orderId, ymd(5), 'admin')).status, 200, 'update by admin');
    const detail = await GET(`/api/v1/sales/bookings/${orderId}`, U.sales);
    const shown = new Date(detail.body.data.msilSupplyDate);
    assert.equal(shown.getTime(), parseIstDay(ymd(5)).getTime());
    assert.equal(new Date((await indentOf(orderId)).supplyDate).getTime(), shown.getTime());
  });

  test('TC-M02 permissions: Warehouse, Inventory Manager and customers cannot set the date or decide', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, -1);
    await arrive(p, 8);
    const indent = await indentOf(orderId);
    for (const who of ['wh', 'im', 'customer', 'msil']) {
      assert.equal((await setDate(orderId, ymd(3), who)).status, 403, `${who} date`);
      assert.equal((await POST(`/api/v1/sales/indents/${indent.reservationId}/convert`, U[who])).status, 403, `${who} convert`);
      assert.equal((await POST(`/api/v1/sales/indents/${indent.reservationId}/cancel`, U[who])).status, 403, `${who} cancel`);
    }
    assert.equal((await indentOf(orderId)).supplyCheck.status, 'Awaiting decision', 'untouched');
  });

  test('TC-M03 validation: non-MSIL booking, malformed date, impossible date, date before booking', async () => {
    const plain = await msilBooking({ who: 'customer' });
    assert.equal((await setDate(plain.orderId, ymd(3))).status, 400);
    const { orderId } = await msilBooking({ bookedAgoMs: 2 * DAY });
    for (const bad of ['30/10/2026', '2026-02-30', 'tomorrow', ymd(-5), 12345]) {
      assert.equal((await setDate(orderId, bad)).status, 400, `${bad}`);
    }
    assert.equal((await setDate('BO-NOPE', ymd(3))).status, 404);
  });

  test('TC-M04 arrival BEFORE the Supply Date, inside 7 days → converted automatically', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 1 * DAY });
    await setDate(orderId, ymd(2));
    await arrive(p, 8);
    const i = await indentOf(orderId);
    assert.equal(i.status, 'Confirmed');
    assert.equal(i.supplyCheck.status, 'Auto-converted');
    await invariant(p);
  });

  test('TC-M05 arrival ON the Supply Date → converted automatically', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 1 * DAY });
    await forceDate(orderId, 0);
    await arrive(p, 8);
    assert.equal((await indentOf(orderId)).supplyCheck.status, 'Auto-converted');
  });

  test('TC-M06 arrival AFTER the Supply Date → not converted; Convert and Cancel offered', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, -1);
    const before = await indentOf(orderId);
    await arrive(p, 8);
    const i = await indentOf(orderId);
    assert.equal(i.status, before.status);
    assert.equal(i.supplyCheck.status, 'Awaiting decision');
    assert.equal((await Product.findById(p._id).lean()).availableForSale, 8, 'stock not taken');
    const line = (await GET(`/api/v1/sales/bookings/${orderId}`, U.sales)).body.data.indent.lines[0];
    assert.equal(line.supplyCheck.status, 'Awaiting decision');
  });

  test('TC-M07 exact 7-day boundary: 1 minute inside converts, 1 minute outside is held', async () => {
    const inside = await msilBooking({ bookedAgoMs: 7 * DAY - 60_000 });
    await forceDate(inside.orderId, 5);
    await arrive(inside.p, 8);
    assert.equal((await indentOf(inside.orderId)).supplyCheck.status, 'Auto-converted', 'inside');

    const outside = await msilBooking({ bookedAgoMs: 7 * DAY + 60_000 });
    await forceDate(outside.orderId, 5);
    await arrive(outside.p, 8);
    const held = await indentOf(outside.orderId);
    assert.equal(held.supplyCheck.status, 'Awaiting decision', 'outside');
    assert.match(held.supplyCheck.reason, /7 days/);
  });

  test('TC-M08 missing Supply Date → converts as before', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 9 * DAY });
    await arrive(p, 8);
    assert.equal((await indentOf(orderId)).status, 'Confirmed');
  });

  test('TC-M09 delayed stock: a second late delivery does not re-notify or change the verdict', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, -1);
    await arrive(p, 3);
    const first = await indentOf(orderId);
    await arrive(p, 5);
    const second = await indentOf(orderId);
    assert.equal(second.supplyCheck.status, 'Awaiting decision');
    assert.equal(String(second.supplyCheck.arrivedAt), String(first.supplyCheck.arrivedAt));
  });

  test('TC-M10 Convert: once only — repeated and concurrent attempts create one booking allocation', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, -1);
    await arrive(p, 8);
    const { reservationId } = await indentOf(orderId);

    const results = await Promise.all([1, 2, 3].map(() => POST(`/api/v1/sales/indents/${reservationId}/convert`, U.sales)));
    const ok = results.filter((r) => r.status === 200);
    assert.equal(ok.length, 1, `exactly one success: ${results.map((r) => `${r.status} ${r.body?.message}`).join(' | ')}`);

    const again = await POST(`/api/v1/sales/indents/${reservationId}/convert`, U.sales);
    assert.ok(again.status === 404 || again.status === 409, `repeat: ${again.status}`);

    const rows = await Order.find({ orderId }).lean();
    const allocated = rows.flatMap((r) => r.allocations || []).reduce((n, a) => n + a.quantity, 0);
    assert.equal(allocated, 8, 'allocated exactly once');
    const x = await invariant(p);
    assert.equal(x.availableForSale, 0);
    assert.equal(x.bookedQuantity, 10);
  });

  test('TC-M11 Cancel: indent cancelled; later stock does not revive it; Convert after Cancel refused', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, -1);
    await arrive(p, 8);
    const { reservationId } = await indentOf(orderId);
    assert.equal((await POST(`/api/v1/sales/indents/${reservationId}/cancel`, U.sales, { reason: 'Not needed' })).status, 200);
    assert.ok([404, 409].includes((await POST(`/api/v1/sales/indents/${reservationId}/cancel`, U.sales)).status), 'second cancel');
    assert.ok([404, 409].includes((await POST(`/api/v1/sales/indents/${reservationId}/convert`, U.sales)).status), 'convert after cancel');
    await arrive(p, 5);
    const i = await indentOf(orderId);
    assert.equal(i.status, 'Cancelled');
    assert.equal(i.supplyCheck.status, 'Cancelled');
    const x = await invariant(p);
    assert.equal(x.bookedQuantity, 2, 'only the original 2');
  });

  test('TC-M12 Convert racing Cancel: exactly one wins, records stay consistent', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, -1);
    await arrive(p, 8);
    const { reservationId } = await indentOf(orderId);
    const [c, x] = await Promise.all([
      POST(`/api/v1/sales/indents/${reservationId}/convert`, U.sales),
      POST(`/api/v1/sales/indents/${reservationId}/cancel`, U.admin),
    ]);
    const i = await indentOf(orderId);
    const prod = await invariant(p);
    const allocated = (await Order.find({ orderId }).lean()).flatMap((r) => r.allocations || []).reduce((n, a) => n + a.quantity, 0);
    // Whatever the order, the indent and the stock must tell the same story.
    if (i.status === 'Cancelled') {
      assert.equal(allocated, 0, `cancelled but ${allocated} allocated (convert ${c.status}, cancel ${x.status})`);
      assert.equal(prod.bookedQuantity, 2);
    } else {
      assert.equal(allocated, 8, `converted: allocated ${allocated} (convert ${c.status}, cancel ${x.status})`);
      assert.equal(prod.bookedQuantity, 10);
    }
  });

  test('TC-M13 a held indent whose booking then expires (no PO in 7 days) can still be converted', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 8 * DAY });
    await forceDate(orderId, 5);
    await arrive(p, 8);
    assert.equal((await indentOf(orderId)).supplyCheck.status, 'Awaiting decision');
    await runPoSettlement();
    const { reservationId } = await indentOf(orderId);
    const r = await POST(`/api/v1/sales/indents/${reservationId}/convert`, U.sales);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await invariant(p);
  });

  test('TC-M14 the bookings list flags held lines for the desk', async () => {
    const { p, orderId } = await msilBooking({ bookedAgoMs: 3 * DAY });
    await forceDate(orderId, -1);
    await arrive(p, 8);
    const list = await GET('/api/v1/sales/bookings?status=all', U.sales);
    assert.equal(list.body.data.find((b) => b.orderId === orderId).awaitingDecision, 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. END TO END
// ════════════════════════════════════════════════════════════════════════════

describe('4. End to end', () => {
  test('TC-E01 new brand → priced → MSIL booking → late stock held → Convert → priced PO line', async () => {
    assert.equal((await POST('/api/v1/inventory/brands', U.admin, { name: 'Stanley' })).status, 201);
    await User.updateOne({ _id: U.msil._id }, { $set: { 'brandAccess.stanley': true } });
    const p = await product('Stanley', 'ST-E2E', 2);
    assert.equal((await PUT('/api/v1/inventory/items/ST-E2E/pricing', U.admin, { brand: 'Stanley', prices: { msil: 480 } })).status, 200);

    const orderId = await book(U.msil, p, 10);
    await age(orderId, 3 * DAY);
    const day = parseIstDay(ymd(-1));
    await Order.updateMany({ orderId }, { $set: { msilSupplyDate: day } });
    await Reservation.updateMany({ indentNumber: orderId.replace(/^BO-/, 'PI-') }, { $set: { supplyDate: day } });

    await arrive(p, 8);
    const held = await indentOf(orderId);
    assert.equal(held.supplyCheck.status, 'Awaiting decision');

    assert.equal((await POST(`/api/v1/sales/indents/${held.reservationId}/convert`, U.sales)).status, 200);
    const applied = await PUT(`/api/v1/sales/bookings/${orderId}/pricing`, U.sales, { priceType: 'msil' });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const rows = await Order.find({ orderId }).lean();
    assert.ok(rows.every((r) => r.brand === 'Stanley' && r.unitPrice === 480));
    const x = await invariant(p);
    assert.equal(x.bookedQuantity, 10);
  });
});
