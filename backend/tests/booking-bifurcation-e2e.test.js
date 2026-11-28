/**
 * BOOKING DATA BIFURCATION, END TO END, THROUGH THE REAL APP.
 *
 * utils/bookingBifurcation.js is unit-tested against hand-built rows in
 * booking-bifurcation.test.js. That proves the arithmetic. It does not prove
 * that the rows the REAL booking flow writes have the shape the arithmetic
 * assumes — which is the half that actually breaks, because the flow writes
 * `pendingQty` and the reservation as two records of the same units and it is
 * easy to read both.
 *
 * So every number here comes from driving the live routes: book through
 * `/reservations/direct-booking`, let stock arrive through the real adjustment
 * endpoint, raise the PO, cancel, expire. Nothing is stubbed but Socket.IO,
 * email and the JWT check.
 *
 * The one assertion made after every single step is the identity:
 *
 *   Total Bookings = Allocated Against Bookings + Pending Indents
 *
 * and alongside it, that the Admin Portal and the Customer Portal are reading
 * the SAME derivation — which is the defect the client reported.
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
      if (!user) return res.status(401).json({ success: false, message: 'Not authorized.' });
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
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { createProductModel } = await import('../models/Product.js');
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
  email: `${role.replace(/\s/g, '').toLowerCase()}${++seq}@example.com`,
  password: 'x'.repeat(12),
  user: `${role} ${seq}`, company: `${role} Co ${seq}`, role, ...extra,
})).toObject();

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

beforeEach(async () => {
  await clearCollections();
  await seedBrands();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({
    scope: 'global', indentAssignmentMode: 'auto', effectiveFrom: new Date(0),
  });
  U = {
    admin: await mkUser('Admin'),
    sales: await mkUser('Sales'),
    customer: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
    other: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
  };
});

const product = (sku, units) => createProductModel('Koken').create({
  skuCode: sku, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0,
});

/**
 * Put `units` of physical stock on the shelf THROUGH THE LEDGER.
 *
 * The `product()` fixture above writes the legacy Product counters directly,
 * which is enough to book against but leaves the StockBalance projection at
 * zero. A later adjustment reads that projection, so stock a test means to
 * "receive" has to arrive the way real stock does — through the adjustment
 * endpoint — or the receipt is refused for dropping on-hand below what is
 * reserved.
 */
const receive = async (sku, units, mode = 'set') => {
  const res = await POST(`/api/v1/inventory/items/${sku}/adjust`, U.admin, {
    brand: 'Koken', quantity: units, mode, reasonCode: 'FOUND', note: 'goods in',
  });
  assert.ok(res.status < 300, `receipt failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

/** Book through the real route. Returns the booking id. */
const book = async (who, p, qty, body = {}) => {
  const res = await POST('/api/v1/reservations/direct-booking', who, {
    items: [{ productId: String(p._id), quantity: qty }], ...body,
  });
  assert.ok(res.status < 300, `booking failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.orderId || res.body.data.indentId.replace(/^PI-/, 'BO-');
};

/** The split the CUSTOMER's own Order History receives. */
const customerSplit = async (who, orderId) => {
  const res = await GET('/api/v1/orders', who);
  assert.equal(res.status, 200);
  const row = res.body.data.find((r) => r.orderId === orderId);
  return row?.bifurcation ?? null;
};

/** The split the SALES DESK receives for the same booking. */
const deskSplit = async (orderId) => {
  const res = await GET(`/api/v1/sales/bookings/${encodeURIComponent(orderId)}`, U.admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.totals;
};

/** The SKU-wise split. */
const skuSplit = async (sku, who = U.admin) => {
  const res = await GET(`/api/v1/inventory/items/${encodeURIComponent(sku)}/bookings`, who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

/** The identity, checked on whichever shape it is handed. */
const identity = (split, where) => {
  assert.equal(
    split.allocatedQty + split.pendingIndentQty, split.totalBookedQty,
    `bifurcation identity broken ${where}: ${JSON.stringify(split)}`,
  );
};

// ── The worked example ──────────────────────────────────────────────────────

describe("the client's example, driven through the app", () => {
  test('book 100 with 70 in stock: 100 / 70 / 30, on both portals', async () => {
    const p = await product('SKU-A', 70);
    const orderId = await book(U.customer, p, 100);

    const mine = await customerSplit(U.customer, orderId);
    assert.deepEqual(
      [mine.totalBookedQty, mine.allocatedQty, mine.pendingIndentQty], [100, 70, 30],
    );
    identity(mine, 'on the customer portal');

    const desk = await deskSplit(orderId);
    assert.equal(desk.totalBookedQty, mine.totalBookedQty, 'the two portals must agree');
    assert.equal(desk.allocatedQty, mine.allocatedQty);
    assert.equal(desk.pendingIndentQty, mine.pendingIndentQty);

    // And the unreserved stock is reported as its own, different fact.
    const sku = await skuSplit('SKU-A');
    assert.deepEqual(
      [sku.totalBookedQty, sku.allocatedQty, sku.pendingIndentQty], [100, 70, 30],
    );
    assert.equal(sku.availableForSale, 0, 'all 70 went to the booking');
    assert.notEqual(sku.availableForSale, sku.allocatedQty, 'AVL and allocated are not the same figure');
  });

  test('stock arriving moves units from pending to allocated, and the two portals move together', async () => {
    const p = await product('SKU-A', 0);
    await receive('SKU-A', 70);
    const orderId = await book(U.customer, p, 100);

    // 15 more units arrive. Automatic assignment allocates them to the open
    // indent, which is what makes the frozen `pendingQty` go stale.
    await receive('SKU-A', 15, 'delta');

    const mine = await customerSplit(U.customer, orderId);
    identity(mine, 'after a partial receipt');
    assert.equal(mine.totalBookedQty, 100, 'the customer still wants 100');
    assert.equal(mine.allocatedQty, 85);
    assert.equal(mine.pendingIndentQty, 15);

    // On THIS path the automatic allocation also decrements the row's
    // `pendingQty`, so the snapshot happens to agree. Asserted, not assumed:
    // it is the reason this particular step was never the one that exposed
    // the Customer Portal's old arithmetic, and the divergence that did is
    // pinned separately below.
    const rows = await Order.find({ orderId }).lean();
    assert.equal(rows.reduce((n, r) => n + (r.pendingQty || 0), 0), 15);

    const desk = await deskSplit(orderId);
    assert.equal(desk.pendingIndentQty, mine.pendingIndentQty, 'the portals still agree');
  });

  test('the remaining stock arriving closes the indent', async () => {
    const p = await product('SKU-A', 0);
    await receive('SKU-A', 70);
    const orderId = await book(U.customer, p, 100);
    await receive('SKU-A', 30, 'delta');

    const mine = await customerSplit(U.customer, orderId);
    identity(mine, 'after full fulfilment');
    assert.deepEqual(
      [mine.totalBookedQty, mine.allocatedQty, mine.pendingIndentQty], [100, 100, 0],
    );
  });

  test('a booking stock cannot touch at all is 100 / 0 / 100', async () => {
    const p = await product('SKU-A', 0);
    const orderId = await book(U.customer, p, 100);

    // There is no Order row for this line — the confirmation only writes one
    // when confirmedQty > 0. Any derivation from order rows reports 0 indent.
    assert.equal(await Order.countDocuments({ orderId }), 0, 'the trap: no order row exists');

    const sku = await skuSplit('SKU-A');
    assert.deepEqual(
      [sku.totalBookedQty, sku.allocatedQty, sku.pendingIndentQty], [100, 0, 100],
    );
    assert.ok(sku.bookings.some((b) => b.pendingIndentQty === 100));
  });
  test('THE DIVERGENCE: a closed indent leaves `pendingQty` behind, and the split does not follow it', async () => {
    // Cancelling a booking closes its open indent (closeBookingIndent) without
    // rewriting the order rows — an indent holds no stock, so there is nothing
    // to settle on the row. `pendingQty` therefore keeps its confirmation-time
    // value for ever.
    //
    // This is what the Customer Portal used to sum. It reported 30 units still
    // on indent for a booking nobody was waiting on.
    const p = await product('SKU-A', 70);
    const orderId = await book(U.customer, p, 100);

    const cancelled = await POST(`/api/v1/orders/${orderId}/cancel`, U.admin, {
      reason: 'customer withdrew',
    });
    assert.ok(cancelled.status < 300, JSON.stringify(cancelled.body));

    const rows = await Order.find({ orderId }).lean();
    assert.equal(
      rows.reduce((n, r) => n + (r.pendingQty || 0), 0), 30,
      'the frozen remainder survives the cancellation',
    );
    const live = await Reservation.find({
      indentNumber: orderId.replace(/^BO-/, 'PI-'),
      status: { $in: ['Pending', 'Partially Confirmed'] },
    }).lean();
    assert.equal(live.length, 0, 'but the indent itself is closed');

    const mine = await customerSplit(U.customer, orderId);
    assert.equal(mine.pendingIndentQty, 0, 'the split reads the live indent, not the snapshot');
    identity(mine, 'after the indent was closed');
  });
});

// ── The rest of the lifecycle ───────────────────────────────────────────────

describe('the lifecycle', () => {
  test('raising the PO consumes the stock and leaves the split unchanged', async () => {
    const p = await product('SKU-A', 70);
    const orderId = await book(U.customer, p, 100);
    const before = await customerSplit(U.customer, orderId);

    const po = await POST(`/api/v1/sales/bookings/${orderId}/po`, U.admin, {
      poNumber: 'PO-1001', poDate: new Date().toISOString(),
    });
    assert.ok(po.status < 300, JSON.stringify(po.body));

    const after = await customerSplit(U.customer, orderId);
    identity(after, 'after the PO');
    assert.deepEqual(
      [after.totalBookedQty, after.allocatedQty, after.pendingIndentQty],
      [before.totalBookedQty, before.allocatedQty, before.pendingIndentQty],
      'a PO commits the units; it does not un-book them',
    );
  });

  test('cancelling empties the split and closes the indent with it', async () => {
    const p = await product('SKU-A', 70);
    const orderId = await book(U.customer, p, 100);

    const cancelled = await POST(`/api/v1/orders/${orderId}/cancel`, U.admin, {
      reason: 'no longer required',
    });
    assert.ok(cancelled.status < 300, JSON.stringify(cancelled.body));

    const after = await customerSplit(U.customer, orderId);
    identity(after, 'after cancellation');
    assert.deepEqual(
      [after.totalBookedQty, after.allocatedQty, after.pendingIndentQty], [0, 0, 0],
      'a cancelled booking is not an outstanding reservation',
    );
    assert.equal(after.cancelledQty, 70, 'what was cancelled is still on the record');
    assert.equal(after.bookedQtyEver, 100, 'and so is what was originally asked for');

    // And the SKU-wise view agrees that nothing is outstanding.
    const sku = await skuSplit('SKU-A');
    assert.equal(sku.totalBookedQty, 0);
    assert.equal(sku.availableForSale, 70, 'the stock went back');
  });

  test('a SELECTION LIST line holds nothing and appears in no split', async () => {
    const p = await product('SKU-A', 70);
    const added = await POST('/api/v1/reservations', U.customer, {
      productId: String(p._id), quantity: 50,
    });
    assert.ok(added.status < 300, JSON.stringify(added.body));

    const sku = await skuSplit('SKU-A');
    assert.deepEqual(
      [sku.totalBookedQty, sku.allocatedQty, sku.pendingIndentQty], [0, 0, 0],
      'nothing is committed until the booking is confirmed',
    );
    assert.equal(sku.availableForSale, 70, 'and no stock has moved');
  });

  test('concurrent bookings for one SKU sum correctly, booking by booking', async () => {
    const p = await product('SKU-A', 100);
    const a = await book(U.customer, p, 70);
    const b = await book(U.other, p, 80);

    const sku = await skuSplit('SKU-A');
    // 100 of stock: 70 to the first, 30 to the second, 50 left on indent.
    assert.deepEqual(
      [sku.totalBookedQty, sku.allocatedQty, sku.pendingIndentQty], [150, 100, 50],
    );
    assert.equal(sku.availableForSale, 0, 'no stock was invented, and none went twice');

    const perBooking = Object.fromEntries(sku.bookings.map((x) => [x.orderId, x]));
    assert.equal(perBooking[a].allocatedQty, 70);
    assert.equal(perBooking[b].allocatedQty, 30);
    assert.equal(perBooking[b].pendingIndentQty, 50);
    for (const x of sku.bookings) identity(x, `on ${x.orderId}`);

    // The SKU total is exactly the sum of its bookings — not a second count.
    assert.equal(
      sku.bookings.reduce((n, x) => n + x.totalBookedQty, 0), sku.totalBookedQty,
    );
  });

  test('a booking the SALES DESK placed on a customer\'s behalf splits the same way', async () => {
    const p = await product('SKU-A', 70);
    const orderId = await book(U.sales, p, 100, { customerId: String(U.customer._id) });

    // The customer sees it as their own booking, with the same split.
    const mine = await customerSplit(U.customer, orderId);
    assert.deepEqual(
      [mine.totalBookedQty, mine.allocatedQty, mine.pendingIndentQty], [100, 70, 30],
    );
    const desk = await deskSplit(orderId);
    assert.equal(desk.totalBookedQty, mine.totalBookedQty);
  });
});

// ── Access ──────────────────────────────────────────────────────────────────

describe('who may read the SKU-wise split', () => {
  test('Sales can — which it could not before the brand fence was fixed', async () => {
    const p = await product('SKU-A', 70);
    await book(U.customer, p, 100);
    const res = await GET('/api/v1/inventory/items/SKU-A/bookings', U.sales);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalBookedQty, 100);
  });

  test('a customer cannot', async () => {
    await product('SKU-A', 70);
    const res = await GET('/api/v1/inventory/items/SKU-A/bookings', U.customer);
    assert.equal(res.status, 403, 'other customers\' bookings are not a customer\'s business');
  });

  test('an unknown SKU is a 404, never an empty split', async () => {
    const res = await GET('/api/v1/inventory/items/NOPE/bookings', U.admin);
    assert.equal(res.status, 404);
  });

  test('a customer sees the split only on their OWN booking', async () => {
    const p = await product('SKU-A', 70);
    const orderId = await book(U.customer, p, 100);
    assert.equal(await customerSplit(U.other, orderId), null, 'not their booking');
    assert.ok(await customerSplit(U.customer, orderId), 'but their own is there');
  });
});
