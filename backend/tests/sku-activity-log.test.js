/**
 * SKU Activity Log — the ledger plus the indent side, said in plain language.
 *
 * Driven through the real app.js over HTTP (auth.js stubbed via x-test-user),
 * against a transactional replica set, with the real role permissions. Stock
 * arrives and leaves the way it does in production — Update Stock, and a real
 * booking — so what these tests assert is what the screen will show.
 *
 * The three things worth proving, because getting any of them wrong is how the
 * old Stock Ledger misled people:
 *
 *   1. a confirmed booking does NOT read as stock arriving;
 *   2. an indent appears at all, even though it posts no ledger movement;
 *   3. opening + in − out === closing, which only holds if bookings are left
 *      out of the in/out totals.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
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
const { default: Location } = await import('../models/Location.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { default: Role } = await import('../models/Role.js');
const { loadRoles } = await import('../utils/roleResolver.js');
const { seedBrands } = await import('../utils/brandRegistry.js');

let server;
let U;

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
  // Every BUILT-IN role that holds view_stock_ledger is an inventory role, and
  // inventory roles see every brand by design (utils/brandAccess.js). So the
  // brand fence is only reachable through a custom role, and that is what the
  // scope tests below use — testing it with an Inventory Manager would prove
  // nothing except that inventory roles see everything, which is the rule.
  await Role.create({
    name: 'Brand Auditor',
    permissions: ['view_stock_ledger'],
    grants: [{ module: 'inventory', submodule: 'ledger', actions: ['view'] }],
  });
  // The User model refuses a role name it has never heard of, and the registry
  // is cached, so a role created mid-test has to be published before anyone can
  // hold it.
  await loadRoles();

  U = {
    admin: await mkUser('Admin'),
    im: await mkUser('Inventory Manager'),
    sales: await mkUser('Sales'),
    kokenOnly: await mkUser('Brand Auditor', { brandAccess: { koken: true } }),
    bixOnly: await mkUser('Brand Auditor', { brandAccess: { bix: true } }),
    customer: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
  };
});

// ── HTTP ────────────────────────────────────────────────────────────────────

const http = async (method, url, who, body) => {
  const headers = who ? { 'x-test-user': String(who._id) } : {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${server.url}${url}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const GET = (url, who) => http('GET', url, who);
const POST = (url, who, body) => http('POST', url, who, body);

// ── Fixtures ────────────────────────────────────────────────────────────────

const product = (sku, units = 0, brand = 'Koken') => createProductModel(brand).create({
  skuCode: sku, description: `${sku} description`,
  availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0,
});

/** Stock moves through the real Update Stock route — ledger and all. */
const adjust = async (sku, delta, brand = 'Koken') => {
  const res = await POST(`/api/v1/inventory/items/${encodeURIComponent(sku)}/adjust`, U.admin, {
    brand, mode: 'delta', quantity: delta,
  });
  assert.equal(res.status, 201, `adjust failed: ${JSON.stringify(res.body)}`);
  return res.body;
};

/** Book through the real route, as the customer. */
const book = async (sku, qty, who = U.customer) => {
  const p = await Product.findOne({ skuCode: sku }).lean();
  const res = await POST('/api/v1/reservations/direct-booking', who, {
    items: [{ productId: String(p._id), quantity: qty }],
  });
  assert.ok(res.status < 300, `booking failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};

const activity = async (sku, who = U.admin, qs = '') => {
  const res = await GET(`/api/v1/inventory/items/${encodeURIComponent(sku)}/activity${qs}`, who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

const summary = async (sku, who = U.admin, qs = '') => {
  const res = await GET(`/api/v1/inventory/items/${encodeURIComponent(sku)}/activity/summary${qs}`, who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

const ofType = (records, type) => records.filter((r) => r.activityType === type);

// ── Stock in and out ────────────────────────────────────────────────────────

describe('stock in and out', () => {
  test('a receipt reads as Stock In, with the quantity said in words', async () => {
    await product('SKU-A');
    await adjust('SKU-A', 50);

    const { data, item } = await activity('SKU-A');
    const row = data.find((r) => r.affectsStock && r.quantity === 50);

    assert.ok(row, `no +50 row in ${JSON.stringify(data.map((r) => [r.label, r.quantity]))}`);
    assert.equal(row.label, 'Adjustment');
    assert.equal(row.direction, 'in');
    assert.match(row.description, /50 Units/);
    assert.equal(row.balanceKind, 'onHand');
    assert.equal(row.previousStock, 0);
    assert.equal(row.updatedStock, 50);
    // The product name travels with the row, so no screen has to look it up.
    assert.equal(row.productName, 'SKU-A description');
    assert.equal(item.skuCode, 'SKU-A');
    assert.equal(row.actor.name, U.admin.user);
  });

  test('a reduction reads as going out, and never as a negative arrival', async () => {
    await product('SKU-A');
    await adjust('SKU-A', 50);
    await adjust('SKU-A', -20);

    const { data } = await activity('SKU-A');
    const out = data.find((r) => r.quantity === -20);
    assert.equal(out.direction, 'out');
    assert.match(out.description, /20 Units removed/);
    assert.equal(out.previousStock, 50);
    assert.equal(out.updatedStock, 30);
  });

  test('every record carries the eight things the log has to show', async () => {
    await product('SKU-A');
    await adjust('SKU-A', 50);

    const [row] = (await activity('SKU-A')).data;
    for (const field of [
      'skuCode', 'productName', 'label', 'activityType', 'description',
      'previousStock', 'updatedStock', 'quantity', 'at', 'actor',
    ]) {
      assert.ok(field in row, `record is missing ${field}`);
    }
  });
});

// ── Bookings ────────────────────────────────────────────────────────────────

describe('a confirmed booking', () => {
  test('is labelled Booking, not Stock In, and says stock did not move', async () => {
    await product('SKU-A');
    await adjust('SKU-A', 50);
    await book('SKU-A', 20);

    const { data } = await activity('SKU-A');
    const [confirmed] = ofType(data, 'BOOKING_CONFIRMED');

    assert.ok(confirmed, `no booking row in ${JSON.stringify(data.map((r) => r.activityType))}`);
    assert.equal(confirmed.label, 'Booking');
    // THE bug this screen exists to stop: a +20 painted as goods arriving.
    assert.notEqual(confirmed.direction, 'in');
    assert.equal(confirmed.direction, 'allocate');
    // The before/after pair counts BOOKED units, and says so.
    assert.equal(confirmed.balanceKind, 'booked');
    assert.equal(confirmed.previousStock, 0);
    assert.equal(confirmed.updatedStock, 20);
    assert.match(confirmed.description, /set aside/i);
  });

  test('appears once, not twice', async () => {
    // A fully-covered booking leaves its reservation 'Confirmed'. That outcome
    // is ALREADY in the ledger as a RESERVE movement, so listing the
    // reservation as well showed one booking twice — once correctly, and
    // once as "not yet confirmed".
    await product('SKU-A');
    await adjust('SKU-A', 50);
    await book('SKU-A', 20);

    const { data } = await activity('SKU-A');
    assert.equal(ofType(data, 'BOOKING_CONFIRMED').length, 1);
    assert.equal(ofType(data, 'BOOKING_PENDING').length, 0, 'a confirmed booking is not pending');
    assert.equal(ofType(data, 'INDENT_RAISED').length, 0, 'stock covered it, so no indent');
  });

  test('carries the booking number it came from', async () => {
    await product('SKU-A');
    await adjust('SKU-A', 50);
    const { orderId } = await book('SKU-A', 20);

    const [confirmed] = ofType((await activity('SKU-A')).data, 'BOOKING_CONFIRMED');
    assert.equal(confirmed.referenceNumber, orderId);
    assert.equal(confirmed.referenceLabel, 'Booking');
  });
});

// ── Indents ─────────────────────────────────────────────────────────────────

describe('an indent', () => {
  test('appears even though it posts no ledger movement', async () => {
    // Nothing in stock, so the whole line becomes an indent.
    await product('SKU-A');
    await book('SKU-A', 30);

    const indent = await Reservation.findOne({ skuCode: 'SKU-A' }).lean();
    assert.ok(indent?.indentNumber, 'the booking did not raise an indent');

    const { data } = await activity('SKU-A');
    const [raised] = ofType(data, 'INDENT_RAISED');

    assert.ok(raised, `no indent row in ${JSON.stringify(data.map((r) => r.activityType))}`);
    assert.equal(raised.label, 'Indent');
    assert.equal(raised.quantity, 30);
    assert.equal(raised.referenceNumber, indent.indentNumber);
    // Nothing moved, so there is no sign and no before/after pair to show.
    assert.equal(raised.affectsStock, false);
    assert.equal(raised.previousStock, null);
    assert.equal(raised.updatedStock, null);
    assert.equal(raised.direction, 'none');
  });

  test('a partly-filled booking shows BOTH the confirmed part and the indent', async () => {
    await product('SKU-A');
    await adjust('SKU-A', 10);
    await book('SKU-A', 30);

    const { data } = await activity('SKU-A');
    const [confirmed] = ofType(data, 'BOOKING_CONFIRMED');
    const [raised] = ofType(data, 'INDENT_RAISED');

    assert.equal(confirmed.quantity, 10, 'the confirmed part should be what stock covered');
    assert.equal(raised.quantity, 20, 'the indent should be the remainder');
  });

  test('a booking still awaiting confirmation is Booking Pending, not an indent', async () => {
    await product('SKU-A', 100);
    const p = await Product.findOne({ skuCode: 'SKU-A' }).lean();
    // Added to the selection list, never confirmed. No PI- number, no movement.
    const res = await POST('/api/v1/reservations', U.customer, {
      productId: String(p._id), quantity: 15,
    });
    assert.ok(res.status < 300, `reservation failed: ${JSON.stringify(res.body)}`);

    const { data } = await activity('SKU-A');
    const [pending] = ofType(data, 'BOOKING_PENDING');

    assert.ok(pending, `no pending row in ${JSON.stringify(data.map((r) => r.activityType))}`);
    assert.equal(pending.label, 'Booking');
    assert.equal(pending.quantity, 15);
    assert.equal(pending.affectsStock, false);
    assert.equal(pending.direction, 'none');
    assert.match(pending.description, /not yet confirmed/i);
    // It is not an indent, and must not be counted as one.
    assert.equal(ofType(data, 'INDENT_RAISED').length, 0);
  });

  test('stays in the history after it is cancelled, saying what became of it', async () => {
    await product('SKU-A');
    await book('SKU-A', 30);
    const indent = await Reservation.findOne({ skuCode: 'SKU-A' }).lean();

    await Reservation.updateOne({ _id: indent._id }, { $set: { status: 'Cancelled' } });

    const [raised] = ofType((await activity('SKU-A')).data, 'INDENT_RAISED');
    // The raising happened. A log that drops it once the indent closes is not
    // a history.
    assert.ok(raised, 'a cancelled indent vanished from the log');
    assert.equal(raised.open, false);
    assert.match(raised.description, /since cancelled/i);
  });

  test('the type filter separates indents from everything else', async () =>{
    await product('SKU-A');
    await adjust('SKU-A', 10);
    await book('SKU-A', 30);

    const { data } = await activity('SKU-A', U.admin, '?activityType=INDENT_RAISED');
    assert.equal(data.length, 1);
    assert.equal(data[0].activityType, 'INDENT_RAISED');
  });
});

// ── The summary ─────────────────────────────────────────────────────────────

describe('opening, in, out, closing', () => {
  test('the four numbers add up, and a booking is not counted as stock out', async () => {
    await product('SKU-A');
    await adjust('SKU-A', 100);
    await adjust('SKU-A', -30);
    await book('SKU-A', 20);

    const s = await summary('SKU-A');

    assert.equal(s.openingStock, 0);
    assert.equal(s.stockIn, 100);
    // 20 units are spoken for, but they are still in the building — counting
    // them here is what would break the arithmetic below.
    assert.equal(s.stockOut, 30);
    assert.equal(s.closingStock, 70);
    assert.equal(
      s.openingStock + s.stockIn - s.stockOut, s.closingStock,
      'opening + in − out must equal closing',
    );
    // The booking is reported, separately and by its own name.
    assert.equal(s.reserved, 20);
  });

  test('a SKU with no transactions reports its balance rather than four zeroes', async () => {
    await product('SKU-QUIET', 40);

    const s = await summary('SKU-QUIET');
    assert.equal(s.derivedFromBalance, true);
    assert.equal(s.stockIn, 0);
    assert.equal(s.stockOut, 0);
    // Opening and closing agree, because nothing happened in between.
    assert.equal(s.openingStock, s.closingStock);
  });
});

// ── Paging ──────────────────────────────────────────────────────────────────

describe('history', () => {
  test('defaults to the latest 20, newest first, and pages through the rest', async () => {
    await product('SKU-A');
    for (let i = 0; i < 25; i += 1) await adjust('SKU-A', 2);

    const first = await activity('SKU-A');
    assert.equal(first.data.length, 20, 'the default window is the latest 20');
    assert.equal(first.pagination.total, 25);

    const times = first.data.map((r) => new Date(r.at).getTime());
    assert.deepEqual([...times].sort((a, b) => b - a), times, 'records must be newest first');

    // The complete history is the same request with a bigger page.
    const all = await activity('SKU-A', U.admin, '?limit=100');
    assert.equal(all.data.length, 25);

    const second = await activity('SKU-A', U.admin, '?limit=20&page=2');
    assert.equal(second.data.length, 5);
    // No overlap: page 2 continues where page 1 stopped.
    const ids = new Set(first.data.map((r) => r.id));
    assert.ok(second.data.every((r) => !ids.has(r.id)), 'page 2 repeated rows from page 1');
  });

  test('the merged feed pages correctly across both sources', async () => {
    // Movements and indents interleave, which is where a naive merge breaks.
    await product('SKU-A');
    await adjust('SKU-A', 5);
    await book('SKU-A', 10);   // 5 confirmed + 5 indent
    await adjust('SKU-A', 5);
    await book('SKU-A', 10);   // 5 confirmed + 5 indent

    const all = await activity('SKU-A', U.admin, '?limit=100');
    const paged = [];
    for (let page = 1; page <= Math.ceil(all.data.length / 3); page += 1) {
      paged.push(...(await activity('SKU-A', U.admin, `?limit=3&page=${page}`)).data);
    }
    assert.deepEqual(
      paged.map((r) => r.id), all.data.map((r) => r.id),
      'paging through the feed must give the same rows, in the same order',
    );
  });
});

// ── Access ──────────────────────────────────────────────────────────────────

describe('access', () => {
  test('Sales cannot open the activity log', async () => {
    await product('SKU-A');
    const res = await GET('/api/v1/inventory/items/SKU-A/activity', U.sales);
    assert.equal(res.status, 403);
  });

  test('an unauthenticated request is refused', async () => {
    const res = await GET('/api/v1/inventory/items/SKU-A/activity', null);
    assert.equal(res.status, 401);
  });

  test('a brand-restricted account sees neither movements nor indents from another brand', async () => {
    await product('KOK-1', 0, 'Koken');
    await product('BIX-1', 0, 'BIX');
    await adjust('KOK-1', 10, 'Koken');
    await adjust('BIX-1', 10, 'BIX');
    await book('KOK-1', 50);   // leaves an indent on KOK-1

    const mine = await activity('KOK-1', U.kokenOnly);
    assert.ok(mine.data.length > 0, 'a Koken user must see Koken activity');

    // The cross-SKU feed is the real test of the fence: it names no SKU, so
    // nothing narrows it except the user's brands.
    const theirs = await GET('/api/v1/inventory/activity', U.bixOnly);
    assert.equal(theirs.status, 200);
    assert.ok(
      theirs.body.data.every((r) => r.skuCode !== 'KOK-1'),
      'a BIX user must see no Koken activity',
    );

    // Including the indent side, which has no brand of its own and is fenced
    // by the SKU set instead.
    const feed = await GET('/api/v1/inventory/activity?activityType=INDENT_RAISED', U.bixOnly);
    assert.equal(feed.status, 200);
    assert.equal(feed.body.data.length, 0);

    // And the same indent IS visible to the account whose brand it belongs to,
    // so the assertion above is about the fence, not about an empty database.
    const ours = await GET('/api/v1/inventory/activity?activityType=INDENT_RAISED', U.kokenOnly);
    assert.equal(ours.body.data.length, 1);
  });

  test('an inaccessible SKU is 404, not an empty history', async () => {
    await product('BIX-1', 0, 'BIX');
    const res = await GET('/api/v1/inventory/items/BIX-1/activity', U.kokenOnly);
    assert.equal(res.status, 404);
  });
});

// ── The cross-SKU feed and its helpers ──────────────────────────────────────

describe('the feed', () => {
  test('lists activity across SKUs, and the picker ranks by last activity', async () => {
    await product('SKU-A');
    await product('SKU-B');
    await adjust('SKU-A', 10);
    await adjust('SKU-B', 10);

    const feed = await GET('/api/v1/inventory/activity', U.admin);
    assert.equal(feed.status, 200);
    assert.ok(new Set(feed.body.data.map((r) => r.skuCode)).size >= 2);

    const picker = await GET('/api/v1/inventory/activity/skus', U.admin);
    assert.equal(picker.status, 200);
    assert.equal(picker.body.data[0].skuCode, 'SKU-B', 'most recently active first');
    assert.equal(picker.body.data[0].productName, 'SKU-B description');

    const search = await GET('/api/v1/inventory/activity/skus?search=SKU-A', U.admin);
    assert.deepEqual(search.body.data.map((r) => r.skuCode), ['SKU-A']);
  });

  test('the type list is offered for the filter', async () => {
    const res = await GET('/api/v1/inventory/activity/types', U.admin);
    assert.equal(res.status, 200);
    const types = res.body.data.map((t) => t.type);
    for (const expected of [
      'STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT', 'BOOKING_CONFIRMED', 'INDENT_RAISED', 'BOOKING_PENDING',
    ]) {
      assert.ok(types.includes(expected), `${expected} missing from the filter list`);
    }
  });

  test('a bad filter is refused rather than silently ignored', async () => {
    const bad = await GET('/api/v1/inventory/activity?activityType=NONSENSE', U.admin);
    assert.equal(bad.status, 400);

    const backwards = await GET('/api/v1/inventory/activity?from=2026-06-01&to=2026-01-01', U.admin);
    assert.equal(backwards.status, 400);

    // A query-string operator must never reach the Mongo filter.
    const injected = await GET('/api/v1/inventory/activity?skuCode[$ne]=x', U.admin);
    assert.equal(injected.status, 200);
  });
});

// ── The Stock Ledger reads the same sentences ───────────────────────────────

describe('the Stock Ledger', () => {
  test('a grouped posting reports its stock net apart from its booked net', async () => {
    // Raising a PO posts RELEASE −4 and ISSUE −4 in ONE batch: the units stop
    // being reserved AND leave the building. Added together that is −8 for a
    // four-unit line, which is the sum of two different balances and describes
    // nothing. They are reported separately.
    await product('SKU-A');
    await adjust('SKU-A', 50);
    const { orderId } = await book('SKU-A', 4);
    const po = await POST(`/api/v1/sales/bookings/${encodeURIComponent(orderId)}/po`, U.admin, {
      poNumber: 'PO-TEST-0001',
    });
    assert.ok(po.status < 300, `PO failed: ${po.status} ${JSON.stringify(po.body)}`);

    const res = await GET('/api/v1/inventory/ledger/grouped?skuCode=SKU-A', U.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const settle = res.body.data.find((g) => (g.movementTypes || []).includes('ISSUE'));
    assert.ok(settle, `no issuing posting in ${JSON.stringify(res.body.data.map((g) => g.movementTypes))}`);
    assert.equal(settle.netPhysical, -4, 'four units left the building, not eight');
    assert.equal(settle.netAllocation, -4, 'and four stopped being reserved');
    // The old combined field still exists, and still double-counts — which is
    // exactly why the screen no longer reads it.
    assert.equal(settle.netQuantity, -8);
  });

  test('every row carries the plain-language reading of itself', async () => {
    await product('SKU-A');
    await adjust('SKU-A', 50);
    await book('SKU-A', 20);

    const res = await GET('/api/v1/inventory/ledger?skuCode=SKU-A', U.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    for (const m of res.body.data) {
      assert.ok(m.plain, `${m.transactionId} has no plain reading`);
      assert.ok(m.plain.description, `${m.transactionId} has no description`);
      assert.ok(
        ['in', 'out', 'allocate', 'release', 'none'].includes(m.plain.direction),
        `${m.transactionId} has direction ${m.plain.direction}`,
      );
    }

    const reserve = res.body.data.find((m) => m.movementType === 'RESERVE');
    assert.equal(reserve.plain.label, 'Booking');
    assert.equal(reserve.plain.balanceKind, 'booked');
    // The raw type is still there for whoever is investigating a row.
    assert.equal(reserve.movementType, 'RESERVE');
  });
});
