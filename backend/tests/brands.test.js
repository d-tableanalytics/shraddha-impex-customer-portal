/**
 * Configurable brands: one created in Inventory → Brands must reach every
 * brand-scoped path — access rules, product models, orders, imports, account
 * forms and /auth/me — with nothing else edited, and an account saved by a
 * screen that predates the brand must not lose it.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});

const { default: Brand } = await import('../models/Brand.js');
const { default: User } = await import('../models/User.js');
const { default: Order } = await import('../models/Order.js');
const { Product, ProductKoken } = await import('../models/Product.js');
const {
  seedBrands, loadBrands, brandNames, mergeBrandAccess, canonicalBrand,
} = await import('../utils/brandRegistry.js');
const {
  allowedBrands, allowedBrandModels, brandOfProduct, brandsVisibleTo, canAccessBrand,
} = await import('../utils/brandAccess.js');
const {
  createBrand, deleteBrand, updateBrand, listBrandsHandler,
} = await import('../modules/inventory/brand.controller.js');
const { updateUser } = await import('../modules/users/user.controller.js');
const { createImportJob } = await import('../modules/inventory/import.service.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');

const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', permissions: ['*'] };
const customer = (brandAccess, extra = {}) => ({
  _id: new mongoose.Types.ObjectId(), role: 'Customer', brandAccess, ...extra,
});

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => {
  await clearCollections();
  await seedBrands();
});

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const full = {
    body: {}, params: {}, query: {}, headers: {}, method: 'POST', originalUrl: '/test',
    app: { get: () => null }, user: ADMIN, ...req,
  };
  let err = null;
  await handler(full, res, (e) => { err = e; });
  if (err) {
    const original = console.error;
    console.error = () => {};
    try { errorHandler(err, full, res, () => {}); } finally { console.error = original; }
  }
  return res;
};

const create = (name, extra = {}) => call(createBrand, { body: { name, ...extra } });

describe('the registry', () => {
  test('the built-in three are seeded and load in their usual order', () => {
    assert.deepEqual(brandNames(), ['Koken', 'BIX', 'IMADA']);
  });

  test('brandAccess is merged per brand, never replaced', () => {
    // A brand the request does not mention keeps its stored flag...
    assert.deepEqual(mergeBrandAccess({ koken: true, bix: true }, { koken: false }),
      { koken: false, bix: true });
    // ...including one for a brand this process has not loaded yet: the other
    // portal may have created it a moment ago (release defect DEF-B01).
    assert.deepEqual(mergeBrandAccess({ koken: true, stanley: true }, {}), { koken: true, stanley: true });
    // But a request cannot add a key that is not a configured brand.
    assert.deepEqual(mergeBrandAccess({}, { stanley: true }), {});
  });

  test('keys that are not brands are dropped', () => {
    assert.deepEqual(mergeBrandAccess({}, { koken: 1, $where: true, junk: true }), { koken: true });
  });
});

describe('creating a brand', () => {
  test('it reaches the access rules, the product models and /auth/me at once', async () => {
    const res = await create('Stanley Tools');
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.data.key, 'stanleytools');

    assert.deepEqual(brandNames(), ['Koken', 'BIX', 'IMADA', 'Stanley Tools']);
    assert.ok(allowedBrands(ADMIN).includes('Stanley Tools'));
    assert.equal(canonicalBrand('STANLEY TOOLS'), 'Stanley Tools');

    // A customer sees it only once it is ticked on their account.
    assert.deepEqual(allowedBrands(customer({ koken: true })), ['Koken']);
    assert.deepEqual(allowedBrands(customer({ koken: true, stanleytools: true })), ['Koken', 'Stanley Tools']);

    // Its products get a model that stamps the real name, and read back as it.
    const [Model] = allowedBrandModels(customer({ koken: true, stanleytools: true }))
      .find(([, brand]) => brand === 'Stanley Tools');
    const doc = await Model.create({ skuCode: 'ST-1' });
    assert.equal((await Product.findById(doc._id).lean()).brand, 'Stanley Tools');
    assert.equal(brandOfProduct(await Product.findById(doc._id)), 'Stanley Tools');

    // Orders accept it — the enum that would have refused it is gone.
    await Order.create({
      orderId: 'BO-1', brand: 'Stanley Tools', user: ADMIN._id, status: 'Booked', skuCode: 'ST-1',
    });

    // The browser list: everything for an admin, only their own for a customer.
    assert.ok(brandsVisibleTo(ADMIN).some((b) => b.name === 'Stanley Tools'));
    assert.deepEqual(brandsVisibleTo(customer({ bix: true })).map((b) => b.name), ['BIX']);
  });

  test('hidden-from-MSIL applies to a new brand the way it applies to IMADA', async () => {
    await create('Taparia', { hiddenFromMsil: true });
    const msil = customer({ koken: true, imada: true, taparia: true }, { customerCategory: 'MSIL' });
    assert.deepEqual(allowedBrands(msil), ['Koken']);
    assert.equal(canAccessBrand(msil, 'Taparia'), false);

    await call(updateBrand, { params: { key: 'taparia' }, body: { hiddenFromMsil: false } });
    assert.deepEqual(allowedBrands(msil), ['Koken', 'Taparia']);
  });

  test('a duplicate, a near-duplicate and a bad name are refused', async () => {
    assert.equal((await create('koken')).statusCode, 409);
    const near = await create('Ko-ken');
    assert.equal(near.statusCode, 409);
    assert.match(near.payload.message, /too close to the existing brand Koken/);
    assert.equal((await create('')).statusCode, 400);
    assert.equal((await create('123')).statusCode, 400);
    assert.equal((await create('Bad<script>')).statusCode, 400);
    assert.equal(await Brand.countDocuments(), 3);
  });

  test('the import sheets accept it in their Brand column', async () => {
    await create('Stanley');
    await ProductKoken.create({ skuCode: 'K-1' });
    await allowedBrandModels(ADMIN).find(([, b]) => b === 'Stanley')[0].create({ skuCode: 'S-1' });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-import-'));
    const file = path.join(dir, 'p.csv');
    fs.writeFileSync(file, ['SKU Code,Brand,Trader Price', 'S-1,stanley,10', 'K-1,Nope,10'].join('\n'));
    const job = await createImportJob({
      filePath: file, fileName: 'p.csv', fileType: 'csv', fileSize: 1,
      importType: 'sku-pricing', actor: ADMIN, req: null,
    });
    assert.equal(job.validRows, 1);
    assert.equal(job.invalidRows, 1);
  });
});

describe('accounts', () => {
  test('saving an account from an older form keeps access to a newer brand', async () => {
    await create('Stanley');
    const u = await User.create({
      email: 'c@example.com', password: 'x'.repeat(12), role: 'Customer',
      brandAccess: { koken: true, bix: false, imada: false, stanley: true },
    });
    assert.equal((await User.findById(u._id).lean()).brandAccess.stanley, true);

    const res = await call(updateUser, {
      method: 'PUT', params: { id: String(u._id) },
      body: { brandAccess: { koken: false, bix: true, imada: false } },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    assert.deepEqual((await User.findById(u._id).lean()).brandAccess,
      { koken: false, bix: true, imada: false, stanley: true });
  });
});

describe('deleting a brand', () => {
  test('built-in brands cannot be deleted', async () => {
    assert.equal((await call(deleteBrand, { params: { key: 'bix' } })).statusCode, 409);
  });

  test('a brand in use cannot be deleted', async () => {
    await create('Stanley');
    await allowedBrandModels(ADMIN).find(([, b]) => b === 'Stanley')[0].create({ skuCode: 'S-1' });
    const res = await call(deleteBrand, { params: { key: 'stanley' } });
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.message, /1 products/);
  });

  test('an unused brand is deleted, and its flag leaves every account', async () => {
    await create('Stanley');
    const u = await User.create({
      email: 'd@example.com', password: 'x'.repeat(12), role: 'Customer',
      brandAccess: { koken: true, stanley: true },
    });
    const res = await call(deleteBrand, { params: { key: 'stanley' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(brandNames(), ['Koken', 'BIX', 'IMADA']);
    assert.deepEqual((await User.findById(u._id).lean()).brandAccess, { koken: true });
  });

  test('the settings list reports products and accounts per brand', async () => {
    await create('Stanley');
    await ProductKoken.create({ skuCode: 'K-1' });
    await User.create({ email: 'e@example.com', password: 'x'.repeat(12), role: 'Customer', brandAccess: { stanley: true } });
    const res = await call(listBrandsHandler, { method: 'GET' });
    const byName = Object.fromEntries(res.payload.data.map((b) => [b.name, b]));
    assert.equal(byName.Koken.products, 1);
    assert.equal(byName.Stanley.usersWithAccess, 1);
    assert.equal(byName.Stanley.system, false);
    assert.equal(byName.IMADA.hiddenFromMsil, true);
  });
});

test('a database outage keeps the last good list', async () => {
  await create('Stanley');
  const original = Brand.find;
  Brand.find = () => { throw new Error('down'); };
  const errorLog = console.error;
  console.error = () => {};
  try {
    await loadBrands();
  } finally {
    Brand.find = original;
    console.error = errorLog;
  }
  assert.ok(brandNames().includes('Stanley'));
});
