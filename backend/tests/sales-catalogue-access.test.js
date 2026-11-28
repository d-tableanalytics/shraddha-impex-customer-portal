/**
 * PRODUCT CATALOGUE ACCESS FOR SALES.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 *
 * A Sales user holding View on the Product Catalogue opened `/inventory` and
 * saw no products. No 403, no error — HTTP 200 with an empty list, which is
 * the hardest kind of failure to diagnose because every obvious check passes.
 *
 * It was never the permission. `authorize('view_catalogue', 'view_inventory',
 * 'create_order', 'view_all_bookings')` let the request through exactly as it
 * should. The request then reached `getInventory`, which iterates
 * `allowedBrandModels(req.user)` — and that returned an EMPTY ARRAY, so there
 * were no collections to query.
 *
 * `allowedBrands()` decided a Sales account's brands from its `brandAccess`
 * flags, the per-account flags whose purpose is to scope a CUSTOMER to the
 * brands they buy. No staff onboarding path sets them, so every Sales account
 * carried the schema default — all false — and was read as "entitled to no
 * brands" rather than "never scoped to any".
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FIX MUST NOT BREAK
 * ---------------------------------------------------------------------------
 *
 * Scoping a STAFF account to one brand is a capability the system genuinely
 * has and that a Super Admin uses: a BIX-only salesperson, a Koken-only
 * auditor. So the rule cannot be "staff see everything". It is "an account
 * nobody has scoped is not scoped" — and a customer, who always fails closed,
 * is excluded from the relaxation entirely.
 *
 * Both halves are asserted below, as is the fact that this grants no new
 * permission: Sales still cannot create, edit or delete a product.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';
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
const { default: Role } = await import('../models/Role.js');
const { createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { loadRoles } = await import('../utils/roleResolver.js');
const { allowedBrands, isBrandScopedAccount } = await import('../utils/brandAccess.js');

let server;
let U;

before(async () => {
  await startTestMongo();
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

const product = (brand, sku, units = 10) => createProductModel(brand).create({
  skuCode: sku, availableForSale: units, totalAvailableQuantity: units, bookedQuantity: 0,
});

beforeEach(async () => {
  await clearCollections();
  await seedBrands();

  // A staff role somebody has deliberately created, NOT fenced to the portal.
  // The brand-scoping capability below is only reachable through a role like
  // this, because the built-in warehouse roles see every brand by design.
  await Role.create({
    name: 'Brand Auditor',
    permissions: ['view_catalogue', 'view_inventory'],
    grants: [{ module: 'customer_portal', submodule: 'catalogue', actions: ['view'] }],
  });
  await loadRoles();

  U = {
    admin: await mkUser('Admin'),
    // The affected account, exactly as it exists in production: a Sales user
    // whose brandAccess has never been touched.
    sales: await mkUser('Sales'),
    // The same role, scoped on purpose to one brand.
    bixSales: await mkUser('Sales', { brandAccess: { bix: true } }),
    auditor: await mkUser('Brand Auditor', { brandAccess: { koken: true } }),
    // A Customer with NO brands ticked. Must still see nothing.
    strandedCustomer: await mkUser('Customer', { moq: 'SKIP' }),
    customer: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
  };

  await product('Koken', 'KOK-1');
  await product('Koken', 'KOK-2');
  await product('BIX', 'BIX-1');
  await product('IMADA', 'IMA-1');
});

// ── The defect ──────────────────────────────────────────────────────────────

describe('a Sales user opening the Product Catalogue', () => {
  test('sees the products — this is the reported defect', async () => {
    const res = await GET('/api/v1/products', U.sales);
    assert.equal(res.status, 200, 'the permission was never the problem');
    assert.ok(res.body.data.length > 0, 'an empty 200 is the bug: no brands to query');
    assert.equal(res.body.pagination.total, 4, 'every brand, since none was ever ticked');
  });

  test('sees exactly what an Admin sees', async () => {
    const mine = await GET('/api/v1/products?limit=200', U.sales);
    const theirs = await GET('/api/v1/products?limit=200', U.admin);
    assert.deepEqual(
      mine.body.data.map((p) => p.skuCode).sort(),
      theirs.body.data.map((p) => p.skuCode).sort(),
      'the two responses are the comparison the brief asked for',
    );
    assert.equal(mine.body.pagination.total, theirs.body.pagination.total);
  });

  test('search, brand filter and pagination all work', async () => {
    const searched = await GET('/api/v1/products?search=KOK', U.sales);
    assert.deepEqual(searched.body.data.map((p) => p.skuCode).sort(), ['KOK-1', 'KOK-2']);

    const filtered = await GET('/api/v1/products?brand=BIX', U.sales);
    assert.deepEqual(filtered.body.data.map((p) => p.skuCode), ['BIX-1']);

    const page1 = await GET('/api/v1/products?limit=2&page=1', U.sales);
    const page2 = await GET('/api/v1/products?limit=2&page=2', U.sales);
    assert.equal(page1.body.data.length, 2);
    assert.equal(page2.body.data.length, 2);
    assert.equal(page1.body.pagination.pages, 2);
    const seen = new Set(page1.body.data.map((p) => p.skuCode));
    assert.ok(page2.body.data.every((p) => !seen.has(p.skuCode)), 'page 2 repeated page 1');
  });

  test('can open a single product, and the SKU picker finds every brand', async () => {
    const one = await GET('/api/v1/products/koken/KOK-1', U.sales);
    assert.equal(one.status, 200);
    assert.equal(one.body.data.skuCode, 'KOK-1');

    const picker = await GET('/api/v1/products/search?search=BIX', U.sales);
    assert.equal(picker.status, 200);
    assert.deepEqual(picker.body.data.map((p) => p.skuCode), ['BIX-1']);
  });

  test('the brand list the browser is handed is not empty either', async () => {
    // brandsVisibleTo() follows the same rule, so an empty one would leave the
    // catalogue's Brand filter with no options even once rows arrived.
    assert.deepEqual(allowedBrands(U.sales).sort(), ['BIX', 'IMADA', 'Koken']);
    assert.equal(isBrandScopedAccount(U.sales), false, 'the flag sent to the browser');
  });
});

// ── What must not have changed ──────────────────────────────────────────────

describe('what the fix does NOT do', () => {
  test('a deliberately brand-scoped Sales account stays scoped', async () => {
    const res = await GET('/api/v1/products?limit=200', U.bixSales);
    assert.deepEqual(res.body.data.map((p) => p.skuCode), ['BIX-1']);
    assert.equal(isBrandScopedAccount(U.bixSales), true);
  });

  test('a brand-scoped custom staff role stays scoped', async () => {
    const res = await GET('/api/v1/products?limit=200', U.auditor);
    assert.deepEqual(res.body.data.map((p) => p.skuCode).sort(), ['KOK-1', 'KOK-2']);
  });

  test('a customer with no brands ticked still sees nothing — fail closed', async () => {
    const res = await GET('/api/v1/products?limit=200', U.strandedCustomer);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 0, 'a customer is never widened by having no flags');
    assert.deepEqual(allowedBrands(U.strandedCustomer), []);
  });

  test('a customer still sees only their own brands', async () => {
    const res = await GET('/api/v1/products?limit=200', U.customer);
    assert.deepEqual(res.body.data.map((p) => p.skuCode).sort(), ['KOK-1', 'KOK-2']);
  });

  test('an account with no role at all is not widened', async () => {
    assert.deepEqual(allowedBrands({ role: '', brandAccess: {} }), []);
    assert.deepEqual(allowedBrands({ role: 'Not A Real Role', brandAccess: {} }), []);
    assert.deepEqual(allowedBrands(null), []);
  });

  test('Sales gains no administrative permission from this', async () => {
    const created = await POST('/api/v1/products/koken', U.sales, {
      skuCode: 'NEW-1', availableForSale: 5,
    });
    assert.equal(created.status, 403, 'creating a product is still Admin-only');
  });

  test('an MSIL customer is still never shown a hidden brand', async () => {
    const msil = await mkUser('Customer', {
      customerCategory: 'MSIL', brandAccess: { koken: true, imada: true }, moq: 'SKIP',
    });
    const res = await GET('/api/v1/products?limit=200', msil);
    assert.ok(
      res.body.data.every((p) => p.brand !== 'IMADA'),
      'the hiddenFromMsil rule is unaffected by the brand fence change',
    );
  });
});
